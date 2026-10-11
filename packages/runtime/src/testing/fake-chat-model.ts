/**
 * FAKE, DETERMINISTIC TEST PROVIDER. NOT A MODEL. NEVER A SUBSTITUTE FOR LIVE EVIDENCE.
 *
 * `FakeChatModel` is a TanStack AI text adapter (`kind: 'text'`) whose `chatStream` replays a
 * script instead of calling a provider. It lets protocol tests drive the REAL pieces above it
 * (TanStack `chat()` agent loop, tool execution, CopilotKit's BuiltInAgent factory runner and
 * `convertTanStackStream`, the vendored OpenMuse helpers, ExpungeExecutionAgent) without a
 * provider key. The chunk shape follows what the real OpenAI adapters in
 * @tanstack/openai-base 0.12.1 yield (RUN_STARTED, TEXT_MESSAGE_START/CONTENT/END,
 * TOOL_CALL_START/ARGS/END with parsed `input`, RUN_FINISHED with `finishReason`).
 *
 * It is exported for tests only: no production entrypoint imports it (a test enforces that).
 * Anything that passes only because of this fake is protocol evidence, not provider evidence.
 */
import { normalizeSystemPrompts, type AnyTextAdapter, type TextOptions } from '@tanstack/ai';
import type { AdapterYieldChunk } from '@tanstack/ai';

export const FAKE_PROVIDER_NAME = 'FAKE_DETERMINISTIC_TEST_PROVIDER';

export type FakePart =
  | { kind: 'text'; text: string; pieces?: number }
  | { kind: 'tool_call'; name: string; args: unknown; id?: string }
  /** Stream starts, then blocks until the request's AbortSignal fires. */
  | { kind: 'hang' }
  /** The provider stream fails mid-flight (surfaces as RUN_ERROR through the real converter). */
  | { kind: 'error'; message: string };

export type FakeTurn = {
  parts: FakePart[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
};

/** What one `chatStream` call received. Lets tests prove what the model was and was not given. */
export type FakeModelCall = {
  turn: number;
  model: string;
  messageCount: number;
  systemPrompts: string[];
  toolNames: string[];
  signal: AbortSignal | undefined;
};

export const fakeText = (text: string, pieces = 2): FakeTurn => ({
  parts: [{ kind: 'text', text, pieces }],
});
export const fakeToolCalls = (
  calls: Array<{ name: string; args: unknown; id?: string }>,
  text?: string,
): FakeTurn => ({
  parts: [
    ...(text ? [{ kind: 'text' as const, text }] : []),
    ...calls.map((call) => ({ kind: 'tool_call' as const, ...call })),
  ],
});
export const fakeHang = (): FakeTurn => ({ parts: [{ kind: 'hang' }] });

const asChunk = (chunk: Record<string, unknown>) => chunk as unknown as AdapterYieldChunk;

export class FakeChatModel {
  readonly kind = 'text' as const;
  readonly name = FAKE_PROVIDER_NAME;
  readonly model: string;
  readonly supportsFileSources = false;
  readonly '~types' = {} as AnyTextAdapter['~types'];
  /** Every call received, in order. */
  readonly calls: FakeModelCall[] = [];
  /** Set when a `hang` turn observed the request's AbortSignal firing. */
  hangObservedAbort = false;
  /** Set when a stream was abandoned by its consumer (generator return). */
  streamsClosedEarly = 0;
  private turn = 0;

  constructor(
    private readonly script: readonly FakeTurn[],
    model = 'fake-deterministic-1',
  ) {
    this.model = model;
  }

  /** The adapter value to hand to chat()/tanstackAgent({ textAdapter }). */
  get adapter(): AnyTextAdapter {
    return this as unknown as AnyTextAdapter;
  }

  get turnsConsumed(): number {
    return this.turn;
  }

  async *chatStream(options: TextOptions): AsyncIterable<AdapterYieldChunk> {
    const index = this.turn++;
    const signal = (options.request as RequestInit | undefined)?.signal ?? undefined;
    this.calls.push({
      turn: index,
      model: options.model,
      messageCount: options.messages.length,
      systemPrompts: normalizeSystemPrompts(options.systemPrompts).map((prompt) => prompt.content),
      toolNames: (options.tools ?? []).map((tool) => tool.name),
      signal,
    });
    const turn = this.script[index];
    const runId = options.runId ?? 'fake-run';
    const threadId = options.threadId ?? 'fake-thread';
    const model = options.model;
    const messageId = `fake_msg_${index}`;
    const common = () => ({ model, timestamp: Date.now() });
    yield asChunk({ type: 'RUN_STARTED', runId, threadId, ...common() });
    if (!turn) {
      yield asChunk({
        type: 'RUN_ERROR',
        message: `FakeModelScriptExhausted:turn=${index}`,
        ...common(),
      });
      return;
    }
    let textOpen = false;
    let toolCalls = 0;
    let accumulated = '';
    let finished = false;
    try {
      for (const part of turn.parts) {
        if (part.kind === 'text') {
          if (!textOpen) {
            textOpen = true;
            yield asChunk({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant', ...common() });
          }
          const pieces = Math.max(1, Math.min(part.pieces ?? 1, part.text.length || 1));
          const size = Math.ceil(part.text.length / pieces);
          for (let at = 0; at < part.text.length; at += size) {
            const delta = part.text.slice(at, at + size);
            accumulated += delta;
            yield asChunk({
              type: 'TEXT_MESSAGE_CONTENT',
              messageId,
              delta,
              content: accumulated,
              ...common(),
            });
          }
        } else if (part.kind === 'tool_call') {
          const toolCallId = part.id ?? `fake_call_${index}_${toolCalls}`;
          const argsJson = JSON.stringify(part.args ?? {});
          yield asChunk({
            type: 'TOOL_CALL_START',
            toolCallId,
            toolCallName: part.name,
            toolName: part.name,
            parentMessageId: messageId,
            index: toolCalls,
            ...common(),
          });
          yield asChunk({ type: 'TOOL_CALL_ARGS', toolCallId, delta: argsJson, ...common() });
          yield asChunk({
            type: 'TOOL_CALL_END',
            toolCallId,
            toolCallName: part.name,
            toolName: part.name,
            input: part.args ?? {},
            ...common(),
          });
          toolCalls++;
        } else if (part.kind === 'hang') {
          if (signal?.aborted) {
            this.hangObservedAbort = true;
            return;
          }
          await new Promise<void>((resolve) => {
            if (!signal) return; // no signal: never resolves, by design (a caller bug the test shows)
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          this.hangObservedAbort = true;
          return;
        } else {
          yield asChunk({ type: 'RUN_ERROR', message: part.message, ...common() });
          return;
        }
      }
      if (textOpen) yield asChunk({ type: 'TEXT_MESSAGE_END', messageId, ...common() });
      finished = true;
      yield asChunk({
        type: 'RUN_FINISHED',
        runId,
        threadId,
        finishReason: toolCalls > 0 ? 'tool_calls' : 'stop',
        ...(turn.usage ? { usage: turn.usage } : {}),
        ...common(),
      });
    } finally {
      if (!finished) this.streamsClosedEarly++;
    }
  }

  structuredOutput(): Promise<never> {
    return Promise.reject(new Error('FakeChatModel does not implement structured output'));
  }
}
