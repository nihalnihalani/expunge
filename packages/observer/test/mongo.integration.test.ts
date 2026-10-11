import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import {
  IngestClient,
  enqueueTelemetry,
  operationIdFor,
  sdkEpisodeIntent,
  verifierSignalIntent,
} from '@expunge/observability';
import { JobRepository, ObserverCursorRepository, OutboxRepository, type MongoService } from '@expunge/mongo';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import { MongoEvidenceStore, ObserverRunner, OutboxDispatcher, RaindropQueryClient } from '../src/index.js';
import {
  actor,
  createJob,
  describeLive,
  openEnvironment,
  scope,
  type LiveEnvironment,
} from './mongo-support.js';
import { GUARD, LITERAL, identity, seedWorkerEvents } from './helpers.js';

describeLive('telemetry outbox and observer on a real replica set (local protocol evidence only)', () => {
  const fake = new FakeRaindrop();
  let env: LiveEnvironment;
  let executor: MongoService;
  let observer: MongoService;

  beforeAll(async () => {
    await fake.start();
    env = await openEnvironment('observer');
    executor = await env.as('domain_executor');
    observer = await env.as('observer');
  }, 30000);
  beforeEach(async () => {
    fake.reset();
    await env.reset();
  });
  afterAll(async () => {
    await fake.stop();
    if (env) await env.dispose();
  }, 30000);

  const outboxRows = () => env.setup.control.collection<Document>('telemetry_outbox');

  describe('intent atomicity with the domain outcome', () => {
    it('commits the failure outcome and its telemetry intent together, or neither', async () => {
      const jobs = new JobRepository(executor);
      const outbox = new OutboxRepository(executor);
      const id = await createJob(env.setup);
      const claimed = (await jobs.claim(actor, id, 'worker-1', 30000))!;
      const lease = { jobId: id, ownerId: 'worker-1', fence: claimed.lease.fence };
      const intent = sdkEpisodeIntent({
        jobId: id,
        eventId: `expunge:worker:${id}:run:1`,
        role: 'worker',
        attempt: 1,
      });

      // The domain outcome succeeds, the intent is written, then the transaction fails: neither persists.
      await expect(
        executor.transaction(async (session) => {
          await jobs.finish(actor, lease, 'failed', [], session);
          await enqueueTelemetry(outbox, scope, intent, session);
          throw new Error('abort after both writes');
        }),
      ).rejects.toThrow('abort after both writes');
      expect(await outboxRows().countDocuments({})).toBe(0);
      expect(await env.setup.control.collection('jobs').findOne({ _id: id as never })).toMatchObject({
        status: 'running',
      });

      // The same transaction committed: both exist.
      await executor.transaction(async (session) => {
        await jobs.finish(actor, lease, 'failed', [], session);
        await enqueueTelemetry(outbox, scope, intent, session);
      });
      expect(await env.setup.control.collection('jobs').findOne({ _id: id as never })).toMatchObject({
        status: 'failed',
      });
      const row = await outboxRows().findOne({ _id: operationIdFor(intent) as never });
      expect(row).toMatchObject({ status: 'pending', kind: 'sdk_event', attempts: 0, jobId: id });
      expect(row?.payload).toEqual(intent.payload);
    });

    it('a duplicate intent inside a transaction rolls the whole domain outcome back', async () => {
      const jobs = new JobRepository(executor);
      const outbox = new OutboxRepository(executor);
      const id = await createJob(env.setup);
      const claimed = (await jobs.claim(actor, id, 'worker-1', 30000))!;
      const lease = { jobId: id, ownerId: 'worker-1', fence: claimed.lease.fence };
      const intent = sdkEpisodeIntent({
        jobId: id,
        eventId: `expunge:worker:${id}:run:1`,
        role: 'worker',
        attempt: 1,
      });
      await enqueueTelemetry(outbox, scope, intent); // an earlier attempt already recorded it
      await expect(
        executor.transaction(async (session) => {
          await jobs.finish(actor, lease, 'failed', [], session);
          await enqueueTelemetry(outbox, scope, intent, session);
        }),
      ).rejects.toThrow('TelemetryIntentConflict');
      // The whole outcome rolled back: the job is not finished by a transaction whose intent insert failed.
      expect(await outboxRows().countDocuments({})).toBe(1);
      expect(await env.setup.control.collection('jobs').findOne({ _id: id as never })).toMatchObject({
        status: 'running',
      });
    });

    it('is idempotent outside a transaction: the second enqueue inserts nothing', async () => {
      const outbox = new OutboxRepository(executor);
      const intent = verifierSignalIntent({
        jobId: 'j1',
        eventId: 'evt-1',
        passed: true,
        evaluationId: 'e1',
        harnessHash: 'h'.repeat(64),
      });
      expect(await enqueueTelemetry(outbox, scope, intent)).toMatchObject({ inserted: true });
      expect(await enqueueTelemetry(outbox, scope, intent)).toMatchObject({ inserted: false });
      expect(await outboxRows().countDocuments({})).toBe(1);
    });
  });

  describe('dispatcher against the real OutboxRepository and evidence collection', () => {
    const dispatcherFor = (owner: string, over: { writeKey?: string } = {}) =>
      new OutboxDispatcher(
        {
          outbox: new OutboxRepository(observer),
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
          evidence: new MongoEvidenceStore(observer),
          transaction: (work) => observer.transaction(work),
          scope,
          projectId: 'proj-1',
          guard: GUARD,
        },
        { ownerId: owner, leaseMs: 20000, baseDelayMs: 100, maxAttempts: 4 },
      );
    const enqueueVerifier = async (eventId = 'evt-run-1') => {
      const intent = verifierSignalIntent({
        jobId: 'job-1',
        eventId,
        passed: false,
        evaluationId: 'eval-1',
        harnessHash: 'h'.repeat(64),
      });
      await enqueueTelemetry(new OutboxRepository(executor), scope, intent);
      return operationIdFor(intent);
    };

    it('walks one signal intent to evidence_ready, persisting each state with its own proof, and stores the evidence', async () => {
      fake.seedEvent({ id: 'evt-run-1', assistant_output: '{"status":"failed"}' });
      const operationId = await enqueueVerifier();
      const outcome = await dispatcherFor('d1').runOnce();
      expect(outcome).toMatchObject({ result: 'evidence_ready' });
      const row = (await outboxRows().findOne({ _id: operationId as never }))!;
      expect(row.status).toBe('evidence_ready');
      expect(Object.keys(row.attained)).toEqual([
        'sdk_enqueued',
        'ingest_accepted',
        'query_visible',
        'evidence_ready',
      ]);
      const times = Object.values(row.attained as Record<string, { at: Date }>).map((a) => a.at.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      const stored = await env.setup.control.collection('evidence').find({}).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        externalEventId: 'evt-run-1',
        provider: 'raindrop',
        evidenceRevision: 1,
      });
      // Terminal rows are never claimed again.
      expect(await dispatcherFor('d2').runOnce()).toBeNull();
    });

    it('two dispatchers racing for one row: exactly one claims it, one signal is sent', async () => {
      fake.seedEvent({ id: 'evt-run-1', assistant_output: '{"status":"failed"}' });
      await enqueueVerifier();
      const outcomes = await Promise.all([dispatcherFor('d1').runOnce(), dispatcherFor('d2').runOnce()]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(fake.signalPosts).toHaveLength(1);
    });

    it('a bad write key is a blocked hold with the delivery states so far kept, not a dead letter', async () => {
      fake.seedEvent({ id: 'evt-run-1', assistant_output: '{}' });
      const operationId = await enqueueVerifier();
      const outcome = await dispatcherFor('d1', { writeKey: 'wrong' }).runOnce();
      expect(outcome).toMatchObject({ result: 'blocked' });
      const row = (await outboxRows().findOne({ _id: operationId as never }))!;
      expect(row.status).not.toBe('dead_letter');
      expect(row.status).not.toBe('evidence_ready');
      expect(row.attained.ingest_accepted).toBeUndefined();
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('a visible but incomplete event is HELD with retry scheduled, never promoted', async () => {
      fake.seedEvent({ id: 'evt-run-1' }); // no assistant_output; the verifier intent requires signals
      fake.attachPostedSignals = false;
      const operationId = await enqueueVerifier();
      const outcome = await dispatcherFor('d1').runOnce();
      expect(outcome?.result).toBe('hold');
      const row = (await outboxRows().findOne({ _id: operationId as never }))!;
      expect(row.attained.query_visible).toBeDefined();
      expect(row.attained.evidence_ready).toBeUndefined();
      expect(await env.setup.control.collection('evidence').countDocuments({})).toBe(0);
    });
  });

  describe('observer cursor and evidence with real transactions', () => {
    const rig = () => {
      const cursors = new ObserverCursorRepository(observer);
      const evidence = new MongoEvidenceStore(observer);
      const runner = new ObserverRunner({
        client: new RaindropQueryClient({
          queryKey: fake.keys().queryKey,
          projectId: 'proj-1',
          baseUrl: fake.queryUrl,
          maxAttempts: 1,
          sleep: async () => undefined,
        }),
        cursors,
        evidence,
        transaction: (work) => observer.transaction(work),
        scope,
        guard: GUARD,
      });
      return { cursors, runner };
    };
    const evidenceRows = () => env.setup.control.collection<Document>('evidence');
    const cursorRow = () => env.setup.control.collection<Document>('observer_cursors').findOne({});

    it('commits each page of evidence with its cursor checkpoint in one transaction', async () => {
      seedWorkerEvents(fake, 4);
      const { runner } = rig();
      const result = await runner.runOnce(identity(), { requiredFields: [], pageSize: 2 });
      expect(result).toMatchObject({ status: 'complete', pagesCommitted: 2, observationsStored: 4 });
      expect(await evidenceRows().countDocuments({})).toBe(4);
      expect((await cursorRow())!.revision).toBe(2);
    });

    it('a crash before commit leaves neither evidence nor cursor movement, and the rerun completes without duplicates', async () => {
      seedWorkerEvents(fake, 4);
      const { runner } = rig();
      const query = identity();
      await expect(
        runner.runOnce(query, {
          requiredFields: [],
          pageSize: 2,
          hooks: {
            beforeCommit: () => {
              throw new Error('crash before commit');
            },
          },
        }),
      ).rejects.toThrow('crash before commit');
      expect(await evidenceRows().countDocuments({})).toBe(0);
      expect((await cursorRow())!.revision).toBe(0);
      const result = await runner.runOnce(query, { requiredFields: [], pageSize: 2 });
      expect(result.observationsStored).toBe(4);
      expect(await evidenceRows().countDocuments({})).toBe(4);
    });

    it('a crash after commit resumes from the committed cursor without refetching or duplicating', async () => {
      seedWorkerEvents(fake, 4);
      const { runner } = rig();
      const query = identity();
      let commits = 0;
      await expect(
        runner.runOnce(query, {
          requiredFields: [],
          pageSize: 2,
          hooks: {
            afterCommit: () => {
              if (++commits === 1) throw new Error('crash after commit');
            },
          },
        }),
      ).rejects.toThrow('crash after commit');
      expect(await evidenceRows().countDocuments({})).toBe(2);
      const { runner: restarted } = rig();
      const result = await restarted.runOnce(query, { requiredFields: [], pageSize: 2 });
      expect(result.observationsStored).toBe(2);
      expect(await evidenceRows().countDocuments({})).toBe(4);
      const ids = (await evidenceRows().find({}).toArray()).map((row) => row.externalEventId);
      expect(new Set(ids).size).toBe(4);
    });

    it('two observers with the same cursor: the stale checkpoint loses and its evidence rolls back', async () => {
      seedWorkerEvents(fake, 2);
      const a = rig();
      const b = rig();
      const query = identity();
      const gate = { release: () => {} };
      const holdA = new Promise<void>((resolve) => (gate.release = resolve));
      // A reads the page and pauses just before its commit; B completes the same page first.
      const aRun = a.runner.runOnce(query, {
        requiredFields: [],
        pageSize: 10,
        hooks: { beforeCommit: () => holdA },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await b.runner.runOnce(query, { requiredFields: [], pageSize: 10 });
      gate.release();
      await expect(aRun).rejects.toThrow('StaleObserverCursor');
      expect(await evidenceRows().countDocuments({})).toBe(2); // B's rows only, A's insert rolled back with its failed CAS
      expect((await cursorRow())!.revision).toBe(1);
    });

    it('O2: a poisoned remote event is stored structure-only in the real evidence collection, under a scope-prefixed id, with no literal anywhere', async () => {
      fake.seedEvent({
        id: 'evt-poison',
        timestamp: new Date(Date.UTC(2026, 5, 1)).toISOString(),
        properties: { role: 'worker', run_id: 'run-1', note: `about ${LITERAL}`, expected_poststate: ['x'] },
        assistant_output: '{}',
      });
      const { runner } = rig();
      const result = await runner.runOnce(identity(), { requiredFields: [], pageSize: 10 });
      expect(result.quarantined).toEqual(['evt-poison']);
      const rows = await evidenceRows().find({}).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ quarantined: expect.any(String), presentFields: [] });
      expect(rows[0]!._id).toMatch(
        new RegExp(`^raindrop:${scope.tenantId}:${scope.env}:${scope.scopeId}:proj-1:evt-poison:1$`),
      );
      const raw = JSON.stringify(rows);
      expect(raw).not.toContain(LITERAL);
      expect(raw).not.toContain('expected_poststate');
    });

    it('refuses to resume the cursor under a changed filter identity', async () => {
      seedWorkerEvents(fake, 2);
      const { runner } = rig();
      await runner.runOnce(identity(), { requiredFields: [] });
      await expect(
        runner.runOnce(
          identity({ filter: { eventName: 'expunge.worker', properties: { role: 'improver' } } }),
          { requiredFields: [] },
        ),
      ).rejects.toThrow('ObserverQueryIdentityChanged');
    });

    it('stores a new evidence revision only when enrichment changes the content', async () => {
      seedWorkerEvents(fake, 1, false);
      const { runner } = rig();
      const query = identity();
      await runner.runOnce(query, { requiredFields: ['tool_calls', 'signals'] });
      expect(await evidenceRows().countDocuments({})).toBe(1);
      fake.enrichLater('evt-000', 0, (event) => {
        event.tool_calls = [{ name: 'inspect_scope' }];
        event.signals = [{ id: 's1', name: 'cleanup_not_verified', score: null }];
      });
      await runner.runOnce(query, { requiredFields: ['tool_calls', 'signals'] });
      const rows = await evidenceRows()
        .find({ externalEventId: 'evt-000' })
        .sort({ evidenceRevision: 1 })
        .toArray();
      expect(rows.map((r) => r.evidenceRevision)).toEqual([1, 2]);
      // Observing the unchanged event again adds nothing.
      await runner.runOnce(query, { requiredFields: ['tool_calls', 'signals'] });
      expect(await evidenceRows().countDocuments({ externalEventId: 'evt-000' })).toBe(2);
    });
  });
});
