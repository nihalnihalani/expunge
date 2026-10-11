/**
 * Dispatcher against the REAL JobRepository / ArtifactRepository on a local replica set (the unauthenticated
 * protocol lane: MONGODB_TEST_URI). This is MongoDB protocol evidence for claim/renew/fence/checkpoint/yield/
 * finish/cancel. It is NOT evidence about Atlas RBAC or the invited deployment, and the model is the labeled
 * FakeChatModel, so it is not provider evidence either.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import {
  ArtifactRepository,
  JobRepository,
  ProjectionRepository,
  WakeCommandRepository,
  type MongoService,
} from '@expunge/mongo';
import { JobWaitSignal } from '@expunge/runtime';
import { FakeChatModel, fakeHang, fakeText, fakeToolCalls } from '@expunge/runtime/testing';
import { defineTool, type ToolDefinition } from '@expunge/vendor-openmuse';
import { z } from 'zod';
import {
  HASH,
  TEST_URI,
  actor,
  createJob,
  liveSuite,
  openEnvironment,
  waitFor,
  type LiveEnvironment,
  deployWorker,
} from '../../../packages/mongo/test/support.js';
import { FakeToolProvider, FixedModelResolver, makeBundle } from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  MongoWakeCommandStore,
  asProjectionSink,
  asArtifactReader,
  asDispatchJobs,
  workerConfigFromEnv,
} from '../src/index.js';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');
type StoredJob = {
  status: string;
  lease: { ownerId: string; fence: number; until: Date };
  contextInputs: string[];
  checkpoint: { terminal: { decision: unknown } };
};
const bundle = makeBundle({ toolPolicy: { grants: ['echo', 'ask'], prerequisites: [] } });
const harnessHash = contentHash(bundle);

describeLive('Dispatcher with the real JobRepository (local replica-set protocol lane)', () => {
  let env: LiveEnvironment;
  let setup: MongoService;
  let executor: MongoService;
  beforeAll(async () => {
    env = await openEnvironment('worker');
    setup = env.service;
    executor = await env.as('domain_executor');
  }, 30_000);
  beforeEach(async () => {
    await env.reset();
    await deployWorker(setup, bundle); // stores the artifact and points the scope's deployment at it
    await setup.control.collection('artifact_eligibility').insertOne({
      tenantId: actor.tenantId,
      env: actor.env,
      scopeId: actor.scopeId,
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

  function dispatcherFor(
    script: ConstructorParameters<typeof FakeChatModel>[0],
    tools: () => ToolDefinition[],
    config: Record<string, string> = {},
  ) {
    const jobs = new JobRepository(executor);
    const fake = new FakeChatModel(script);
    const dispatcher = new Dispatcher({
      jobs: asDispatchJobs(jobs),
      resolver: new MongoJobResolver(jobs),
      artifacts: asArtifactReader(new ArtifactRepository(executor)),
      tools: new FakeToolProvider(() => tools()),
      models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
      receipts: new MongoCompletionReceiptReader(executor),
      projection: asProjectionSink(new ProjectionRepository(executor)),
      config: workerConfigFromEnv({
        EXPUNGE_WORKER_ID: 'worker-int-1',
        EXPUNGE_WORKER_LEASE_MS: '600',
        EXPUNGE_TENANT_ID: actor.tenantId,
        EXPUNGE_ENV: actor.env,
        EXPUNGE_SCOPE_ID: actor.scopeId,
        ...config,
      }),
    });
    return { jobs, fake, dispatcher };
  }
  const makeTools = (): ToolDefinition[] => [
    defineTool({
      name: 'echo',
      description: 'e',
      parameters: z.object({ v: z.number() }),
      execute: async () => ({ ok: true }),
    }),
  ];
  const stored = async (id: string) =>
    (await setup.control.collection('jobs').findOne({ _id: id } as never)) as unknown as StoredJob;

  it('claims, records context inputs (permission-checked), checkpoints each phase, and fails a narrative-only run', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher, fake } = dispatcherFor(
      [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('All records deleted.')],
      makeTools,
    );
    const result = await dispatcher.runJob(id);
    const job = await stored(id);
    expect(result.outcome).toBe('failed');
    expect(job.status).toBe('failed');
    expect(job.lease.ownerId).toBe('worker-int-1');
    expect(job.lease.fence).toBe(1);
    expect(job.contextInputs).toEqual([harnessHash]);
    expect(job.checkpoint.terminal.decision).toEqual({ status: 'failed', reason: 'NoCompletionReceipt' });
    expect(JSON.stringify(job.checkpoint)).not.toContain('All records deleted');
    expect(fake.turnsConsumed).toBe(2);
  });

  it('refuses to start a job whose pinned harness stopped being the deployed one between create and claim: a committed failure, no model call, no effect', async () => {
    const id = await createJob(setup, { harnessHash });
    // A rollback or promotion moves the scope's deployment pointer after the job was created.
    const moved = await setup.control
      .collection('deployments')
      .updateMany({ tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId } as never, {
        $set: { activeHash: 'e'.repeat(64) },
      });
    expect(moved.modifiedCount).toBe(1);
    let toolRan = false;
    const { dispatcher, fake } = dispatcherFor(
      [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('never')],
      () => [
        defineTool({
          name: 'echo',
          description: 'e',
          parameters: z.object({ v: z.number() }),
          execute: async () => ((toolRan = true), { ok: true }),
        }),
      ],
    );
    const result = await dispatcher.runJob(id);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'HarnessNotDeployed' });
    expect(fake.turnsConsumed).toBe(0);
    expect(toolRan).toBe(false);
    const job = await stored(id);
    expect(job.status).toBe('failed');
    expect(job.checkpoint.terminal.decision).toEqual({ status: 'failed', reason: 'HarnessNotDeployed' });
    expect(job.contextInputs ?? []).toEqual([]); // nothing was placed in model context
    const events = await new ProjectionRepository(setup).read(
      { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId },
      0,
      id,
    );
    expect(events.map((e) => e.kind)).toEqual(['job_failed']);
    expect(events[0]?.payload).toMatchObject({ code: 'policy_denied', message: 'HarnessNotDeployed' });
  });

  it('refuses to run when the pinned harness is not permitted in the job scope', async () => {
    await setup.control.collection('artifact_eligibility').deleteMany({});
    const id = await createJob(setup, { harnessHash });
    const { dispatcher, fake } = dispatcherFor([fakeText('never')], makeTools);
    const result = await dispatcher.runJob(id);
    expect(result.stats?.errorCode).toBe('HarnessUnavailable');
    expect(fake.calls).toHaveLength(0);
    expect((await stored(id)).status).toBe('failed');
  });

  it('turns jobs.cancel() on a live lease into a cancelled job while the model call is blocked', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher, jobs, fake } = dispatcherFor([fakeHang()], makeTools);
    const running = dispatcher.runJob(id);
    await waitFor(async () => fake.calls.length === 1);
    await jobs.cancel(actor, id);
    const result = await running;
    expect(fake.hangObservedAbort).toBe(true);
    expect(result.outcome).toBe('cancelled');
    expect((await stored(id)).status).toBe('cancelled');
  });

  it('writes nothing after another worker takes the lease over (fence)', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher, jobs, fake } = dispatcherFor([fakeHang()], makeTools);
    const running = dispatcher.runJob(id);
    await waitFor(async () => fake.calls.length === 1);
    // Force the lease to look expired, then let a second worker claim it (new fence).
    await setup.control
      .collection('jobs')
      .updateOne({ _id: id } as never, { $set: { 'lease.until': new Date(0) } });
    const takeover = await jobs.claim(actor, id, 'worker-int-2', 30_000);
    expect(takeover?.lease.fence).toBe(2);
    const result = await running;
    expect(result.outcome).toBe('lost_lease');
    const job = await stored(id);
    expect(job.status).toBe('running');
    expect(job.lease.ownerId).toBe('worker-int-2');
    expect(job.lease.fence).toBe(2);
  });

  it('yields to waiting_approval and releases the lease', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher } = dispatcherFor(
      [fakeToolCalls([{ name: 'ask', args: {} }]), fakeText('never')],
      () => [
        defineTool({
          name: 'ask',
          description: 'a',
          parameters: z.object({}),
          execute: async () => {
            throw new JobWaitSignal('waiting_approval');
          },
        }),
      ],
    );
    const result = await dispatcher.runJob(id);
    expect(result.outcome).toBe('yielded');
    const job = await stored(id);
    expect(job.status).toBe('waiting_approval');
    expect(new Date(job.lease.until).getTime()).toBe(0);
  });

  it('leaves a job it cannot claim untouched (already held by a live lease)', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher, jobs } = dispatcherFor([fakeText('never')], makeTools);
    await jobs.claim(actor, id, 'someone-else', 30_000);
    const result = await dispatcher.runJob(id);
    expect(result.outcome).toBe('not_claimable');
    expect((await stored(id)).lease.ownerId).toBe('someone-else');
  });

  const scopeKey = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

  it('persists committed-state projection events through ProjectionRepository with contiguous sequences', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher } = dispatcherFor([fakeText('Done!')], makeTools);
    await dispatcher.runJob(id);
    const events = await new ProjectionRepository(executor).read(scopeKey, 0, id);
    expect(events.map((e) => [e.sequence, e.kind])).toEqual([
      [1, 'job_started'],
      [2, 'job_failed'],
    ]);
    expect(events[1]?.payload).toMatchObject({ code: 'verification_failed', retryable: false, phase: null });
    // Re-running the append with the same event id is idempotent (same payload returns the stored row).
    const again = await new ProjectionRepository(executor).append(scopeKey, {
      eventId: `${id}:started:1`,
      jobId: id,
      runId: `run-${id}`,
      artifactIds: [harnessHash],
      kind: 'job_started',
      payload: events[0]!.payload as never,
    });
    expect(again.sequence).toBe(1);
  });

  it('dedupes wake commands durably: a second store instance (a restart) still sees the id as a duplicate', async () => {
    const first = new MongoWakeCommandStore(new WakeCommandRepository(executor));
    const command = { jobId: 'job-x', commandId: 'command-durable-0001' };
    expect(await first.accept(command)).toBe('accepted');
    expect(await first.accept(command)).toBe('duplicate');
    const afterRestart = new MongoWakeCommandStore(new WakeCommandRepository(executor));
    expect(await afterRestart.accept(command)).toBe('duplicate');
    expect(await afterRestart.accept({ ...command, commandId: 'command-durable-0002' })).toBe('accepted');
  });

  it('recovers a crashed worker: poll finds the lease-expired job via listClaimable and reclaims it under a new fence', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher, jobs } = dispatcherFor([fakeText('x')], makeTools);
    const dead = await jobs.claim(actor, id, 'dead-worker', 150);
    expect(dead?.lease.fence).toBe(1);
    expect(await dispatcher.poll()).toBe(0); // lease still live: not claimable yet
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await dispatcher.poll()).toBe(1);
    await dispatcher.idle();
    const job = await stored(id);
    expect(job.lease.fence).toBe(2);
    expect(job.lease.ownerId).toBe('worker-int-1');
    expect(job.status).toBe('failed'); // fake model narrates; no receipt, so the job is failed truthfully
  });

  it('on graceful stop, RELEASES the running job (running -> queued) so another worker can claim at once', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher, jobs, fake } = dispatcherFor([fakeHang()], makeTools);
    dispatcher.wake({ jobId: id, commandId: 'command-stop-0001' });
    await waitFor(async () => fake.calls.length === 1);
    await dispatcher.stop();
    const job = await stored(id);
    expect(job.status).toBe('queued');
    expect(job.lease.fence).toBe(1);
    expect(new Date(job.lease.until).getTime()).toBe(0);
    expect((await jobs.claim(actor, id, 'worker-int-2', 5000))?.lease.fence).toBe(2);
  });

  it('refuses a job outside the configured scope without claiming it', async () => {
    const id = await createJob(setup, { harnessHash });
    const { dispatcher } = dispatcherFor([fakeText('x')], makeTools, { EXPUNGE_SCOPE_ID: 'another-scope' });
    expect((await dispatcher.runJob(id)).outcome).toBe('out_of_scope');
    expect((await stored(id)).status).toBe('queued');
  });
});
