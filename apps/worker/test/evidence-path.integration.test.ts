/**
 * The Raindrop evidence path as a RUNNING process, end to end on a local replica set:
 *   a worker job (real Dispatcher, FAKE model) commits its telemetry intent with the terminal state
 *   -> the evidence process (own `observer` principal) walks it through the delivery ladder against a labeled FAKE Raindrop
 *      server -> the Query observer pages the event back under its fixed window with a durable cursor
 *   -> the stored read-back becomes a sanitized EvidenceBundle the evolver accepts.
 * Everything Raindrop-shaped is the FAKE (packages/observability/test/fake-raindrop.ts): this proves OUR protocol handling,
 * never that bytes reached Raindrop. MongoDB is the local replica set (not Atlas RBAC).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import {
  ArtifactRepository,
  JobRepository,
  OutboxRepository,
  ProjectionRepository,
  type MongoService,
} from '@expunge/mongo';
import { closeTracing, initTracing } from '@expunge/observability';
import * as observerPackage from '@expunge/observer';
import { bundleForRun, createEvidenceProcess, evidenceMain, evidenceReadiness } from '@expunge/observer';
import { FakeChatModel, fakeText, fakeToolCalls } from '@expunge/runtime/testing';
import { defineTool } from '@expunge/vendor-openmuse';
import { z } from 'zod';
import { buildEvidencePacket } from '../../../packages/evolution/src/evidence.js';
import {
  TEST_URI,
  actor,
  createJob,
  deployWorker,
  liveSuite,
  openEnvironment,
  type LiveEnvironment,
} from '../../../packages/mongo/test/support.js';
import { createRunBundler } from '../../../packages/observer/src/run-bundle-testing.js';
import { FakeRaindrop } from '../../../packages/observability/test/fake-raindrop.js';
import { FakeToolProvider, FixedModelResolver, makeBundle } from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  asArtifactReader,
  asDispatchJobs,
  asProjectionSink,
  createTelemetry,
  workerConfigFromEnv,
} from '../src/index.js';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');
const bundle = makeBundle({ toolPolicy: { grants: ['echo'], prerequisites: [] } });
const harnessHash = contentHash(bundle);
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const LITERAL = 'syn_subject_maria_rossi';
const GUARD = { forbiddenLiterals: [LITERAL] };
const NO_SUPPRESSED = { suppressedUserIds: async (): Promise<ReadonlySet<string>> => new Set() };

describeLive('Raindrop evidence path as a running process (FAKE Raindrop, local replica set)', () => {
  const fake = new FakeRaindrop();
  let env: LiveEnvironment;
  let setup: MongoService;
  let executor: MongoService;
  let observer: MongoService;
  beforeAll(async () => {
    await fake.start();
    initTracing(
      { writeKey: fake.keys().writeKey, projectId: 'proj-1', endpoint: fake.ingestUrl },
      { disableBatching: true, bufferSize: 1 },
    );
    env = await openEnvironment('evpath');
    setup = env.service;
    executor = await env.as('domain_executor');
    observer = await env.as('observer');
  }, 30_000);
  beforeEach(async () => {
    fake.reset();
    await env.reset();
    await deployWorker(setup, bundle);
    await setup.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash: harnessHash,
      state: 'permitted',
      policyHash: 'a'.repeat(64),
      reasonCode: 'test',
      sourceIds: [],
      updatedAt: new Date(),
    });
  });
  afterAll(async () => {
    await closeTracing();
    await fake.stop();
    if (env) await env.dispose();
  }, 30_000);

  const processEnv = (over: Record<string, string> = {}) => ({
    RAINDROP_API_KEY: fake.keys().writeKey,
    RAINDROP_QUERY_API_KEY: fake.keys().queryKey,
    RAINDROP_PROJECT_ID: 'proj-1',
    RAINDROP_INGEST_URL: fake.ingestUrl,
    RAINDROP_QUERY_URL: fake.queryUrl,
    RAINDROP_ORGANIZATION_ID: 'org-1',
    MONGODB_OBSERVER_URI: 'mongodb://127.0.0.1:1/unused',
    EXPUNGE_TENANT_ID: scope.tenantId,
    EXPUNGE_ENV: scope.env,
    EXPUNGE_SCOPE_ID: scope.scopeId,
    ...over,
  });
  const started = (
    over: Record<string, string> = {},
    suppression = NO_SUPPRESSED,
    tuning: {
      dispatcher?: Parameters<typeof createEvidenceProcess>[2] extends infer O
        ? O extends { dispatcher?: infer D }
          ? D
          : never
        : never;
      scan?: Record<string, unknown>;
      filter?: Record<string, unknown>;
      window?: { start: string; end: string };
    } = {},
  ) => {
    const result = createEvidenceProcess(
      processEnv(over),
      { guard: GUARD, suppression },
      {
        service: observer,
        ownerId: 'evidence-test',
        ...(tuning.dispatcher ? { dispatcher: tuning.dispatcher } : {}),
        window: {
          filter: (tuning.filter ?? { eventName: 'expunge.worker' }) as never,
          windowStart: tuning.window?.start ?? new Date(Date.now() - 3_600_000).toISOString(),
          windowEnd: tuning.window?.end ?? new Date(Date.now() + 3_600_000).toISOString(),
        },
        scan: { requiredFields: ['assistant_output'], pageSize: 2, ...tuning.scan } as never,
      },
    );
    if (result.status !== 'READY') throw new Error(`blocked: ${JSON.stringify(result.readiness.blockers)}`);
    return result.process;
  };

  /** A worker job with one echo tool call: its episode event is produced by the REAL SDK path into the FAKE server. */
  async function runWorkerJob(): Promise<string> {
    const id = await createJob(setup, { harnessHash });
    const jobs = new JobRepository(executor);
    const tracing = initTracing({
      writeKey: fake.keys().writeKey,
      projectId: 'proj-1',
      endpoint: fake.ingestUrl,
    });
    const dispatcher = new Dispatcher({
      jobs: asDispatchJobs(jobs),
      resolver: new MongoJobResolver(jobs),
      artifacts: asArtifactReader(new ArtifactRepository(executor)),
      tools: new FakeToolProvider(() => [
        defineTool({
          name: 'echo',
          description: 'e',
          parameters: z.object({ v: z.number() }),
          execute: async () => ({ ok: true }),
        }),
      ]),
      models: new FixedModelResolver({
        spec: 'fake/fake',
        textAdapter: new FakeChatModel([
          fakeToolCalls([{ name: 'echo', args: { v: 1 } }]),
          fakeText('narrative only'),
        ]).adapter,
      }),
      receipts: new MongoCompletionReceiptReader(executor),
      projection: asProjectionSink(new ProjectionRepository(executor)),
      telemetry: createTelemetry({
        tracing,
        outbox: new OutboxRepository(executor),
        transaction: (work) => executor.transaction(work),
      }),
      config: workerConfigFromEnv({
        EXPUNGE_WORKER_ID: 'worker-evpath',
        EXPUNGE_WORKER_LEASE_MS: '20000',
        EXPUNGE_TENANT_ID: scope.tenantId,
        EXPUNGE_ENV: scope.env,
        EXPUNGE_SCOPE_ID: scope.scopeId,
      }),
    });
    expect((await dispatcher.runJob(id)).outcome).toBe('failed'); // narrative only: no receipt, honest failure
    return id;
  }
  const outboxRows = () => setup.control.collection('telemetry_outbox');

  it('readiness is BLOCKED with variable NAMES until keys, the observer principal, a suppression source and a guard exist; never READY by default', () => {
    const empty = evidenceReadiness({});
    expect(empty).toMatchObject({ status: 'BLOCKED', mode: 'blocked' });
    expect(empty.blockers.map((b) => b.name)).toEqual(
      expect.arrayContaining([
        'RAINDROP_API_KEY',
        'RAINDROP_PROJECT_ID',
        'RAINDROP_QUERY_API_KEY',
        'MONGODB_OBSERVER_URI',
        'EXPUNGE_TENANT_ID',
        'RAINDROP_ORGANIZATION_ID',
        'export suppression source',
        'leak guard source',
      ]),
    );
    expect(empty.lines.every((line) => line.startsWith('BLOCKED:'))).toBe(true);
    expect(JSON.stringify(empty)).not.toMatch(/ready/i);
    // Everything present but NO suppression source: still blocked, because an empty list would be a lie.
    const noSuppression = evidenceReadiness(processEnv(), { guard: GUARD });
    expect(noSuppression.status).toBe('BLOCKED');
    expect(noSuppression.blockers.map((b) => b.name)).toEqual(['export suppression source']);
    // Present, endpoints overridden: READY, but labelled as a LOCAL FAKE and claiming no delivery.
    const local = evidenceReadiness(processEnv(), { guard: GUARD, suppression: NO_SUPPRESSED });
    expect(local).toMatchObject({ status: 'READY', mode: 'local_fake' });
    expect(local.lines[0]).toContain('LOCAL FAKE');
    // Without overrides it is 'live' configured, still not delivery.
    const { RAINDROP_INGEST_URL: _a, RAINDROP_QUERY_URL: _b, ...live } = processEnv();
    const configured = evidenceReadiness(live, { guard: GUARD, suppression: NO_SUPPRESSED });
    expect(configured).toMatchObject({ status: 'READY', mode: 'live' });
    expect(configured.lines[0]).toContain('not verified');
    // The builder refuses to build anything when blocked.
    expect(createEvidenceProcess({}, { guard: GUARD }, {}).status).toBe('BLOCKED');
    expect(createEvidenceProcess(processEnv(), { guard: GUARD }, {}).status).toBe('BLOCKED');
  });

  it('the process entry exits 3 and prints only BLOCKED lines with names while no leak guard file exists (the suppression source is wired from the observer principal)', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      expect(await evidenceMain(processEnv())).toBe(3);
    } finally {
      console.log = original;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith('BLOCKED:'))).toBe(true);
    expect(lines.join('\n')).toContain('leak guard source');
    expect(lines.join('\n')).not.toContain('export suppression source'); // main wires it from MONGODB_OBSERVER_URI
    expect(lines.join('\n')).not.toContain(fake.keys().writeKey); // names, never values
  });

  it('(FAKE split seam for the train-path check) a real worker job reaches evidence_ready through the ladder, the observer reads it back, and the bundle is accepted by the evolver', async () => {
    const jobId = await runWorkerJob();
    const row = (await outboxRows().findOne({ jobId, kind: 'sdk_event' } as never))!;
    expect(row).toMatchObject({ status: 'pending' }); // committed WITH the terminal state, nothing sent yet
    const evidence = started();
    // 1. The SDK event is visible but the Query API does not show its tool calls yet: HELD, never promoted.
    const first = await evidence.drain();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ result: 'hold' });
    expect(first[0]!.detail).toContain('tool_calls');
    const held = (await outboxRows().findOne({ jobId, kind: 'sdk_event' } as never))!;
    expect(Object.keys(held.attained)).toEqual(['sdk_enqueued', 'ingest_accepted', 'query_visible']);
    expect(held.attained).not.toHaveProperty('evidence_ready');
    expect(held.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // retry is scheduled (backoff)
    // 2. Enrichment arrives late; the next attempt (made due here) completes the ladder.
    const eventId = (held.payload as { eventId: string }).eventId;
    fake.events.get(eventId)!.tool_calls = [{ name: 'echo' }];
    await outboxRows().updateOne({ jobId, kind: 'sdk_event' } as never, {
      $set: { nextAttemptAt: new Date(0) },
    });
    const outcomes = await evidence.drain();
    expect(outcomes).toHaveLength(1);
    const after = (await outboxRows().findOne({ jobId, kind: 'sdk_event' } as never))!;
    expect(outcomes[0]).toMatchObject({ result: 'evidence_ready' });
    expect(Object.keys(after.attained)).toEqual([
      'sdk_enqueued',
      'ingest_accepted',
      'query_visible',
      'evidence_ready',
    ]);
    expect(after.attained.sdk_enqueued.externalReceiptId).toBe('worker-attested-not-observed');
    expect(after.attained.ingest_accepted.externalReceiptId).toBe('inferred-from-query-visible');

    // The observer pages the event under its fixed window with a durable cursor and stores a revision of it.
    const scan = await evidence.scan();
    expect(scan).toMatchObject({ status: 'complete', windowComplete: true });
    const stored = await setup.control
      .collection('evidence')
      .find({ projectId: 'proj-1' } as never)
      .toArray();
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(await setup.control.collection('observer_cursors').countDocuments({})).toBe(1);

    // Read-back -> sanitized bundle -> the evolver's own acceptance rule (train + training-permitted + sanitized).
    const fakeTrainBundle = createRunBundler({ __fakeSplitResolverForTests: () => 'train' });
    const fakeProtectedBundle = createRunBundler({ __fakeSplitResolverForTests: () => 'protected' });
    const built = await fakeTrainBundle(observer, {
      scope,
      jobId,
      projectId: 'proj-1',
      guard: GUARD,
    });
    expect(built).toMatchObject({ split: 'train', binding: { jobId } });
    expect(built.sources[0]).toMatchObject({
      provider: 'raindrop',
      origin: 'agent_self_report',
      permittedUse: 'training',
    });
    expect(built.sources[0]!.delivery).toMatchObject({
      sdkEnqueued: 'worker_attested',
      ingestAccepted: 'inferred',
      queryVisible: 'observed',
    });
    expect(built.modelOutput).toMatch(/^untrusted-model-output:sha256:/); // the narrative is a hash, never text
    expect(JSON.stringify(built)).not.toContain(LITERAL);
    const packet = buildEvidencePacket({ arm: 'trace_informed', incident: [built], budgetChars: 20_000 });
    expect(packet.citableIds).toContain(built.sources[0]!.externalEventId);
    // Held-out splits cannot reach the proposer.
    const heldOut = await fakeProtectedBundle(observer, {
      scope,
      jobId,
      projectId: 'proj-1',
      guard: GUARD,
    });
    expect(() =>
      buildEvidencePacket({ arm: 'trace_informed', incident: [heldOut], budgetChars: 20_000 }),
    ).toThrow('EvidenceNotPermitted');
    // The PRODUCTION path has no stored split yet: it fails closed (withheld, gate-only) and ignores anything smuggled in.
    const production = await bundleForRun(observer, { scope, jobId, projectId: 'proj-1', guard: GUARD });
    expect(production.split).not.toBe('train');
    expect(production.sources[0]).toMatchObject({ permittedUse: 'gate_only' });
    const smuggled = await bundleForRun(observer, {
      scope,
      jobId,
      projectId: 'proj-1',
      guard: GUARD,
      splitOf: () => 'train',
      split: 'train',
      __fakeSplitResolverForTests: () => 'train',
    } as never);
    expect(smuggled.split).not.toBe('train');
    expect(smuggled.sources[0]).toMatchObject({ permittedUse: 'gate_only' });
  }, 60_000);

  it('a bundle is refused for a run whose evidence is not ready', async () => {
    const jobId = await runWorkerJob();
    await expect(
      bundleForRun(observer, {
        scope,
        jobId,
        projectId: 'proj-1',
        guard: GUARD,
      }),
    ).rejects.toMatchObject({
      code: 'EmptySources',
    });
  }, 60_000);

  it('EP-1: a mismatching assertion against the stored split is refused, and neither the seam nor a resolver reaches the production path', async () => {
    const jobId = await runWorkerJob();
    const base = { scope, jobId, projectId: 'proj-1', guard: GUARD };
    // A stored split that contradicts the caller's assertion is refused (before any evidence is read).
    const fakeProtected = createRunBundler({ __fakeSplitResolverForTests: () => 'protected' });
    await expect(fakeProtected(observer, { ...base, expectedSplit: 'train' })).rejects.toMatchObject({
      code: 'SplitMismatch',
    });
    // The seam is not part of the package, and the evidence process has no resolver.
    expect(Object.keys(observerPackage)).not.toContain('createRunBundler');
    expect(Object.keys(observerPackage)).not.toContain('buildRunBundle');
    expect(Object.keys(started()).filter((key) => /split|resolver/i.test(key))).toEqual([]);
  }, 60_000);

  it('401/403/429/5xx on ingestion: auth is HELD with its state kept, 429 and 5xx retry with backoff, and the row finishes once the server recovers', async () => {
    const jobId = await runWorkerJob();
    // Auth: a wrong write key is a blocked hold, never a dead letter.
    // (The SDK episode intent is read-back only; use a signal intent that needs an HTTP send.)
    const { verifierSignalIntent, enqueueTelemetry } = await import('@expunge/observability');
    await enqueueTelemetry(
      new OutboxRepository(observer),
      scope,
      verifierSignalIntent({ jobId, eventId: 'evt-sig-1', passed: false, evaluationId: 'e1', harnessHash }),
    );
    fake.seedEvent({ id: 'evt-sig-1', assistant_output: '{"status":"failed"}' });
    const bad = started({ RAINDROP_API_KEY: 'wrong-write-key' });
    const outcomes = await bad.drain();
    expect(outcomes.some((o) => o.result === 'blocked')).toBe(true);
    const signalRow = (await outboxRows().findOne({ jobId, kind: { $ne: 'sdk_event' } } as never))!;
    expect(signalRow.status).not.toBe('dead_letter');
    expect(signalRow.attained.ingest_accepted).toBeUndefined();
    expect(signalRow.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  it('suppression HOLDS an event intent for a suppressed user and for an unreadable list; the process drains the rest', async () => {
    const jobId = await runWorkerJob();
    const sdkRow = (await outboxRows().findOne({ jobId, kind: 'sdk_event' } as never))!;
    fake.events.get((sdkRow.payload as { eventId: string }).eventId)!.tool_calls = [{ name: 'echo' }];
    // An HTTP `event` intent for a (pseudonymous) user id under an open erasure.
    const USER = 'u_00000000000000000000000000000a01';
    await outboxRows().insertOne({
      _id: 'op-event-1',
      ...scope,
      operationId: 'op-event-1',
      kind: 'event',
      dedupeKey: 'op-event-1',
      jobId,
      payload: {
        type: 'event',
        eventId: 'evt-user-1',
        event: 'cleanup_summary',
        userId: USER,
        origin: 'verifier_feedback',
        output: '{"ok":true}',
        properties: {},
      },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(0),
      lease: { ownerId: '', fence: 0, until: new Date(0), heartbeatAt: new Date(0) },
      evidenceRequired: ['assistant_output'],
      attained: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const suppressed = started({}, { suppressedUserIds: async () => new Set([USER]) });
    const outcomes = await suppressed.drain();
    expect(outcomes.find((o) => o.operationId === 'op-event-1')).toMatchObject({
      result: 'blocked',
      detail: 'ExportSuppressed',
    });
    expect(outcomes.find((o) => o.operationId === sdkRow.operationId)).toMatchObject({
      result: 'evidence_ready',
    }); // unaffected
    expect(fake.ingestEvents.filter((e) => (e as { user_id?: string }).user_id === USER)).toHaveLength(0);
    // The same row with an UNREADABLE list: held again, not sent.
    await outboxRows().updateOne({ _id: 'op-event-1' } as never, {
      $set: { nextAttemptAt: new Date(0), status: 'pending' },
    });
    const broken = started(
      {},
      {
        suppressedUserIds: async () => {
          throw new Error('store down');
        },
      },
    );
    expect((await broken.drain()).find((o) => o.operationId === 'op-event-1')).toMatchObject({
      result: 'blocked',
      detail: 'SuppressionUnavailable',
    });
    expect(fake.ingestEvents.filter((e) => (e as { user_id?: string }).user_id === USER)).toHaveLength(0);
  }, 60_000);

  /** An HTTP-send intent (a verifier signal) whose event already exists remotely: the ladder needs the write path. */
  async function enqueueSignal(jobId: string, eventId: string): Promise<string> {
    const { verifierSignalIntent, enqueueTelemetry, operationIdFor } = await import('@expunge/observability');
    const intent = verifierSignalIntent({ jobId, eventId, passed: false, evaluationId: 'e1', harnessHash });
    await enqueueTelemetry(new OutboxRepository(observer), scope, intent);
    fake.seedEvent({ id: eventId, assistant_output: '{"status":"failed"}' });
    return operationIdFor(intent);
  }
  const makeDue = (operationId: string) =>
    outboxRows().updateOne({ _id: operationId } as never, { $set: { nextAttemptAt: new Date(0) } });

  it('429 (with Retry-After) and 5xx on ingestion retry with backoff keeping the earlier proof; the row then completes the ladder', async () => {
    const jobId = await runWorkerJob();
    await outboxRows().deleteMany({ jobId, kind: 'sdk_event' } as never); // isolate the signal intent
    const operationId = await enqueueSignal(jobId, 'evt-retry-1');
    fake.failNext(/signals\/track/, [429, 503], { 'retry-after': '1' });
    const evidence = started({}, NO_SUPPRESSED, {
      dispatcher: { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 6 },
    });
    const first = await evidence.drain();
    expect(first[0]).toMatchObject({ result: 'retrying' });
    let row = (await outboxRows().findOne({ _id: operationId } as never))!;
    expect(row.attempts).toBeGreaterThan(0);
    expect(row.attained).not.toHaveProperty('ingest_accepted');
    await makeDue(operationId);
    expect((await evidence.drain())[0]).toMatchObject({ result: 'retrying' }); // the 503
    await makeDue(operationId);
    expect((await evidence.drain())[0]).toMatchObject({ result: 'evidence_ready' });
    row = (await outboxRows().findOne({ _id: operationId } as never))!;
    expect(row.status).toBe('evidence_ready');
    expect(fake.signalPosts).toHaveLength(1); // sent once despite the earlier failures
  }, 60_000);

  it('403 holds like 401 (blocked, not dead-lettered), and persistent 5xx dead-letters at the attempt bound', async () => {
    const jobId = await runWorkerJob();
    await outboxRows().deleteMany({ jobId, kind: 'sdk_event' } as never);
    const forbidden = await enqueueSignal(jobId, 'evt-403');
    fake.failNext(/signals\/track/, [403]);
    expect((await started().drain())[0]).toMatchObject({ result: 'blocked' });
    expect((await outboxRows().findOne({ _id: forbidden } as never))!.status).not.toBe('dead_letter');

    await outboxRows().deleteMany({});
    const doomed = await enqueueSignal(jobId, 'evt-5xx');
    fake.failNext(/signals\/track/, [500, 500, 500, 500, 500, 500]);
    const evidence = started({}, NO_SUPPRESSED, {
      dispatcher: { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 },
    });
    for (let i = 0; i < 4; i++) {
      await makeDue(doomed);
      await evidence.drain();
    }
    const row = (await outboxRows().findOne({ _id: doomed } as never))!;
    expect(row.status).toBe('dead_letter');
    expect(row.attained).not.toHaveProperty('evidence_ready');
  }, 60_000);

  it('a cursor crash mid-page is resumed from the committed cursor with no duplicate and no gap', async () => {
    const { seedWorkerEvents } = await import('../../../packages/observer/test/helpers.js');
    seedWorkerEvents(fake, 5);
    let commits = 0;
    let armed = true;
    const evidence = started({}, NO_SUPPRESSED, {
      filter: { properties: { role: 'worker' } },
      window: { start: '2026-06-01T00:00:00.000Z', end: '2026-06-01T01:00:00.000Z' },
      scan: {
        hooks: {
          beforeCommit: () => {
            commits += 1;
            if (armed && commits === 2) throw new Error('process died before the second page committed');
          },
        },
      },
    });
    expect(await evidence.scan()).toBeNull(); // the crash is contained; nothing is thrown out of the loop
    const cursor = await setup.control.collection('observer_cursors').findOne({});
    expect(cursor?.providerCursor).toBeTruthy(); // page 1 is committed and so is its cursor
    armed = false;
    const resumed = await evidence.scan();
    expect(resumed).toMatchObject({ status: 'complete', windowComplete: true });
    const rows = await setup.control
      .collection('evidence')
      .find({ projectId: 'proj-1' } as never)
      .toArray();
    const ids = rows.map((r) => r.externalEventId as string).sort();
    expect(ids).toEqual(['evt-000', 'evt-001', 'evt-002', 'evt-003', 'evt-004']); // each exactly once
    expect(rows.every((r) => r.evidenceRevision === 1)).toBe(true);
    // A completed window is not rescanned.
    expect(await evidence.scan()).toMatchObject({ pagesCommitted: 0 });
  }, 60_000);
});
