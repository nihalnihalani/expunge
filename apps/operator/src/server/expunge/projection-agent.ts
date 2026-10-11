import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { expungeReviewTool } from '../../shared/expunge.js';
import {
  NO_TOOL_COPY,
  UNAVAILABLE_COPY,
  UNBOUND_COPY,
  acknowledgement,
} from './agent-copy.js';
import type { ExpungeDomainService } from './domain-service.js';

/** The only frontend tools this agent will emit calls for (backend half of the HITL registration). */
const ADMITTED = new Set<string>([expungeReviewTool.name]);
const RUN_BUDGET_MS = 15_000;
export const BUDGET_COPY =
  'The Expunge status read did not finish in time. Nothing was started, changed or cancelled by this message.';

/** Rejects when the signal aborts, so a read that ignores its signal still cannot hang the run. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Observes and acknowledges. It never runs the model campaign (that is the durable worker),
 * never calls an LLM, never parses free text into authority, and every turn is finite. Ending
 * the stream, closing the tab or aborting a run cannot complete or cancel a job.
 *
 * Trusted dependencies live in the constructor and survive clone() (the runtime clones agents
 * before running them). The job is resolved from the stored thread binding, never from
 * client-supplied state or forwardedProps.
 */
export class ExpungeProjectionAgent extends AbstractAgent {
  private controller?: AbortController;
  constructor(
    private readonly domain: ExpungeDomainService,
    private readonly agentName = 'expunge',
    private readonly budgetMs = RUN_BUDGET_MS,
  ) {
    super({ agentId: agentName });
  }
  clone() {
    return new ExpungeProjectionAgent(
      this.domain,
      this.agentName,
      this.budgetMs,
    );
  }
  abortRun() {
    this.controller?.abort();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      this.controller = controller;
      let timedOut = false;
      const budget = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.budgetMs);
      const emit = (event: Record<string, unknown> & { type: EventType }) =>
        subscriber.next(event as unknown as BaseEvent);
      const text = (messageId: string, content: string) => {
        emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: 'assistant',
        });
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: content,
        });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId });
      };
      void (async () => {
        emit({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        try {
          const binding = await raceAbort(
            this.domain.readJobByThread(input.threadId, controller.signal),
            controller.signal,
          );
          if (!binding) {
            text(`expunge-unbound-${input.runId}`, UNBOUND_COPY);
          } else {
            const snapshot = await raceAbort(
              this.domain.readJob(binding.jobId, controller.signal),
              controller.signal,
            );
            if (!snapshot) {
              text(`expunge-unbound-${input.runId}`, UNBOUND_COPY);
            } else {
              const messageId = `expunge-${snapshot.jobId}-${snapshot.sequence}-${input.runId}`;
              const admitted = (input.tools ?? []).some((tool) =>
                ADMITTED.has(tool.name),
              );
              const proposalId =
                snapshot.approval.state === 'pending'
                  ? snapshot.approval.proposalId
                  : null;
              text(
                messageId,
                proposalId && !admitted
                  ? `${acknowledgement(snapshot)} ${NO_TOOL_COPY}`
                  : acknowledgement(snapshot),
              );
              if (proposalId && admitted) {
                // Stored descriptor and decision live on the server; the call carries only the ID.
                const toolCallId = `review-${proposalId}-${input.runId}`;
                emit({
                  type: EventType.TOOL_CALL_START,
                  toolCallId,
                  toolCallName: expungeReviewTool.name,
                  parentMessageId: messageId,
                });
                emit({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId,
                  delta: JSON.stringify({ proposalId }),
                });
                emit({ type: EventType.TOOL_CALL_END, toolCallId });
              }
              emit({
                type: EventType.STATE_SNAPSHOT,
                snapshot: {
                  projection: {
                    jobId: snapshot.jobId,
                    status: snapshot.status,
                    sequence: snapshot.sequence,
                  },
                },
              });
            }
          }
        } catch {
          if (!controller.signal.aborted)
            text(`expunge-unavailable-${input.runId}`, UNAVAILABLE_COPY);
        }
        // An abandoned stream emits nothing more. A budget breach is an error event, never a
        // job state change and never a made-up status.
        if (timedOut) emit({ type: EventType.RUN_ERROR, message: BUDGET_COPY });
        else if (!controller.signal.aborted)
          emit({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });
        subscriber.complete();
      })();
      return () => {
        clearTimeout(budget);
        controller.abort();
      };
    });
  }
}
