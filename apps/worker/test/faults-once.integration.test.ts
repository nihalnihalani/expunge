/**
 * A campaign world's stored fault plan fires exactly as declared when a worker runs it: the gateway injects it (spent in
 * the fenced step log) and the worker adds nothing. REAL Dispatcher and domain tools on a local replica set
 * (MONGODB_TEST_URI); the model is a labeled FakeChatModel that retries what an agent would retry. Not Atlas RBAC.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { storedFaultPlan } from '@expunge/domain';
import {
  ArtifactRepository,
  DeploymentRepository,
  JobRepository,
  ProjectionRepository,
} from '@expunge/mongo';
import { FakeChatModel, fakeText, fakeToolCalls, type FakeTurn } from '@expunge/runtime/testing';
import { HASH, liveSuite, TEST_URI } from '../../../packages/mongo/test/support.js';
import { openRig, type Rig } from '../../../packages/domain/test/rig.js';
import { FixedModelResolver } from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  FencedProjectionSink,
  MongoCommittedReader,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  asArtifactReader,
  asDispatchJobs,
  workerConfigFromEnv,
} from '../src/index.js';
import { createDomainToolWiring } from '../src/domain-wiring.js';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');

describeLive('stored fault plan fires once, in the gateway only (local protocol lane, FAKE model)', () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await openRig('wfaults');
  }, 60_000);
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 30_000);

  it('a plan with transientFailures: 2 yields exactly 2 transient faults in the step log, not double', async () => {
    const seeded = await rig.seed('direct_nested', 'worker-faults-1');
    await rig.env.service.world
      .collection('world_scope_bindings')
      .updateOne({ _id: seeded.world.worldId as never }, { $set: { campaignId: 'campaign-faults-once' } });
    await rig.env.service.control.collection('world_faults').insertOne(
      storedFaultPlan(seeded.binding, seeded.world.worldId, {
        partialAcknowledgements: 0,
        interruptAfterEffects: null,
        transientFailures: 2,
      }) as never,
    );
    await new DeploymentRepository(rig.env.service).initialize(
      seeded.actor,
      'worker',
      seeded.bundleHashes.expert,
      1,
    );
    const jobId = 'job-worker-faults-1';
    await new JobRepository(rig.env.service).create(seeded.actor, {
      jobId,
      kind: 'cleanup',
      binding: {
        runId: `run-${jobId}`,
        worldId: seeded.world.worldId,
        harnessHash: seeded.bundleHashes.expert,
        scopeRevision: seeded.world.scope.revision,
        workerProfileHash: HASH,
      },
    });
    await rig.domain.store.putSubject(seeded.actor, jobId, {
      idType: 'string',
      value: seeded.world.subjectHandle,
    });
    // The two first apply calls fail transiently (nothing committed); the agent retries the same call, then both batches.
    const workflow = [
      'inspect_scope',
      'resolve_subject',
      'discover_references',
      'preview_cleanup',
      'apply_cleanup_batch', // transient #1
      'apply_cleanup_batch', // transient #2
      'apply_cleanup_batch', // batch 1
      'apply_cleanup_batch', // batch 2
      'verify_registered_scope',
      'complete_cleanup',
    ];
    const model = new FakeChatModel([
      ...workflow.map((name) => fakeToolCalls([{ name, args: {} }])),
      fakeText('done'),
    ] as FakeTurn[]);
    const jobs = new JobRepository(rig.executor);
    const base = createDomainToolWiring(rig.executor, { log: () => undefined }).provider;
    const dispatcher = new Dispatcher({
      jobs: asDispatchJobs(jobs),
      resolver: new MongoJobResolver(jobs),
      artifacts: asArtifactReader(new ArtifactRepository(rig.executor)),
      tools: base, // the provider exactly as the worker wires it: no fault wrapper
      models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: model.adapter }),
      receipts: new MongoCompletionReceiptReader(rig.executor),
      committed: new MongoCommittedReader(rig.executor),
      projection: new FencedProjectionSink(rig.executor, jobs, new ProjectionRepository(rig.executor)),
      log: () => undefined,
      config: workerConfigFromEnv({
        EXPUNGE_WORKER_ID: 'worker-faults-1',
        EXPUNGE_WORKER_LEASE_MS: '20000',
        EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '15000',
      }),
    });
    const result = await dispatcher.runJob(jobId);
    const faults = await rig.env.service.control
      .collection('domain_steps')
      .find({ jobId, kind: 'fault' })
      .toArray();
    const spent = (kind: string) => faults.filter((row) => (row.payload as { kind?: string }).kind === kind);
    expect(spent('transient')).toHaveLength(2); // the plan's count, once each
    expect(spent('lost_ack')).toHaveLength(0);
    expect(spent('interrupt')).toHaveLength(0);
    expect(spent('attest')).toHaveLength(1);
    expect(result.outcome).toBe('succeeded');
  }, 60_000);
});
