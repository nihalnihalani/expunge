/**
 * The worker's REAL domain tool provider (the nine gateway tools from @expunge/domain) driven by the REAL Dispatcher on
 * a local replica set (MONGODB_TEST_URI). The model is the labeled FakeChatModel following W0's workflow: this is
 * protocol evidence for wiring and committed-state finalization, not model evidence. Not Atlas RBAC.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DeploymentRepository, JobRepository, ProjectionRepository } from '@expunge/mongo';
import { FakeChatModel, fakeText, fakeToolCalls, type FakeTurn } from '@expunge/runtime/testing';
import { HASH, liveSuite, TEST_URI } from '../../../packages/mongo/test/support.js';
import { openRig, bundles, type Rig } from '../../../packages/domain/test/rig.js';
import { FixedModelResolver } from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  MongoCommittedReader,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  MongoTerminalSweep,
  FencedProjectionSink,
  asArtifactReader,
  asDispatchJobs,
  workerConfigFromEnv,
  type LogEntry,
} from '../src/index.js';
import { createDomainToolWiring } from '../src/domain-wiring.js';
import { ArtifactRepository } from '@expunge/mongo';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');

describeLive('worker with the real domain gateway tools (local protocol lane, FAKE model)', () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await openRig('wdomain');
  }, 60_000);
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 30_000);

  it('offers the granted gateway tools and finishes an expert-workflow cleanup from a committed completion receipt', async () => {
    const seeded = await rig.seed('direct_nested', 'worker-domain-1');
    // The scope deploys the expert harness, as a promotion would have; the worker refuses a job pinned to anything else.
    await new DeploymentRepository(rig.env.service).initialize(
      seeded.actor,
      'worker',
      seeded.bundleHashes.expert,
      1,
    );
    const jobId = 'job-worker-domain-1';
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
    // The expert workflow, one scripted tool call per model turn. The model decides nothing: the gateway does.
    const workflow = [
      'inspect_scope',
      'resolve_subject',
      'discover_references',
      'preview_cleanup',
      'apply_cleanup_batch',
      'apply_cleanup_batch', // this family previews two batches
      'verify_registered_scope',
      'complete_cleanup',
    ];
    const turns: FakeTurn[] = [
      ...workflow.map((name) => fakeToolCalls([{ name, args: {} }])),
      fakeText('done'),
    ];
    const model = new FakeChatModel(turns);
    const logs: LogEntry[] = [];
    const jobs = new JobRepository(rig.executor);
    const projections = new ProjectionRepository(rig.executor);
    const dispatcher = new Dispatcher({
      jobs: asDispatchJobs(jobs),
      resolver: new MongoJobResolver(jobs),
      artifacts: asArtifactReader(new ArtifactRepository(rig.executor)),
      tools: createDomainToolWiring(rig.executor, { log: (e) => logs.push(e) }).provider,
      models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: model.adapter }),
      receipts: new MongoCompletionReceiptReader(rig.executor),
      committed: new MongoCommittedReader(rig.executor),
      projection: new FencedProjectionSink(rig.executor, jobs, projections),
      log: (e) => logs.push(e),
      config: workerConfigFromEnv({
        EXPUNGE_WORKER_ID: 'worker-domain-1',
        EXPUNGE_WORKER_LEASE_MS: '20000',
        EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '15000',
      }),
    });
    const result = await dispatcher.runJob(jobId);
    // Offered: the bundle's grants (plus the gateway's report_diagnostic and the AG-UI state tools the runtime drops).
    const offered = model.calls[0]?.toolNames ?? [];
    for (const granted of bundles.expert().toolPolicy.grants) expect(offered).toContain(granted);
    expect(result.outcome).toBe('succeeded');
    expect(result.reason).toBe('already_terminal'); // complete_cleanup committed the receipt and the terminal state together
    expect(result.receiptId).toBeDefined();
    const events = await projections.read(seeded.binding, 0, jobId);
    const terminal = events.filter(
      (e) => e.kind === 'job_status_changed' && (e.payload as { to?: string }).to === 'succeeded',
    );
    expect(terminal).toHaveLength(1); // the gateway's own; the worker adds none on this path
    expect(events.at(-1)).toBe(terminal[0]);
    // The startup repair finds a terminal event already there and appends nothing.
    const before = events.length;
    const sweeper = new Dispatcher({
      jobs: asDispatchJobs(jobs),
      resolver: new MongoJobResolver(jobs),
      artifacts: asArtifactReader(new ArtifactRepository(rig.executor)),
      tools: { create: () => [] },
      models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: model.adapter }),
      receipts: new MongoCompletionReceiptReader(rig.executor),
      projection: new FencedProjectionSink(rig.executor, jobs, projections),
      terminalSweep: new MongoTerminalSweep(rig.executor),
      config: workerConfigFromEnv({
        EXPUNGE_WORKER_ID: 'worker-domain-1',
        EXPUNGE_TENANT_ID: seeded.binding.tenantId,
        EXPUNGE_ENV: seeded.binding.env,
        EXPUNGE_SCOPE_ID: seeded.binding.scopeId,
      }),
    });
    expect(await sweeper.repairTerminalProjections()).toBe(0);
    expect(await projections.read(seeded.binding, 0, jobId)).toHaveLength(before);
  }, 60_000);
});
