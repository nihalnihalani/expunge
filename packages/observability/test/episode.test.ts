import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chat, toolDefinition, type SchemaInput } from '@tanstack/ai';
import { defineTool, type ToolDefinition } from '@expunge/vendor-openmuse';
import { z } from 'zod';
import { FakeChatModel, fakeText, fakeToolCalls } from '../../runtime/src/testing/index.js';
import {
  CARRIER_HEADERS,
  DEFAULT_SANITIZATION,
  Episode,
  carrierIsComplete,
  closeTracing,
  createDiagnosticsTool,
  currentTracing,
  dispatchSubagent,
  initTracing,
  pickCarrierHeaders,
  runAsSubagent,
  type EpisodeContext,
  type RaindropTracing,
} from '../src/index.js';
import { FakeRaindrop, type DecodedSpan } from './fake-raindrop.js';

const fake = new FakeRaindrop();
let tracing: RaindropTracing;
const HASH = 'a'.repeat(64);
let counter = 0;

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
  workerProfileHash: 'b'.repeat(64),
  worldId: 'world-1',
  completionPolicy: 'verified_receipt',
  telemetryUserId: 'tok_synthetic_1',
  input: 'cleanup job',
  ...over,
});

async function waitUntil(predicate: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForSpans(predicate: (spans: DecodedSpan[]) => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate(fake.spans)) {
    if (Date.now() > deadline)
      throw new Error(`spans never matched; saw: ${fake.spans.map((s) => s.name).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Drive the REAL TanStack chat loop with the labeled fake model and the episode's tools and middleware. */
async function runChat(episode: Episode, tools: ToolDefinition[], fakeModel: FakeChatModel) {
  await episode.run(async () => {
    const stream = chat({
      adapter: fakeModel.adapter,
      messages: [{ role: 'user', content: 'go' }],
      tools: episode.instrumentTools(tools).map((tool) =>
        toolDefinition({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters as SchemaInput,
        }).server((args) => (tool.execute as (a: unknown) => Promise<unknown>)(args)),
      ),
      middleware: [episode.chatMiddleware()],
    });
    for await (const chunk of stream) void chunk;
  });
}

const inspectTool = (over: Partial<{ execute: () => Promise<unknown> }> = {}) =>
  defineTool({
    name: 'inspect_scope',
    description: 'inspect',
    parameters: z.object({ collectionId: z.string(), subject: z.string() }),
    execute: over.execute ?? (async () => ({ status: 'ok', note: 'Jane Doe lives at 1 Main St' })),
  });

describe('worker episode instrumentation (real SDK, real TanStack loop, labeled fake server and model)', () => {
  it('produces real GenAI model spans per provider call, with usage and run correlation', async () => {
    const episode = Episode.begin(tracing, context());
    const model = new FakeChatModel([
      {
        ...fakeToolCalls([{ name: 'inspect_scope', args: { collectionId: 'customers', subject: 'x' } }]),
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      },
      { ...fakeText('done'), usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 } },
    ]);
    await runChat(episode, [inspectTool()], model);
    await waitForSpans(
      (spans) => spans.filter((s) => s.name.startsWith('chat fake-deterministic-1 #')).length === 2,
    );
    const modelSpans = fake.spans.filter((s) => s.name.startsWith('chat fake-deterministic-1 #'));
    expect(modelSpans.map((s) => s.attributes['tanstack.ai.iteration'])).toEqual([0, 1]);
    for (const span of modelSpans) {
      expect(span.attributes['gen_ai.operation.name']).toBe('chat');
      expect(span.attributes['gen_ai.request.model']).toBe('fake-deterministic-1');
      expect(span.attributes['gen_ai.system']).toBe('FAKE_DETERMINISTIC_TEST_PROVIDER');
      expect(span.attributes['traceloop.association.properties.event_id']).toBe(episode.eventId);
      expect(span.attributes['traceloop.association.properties.run_id']).toBe(episode.context.runId);
      expect(span.attributes['traceloop.association.properties.harness_hash']).toBe(HASH);
      expect(span.attributes['expunge.harness_hash']).toBe(HASH);
      expect(span.attributes['raindrop.project_id']).toBe('proj-1');
    }
    expect(modelSpans[0]!.attributes['gen_ai.usage.input_tokens']).toBe(7);
    expect(modelSpans[1]!.attributes['gen_ai.usage.output_tokens']).toBe(2);
  });

  it('records tool spans with SANITIZED input and output; no raw value reaches any span, event or request', async () => {
    const episode = Episode.begin(tracing, context(), {
      policy: { ...DEFAULT_SANITIZATION, forbiddenLiterals: ['jane doe'] },
    });
    const model = new FakeChatModel([
      fakeToolCalls([{ name: 'inspect_scope', args: { collectionId: 'customers', subject: 'Jane Doe' } }]),
      fakeText('done'),
    ]);
    await runChat(episode, [inspectTool()], model);
    await episode.complete({ status: 'failed', endedBy: 'finished', toolCalls: 1, phases: 1, elapsedMs: 4 });
    await waitForSpans((spans) => spans.some((s) => s.name === 'inspect_scope'));
    const toolSpan = fake.spans.find((s) => s.name === 'inspect_scope')!;
    const input = JSON.parse(String(toolSpan.attributes['traceloop.entity.input']));
    expect(input.collectionId).toBe('customers');
    expect(input.subject).toMatchObject({ redacted: true });
    const output = JSON.parse(String(toolSpan.attributes['traceloop.entity.output']));
    expect(output.status).toBe('ok');
    expect(output.note).toMatchObject({ redacted: true });
    const everything = JSON.stringify([fake.spans, fake.partialEvents, fake.signalPosts, fake.ingestEvents]);
    expect(everything).not.toContain('Jane Doe');
    expect(everything).not.toContain('Main St');
  });

  it('marks a failing tool span as an error and rethrows the original error to the runtime', async () => {
    const episode = Episode.begin(tracing, context());
    const failing = inspectTool({
      execute: async () => {
        throw Object.assign(new Error('boom for Jane Doe'), { code: 'E_TOOL' });
      },
    });
    const model = new FakeChatModel([
      fakeToolCalls([{ name: 'inspect_scope', args: { collectionId: 'customers', subject: 'x' } }]),
      fakeText('done'),
    ]);
    await runChat(episode, [failing], model);
    await waitForSpans((spans) => spans.some((s) => s.name === 'inspect_scope'));
    const toolSpan = fake.spans.find((s) => s.name === 'inspect_scope')!;
    expect(toolSpan.status).toBe(2);
    expect(JSON.stringify(fake.spans)).not.toContain('Jane Doe');
    const direct = episode.instrumentTools([failing])[0]!;
    await expect(direct.execute!({ collectionId: 'c', subject: 's' } as never)).rejects.toThrow(
      'boom for Jane Doe',
    );
  });

  it('finishes the interaction from committed facts only, stamped with identities as properties and a feature flag', async () => {
    const ctx = context({ evidenceArm: 'trace_and_score' });
    const episode = Episode.begin(tracing, ctx);
    await episode.complete({
      status: 'succeeded',
      endedBy: 'finished',
      receiptId: 'rcpt-9',
      toolCalls: 3,
      phases: 3,
      elapsedMs: 12,
      inputTokens: 40,
      outputTokens: 9,
      unpricedCalls: 2,
    });
    await episode.complete({ status: 'failed', endedBy: 'x', toolCalls: 0, phases: 0, elapsedMs: 0 }); // idempotent: second call is a no-op
    const partial = fake.partialEvents.find((e) => e.event_id === episode.eventId) as any;
    expect(partial.event).toBe('expunge.worker');
    expect(partial.user_id).toBe('tok_synthetic_1');
    expect(partial.properties).toMatchObject({
      run_id: ctx.runId,
      job_id: ctx.jobId,
      harness_hash: HASH,
      worker_profile_hash: 'b'.repeat(64),
      world_id: 'world-1',
      attempt: '1',
      outcome: 'succeeded',
      evidence_arm: 'trace_and_score',
    });
    expect(partial.feature_flags).toMatchObject({ harness_version: HASH, evidence_arm: 'trace_and_score' });
    const summary = JSON.parse(partial.ai_data.output);
    expect(summary).toMatchObject({
      status: 'succeeded',
      receiptId: 'rcpt-9',
      toolCalls: 3,
      unpricedCalls: 2,
    });
    expect(Object.keys(summary)).not.toContain('narrative');
    expect(
      fake.partialEvents.filter((e) => e.event_id === episode.eventId && (e as any).is_pending === false),
    ).toHaveLength(1);
  });

  it('dispatches Self Diagnostics through a REAL TanStack server tool into diagnostics.execute, labeled agent_self_report', async () => {
    const episode = Episode.begin(tracing, context(), {
      policy: { ...DEFAULT_SANITIZATION, forbiddenLiterals: ['jane doe'] },
    });
    const diagnostics = createDiagnosticsTool(episode);
    expect(diagnostics.name).toBe('report_diagnostic');
    const model = new FakeChatModel([
      fakeToolCalls([
        {
          name: 'report_diagnostic',
          args: { category: 'missing_context', detail: 'the archive for Jane Doe is not in my registry' },
        },
      ]),
      fakeText('noted'),
    ]);
    await runChat(episode, [diagnostics], model);
    await waitUntil(() => fake.signalPosts.length === 1);
    expect(fake.signalPosts).toHaveLength(1);
    const signal = fake.signalPosts[0] as any;
    expect(signal).toMatchObject({ event_id: episode.eventId, signal_type: 'agent', sentiment: 'NEGATIVE' });
    expect(signal.properties).toMatchObject({
      origin: 'agent_self_report',
      category: 'missing_context',
      run_id: episode.context.runId,
      source: 'expunge_worker',
    });
    expect(signal.properties.detail).toMatch(/^\[redacted:[a-f0-9]{16}\]$/);
    expect(JSON.stringify(signal)).not.toContain('Jane Doe');
  });

  it('rejects an invalid diagnostic category before it reaches the SDK', async () => {
    const episode = Episode.begin(tracing, context());
    const diagnostics = createDiagnosticsTool(episode);
    const result = await diagnostics.parameters['~standard'].validate({
      category: 'not_a_category',
      detail: 'x',
    });
    expect('issues' in result && result.issues).toBeTruthy();
    expect(fake.signalPosts).toHaveLength(0);
  });
});

describe('detached sub-agent carriers', () => {
  it('forwards all three carrier headers from a real dispatch and links the child run to its parent', async () => {
    const parent = Episode.begin(tracing, context({ role: 'observer' }));
    const dispatched = await parent.run(async () =>
      dispatchSubagent(parent, {
        name: 'improver',
        childEventId: 'child-job-1',
        input: { job: 'child-job-1' },
      }),
    );
    expect(dispatched.linked).toBe(true);
    expect(dispatched.childEventId).toBe('child-job-1');
    expect(Object.keys(dispatched.headers).sort()).toEqual([...CARRIER_HEADERS].sort());
    // Through authenticated internal dispatch the headers arrive on a request; only those three are picked.
    const received = pickCarrierHeaders({ ...dispatched.headers, Authorization: 'Bearer x', 'X-Other': 'y' });
    expect(carrierIsComplete(received)).toBe(true);
    const outcome = await runAsSubagent(
      tracing,
      received,
      { name: 'improver', eventId: 'child-job-1', userId: 'tok_child' },
      async (run) => ({ linked: run.linked, eventId: run.eventId, parent: run.parent !== null }),
    );
    expect(outcome).toEqual({ linked: true, eventId: 'child-job-1', parent: true });
  });

  it('runs unlinked, without inventing a link, when no carrier arrived', async () => {
    const outcome = await runAsSubagent(
      tracing,
      null,
      { name: 'improver', eventId: 'orphan-1', userId: 'tok_child' },
      async (run) => ({ linked: run.linked, parent: run.parent }),
    );
    expect(outcome).toEqual({ linked: false, parent: null });
  });

  it('picks headers case-insensitively, ignores everything else, and reports partial carriers', () => {
    expect(
      pickCarrierHeaders({ TraceParent: '00-abc-def-01', Baggage: 'a=b', Authorization: 'secret' }),
    ).toEqual({ traceparent: '00-abc-def-01', baggage: 'a=b' });
    expect(carrierIsComplete(pickCarrierHeaders({ traceparent: 't', baggage: 'b' }))).toBe(false);
    expect(pickCarrierHeaders({ authorization: 'x' })).toBeNull();
    expect(pickCarrierHeaders({ 'x-raindrop-handoff': ['first', 'second'] })).toEqual({
      'x-raindrop-handoff': 'first',
    });
  });
});

describe('one tracing initialization per process', () => {
  it('returns the same instance for the same configuration and refuses a different one', () => {
    const again = initTracing({
      writeKey: fake.keys().writeKey,
      projectId: 'proj-1',
      endpoint: fake.ingestUrl,
    });
    expect(again).toBe(tracing);
    expect(currentTracing()).toBe(tracing);
    expect(() =>
      initTracing({ writeKey: fake.keys().writeKey, projectId: 'other-project', endpoint: fake.ingestUrl }),
    ).toThrow('TracingAlreadyInitialized');
    expect(JSON.stringify(tracing.config)).not.toContain('test-write-key');
  });
});
