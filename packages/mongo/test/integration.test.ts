import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import {
  ArtifactRepository,
  EffectRepository,
  JobRepository,
  OutboxRepository,
  ProjectionRepository,
  ProjectionStreamConsumer,
} from '../src/index.js';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import { PROJECTION_SAMPLES } from '../../contracts/test/projection-samples.js';
import { BSON } from 'mongodb';
import {
  HASH,
  actor,
  completionReceipt,
  createJob,
  describeLive,
  insertRegistry,
  intent,
  openEnvironment,
  recordDecisionFor,
  sameBson,
  waitFor,
} from './support.js';
import type { LiveEnvironment } from './support.js';

describeLive('real MongoDB replica-set protocols (explicit MONGODB_TEST_URI)', () => {
  let env: LiveEnvironment;
  let service: LiveEnvironment['service'];
  let jobs: JobRepository;
  let effects: EffectRepository;
  let artifacts: ArtifactRepository;
  beforeAll(async () => {
    env = await openEnvironment('protocol');
    service = env.service;
    jobs = new JobRepository(service);
    effects = new EffectRepository(service);
    artifacts = new ArtifactRepository(service);
  }, 30000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);
  it('rejects invalid extra bundle fields with a server strict/error validator', async () => {
    const b = validBundle();
    await expect(
      service.control.collection<import('mongodb').Document & { _id: string }>('artifacts').insertOne({
        _id: contentHash(b),
        payload: { ...b, subjectLiteral: 'forbidden' },
        createdAt: new Date(),
        sourceBlobIds: [],
      }),
    ).rejects.toMatchObject({ code: 121 });
    await artifacts.insert(b);
  });
  it('has one concurrent owner; stale and expired heartbeats fail after takeover', async () => {
    const id = await createJob(service);
    const claimed = await Promise.all([jobs.claim(actor, id, 'a', 1000), jobs.claim(actor, id, 'b', 1000)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const first = claimed.find(Boolean)!;
    await service.control
      .collection('jobs')
      .updateOne({ _id: id } as never, { $set: { 'lease.until': new Date(0) } });
    await expect(
      jobs.renew(actor, { jobId: id, ownerId: first.lease.ownerId, fence: first.lease.fence }),
    ).rejects.toThrow('LostLease');
    const next = await jobs.claim(actor, id, 'new', 10000);
    expect(next?.lease.fence).toBe(first.lease.fence + 1);
    await expect(
      effects.commitEffect({
        actor,
        lease: { jobId: id, ownerId: first.lease.ownerId, fence: first.lease.fence },
        intent: intent(id),
        apply: async () => [],
      }),
    ).rejects.toThrow('LostLease');
    expect(await service.control.collection('effects').countDocuments()).toBe(0);
  });
  it('returns a lost-ack receipt after job terminal state and changed world without reapplying', async () => {
    const id = await createJob(service);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const lease = { jobId: id, ownerId: 'worker', fence: job.lease.fence };
    let calls = 0;
    const action = intent(id);
    await recordDecisionFor(service, action);
    const first = await effects.commitEffect({
      actor,
      lease,
      intent: action,
      apply: async () => {
        calls++;
        return [];
      },
    });
    await jobs.finish(actor, lease, 'failed', [first.receiptId]);
    const replay = await effects.commitEffect({
      actor,
      lease: { ...lease, fence: 0 },
      intent: action,
      apply: async () => {
        calls++;
        return [];
      },
    });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(await service.control.collection('effects').countDocuments()).toBe(1);
    await expect(effects.replay(actor, { ...action, argsDigest: 'b'.repeat(64) })).rejects.toThrow(
      'IdempotencyConflict',
    );
    await expect(effects.replay({ ...actor, tenantId: 'other' }, action)).rejects.toThrow('UnauthorizedJob');
  });
  it('deduplicates concurrent logical effects before revisiting obsolete world revision', async () => {
    const id = await createJob(service);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const lease = { jobId: id, ownerId: 'worker', fence: job.lease.fence };
    const action = intent(id);
    await recordDecisionFor(service, action);
    const input = { actor, lease, intent: action, apply: async () => [] };
    const results = await Promise.all([effects.commitEffect(input), effects.commitEffect(input)]);
    expect(results[0].receiptId).toBe(results[1].receiptId);
    expect(
      await service.world.collection('world_revisions').findOne({ _id: `world-${id}` } as never),
    ).toHaveProperty('revision', 1);
    expect(await service.control.collection('action_receipts').countDocuments()).toBe(1);
  });
  it('rolls back job fence/world/effect when bounded database application fails', async () => {
    const id = await createJob(service);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const action = intent(id);
    await recordDecisionFor(service, action);
    await expect(
      effects.commitEffect({
        actor,
        lease: { jobId: id, ownerId: 'worker', fence: job.lease.fence },
        intent: action,
        apply: async (session) => {
          await service.world
            .collection('customers')
            .insertOne(
              { tenantId: actor.tenantId, env: actor.env, worldId: `world-${id}`, _rev: 0 },
              { session },
            );
          throw new Error('injected');
        },
      }),
    ).rejects.toThrow('injected');
    expect((await jobs.readAuthorized(actor, id)).commitSeq).toBe(0);
    expect(await service.control.collection('effects').countDocuments()).toBe(0);
    expect(await service.world.collection('customers').countDocuments()).toBe(0);
    expect(
      await service.world.collection('world_revisions').findOne({ _id: `world-${id}` } as never),
    ).toHaveProperty('revision', 0);
  });
  it('rejects stale completion sweep and commits no completion receipt', async () => {
    const id = await createJob(service);
    await insertRegistry(service);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    await service.world
      .collection('world_revisions')
      .updateOne({ _id: `world-${id}` } as never, { $inc: { revision: 1 } });
    await expect(
      effects.complete(
        actor,
        { jobId: id, ownerId: 'worker', fence: job.lease.fence },
        completionReceipt(id),
      ),
    ).rejects.toThrow('StaleVerification');
    expect(await service.control.collection('completion_receipts').countDocuments()).toBe(0);
  });
  it('incomplete remote content stays query_visible; retry preserves acceptance proof', async () => {
    const outbox = new OutboxRepository(service);
    await outbox.enqueue(actor, {
      operationId: 'o',
      kind: 'trace',
      dedupeKey: 'o',
      jobId: 'j',
      payload: {},
      evidenceRequired: ['signals', 'tools'],
    });
    const row = (await outbox.claim(actor, 'observer'))!;
    for (const state of ['sdk_enqueued', 'ingest_accepted', 'query_visible'] as const)
      await outbox.advance(actor, 'o', 'observer', row.lease.fence, state, { contentHash: HASH });
    await expect(
      outbox.advance(actor, 'o', 'observer', row.lease.fence, 'evidence_ready', {
        contentHash: HASH,
        presentFields: ['signals'],
      }),
    ).rejects.toThrow('EvidenceIncomplete');
    await outbox.retry(actor, 'o', 'observer', row.lease.fence, 'missing_fields', 0);
    const stored = await service.control.collection('telemetry_outbox').findOne({ operationId: 'o' });
    expect(stored?.attained.ingest_accepted.contentHash).toBe(HASH);
    expect(stored?.status).toBe('retrying');
  });
  it('preserves opaque stream tokens and resumes after the last processed event', async () => {
    const offsets = service.control.collection<import('mongodb').Document & { _id: string }>(
      'stream_offsets',
    );
    const warm = service.control.collection('projection_events').watch([], { maxAwaitTimeMS: 50 });
    await warm.tryNext();
    const token = warm.resumeToken;
    expect(token).toBeTruthy();
    await warm.close();
    await offsets.insertOne({
      _id: 'consumer',
      pipelineVersion: 'v1',
      resumeToken: token,
      updatedAt: new Date(),
    });
    const projections = new ProjectionRepository(service);
    const input = {
      eventId: 'e1',
      jobId: 'j',
      runId: 'r',
      artifactIds: [],
      kind: 'job_started' as const,
      payload: PROJECTION_SAMPLES.job_started,
    };
    const seen: string[] = [];
    const firstSignal = new AbortController();
    const firstConsumer = new ProjectionStreamConsumer(service, 'consumer', 'v1');
    const first = firstConsumer.consume(
      async (e) => {
        seen.push(e.eventId);
      },
      async () => {
        throw new Error('unexpected-recovery');
      },
      firstSignal.signal,
    );
    first.catch(() => {});
    await projections.append(actor, input);
    await waitFor(async () => !sameBson((await offsets.findOne({ _id: 'consumer' }))!.resumeToken, token));
    firstSignal.abort();
    await first;
    expect(seen).toEqual(['e1']);
    const stored = await offsets.findOne({ _id: 'consumer' });
    expect(BSON.serialize(stored!.resumeToken).length).toBeGreaterThan(0);
    const secondSignal = new AbortController();
    const secondConsumer = new ProjectionStreamConsumer(service, 'consumer', 'v1');
    const second = secondConsumer.consume(
      async (e) => {
        seen.push(e.eventId);
      },
      async () => {
        throw new Error('unexpected-recovery');
      },
      secondSignal.signal,
    );
    second.catch(() => {});
    await projections.append(actor, { ...input, eventId: 'e2' });
    await waitFor(async () => seen.includes('e2'));
    secondSignal.abort();
    await second;
    expect(seen).toEqual(['e1', 'e2']);
  });
  it('performs snapshot/backfill recovery on real collection invalidation', async () => {
    const offsets = service.control.collection<import('mongodb').Document & { _id: string }>(
      'stream_offsets',
    );
    const warm = service.control.collection('projection_events').watch([], { maxAwaitTimeMS: 50 });
    await warm.tryNext();
    const token = warm.resumeToken;
    await warm.close();
    await offsets.insertOne({
      _id: 'consumer',
      pipelineVersion: 'v1',
      resumeToken: token,
      updatedAt: new Date(),
    });
    let recovered = false;
    const signal = new AbortController();
    const consumer = new ProjectionStreamConsumer(service, 'consumer', 'v1');
    const running = consumer.consume(
      async () => {},
      async (reason) => {
        expect(reason.kind).toBe('snapshot_backfill');
        recovered = true;
      },
      signal.signal,
    );
    running.catch(() => {});
    await service.control.collection('projection_events').drop();
    await waitFor(async () => recovered);
    await running;
    expect(await offsets.findOne({ _id: 'consumer' })).toBeNull();
  });
});
