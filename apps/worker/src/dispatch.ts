import type { BaseEvent } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import type { ActorContext, Job, JsonValue } from '@expunge/contracts';
import {
  ExpungeExecutionAgent,
  errorCode,
  type ArtifactReader,
  type CompletionReceiptReader,
  type ExecutionHooks,
  type JobPort,
  type LeaseBinding,
  type ModelResolver,
  type RunStats,
  type ToolProvider,
} from '@expunge/runtime';
import type { ProviderEnv } from '@expunge/vendor-openmuse';
import type { Subscription } from 'rxjs';
import type { WorkerConfig } from './config.js';
import { decideTerminal, terminalCheckpoint, type ReceiptFact } from './terminal.js';
import type { WakeCommand, WakeTarget } from './wake.js';

/** `JobRepository` (packages/mongo/src/jobs.ts) satisfies this structurally; wiring.ts checks it at compile time. */
export interface DispatchJobs extends JobPort {
  claim(actor: ActorContext, jobId: string, ownerId: string, durationMs?: number): Promise<Job | null>;
  renew(actor: ActorContext, lease: LeaseBinding, durationMs?: number): Promise<Job>;
  /** Present once mongodb-authority's A2-R lands. Absent: hashes are written through checkpoint (PARTIAL). */
  recordContextInputs?(actor: ActorContext, lease: LeaseBinding, hashes: string[]): Promise<string[]>;
}

/**
 * Trusted dispatcher read of a job by ID, before any actor is known (a wake carries only jobId and commandId).
 * PARTIAL: until `JobRepository.resolveForDispatch` exists this is `jobs.collection.findOne({_id})` (see wiring.ts).
 */
export interface JobResolver {
  resolve(jobId: string): Promise<Job | null>;
}

export interface EventSink {
  record(jobId: string, event: BaseEvent): void | Promise<void>;
}

/** PARTIAL: bounded in-memory diagnostics buffer. Projection persistence and Raindrop tracing arrive with packages/observability. */
export class RingEventSink implements EventSink {
  private readonly events = new Map<string, BaseEvent[]>();
  constructor(private readonly perJob = 200) {}
  record(jobId: string, event: BaseEvent): void {
    const list = this.events.get(jobId) ?? [];
    list.push(event);
    if (list.length > this.perJob) list.shift();
    this.events.set(jobId, list);
  }
  recent(jobId: string): BaseEvent[] {
    return [...(this.events.get(jobId) ?? [])];
  }
}

export type LogEntry = { level: 'info' | 'warn' | 'error'; message: string; jobId?: string; code?: string };

export type JobOutcome =
  | 'unknown_job'
  | 'unsupported_kind'
  | 'terminal'
  | 'not_claimable'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'yielded'
  | 'lost_lease'
  | 'aborted'
  | 'unfinalized';

export type JobRunResult = { jobId: string; outcome: JobOutcome; stats?: RunStats; reason?: string };

export type DispatcherDeps = {
  jobs: DispatchJobs;
  resolver: JobResolver;
  artifacts: ArtifactReader;
  tools: ToolProvider;
  models: ModelResolver;
  receipts: CompletionReceiptReader;
  config: WorkerConfig;
  env?: ProviderEnv;
  events?: EventSink;
  log?: (entry: LogEntry) => void;
  onResult?: (result: JobRunResult) => void;
};

const MAX_CONTEXT_INPUTS = 4096;
const BEGIN = (jobId: string) => `Begin cleanup job ${jobId}.`;

/** Serializes checkpoint writes for one lease and merges state so every write is a complete snapshot. */
class CheckpointWriter {
  private state: Record<string, JsonValue> = { v: 1 };
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly jobs: DispatchJobs,
    private readonly actor: ActorContext,
    private readonly lease: LeaseBinding,
  ) {}
  update(patch: Record<string, JsonValue>): Promise<void> {
    this.state = { ...this.state, ...patch };
    const snapshot = this.state;
    const write = this.chain.then(() => this.jobs.checkpoint(this.actor, this.lease, snapshot));
    this.chain = write.catch(() => undefined);
    return write;
  }
  replace(value: JsonValue): Promise<void> {
    const write = this.chain.then(() => this.jobs.checkpoint(this.actor, this.lease, value));
    this.chain = write.catch(() => undefined);
    return write;
  }
}

/**
 * Durable dispatcher: claims a queued (or lease-expired) cleanup job through `JobRepository.claim`, renews
 * the lease on a timer, runs `ExpungeExecutionAgent`, checkpoints between tool phases, and finalizes the job
 * from committed state. It never takes tenant, actor, harness or budget from a wake command.
 */
