import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  IngestClient,
  admissionSignalIntent,
  operationIdFor,
  sdkEpisodeIntent,
  verifierSignalIntent,
  type TelemetryIntent,
} from '@expunge/observability';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import { InMemoryEvidenceStore, OutboxDispatcher, RaindropQueryClient } from '../src/index.js';
import { Clock, InMemoryOutbox, SCOPE } from './helpers.js';

const fake = new FakeRaindrop();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

function rig(over: { writeKey?: string; maxAttempts?: number; holdTimeoutMs?: number } = {}) {
  const clock = new Clock();
  const outbox = new InMemoryOutbox(clock);
  const evidence = new InMemoryEvidenceStore();
  const dispatcher = new OutboxDispatcher(
    {
      outbox,
      ingest: new IngestClient({
        writeKey: over.writeKey ?? fake.keys().writeKey,
        projectId: 'proj-1',
        baseUrl: fake.ingestUrl,
        timeoutMs: 2000,
      }),
      query: new RaindropQueryClient({
        queryKey: fake.keys().queryKey,
        projectId: 'proj-1',
        baseUrl: fake.queryUrl,
        maxAttempts: 1,
        sleep: async () => undefined,
      }),
      evidence,
      transaction: (work) => work(undefined as never),
      scope: SCOPE,
      projectId: 'proj-1',
    },
    {
      ownerId: 'dispatcher-1',
      now: clock.now,
      random: () => 0.5,
      maxAttempts: over.maxAttempts ?? 5,
      holdTimeoutMs: over.holdTimeoutMs ?? 10 * 60_000,
      baseDelayMs: 1000,
    },
  );
  const enqueue = (intent: TelemetryIntent) =>
    outbox.add({
      operationId: operationIdFor(intent),
      kind: intent.kind,
      jobId: intent.jobId,
      payload: intent.payload as never,
      evidenceRequired: intent.evidenceRequired,
    });
  return { clock, outbox, evidence, dispatcher, enqueue };
}

const verifier = (eventId = 'evt-run-1') =>
  verifierSignalIntent({
    jobId: 'job-1',
    eventId,
    passed: false,
    evaluationId: 'eval-1',
    harnessHash: 'h'.repeat(64),
  });

