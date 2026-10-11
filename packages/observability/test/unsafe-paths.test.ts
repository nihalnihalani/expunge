import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeChatModel, fakeText, fakeToolCalls } from '../../runtime/src/testing/index.js';
import { chat, toolDefinition, type SchemaInput } from '@tanstack/ai';
import {
  DEFAULT_SANITIZATION,
  Episode,
  InvalidTelemetryUserId,
  TelemetryIntentConflict,
  agentDiagnosticIntent,
  closeTracing,
  createDiagnosticsTool,
  dispatchSubagent,
  enqueueTelemetry,
  episodeEventId,
  initTracing,
  operationIdFor,
  runAsSubagent,
  telemetryPayloadSchema,
  type EpisodeContext,
  type RaindropTracing,
} from '../src/index.js';
import { FakeRaindrop } from './fake-raindrop.js';

const fake = new FakeRaindrop();
let tracing: RaindropTracing;
const HASH = 'a'.repeat(64);
let counter = 0;
const LITERAL = 'jane doe';
const policy = { ...DEFAULT_SANITIZATION, forbiddenLiterals: [LITERAL] };

beforeAll(async () => {
  await fake.start();
  tracing = initTracing(
    { writeKey: fake.keys().writeKey, projectId: 'proj-1', endpoint: fake.ingestUrl },
    { disableBatching: true, bufferSize: 1 },
  );
});
afterAll(async () => {
  await closeTracing();
  await fake.stop();
});
beforeEach(() => fake.reset());

const context = (over: Partial<EpisodeContext> = {}): EpisodeContext => ({
  role: 'worker',
  jobId: `job-${++counter}`,
  runId: `run-${counter}`,
  attempt: 1,
  harnessHash: HASH,
  telemetryUserId: 'tok_00000000000000a1',
  input: 'cleanup job',
  ...over,
});
const everythingSent = () =>
  JSON.stringify([fake.spans, fake.partialEvents, fake.signalPosts, fake.ingestEvents, fake.requests]);

class FakeOutbox {
  readonly rows = new Map<string, any>();
  readonly outbox = {
    enqueue: async (_scope: unknown, input: any) => {
      if (this.rows.has(input.operationId)) throw Object.assign(new Error('dup'), { code: 11000 });
      this.rows.set(input.operationId, input);
      return input;
    },
  };
}
const SCOPE = { tenantId: 't', env: 'evaluation' as const, scopeId: 's' };

