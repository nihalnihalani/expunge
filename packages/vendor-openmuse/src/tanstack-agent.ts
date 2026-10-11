// Port of OpenMuse apps/server/src/engine/tanstack-agent.ts at commit
// 1ac68f3909f2478ab6280883f1ab5ea65eb5719d (MIT, Copyright (c) 2026 OpenMuse contributors).
// Adapted to @tanstack/ai 0.63.0, @tanstack/ai-openai 0.25.1 and @copilotkit/runtime 1.75.0.
// Every modification is listed in ../THIRD_PARTY.md (M1-M10). Copied helpers keep the upstream
// names: tanstackAgent, textOnlyToolResult, reportStepLimit, splitTextAtToolCalls.
import { randomUUID } from 'node:crypto';
import { type BaseEvent, EventType, type RunAgentInput } from '@ag-ui/core';
import { BuiltInAgent, convertInputToTanStackAI, type ToolDefinition } from '@copilotkit/runtime/v2';
import {
  type AnyTextAdapter,
  chat,
  isContentPartArray,
  maxIterations,
  type SchemaInput,
  toolDefinition,
} from '@tanstack/ai';
import { map, mergeMap, type Observable } from 'rxjs';
import { adapter as selectAdapter, type ProviderEnv } from './provider.js';
import { stateTools } from './state-tools.js';

/** One model call as seen at the adapter boundary. `usage` is the provider-reported TokenUsage, untouched. */
export type ModelCallRecord = { usage: unknown; completed: boolean };

/** The adapter actually used for a run: what the provider reported, not what a caller claimed. */
export type ModelIdentity = { provider: string; model: string };

export type TanStackAgentOptions = {
  /** "provider/model" string, e.g. "openai/gpt-5". Ignored when `textAdapter` is supplied. */
  model: string;
  maxSteps: number;
  tools: ToolDefinition[];
  prompt: string;
  /** Checked between model turns, after the current turn's tools have settled. */
  shouldContinue?: () => boolean;
  /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
  stepLimitNote?: string;
  /**
   * M12: called, out of band, exactly when the step limit (not the model) ended the run, immediately
   * before the note is emitted. Lets a host learn the ending without matching text the model could forge.
   */
  onStepLimit?: () => void;
  /**
   * M13: called once per model call (one `adapter.chatStream` invocation), when its stream ends, with the usage the
   * provider reported on that call's RUN_FINISHED (undefined when none was reported). Lets a host meter tokens and
   * cost per call instead of trusting a run-end aggregate.
   */
  onModelCall?: (call: ModelCallRecord) => void;
  /** M2: provider credentials come from this injected environment, never from ambient globals. */
  env?: ProviderEnv;
  /** M3: a ready text adapter replaces provider selection. Production code leaves this unset. */
  textAdapter?: AnyTextAdapter;
  /** M5: frontend (AG-UI client) tools the model may be offered. Default none. */
  clientToolAllowlist?: readonly string[];
  /** M6: offer AGUISendStateSnapshot / AGUISendStateDelta (upstream behavior). Default true. */
  stateTools?: boolean;
};

/**
 * M7: composition instead of monkey-patching. Upstream replaced `agent.run` on the returned
 * BuiltInAgent; runtime 1.75.0's BuiltInAgent.clone() recreates the agent from its config and
 * would drop that patch. This wrapper holds the BuiltInAgent privately, so the output helpers
 * (text/tool splitting, text-only tool results, step-limit note) are part of `run` itself.
 */
export class TanStackAgent {
  private readonly agent: BuiltInAgent;
  private resolvedIdentity?: ModelIdentity;
  constructor(private readonly options: TanStackAgentOptions) {
    const serverTools: ToolDefinition[] = [
      ...options.tools,
      ...(options.stateTools === false ? [] : stateTools),
    ];
    for (const tool of serverTools)
      if (!tool.execute) throw new Error(`Server tool has no executor: ${tool.name}`);
    const allowedClientTools = new Set(options.clientToolAllowlist ?? []);
    this.agent = new BuiltInAgent({
      type: 'tanstack',
      factory: ({ input, abortController }) => {
        const converted = convertInputToTanStackAI(scopeInput(input, allowedClientTools));
        const base = options.textAdapter ?? selectAdapter(options.model, options.env);
        // M14: record the identity of the adapter that really serves this run (adapter.name / adapter.model).
        this.resolvedIdentity = { provider: base.name, model: base.model };
        return chat({
          adapter: options.onModelCall ? tapAdapter(base, options.onModelCall) : base,
          messages: converted.messages,
          // M8: ONE composition path. Runtime 1.75.0's converter already appends the AG-UI
          // context entries and application state to `converted.systemPrompts`; upstream built
          // those sections by hand for runtime 1.70.1 and ignored the converter's list.
          systemPrompts: options.prompt
            ? [options.prompt, ...converted.systemPrompts]
            : converted.systemPrompts,
          tools: [
            ...converted.tools,
            ...serverTools.map((tool) =>
              toolDefinition({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.parameters as SchemaInput,
              }).server(async (args, context) => {
                // M9: stop before starting a tool once the run is aborted.
                context?.abortSignal?.throwIfAborted();
                return (tool.execute as (args: unknown) => Promise<unknown>)(args);
              }),
            ),
          ],
          agentLoopStrategy: (state) =>
            maxIterations(options.maxSteps)(state) && (options.shouldContinue?.() ?? true),
          abortController,
          threadId: input.threadId,
          runId: input.runId,
        });
      },
    });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const events = splitTextAtToolCalls(this.agent.run(input)).pipe(map(textOnlyToolResult));
    return this.options.stepLimitNote
      ? reportStepLimit(events, this.options.maxSteps, this.options.stepLimitNote, this.options.onStepLimit)
      : events;
  }