export class Dispatcher implements WakeTarget {
  private readonly queue: string[] = [];
  private readonly running = new Map<string, () => void>();
  private waiters: Array<() => void> = [];
  private stopping = false;

  constructor(private readonly deps: DispatcherDeps) {}

  wake(command: WakeCommand): boolean {
    if (this.stopping) return false;
    if (this.queue.includes(command.jobId) || this.running.has(command.jobId)) return true; // already pending: idempotent
    if (this.queue.length >= this.deps.config.maxQueued) return false;
    this.queue.push(command.jobId);
    this.pump();
    return true;
  }

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Graceful stop: no new work, running jobs are aborted (their leases expire or the run released them). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.queue.length = 0;
    for (const abort of this.running.values()) abort();
    await this.idle();
  }

  get inFlight(): string[] {
    return [...this.running.keys()];
  }

  private pump(): void {
    while (this.running.size < this.deps.config.maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift() as string;
      this.running.set(jobId, () => undefined);
      void this.runJob(jobId)
        .then((result) => this.deps.onResult?.(result))
        .catch((error) =>
          this.log({ level: 'error', message: 'job run failed unexpectedly', jobId, code: errorCode(error) }),
        )
        .finally(() => {
          this.running.delete(jobId);
          this.pump();
          if (this.queue.length === 0 && this.running.size === 0) {
            const waiters = this.waiters;
            this.waiters = [];
            for (const resolve of waiters) resolve();
          }
        });
    }
  }

  private log(entry: LogEntry): void {
    this.deps.log?.(entry);
  }

  async runJob(jobId: string): Promise<JobRunResult> {
    const { jobs, config } = this.deps;
    const stored = await this.deps.resolver.resolve(jobId);
    if (!stored) return { jobId, outcome: 'unknown_job' };
    if (stored.kind !== 'cleanup') return { jobId, outcome: 'unsupported_kind' };
    if (['succeeded', 'failed', 'cancelled'].includes(stored.status)) return { jobId, outcome: 'terminal' };

    const claimed = await jobs.claim(stored.actor, jobId, config.ownerId, config.leaseMs);
    if (!claimed) return { jobId, outcome: 'not_claimable' };
    const actor = claimed.actor;
    const lease: LeaseBinding = { jobId, ownerId: config.ownerId, fence: claimed.lease.fence };
    this.log({ level: 'info', message: 'job claimed', jobId });

    const writer = new CheckpointWriter(jobs, actor, lease);
    const contextInputs = new Set<string>();
    const sink = this.deps.events;
    const hooks: ExecutionHooks = {
      onContextInputs: async (hashes) => {
        if (typeof jobs.recordContextInputs === 'function') {
          await jobs.recordContextInputs(actor, lease, hashes);
          return;
        }
        // PARTIAL fallback until Job.contextInputs/recordContextInputs land: durable, fenced, but only in the checkpoint.
        for (const hash of hashes) contextInputs.add(hash);
        if (contextInputs.size > MAX_CONTEXT_INPUTS) throw new Error('ContextInputsBounds');
        await writer.update({ contextInputs: [...contextInputs] });
      },
      onPhaseComplete: async (info) => {
        try {
          await writer.update({
            phase: info.phase,
            toolCalls: info.toolCalls,
            lastTool: info.toolId,
            lastOutcome: info.outcome,
            lastPhaseMs: info.elapsedMs,
          });
        } catch (error) {
          // complete_cleanup commits the receipt AND the terminal job state in one transaction, so the
          // checkpoint after it legitimately finds no live lease. Re-read: a terminal job ends the run normally.
          if (errorCode(error) === 'LostLease') {
            const now = await jobs.readAuthorized(actor, jobId).catch(() => null);
            if (now && ['succeeded', 'failed', 'cancelled'].includes(now.status)) return 'stop';
          }
          throw error;
        }
        return 'continue';
      },
      onEvent: (event) => sink?.record(jobId, event),
      onHookError: (hook, error) =>
        this.log({ level: 'warn', message: `hook ${hook} failed`, jobId, code: errorCode(error) }),
    };

    const agent = new ExpungeExecutionAgent(
      {
        jobs,
        artifacts: this.deps.artifacts,
        tools: this.deps.tools,
        models: this.deps.models,
        receipts: this.deps.receipts,
        hooks,
        env: this.deps.env,
        phaseTimeoutMs: config.phaseTimeoutMs,
      },
      { actor, lease },
    );

    let subscription: Subscription | undefined;
    let finishRun: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let aborting = false;
    const abortRun = () => {
      aborting = true;
      subscription?.unsubscribe();
      finishRun();
    };
    this.running.set(jobId, abortRun);

    let renewing = false;
    let renewalFailed = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      jobs
        .renew(actor, lease, config.leaseMs)
        .catch((error) => {
          // Lost fence, or cancellation requested (renew requires cancellationRequested=false). Stop the run;
          // the agent's teardown finishes a cancelled job while the lease is still live.
          renewalFailed = true;
          this.log({
            level: 'warn',
            message: 'lease renewal failed; stopping run',
            jobId,
            code: errorCode(error),
          });
          abortRun();
        })
        .finally(() => {
          renewing = false;
        });
    }, config.renewEveryMs);

    let runErrorCode: string | undefined;
    try {
      subscription = agent
        .run({
          threadId: jobId,
          runId: claimed.binding.runId,
          state: {},
          messages: [{ id: `${claimed.binding.runId}-begin`, role: 'user', content: BEGIN(jobId) }],
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .subscribe({
          next: (event) => {
            if (event.type === EventType.RUN_ERROR)
              runErrorCode = (event as unknown as { code?: string }).code;
          },
          error: () => finishRun(),
          complete: () => finishRun(),
        });
      await done;
    } catch (error) {
      runErrorCode = errorCode(error);
    } finally {
      subscription?.unsubscribe();
    }

    try {
      const stats: RunStats = (await agent.settled()) ?? {
        endedBy: aborting ? 'aborted' : 'error',
        ...(runErrorCode ? { errorCode: runErrorCode } : {}),
        toolCalls: 0,
        phases: 0,
        elapsedMs: 0,
        release: 'none',
      };
      return await this.finalize({ jobId, actor, lease, claimed, stats, writer, renewalFailed });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async finalize(input: {
    jobId: string;
    actor: ActorContext;
    lease: LeaseBinding;
    claimed: Job;
    stats: RunStats;
    writer: CheckpointWriter;
    renewalFailed: boolean;
  }): Promise<JobRunResult> {
    const { jobs, receipts } = this.deps;
    const { jobId, actor, lease, claimed, stats, writer } = input;
    const stored = await jobs.readAuthorized(actor, jobId).catch(() => null);
    let receipt: ReceiptFact = null;
    if (!['yielded', 'cancelled'].includes(stats.release)) {
      try {
        const found = await receipts.find(actor, {
          jobId,
          runId: claimed.binding.runId,
          harnessHash: claimed.binding.harnessHash,
        });
        if (found)
          receipt = {
            receiptId: found.receiptId,
            domainStatus: found.domainStatus,
            operationalResiduals: found.operationalResiduals,
          };
      } catch (error) {
        this.log({ level: 'warn', message: 'receipt read failed', jobId, code: errorCode(error) });
      }
    }
    const action = decideTerminal({
      stats,
      stored,
      fence: lease.fence,
      receipt,
      renewalFailed: input.renewalFailed,
    });
    if (action.kind === 'none') {
      const outcome: JobOutcome =
        stats.release === 'yielded'
          ? 'yielded'
          : stats.release === 'cancelled'
            ? 'cancelled'
            : action.reason === 'already_terminal'
              ? stored?.status === 'succeeded'
                ? 'succeeded'
                : stored?.status === 'cancelled'
                  ? 'cancelled'
                  : 'failed'
              : action.reason === 'not_ours'
                ? 'lost_lease'
                : 'aborted';
      this.log({ level: 'info', message: `job ended: ${outcome}`, jobId });
      return { jobId, outcome, stats, reason: action.reason };
    }
    try {
      await writer.replace(terminalCheckpoint(stats, action));
      try {
        await jobs.finish(actor, lease, action.status, action.outputRefs);
        this.log({ level: 'info', message: `job finished: ${action.status}`, jobId, code: action.reason });
        return { jobId, outcome: action.status, stats, reason: action.reason };
      } catch (error) {
        // The repository refuses `succeeded` without a verifiable receipt; downgrade rather than strand the job.
        if (action.status === 'succeeded' && errorCode(error) === 'CompletionReceiptRequired') {
          await jobs.finish(actor, lease, 'failed', action.outputRefs);
          return { jobId, outcome: 'failed', stats, reason: 'CompletionReceiptRequired' };
        }
        throw error;
      }
    } catch (error) {
      this.log({ level: 'error', message: 'could not finalize job', jobId, code: errorCode(error) });
      return { jobId, outcome: 'unfinalized', stats, reason: errorCode(error) };
    }
  }
}