describe('outbox dispatch: separate, honest delivery states', () => {
  it('walks a signal intent through sdk_enqueued, ingest_accepted, query_visible and evidence_ready with a proof for each', async () => {
    fake.seedEvent({ id: 'evt-run-1', assistant_output: '{"status":"failed"}' });
    const { dispatcher, enqueue, outbox, evidence } = rig();
    const intent = verifier();
    enqueue(intent);
    const outcome = await dispatcher.runOnce();
    expect(outcome).toMatchObject({
      result: 'evidence_ready',
      attained: ['sdk_enqueued', 'ingest_accepted', 'query_visible', 'evidence_ready'],
    });
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.status).toBe('evidence_ready');
    expect(row.attained.ingest_accepted?.externalReceiptId).toBe('http-204');
    expect(row.attained.query_visible?.externalReceiptId).toBe('evt-run-1');
    expect(new Set(Object.values(row.attained).map((a) => a.contentHash)).size).toBeGreaterThanOrEqual(2); // not one hash stamped on every state
    // The signal was sent with an explicit application ORIGIN, as a feedback signal with sentiment.
    expect(fake.signalPosts[0]).toMatchObject({
      event_id: 'evt-run-1',
      signal_name: 'cleanup_not_verified',
      signal_type: 'feedback',
      sentiment: 'NEGATIVE',
    });
    expect((fake.signalPosts[0] as any).properties.origin).toBe('verifier_feedback');
    expect(evidence.rows.size).toBe(1);
    expect(await dispatcher.runOnce()).toBeNull(); // terminal rows are not claimed again
  });

  it('an enqueued intent alone proves nothing: with no row due there is no state, and a due row starts at pending', async () => {
    const { dispatcher, enqueue, outbox } = rig();
    expect(await dispatcher.runOnce()).toBeNull();
    const intent = verifier();
    enqueue(intent);
    expect(outbox.rows.get(operationIdFor(intent))).toMatchObject({
      status: 'pending',
      attained: {},
      attempts: 0,
    });
  });

  it('a transient ingest failure keeps the earlier proof only, retries with backoff, and succeeds later', async () => {
    fake.seedEvent({ id: 'evt-run-1' });
    const { dispatcher, enqueue, outbox, clock } = rig();
    const intent = verifier();
    enqueue(intent);
    fake.failNext(/POST \/v1\/signals\/track/, [503]);
    const first = await dispatcher.runOnce();
    expect(first).toMatchObject({ result: 'retrying', detail: 'ingest_server' });
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.attained.sdk_enqueued).toBeDefined();
    expect(row.attained.ingest_accepted).toBeUndefined(); // enqueue is not acceptance
    expect(row.lastErrorCode).toBe('ingest_server_503');
    expect(await dispatcher.runOnce()).toBeNull(); // not due yet
    clock.advance(5_000);
    expect(await dispatcher.runOnce()).toMatchObject({ result: 'evidence_ready' });
    expect(outbox.rows.get(operationIdFor(intent))!.attempts).toBe(2);
  });

  it('honors Retry-After on 429', async () => {
    fake.seedEvent({ id: 'evt-run-1' });
    const { dispatcher, enqueue, outbox, clock } = rig();
    const intent = verifier();
    enqueue(intent);
    fake.failNext(/POST \/v1\/signals\/track/, [429], { 'Retry-After': '120' });
    await dispatcher.runOnce();
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.nextAttemptAt.getTime() - clock.now().getTime()).toBeGreaterThanOrEqual(120_000);
  });

  it('holds a bad write key for an operator (blocked), never dead-letters it, and keeps the evidence pending', async () => {
    fake.seedEvent({ id: 'evt-run-1' });
    const { dispatcher, enqueue, outbox } = rig({ writeKey: 'wrong-key' });
    const intent = verifier();
    enqueue(intent);
    const outcome = await dispatcher.runOnce();
    expect(outcome).toMatchObject({ result: 'blocked', detail: 'blocked_ingest_401' });
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.status).toBe('retrying');
    expect(row.status).not.toBe('dead_letter');
    expect(row.attained.ingest_accepted).toBeUndefined();
  });

  it('dead-letters a poison payload immediately and an unretryable provider rejection', async () => {
    const { dispatcher, outbox } = rig();
    outbox.add({
      operationId: 'poison',
      payload: { type: 'signal', eventId: 'e', signalName: 's', origin: 'raindrop_classifier' } as never,
      evidenceRequired: [],
    });
    expect(await dispatcher.runOnce()).toMatchObject({ result: 'dead_letter', detail: 'InvalidPayload' });
    expect(outbox.rows.get('poison')!.status).toBe('dead_letter');
    fake.seedEvent({ id: 'evt-run-1' });
    const { dispatcher: d2, enqueue } = rig();
    enqueue(verifier());
    fake.failNext(/POST \/v1\/signals\/track/, [400]);
    expect(await d2.runOnce()).toMatchObject({ result: 'dead_letter' });
  });

  it('dead-letters after the attempt bound on persistent failures', async () => {
    fake.seedEvent({ id: 'evt-run-1' });
    const { dispatcher, enqueue, outbox, clock } = rig({ maxAttempts: 3 });
    const intent = verifier();
    enqueue(intent);
    fake.failNext(/POST \/v1\/signals\/track/, [500, 500, 500, 500, 500]);
    for (let i = 0; i < 6; i++) {
      await dispatcher.runOnce();
      clock.advance(120_000);
    }
    expect(outbox.rows.get(operationIdFor(intent))!.status).toBe('dead_letter');
    expect(outbox.rows.get(operationIdFor(intent))!.attempts).toBe(3);
  });
});

