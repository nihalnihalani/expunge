/**
 * V-3 findings (a) and (b) against the REAL JobRepository and ProjectionRepository on a local replica set (the
 * unauthenticated protocol lane: MONGODB_TEST_URI). MongoDB protocol evidence only: not Atlas RBAC. The model is the
 * labeled FakeChatModel; no Raindrop is involved.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import { PROJECTION_SAMPLES } from '../../../packages/contracts/test/projection-samples.js';
import { ArtifactRepository, JobRepository, ProjectionRepository, type MongoService } from '@expunge/mongo';
import { FakeChatModel, fakeText } from '@expunge/runtime/testing';
import {
  HASH,
  TEST_URI,
  actor,
  createJob,
  liveSuite,
  openEnvironment,
  type LiveEnvironment,
} from '../../../packages/mongo/test/support.js';
import { FakeToolProvider, FixedModelResolver, makeBundle } from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  FencedProjectionSink,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  MongoTerminalSweep,
  asArtifactReader,
  asDispatchJobs,
  workerConfigFromEnv,
  type LogEntry,
  type ProjectionSink,
} from '../src/index.js';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');
const bundle = makeBundle({ toolPolicy: { grants: ['echo'], prerequisites: [] } });
const harnessHash = contentHash(bundle);
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

describeLive('V-3 fenced and repairable terminal projection (local protocol lane)', () => {
  let env: LiveEnvironment;
  let setup: MongoService;
  let executor: MongoService;
  beforeAll(async () => {
    env = await openEnvironment('wproj');
    setup = env.service;
    executor = await env.as('domain_executor');
  }, 30_000);
  beforeEach(async () => {
    await env.reset();
    await new ArtifactRepository(setup).insert(bundle);
    await setup.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash: harnessHash,
      state: 'permitted',
      policyHash: HASH,
      reasonCode: 'test',
      sourceIds: [],
      updatedAt: new Date(),
    });
  });
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  const sink = () =>
    new FencedProjectionSink(executor, new JobRepository(executor), new ProjectionRepository(executor));
  const kinds = async (jobId: string) =>
    (await new ProjectionRepository(setup).read(scope, 0, jobId)).map((e) => e.kind);
  /** A terminal event (`job_failed`) and an ordinary progress event (`job_started`). */
  const event = (jobId: string, eventId: string) => ({
    eventId,
    jobId,
    runId: `run-${jobId}`,
    artifactIds: [],
    kind: 'job_failed' as const,
    payload: { code: 'internal_error' as const, retryable: false, phase: null, message: 'x' },
  });
  const progress = (jobId: string, eventId: string) => ({
    eventId,
    jobId,
    runId: `run-${jobId}`,
    artifactIds: [],
    kind: 'job_started' as const,
    payload: PROJECTION_SAMPLES.job_started,
  });
  const expire = (id: string) =>
    setup.control
      .collection('jobs')
      .updateOne({ _id: id } as never, { $set: { 'lease.until': new Date(0) } });

  it('a zombie holding the old fence is refused with StaleFence and writes nothing; the new holder can write while running and its terminal event after finishing', async () => {
    const jobs = new JobRepository(executor);
    const id = await createJob(setup, { harnessHash });
    const a = { jobId: id, ownerId: 'worker-a', fence: 0 };
    a.fence = (await jobs.claim(actor, id, 'worker-a', 600))!.lease.fence;
    await sink().appendFenced(scope, progress(id, `${id}:one`), { actor, lease: a });
    expect(await kinds(id)).toEqual(['job_started']);

    await expire(id); // worker-a freezes; its lease expires; worker-b takes over (fence + 1)
    const b = {
      jobId: id,
      ownerId: 'worker-b',
      fence: (await jobs.claim(actor, id, 'worker-b', 600))!.lease.fence,
    };
    expect(b.fence).toBe(a.fence + 1);

    await expect(
      sink().appendFenced(scope, progress(id, `${id}:zombie`), { actor, lease: a }),
    ).rejects.toMatchObject({
      code: 'StaleFence',
    });
    expect(await kinds(id)).toEqual(['job_started']); // only the first, legitimate event
    await sink().appendFenced(scope, progress(id, `${id}:b-progress`), { actor, lease: b });

    await jobs.finish(actor, b, 'failed', []);
    // The holder appends its terminal event after its own transition: the job is already `failed`, the lease is gone.
    await sink().appendFenced(scope, event(id, `${id}:terminal`), { actor, lease: b });
    expect(await kinds(id)).toEqual(['job_started', 'job_started', 'job_failed']);
    await expect(
      sink().appendFenced(scope, event(id, `${id}:late`), { actor, lease: a }),
    ).rejects.toMatchObject({
      code: 'StaleFence',
    });
  });

  it('PKT33-A: after the job finished, even its own holder cannot add progress; a second, different terminal event is refused; the same id is idempotent', async () => {
    const jobs = new JobRepository(executor);
    const id = await createJob(setup, { harnessHash });
    const lease = {
      jobId: id,
      ownerId: 'worker-a',
      fence: (await jobs.claim(actor, id, 'worker-a', 600))!.lease.fence,
    };
    await jobs.finish(actor, lease, 'failed', []);
    await expect(
      sink().appendFenced(scope, progress(id, `${id}:after`), { actor, lease }),
    ).rejects.toMatchObject({
      code: 'StaleFence',
    });
    await sink().appendFenced(scope, event(id, `${id}:terminal`), { actor, lease });
    await sink().appendFenced(scope, event(id, `${id}:terminal`), { actor, lease }); // same event id: no-op
    await expect(
      sink().appendFenced(scope, event(id, `${id}:other`), { actor, lease }),
    ).rejects.toMatchObject({
      code: 'TerminalExists',
    });
    expect(await kinds(id)).toEqual(['job_failed']);
  });

  it('PKT33-A: an expired lease that nobody reclaimed cannot append progress either (database time)', async () => {
    const jobs = new JobRepository(executor);
    const id = await createJob(setup, { harnessHash });
    const lease = {
      jobId: id,
      ownerId: 'worker-a',
      fence: (await jobs.claim(actor, id, 'worker-a', 600))!.lease.fence,
    };
    await sink().appendFenced(scope, progress(id, `${id}:live`), { actor, lease });
    await expire(id);
    await expect(
      sink().appendFenced(scope, progress(id, `${id}:expired`), { actor, lease }),
    ).rejects.toMatchObject({
      code: 'StaleFence',
    });
    expect(await kinds(id)).toEqual(['job_started']);
  });

  it('the fence alone is enough: the SAME worker id re-claims after expiry with a higher fence, and its append carrying the OLD fence is refused', async () => {
    const jobs = new JobRepository(executor);
    const id = await createJob(setup, { harnessHash });
    const old = {
      jobId: id,
      ownerId: 'worker-a',
      fence: (await jobs.claim(actor, id, 'worker-a', 600))!.lease.fence,
    };
    await expire(id);
    const current = {
      jobId: id,
      ownerId: 'worker-a',
      fence: (await jobs.claim(actor, id, 'worker-a', 600))!.lease.fence,
    };
    expect(current.fence).toBe(old.fence + 1);

    await expect(
      sink().appendFenced(scope, progress(id, `${id}:old-fence`), { actor, lease: old }),
    ).rejects.toMatchObject({
      code: 'StaleFence',
    });
    expect(await kinds(id)).toEqual([]);
    await sink().appendFenced(scope, progress(id, `${id}:current`), { actor, lease: current });
    expect(await kinds(id)).toEqual(['job_started']);
  });

  it('every fenced append is a real write on the job row (eventSeq), so it always conflicts with a concurrent claim', async () => {
    const jobs = new JobRepository(executor);
    const id = await createJob(setup, { harnessHash });
    const lease = {
      jobId: id,
      ownerId: 'worker-a',
      fence: (await jobs.claim(actor, id, 'worker-a', 600))!.lease.fence,
    };
    const seq = async () =>
      (
        (await setup.control.collection('jobs').findOne({ _id: id } as never)) as unknown as {
          eventSeq: number;
        }
      ).eventSeq;
    const before = await seq();
    await sink().appendFenced(scope, progress(id, `${id}:1`), { actor, lease });
    await sink().appendFenced(scope, progress(id, `${id}:2`), { actor, lease });
    expect(await seq()).toBe(before + 2);
  });

  it('PKT33-B: hasTerminal finds a terminal event after more than 1000 other events', async () => {
    const projections = new ProjectionRepository(executor);
    const id = await createJob(setup, { harnessHash });
    for (let i = 0; i < 1010; i++) await projections.append(scope, progress(id, `${id}:p${i}`));
    expect(await sink().hasTerminal(scope, id)).toBe(false);
    await projections.append(scope, event(id, `${id}:last`));
    expect(await sink().hasTerminal(scope, id)).toBe(true);
    expect(await projections.read(scope, 0, id, 1000)).toHaveLength(1000); // the old bounded page missed it
  }, 60_000);

  function dispatcher(projection: ProjectionSink, logs: LogEntry[] = []) {
    const jobs = new JobRepository(executor);
    return new Dispatcher({
      jobs: asDispatchJobs(jobs),
      resolver: new MongoJobResolver(jobs),
      artifacts: asArtifactReader(new ArtifactRepository(executor)),
      tools: new FakeToolProvider(() => []),
      models: new FixedModelResolver({
        spec: 'fake/fake',
        textAdapter: new FakeChatModel([fakeText('narrative only')]).adapter,
      }),
      receipts: new MongoCompletionReceiptReader(executor),
      projection,
      terminalSweep: new MongoTerminalSweep(executor),
      log: (entry) => logs.push(entry),
      config: workerConfigFromEnv({
        EXPUNGE_WORKER_ID: 'worker-proj-1',
        EXPUNGE_WORKER_LEASE_MS: '600',
        EXPUNGE_TENANT_ID: actor.tenantId,
        EXPUNGE_ENV: actor.env,
        EXPUNGE_SCOPE_ID: actor.scopeId,
      }),
    });
  }

  it('a terminal projection lost on a crash is repaired on restart from committed state, once', async () => {
    const id = await createJob(setup, { harnessHash });
    // The process "dies" after the job transition and before its terminal event: that append never happens.
    const crashing: ProjectionSink = {
      append: async () => undefined,
      appendFenced: async (key, ev, holder) => {
        if (ev.kind === 'job_failed') throw new Error('process died before the terminal event');
        return sink().appendFenced(key, ev, holder);
      },
    };
    const first = await dispatcher(crashing).runJob(id);
    expect(first.outcome).toBe('failed');
    expect(await kinds(id)).toEqual(['job_started']); // the stream is behind the committed job
    expect(await setup.control.collection('jobs').findOne({ _id: id } as never)).toMatchObject({
      status: 'failed',
    });

    // Restart: a new dispatcher with the real sink sweeps recently finished jobs.
    const restarted = dispatcher(sink());
    expect(await restarted.repairTerminalProjections()).toBe(1);
    expect(await kinds(id)).toEqual(['job_started', 'job_failed']);
    const repaired = (await new ProjectionRepository(setup).read(scope, 0, id)).at(-1)!;
    expect(repaired.payload).toMatchObject({ code: 'verification_failed', message: 'NoCompletionReceipt' });
    expect(await restarted.repairTerminalProjections()).toBe(0); // already has its terminal event
    expect(await kinds(id)).toEqual(['job_started', 'job_failed']);
  });
});