describe('O6: nothing reaches the SDK or HTTP unsanitized, by code and not by comment', () => {
  it('O6: an episode input is a label or it is redacted; a forbidden literal in it is never sent', async () => {
    const withLiteral = Episode.begin(tracing, context({ input: 'inspect the archive of Jane Doe' }), {
      policy,
    });
    await withLiteral.complete({ status: 'failed', endedBy: 'x', toolCalls: 0, phases: 0, elapsedMs: 1 });
    expect(everythingSent()).not.toMatch(/jane doe/i);
    const input = (fake.partialEvents.find((e) => e.event_id === withLiteral.eventId) as any).ai_data.input;
    expect(input).toMatch(/^\[redacted:[a-f0-9]{16}\]$/);
    fake.reset();
    const unknownText = Episode.begin(tracing, context({ input: 'a perfectly harmless sentence' }));
    await unknownText.complete({ status: 'failed', endedBy: 'x', toolCalls: 0, phases: 0, elapsedMs: 1 });
    expect((fake.partialEvents.find((e) => e.event_id === unknownText.eventId) as any).ai_data.input).toMatch(
      /^\[redacted:/,
    );
    fake.reset();
    const label = Episode.begin(tracing, context({ input: 'cleanup job' }));
    await label.complete({ status: 'failed', endedBy: 'x', toolCalls: 0, phases: 0, elapsedMs: 1 });
    expect((fake.partialEvents.find((e) => e.event_id === label.eventId) as any).ai_data.input).toBe(
      'cleanup job',
    );
  });

  it('O6: a telemetry user id that is not an opaque namespaced digest is refused before any SDK call', () => {
    for (const bad of [
      'maria_rossi',
      'Jane Doe',
      'tok_short',
      'TOK_00000000000000a1',
      'u_' + 'g'.repeat(32),
      '',
    ]) {
      expect(() => Episode.begin(tracing, context({ telemetryUserId: bad }))).toThrowError(
        InvalidTelemetryUserId,
      );
    }
    expect(fake.partialEvents).toHaveLength(0);
    expect(() =>
      runAsSubagent(
        tracing,
        null,
        { name: 'w', eventId: 'e1', userId: 'jane.doe@example.com' },
        async () => 1,
      ),
    ).toThrowError(InvalidTelemetryUserId);
  });

  it('O6: dispatchSubagent reduces its input by the episode policy before the SDK sees it', async () => {
    const parent = Episode.begin(tracing, context({ role: 'observer' }), { policy });
    await parent.run(async () =>
      dispatchSubagent(parent, {
        name: 'improver',
        childEventId: 'child-1',
        input: { subject: 'Jane Doe', note: 'archive of Jane Doe', job: 'child-1' },
      }),
    );
    await parent.complete({
      status: 'succeeded',
      endedBy: 'finished',
      toolCalls: 0,
      phases: 0,
      elapsedMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(everythingSent()).not.toMatch(/jane doe/i);
  });

  it('O6: an `event` intent has its input and output reduced by the policy before it is stored', async () => {
    const store = new FakeOutbox();
    const intent = {
      kind: 'event' as const,
      jobId: 'job-1',
      discriminator: 'e1',
      evidenceRequired: ['assistant_output'],
      payload: {
        type: 'event' as const,
        eventId: 'evt-1',
        event: 'expunge.note',
        userId: 'tok_00000000000000a1',
        origin: 'admission_service' as const,
        output: 'accepted the candidate for Jane Doe',
        input: 'Jane Doe archive',
        properties: {},
      },
    };
    await enqueueTelemetry(store.outbox as never, SCOPE, intent, undefined, policy);
    const stored = [...store.rows.values()][0].payload;
    expect(stored.output).toMatch(/^\[redacted:/);
    expect(stored.input).toMatch(/^\[redacted:/);
    expect(JSON.stringify(stored)).not.toMatch(/jane doe/i);
  });
});

describe('O7: diagnostics are model narrative', () => {
  const diagnosticsRun = async (episode: Episode, detail: string) => {
    const model = new FakeChatModel([
      fakeToolCalls([{ name: 'report_diagnostic', args: { category: 'missing_context', detail } }]),
      fakeText('noted'),
    ]);
    const tool = createDiagnosticsTool(episode);
    await episode.run(async () => {
      const stream = chat({
        adapter: model.adapter,
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          toolDefinition({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters as SchemaInput,
          }).server((args) => (tool.execute as (a: unknown) => Promise<unknown>)(args)),
        ],
      });
      for await (const chunk of stream) void chunk;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  };

  it('O7: with no literal list (the worker cannot know subject literals) the detail never leaves readable', async () => {
    const episode = Episode.begin(tracing, context());
    await diagnosticsRun(episode, 'the archive for Jane Doe is not in my registry');
    expect(fake.signalPosts.length).toBeGreaterThan(0);
    expect(everythingSent()).not.toMatch(/jane doe/i);
    expect(everythingSent()).not.toContain('not in my registry');
    expect((fake.signalPosts[0] as any).properties.detail).toMatch(/^\[redacted:[a-f0-9]{16}\]$/);
  });

  it('O7: with a literal list, text that carries none of them stays readable and text that does is redacted', async () => {
    const episode = Episode.begin(tracing, context(), { policy });
    await diagnosticsRun(episode, 'registry has no archive collection');
    expect((fake.signalPosts[0] as any).properties.detail).toBe('registry has no archive collection');
    fake.reset();
    const second = Episode.begin(tracing, context(), { policy });
    await diagnosticsRun(second, 'J a n e  D o e is missing');
    expect(everythingSent()).not.toMatch(/j a n e/i);
  });
});

describe('agent_diagnostic outbox variant (report_diagnostic from the gateway)', () => {
  const guard = { forbiddenLiterals: [LITERAL] };
  const input = (detail: string) => ({
    jobId: 'job-9',
    runId: 'run-9',
    attempt: 2,
    toolCallId: 'call-7',
    severity: 'warning' as const,
    codes: ['missing_context', 'archive_unknown'],
    detail,
    guard,
  });

  it('carries structure and a hash of the text, never the text; its event id is the worker episode id', () => {
    const intent = agentDiagnosticIntent(input('the archive of someone is not registered'));
    const payload = telemetryPayloadSchema.parse(intent.payload);
    expect(payload).toMatchObject({
      type: 'agent_diagnostic',
      jobId: 'job-9',
      runId: 'run-9',
      toolCallId: 'call-7',
      severity: 'warning',
      codes: ['missing_context', 'archive_unknown'],
      detailLength: 'the archive of someone is not registered'.length,
    });
    expect((payload as any).detailSha256).toBe(
      createHash('sha256').update('the archive of someone is not registered').digest('hex'),
    );
    expect(JSON.stringify(payload)).not.toContain('archive of someone');
    expect((payload as any).eventId).toBe(
      episodeEventId({ role: 'worker', jobId: 'job-9', runId: 'run-9', attempt: 2 }),
    );
    expect((payload as any).detailFlagged).toBeUndefined();
    expect(intent).toMatchObject({
      kind: 'agent_diagnostic',
      discriminator: 'diagnostic:call-7',
      evidenceRequired: ['signals'],
    });
  });

  it('flags text that trips the guard (subject literal, encoded literal, private id) without storing it', () => {
    expect((agentDiagnosticIntent(input('about Jane Doe')).payload as any).detailFlagged).toBe(
      'subject_literal',
    );
    expect(
      (agentDiagnosticIntent(input(`blob ${Buffer.from('Jane Doe').toString('base64')}`)).payload as any)
        .detailFlagged,
    ).toBe('subject_literal');
    expect(JSON.stringify(agentDiagnosticIntent(input('about Jane Doe')).payload)).not.toMatch(/jane doe/i);
  });

  it('rejects unknown fields, free-text codes and oversize values (strict schema)', () => {
    const good = agentDiagnosticIntent(input('x')).payload;
    expect(telemetryPayloadSchema.safeParse({ ...good, detail: 'free text' }).success).toBe(false);
    expect(telemetryPayloadSchema.safeParse({ ...good, codes: ['Jane Doe'] }).success).toBe(false);
    expect(telemetryPayloadSchema.safeParse({ ...good, codes: [] }).success).toBe(false);
    expect(telemetryPayloadSchema.safeParse({ ...good, severity: 'fatal' }).success).toBe(false);
    expect(telemetryPayloadSchema.safeParse({ ...good, detailSha256: 'short' }).success).toBe(false);
  });

  it('enqueues idempotently outside a transaction and reserves a stable operation id', async () => {
    const store = new FakeOutbox();
    const intent = agentDiagnosticIntent(input('x'));
    expect(await enqueueTelemetry(store.outbox as never, SCOPE, intent)).toMatchObject({ inserted: true });
    expect(await enqueueTelemetry(store.outbox as never, SCOPE, intent)).toMatchObject({ inserted: false });
    expect([...store.rows.keys()]).toEqual([operationIdFor(intent)]);
    expect(store.rows.get(operationIdFor(intent))).toMatchObject({
      kind: 'agent_diagnostic',
      jobId: 'job-9',
    });
  });

  it('inside a transaction a duplicate throws TelemetryIntentConflict so the whole outcome rolls back', async () => {
    const store = new FakeOutbox();
    const intent = agentDiagnosticIntent(input('x'));
    await enqueueTelemetry(store.outbox as never, SCOPE, intent);
    await expect(enqueueTelemetry(store.outbox as never, SCOPE, intent, {} as never)).rejects.toThrowError(
      TelemetryIntentConflict,
    );
  });
});
