import { createHash } from 'node:crypto';
import { projectionPayloadSchemas, type OutboxState } from '@expunge/contracts';
import {
  IngestClient,
  agentDiagnosticIntent,
  operationIdFor,
  sdkEpisodeIntent,
  verifierSignalIntent,
  type TelemetryIntent,
} from '@expunge/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import {
  InMemoryEvidenceStore,
  OutboxDispatcher,
  RaindropQueryClient,
  deliveryOf,
  observeEvent,
  type ProjectionPort,
} from '../src/index.js';
import {
  Clock,
  GUARD,
  InMemoryOutbox,
  LITERAL,
  SCOPE,
  identity,
  makeRig,
  seedWorkerEvents,
  NO_SUPPRESSION,
} from './helpers.js';

const fake = new FakeRaindrop();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** Fails ONE advance of the chosen state AFTER the transport succeeded, to model a crash between send and record. */
class CrashingOutbox extends InMemoryOutbox {
  crashOnce?: OutboxState;
  override async advance(
    ...args: Parameters<InMemoryOutbox['advance']>
  ): ReturnType<InMemoryOutbox['advance']> {
    if (args[4] === this.crashOnce) {
      this.crashOnce = undefined;
      throw new Error('simulated process crash');
    }
    return super.advance(...args);
  }
}