describe('read-back of events the worker produced through the SDK', () => {
  const episode = () =>
    sdkEpisodeIntent({ jobId: 'job-1', eventId: 'evt-run-1', role: 'worker', attempt: 1 });

  it('records worker-attested and inferred proofs as such, and only after the event is actually visible', async () => {
    fake.seedEvent({
      id: 'evt-run-1',
      assistant_output: '{"status":"failed"}',
      tool_calls: [{ name: 'inspect_scope' }],
    });
    const { dispatcher, enqueue, outbox } = rig();
    const intent = episode();
    enqueue(intent);
    expect(await dispatcher.runOnce()).toMatchObject({ result: 'evidence_ready' });
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.attained.sdk_enqueued?.externalReceiptId).toBe('worker-attested-not-observed');
    expect(row.attained.ingest_accepted?.externalReceiptId).toBe('inferred-from-query-visible');
    expect(fake.signalPosts).toHaveLength(0);
    expect(fake.ingestEvents).toHaveLength(0); // nothing is re-sent for an SDK-produced event
  });

  it('claims NO delivery state while the event is not visible', async () => {
    const { dispatcher, enqueue, outbox } = rig();
    const intent = episode();
    enqueue(intent);
    expect(await dispatcher.runOnce()).toMatchObject({
      result: 'retrying',
      detail: 'RemoteNotVisible',
      attained: [],
    });
    expect(outbox.rows.get(operationIdFor(intent))!.attained).toEqual({});
  });

  it('HOLDs a visible but incomplete event, keeps re-reading, and releases it only when enrichment completes', async () => {
    fake.seedEvent({ id: 'evt-run-1', assistant_output: '{"status":"failed"}' });
    fake.enrichLater('evt-run-1', 2, (event) => {
      event.tool_calls = [{ name: 'inspect_scope' }];
    });
    const { dispatcher, enqueue, outbox, clock } = rig();
    const intent = episode();
    enqueue(intent);
    const first = await dispatcher.runOnce();
    expect(first).toMatchObject({ result: 'hold', detail: 'hold:tool_calls' });
    let row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.attained.query_visible).toBeDefined();
    expect(row.attained.evidence_ready).toBeUndefined();
    expect(row.status).toBe('retrying');
    let last = first;
    for (let i = 0; i < 4 && last?.result !== 'evidence_ready'; i++) {
      clock.advance(30_000);
      last = (await dispatcher.runOnce()) ?? last;
    }
    expect(last?.result).toBe('evidence_ready');
    row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.attained.evidence_ready).toBeDefined();
  });

  it('dead-letters a visible event whose required evidence never arrives, rather than releasing it', async () => {
    fake.seedEvent({ id: 'evt-run-1', assistant_output: 'x' });
    const { dispatcher, enqueue, outbox, clock } = rig({ holdTimeoutMs: 60_000 });
    const intent = episode();
    enqueue(intent);
    await dispatcher.runOnce();
    clock.advance(120_000);
    const final = await dispatcher.runOnce();
    expect(final).toMatchObject({ result: 'dead_letter' });
    expect(outbox.rows.get(operationIdFor(intent))!.lastErrorCode).toBe(
      'EvidenceIncompleteTimeout:tool_calls',
    );
    expect(outbox.rows.get(operationIdFor(intent))!.attained.evidence_ready).toBeUndefined();
  });

  it('requires THE signal an admission intent is about, not just any signal on the event', async () => {
    fake.attachPostedSignals = false; // the provider accepted the POST but has not reflected it on the event
    fake.seedEvent({ id: 'evt-run-1' });
    fake.enrichLater('evt-run-1', 0, (event) => {
      event.signals = [{ id: 'x', name: 'some_other_signal', score: null }];
    });
    const { dispatcher, enqueue, outbox } = rig();
    const intent = admissionSignalIntent({
      jobId: 'job-1',
      eventId: 'evt-run-1',
      accepted: true,
      proposalId: 'prop-1',
      gateReportId: 'gate-1',
    });
    enqueue(intent);
    const outcome = await dispatcher.runOnce();
    expect(outcome?.result).toBe('hold');
    expect(outbox.rows.get(operationIdFor(intent))!.attained.evidence_ready).toBeUndefined();
  });
});