  abortRun(): void {
    this.agent.abortRun();
  }

  /** Set once the run has built its adapter; undefined before that (e.g. a missing credential). */
  get identity(): ModelIdentity | undefined {
    return this.resolvedIdentity;
  }

  /** A fresh wrapper with the same options (a BuiltInAgent cannot run twice at once). */
  clone(): TanStackAgent {
    return new TanStackAgent(this.options);
  }
}

/** A BuiltInAgent in TanStack factory mode with the options of the classic AI SDK mode. */
export function tanstackAgent(options: TanStackAgentOptions): TanStackAgent {
  return new TanStackAgent(options);
}

/**
 * M5: client messages and tools are untrusted. System/developer messages from the client are
 * dropped (the same trust boundary BuiltInAgent's classic mode applies, and DotAgent copies),
 * and only allow-listed frontend tools reach the model.
 */
function scopeInput(input: RunAgentInput, allowedClientTools: ReadonlySet<string>): RunAgentInput {
  return {
    ...input,
    messages: input.messages.filter((message) => message.role !== 'system' && message.role !== 'developer'),
    tools: (input.tools ?? []).filter((tool) => allowedClientTools.has(tool.name)),
  };
}

/**
 * A tool can return TanStack content parts, e.g. text plus a screenshot. Inside the run
 * the adapters send them to the model as multimodal tool results. The AG-UI result event
 * would carry the same parts JSON-encoded, image data included, into the stored thread,
 * and later turns replay that history as plain text. Keep only the text parts there.
 */
export function textOnlyToolResult(event: BaseEvent): BaseEvent {
  if (event.type !== EventType.TOOL_CALL_RESULT) return event;
  const content = (event as { content?: unknown }).content;
  if (typeof content !== 'string' || !content.startsWith('[')) return event;
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch {
    return event;
  }
  if (!isContentPartArray(parts)) return event;
  const text = parts.flatMap((part) => (part.type === 'text' ? [part.content] : []));
  return { ...event, content: text.join('\n') } as BaseEvent;
}

/**
 * maxIterations ends the loop after the last allowed tool step without a final model reply.
 * When a run ends that way, add a short assistant message so it does not stop silently.
 */
export function reportStepLimit(
  events: Observable<BaseEvent>,
  maxSteps: number,
  note: string,
  onLimit?: () => void,
) {
  let steps = 0;
  let phase: 'text' | 'calling' | 'results' = 'text';
  return events.pipe(
    mergeMap((event): BaseEvent[] => {
      if (event.type === EventType.TOOL_CALL_START) {
        // Parallel calls of one model step arrive together; results end the step.
        if (phase !== 'calling') steps++;
        phase = 'calling';
      } else if (event.type === EventType.TOOL_CALL_RESULT) phase = 'results';
      else if (event.type === EventType.TEXT_MESSAGE_CHUNK) phase = 'text';
      else if (event.type === EventType.RUN_FINISHED && phase === 'results' && steps >= maxSteps) {
        onLimit?.();
        return [
          {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: randomUUID(),
            role: 'assistant',
            delta: note,
          } as BaseEvent,
          event,
        ];
      }
      return [event];
    }),
  );
}

// M10: upstream marked this workaround for removal once the converter starts a new message ID
// per step. @copilotkit/runtime 1.75.0's convertTanStackStream still creates ONE messageId per
// stream (dist/agent/converters/tanstack.mjs), so the workaround is still needed; the vendor
// tests assert both facts so the next runtime upgrade surfaces this loudly.
// Text after a tool call gets a new message ID, so each step's text is a separate message.
export function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}

/**
 * M13: observes every `chatStream` call of an adapter without changing it. The Proxy forwards everything else
 * (bound to the real adapter so private fields keep working).
 */
function tapAdapter(adapter: AnyTextAdapter, onCall: (call: ModelCallRecord) => void): AnyTextAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'chatStream')
        return (options: Parameters<AnyTextAdapter['chatStream']>[0]) =>
          tapStream(target.chatStream(options), onCall);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function* tapStream<T>(
  stream: AsyncIterable<T>,
  onCall: (call: ModelCallRecord) => void,
): AsyncGenerator<T> {
  let usage: unknown;
  let completed = false;
  try {
    for await (const chunk of stream) {
      const record = chunk as { type?: string; usage?: unknown };
      if (record.type === 'RUN_FINISHED') {
        completed = true;
        if (record.usage !== undefined) usage = record.usage;
      }
      yield chunk;
    }
  } finally {
    onCall({ usage, completed });
  }
}