function rig() {
  const clock = new Clock();
  const outbox = new CrashingOutbox(clock);
  const evidence = new InMemoryEvidenceStore();
  const projected: Array<{ key: unknown; event: any }> = [];
  const projection: ProjectionPort = { append: async (key, event) => void projected.push({ key, event }) };
  const dispatcher = new OutboxDispatcher(
    {
      outbox,
      ingest: new IngestClient({
        writeKey: fake.keys().writeKey,
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
      guard: GUARD,
      ...NO_SUPPRESSION,
      projection,
    },
    {
      ownerId: 'dispatcher-1',
      now: clock.now,
      random: () => 0.5,
      leaseMs: 30_000,
      baseDelayMs: 1000,
      holdTimeoutMs: 600_000,
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
  return { clock, outbox, evidence, projected, dispatcher, enqueue };
}

const verifier = (eventId = 'evt-run-1') =>
  verifierSignalIntent({
    jobId: 'job-1',
    eventId,
    passed: false,
    evaluationId: 'eval-1',
    harnessHash: 'h'.repeat(64),
  });

describe('O3: a crash between the 2xx and ingest_accepted does not double count a signal', () => {
  it('O3: with the signal visible on the remote event the second claim does NOT send again and records an inference', async () => {
    fake.seedEvent({ id: 'evt-run-1', assistant_output: '{"status":"failed"}' });
    const { dispatcher, enqueue, outbox, clock } = rig();
    const intent = verifier();
    enqueue(intent);
    outbox.crashOnce = 'ingest_accepted';
    await expect(dispatcher.runOnce()).rejects.toThrow('simulated process crash');
    expect(fake.signalPosts).toHaveLength(1); // the first send did reach the vendor
    clock.advance(60_000); // the crashed holder's lease expires
    const outcome = await dispatcher.runOnce();
    expect(outcome).toMatchObject({ result: 'evidence_ready' });
    expect(fake.signalPosts).toHaveLength(1); // no second send
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.attained.ingest_accepted?.externalReceiptId).toBe('inferred-from-query-visible');
    expect(deliveryOf(row.attained).ingestAccepted).toBe('inferred');
  });

  it('O3: with the signal NOT visible the resend happens and is labelled unverified', async () => {
    fake.attachPostedSignals = false;
    fake.seedEvent({ id: 'evt-run-1', assistant_output: '{"status":"failed"}' });
    const { dispatcher, enqueue, outbox, clock } = rig();
    const intent = verifier();
    enqueue(intent);
    outbox.crashOnce = 'ingest_accepted';
    await expect(dispatcher.runOnce()).rejects.toThrow('simulated process crash');
    clock.advance(60_000);
    await dispatcher.runOnce();
    expect(fake.signalPosts).toHaveLength(2);
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.attained.ingest_accepted?.externalReceiptId).toBe('http-204-resend-unverified');
    expect(deliveryOf(row.attained).ingestAccepted).toBe('resend_unverified');
  });

  it('O3: every signal carries dedupe_key = the outbox operation id, identical across a resend', async () => {
    fake.attachPostedSignals = false;
    fake.seedEvent({ id: 'evt-run-1', assistant_output: '{}' });
    const { dispatcher, enqueue, outbox, clock } = rig();
    const intent = verifier();
    enqueue(intent);
    outbox.crashOnce = 'ingest_accepted';
    await expect(dispatcher.runOnce()).rejects.toThrow();
    clock.advance(60_000);
    await dispatcher.runOnce();
    const keys = fake.signalPosts.map((post) => (post.properties as Record<string, unknown>).dedupe_key);
    expect(keys).toEqual([operationIdFor(intent), operationIdFor(intent)]);
  });
});

describe('O4: delivery labels are computed from the receipts and travel into the evidence_ready projection', () => {
  it('O4: a signal intent is observed end to end; its projection event validates against the strict contract schema', async () => {
    fake.seedEvent({
      id: 'evt-run-1',
      assistant_output: '{}',
      properties: { run_id: 'run-77', role: 'worker' },
    });
    const { dispatcher, enqueue, projected } = rig();
    enqueue(verifier());
    await dispatcher.runOnce();
    expect(projected).toHaveLength(1);
    const { event } = projected[0]!;
    expect(event).toMatchObject({ kind: 'evidence_ready', jobId: 'job-1', runId: 'run-77' });
    expect(event.payload.delivery).toEqual({
      sdkEnqueued: 'observed',
      ingestAccepted: 'observed',
      queryVisible: 'observed',
      evidenceReady: 'observed',
    });
    expect(() => projectionPayloadSchemas.evidence_ready.parse(event.payload)).not.toThrow();
    expect(event.payload).toMatchObject({
      outboxState: 'evidence_ready',
      origin: 'verifier_feedback',
      permittedUse: 'display_only',
    });
  });

  it('O4: an sdk_event is worker-attested and inferred, never observed', async () => {
    fake.seedEvent({
      id: 'expunge:worker:job-1:run-1:1',
      assistant_output: '{"status":"failed"}',
      tool_calls: [{ name: 'inspect_scope' }],
      properties: { run_id: 'run-1' },
    });
    const { dispatcher, enqueue, projected, outbox } = rig();
    const intent = sdkEpisodeIntent({
      jobId: 'job-1',
      eventId: 'expunge:worker:job-1:run-1:1',
      role: 'worker',
      attempt: 1,
    });
    enqueue(intent);
    await dispatcher.runOnce();
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(deliveryOf(row.attained)).toEqual({
      sdkEnqueued: 'worker_attested',
      ingestAccepted: 'inferred',
      queryVisible: 'observed',
      evidenceReady: 'observed',
    });
    expect(projected[0]!.event.payload.delivery).toMatchObject({
      sdkEnqueued: 'worker_attested',
      ingestAccepted: 'inferred',
    });
    expect(projected[0]!.event.payload.origin).toBe('agent_self_report');
  });

  it('O4: a projection append that fails never changes the dispatch result', async () => {
    fake.seedEvent({ id: 'evt-run-1', assistant_output: '{}', properties: { run_id: 'run-1' } });
    const r = rig();
    (r.dispatcher as any).deps.projection = {
      append: async () => Promise.reject(new Error('projection down')),
    };
    r.enqueue(verifier());
    expect(await r.dispatcher.runOnce()).toMatchObject({ result: 'evidence_ready' });
  });
});

describe('agent_diagnostic delivery (report_diagnostic from the gateway)', () => {
  const diagnostic = (detail = 'registry has no archive collection') =>
    agentDiagnosticIntent({
      jobId: 'job-1',
      runId: 'run-1',
      attempt: 1,
      toolCallId: 'call-1',
      severity: 'warning',
      codes: ['missing_context'],
      detail,
      guard: GUARD,
    });

  it('sends it as the agent_diagnostic signal labelled agent_self_report, with the hash and no text', async () => {
    const intent = diagnostic();
    fake.seedEvent({
      id: (intent.payload as any).eventId,
      assistant_output: '{}',
      properties: { run_id: 'run-1' },
    });
    const { dispatcher, enqueue, outbox } = rig();
    enqueue(intent);
    const outcome = await dispatcher.runOnce();
    expect(outcome).toMatchObject({ result: 'evidence_ready' });
    expect(fake.signalPosts[0]).toMatchObject({
      event_id: (intent.payload as any).eventId,
      signal_name: 'agent_diagnostic',
      signal_type: 'default',
    });
    const properties = (fake.signalPosts[0] as any).properties;
    expect(properties).toMatchObject({
      origin: 'agent_self_report',
      severity: 'warning',
      codes: 'missing_context',
      tool_call_id: 'call-1',
      detail_sha256: createHash('sha256').update('registry has no archive collection').digest('hex'),
      dedupe_key: operationIdFor(intent),
    });
    expect(JSON.stringify(fake.signalPosts)).not.toContain('registry has no archive');
    expect(outbox.rows.get(operationIdFor(intent))!.status).toBe('evidence_ready');
  });
});

describe('O2: remote event content is never stored as received', () => {
  const event = (over: Record<string, unknown>) =>
    ({
      id: 'evt-x',
      event_name: 'expunge.worker',
      timestamp: '2026-06-02T00:00:00.000Z',
      user_id: 'tok_00000000000000a1',
      convo_id: 'job-1',
      properties: { role: 'worker', run_id: 'run-1' },
      feature_flags: {},
      ...over,
    }) as never;

  it('O2: identifiers under keys this system writes survive; everything else is a hash', () => {
    const observation = observeEvent(
      'proj-1',
      event({
        properties: {
          role: 'worker',
          run_id: 'run-1',
          harness_hash: 'h'.repeat(64),
          note: 'the archive of a person is gone',
          nested: { free: 'some sentence', status: 'ok' },
        },
        feature_flags: { harness_version: 'h'.repeat(64), custom: 'free text value' },
      }),
      { guard: GUARD },
    );
    const props = observation.event.properties as Record<string, unknown>;
    expect(props.role).toBe('worker');
    expect(props.run_id).toBe('run-1');
    expect(props.harness_hash).toBe('h'.repeat(64));
    expect(props.note).toMatchObject({ redacted: true });
    expect(JSON.stringify(observation)).not.toContain('archive of a person');
    expect(JSON.stringify(observation)).not.toContain('some sentence');
    expect(JSON.stringify(observation)).not.toContain('free text value');
  });

  it('O2: a user id that is not an opaque telemetry id is hashed, not stored', () => {
    const observation = observeEvent('proj-1', event({ user_id: 'maria_rossi' }), { guard: GUARD });
    expect(observation.event.userId).toMatch(/^redacted:/);
    expect(JSON.stringify(observation)).not.toContain('maria_rossi');
    expect(observeEvent('proj-1', event({}), { guard: GUARD }).event.userId).toBe('tok_00000000000000a1');
  });

  it.each([
    ['a subject literal in a property value', { properties: { note: `see ${LITERAL}` } }, 'SubjectLiteral'],
    ['a subject literal as a property KEY', { properties: { [LITERAL]: 1 } }, 'SubjectLiteral'],
    ['a base64 literal', { properties: { blob: Buffer.from(LITERAL).toString('base64') } }, 'SubjectLiteral'],
    ['a held-out key', { properties: { expected_poststate: 1 } }, 'HeldOutLeak'],
    ['a literal in a signal name', { signals: [{ id: 's1', name: LITERAL, score: null }] }, 'SubjectLiteral'],
    ['a literal in a tool call name', { tool_calls: [{ name: LITERAL }] }, 'SubjectLiteral'],
  ])('O2: %s quarantines the observation (structure only, never evidence)', (_label, over, code) => {
    const observation = observeEvent('proj-1', event(over), { guard: GUARD });
    expect(observation.quarantined).toBe(code);
    expect(observation.presentFields).toEqual([]);
    expect(observation.event.properties).toEqual({});
    expect(observation.event.signals).toEqual([]);
    expect(JSON.stringify(observation)).not.toContain(LITERAL);
    expect(JSON.stringify(observation)).not.toMatch(/expected_poststate/);
  });

  it('O2: a quarantined event is dead-lettered by the dispatcher, stored structure-only, and never promoted', async () => {
    fake.seedEvent({
      id: 'evt-run-1',
      assistant_output: '{}',
      properties: { run_id: 'run-1', note: `about ${LITERAL}` },
    });
    const { dispatcher, enqueue, outbox, evidence, projected } = rig();
    const intent = verifier();
    enqueue(intent);
    const outcome = await dispatcher.runOnce();
    expect(outcome).toMatchObject({ result: 'dead_letter', detail: 'EvidenceQuarantined:SubjectLiteral' });
    const row = outbox.rows.get(operationIdFor(intent))!;
    expect(row.status).toBe('dead_letter');
    expect(row.attained.evidence_ready).toBeUndefined();
    expect(projected).toHaveLength(0);
    expect(JSON.stringify([...evidence.rows.values()])).not.toContain(LITERAL);
    expect([...evidence.rows.values()][0]?.[0]?.quarantined).toBe('SubjectLiteral');
  });
});

describe('O2: a poisoned event cannot stall the cursor behind it', () => {
  it('O2: the page commits, the cursor advances past it, and it is reported as quarantined, not ready or pending', async () => {
    seedWorkerEvents(fake, 3);
    fake.seedEvent({
      id: 'evt-001',
      timestamp: new Date(Date.UTC(2026, 5, 1, 0, 0, 1)).toISOString(),
      properties: { role: 'worker', run_id: 'run-1', note: `about ${LITERAL}` },
      user_input: 'cleanup job',
      assistant_output: '{}',
      tool_calls: [{ name: 'inspect_scope' }],
      signals: [{ id: 'sig-1', name: 'cleanup_not_verified', score: null }],
    });
    const { runner, evidence, cursors } = makeRig(fake);
    const result = await runner.runOnce(identity(), {
      requiredFields: ['tool_calls', 'signals'],
      pageSize: 10,
    });
    expect(result).toMatchObject({
      status: 'complete',
      windowComplete: true,
      quarantined: ['evt-001'],
      pending: [],
      held: [],
    });
    expect(result.ready).toEqual(['evt-000', 'evt-002']);
    const stored = [...evidence.rows.values()].flat();
    expect(stored).toHaveLength(3);
    expect(stored.find((row) => row.externalEventId === 'evt-001')?.quarantined).toBe('SubjectLiteral');
    expect(JSON.stringify(stored)).not.toContain(LITERAL);
    expect([...cursors.rows.values()][0]?.pendingEnrichmentIds).toEqual([]);
  });
});
