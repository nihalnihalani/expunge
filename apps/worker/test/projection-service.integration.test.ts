/**
 * A job run by the REAL Dispatcher with the REAL gateway tools (FAKE scripted model; protocol evidence only) is shown by
 * the domain service's read projection: its snapshot, its event pages and the list, parsed with the OPERATOR's own strict
 * schemas. The service module is called directly (the handler only routes to it).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DeploymentRepository, JobRepository, ProjectionRepository } from '@expunge/mongo';
import { FakeChatModel, fakeText, fakeToolCalls, type FakeTurn } from '@expunge/runtime/testing';
import { HASH, liveSuite, TEST_URI } from '../../../packages/mongo/test/support.js';
import { openRig, type Rig } from '../../../packages/domain/test/rig.js';
import { FixedModelResolver } from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  MongoCommittedReader,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  FencedProjectionSink,
  asArtifactReader,
  asDispatchJobs,
  workerConfigFromEnv,
  type LogEntry,
} from '../src/index.js';
import { createDomainToolWiring } from '../src/domain-wiring.js';
import { serveProjection } from '../../../packages/domain/src/service/projection.js';
import { snapshotSchema, jobListSchema, parseEventsPage } from '../../operator/src/server/expunge/schemas.js';
import { ArtifactRepository } from '@expunge/mongo';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');

describeLive(
  'a job run by the worker is served by the read projection (local protocol lane, FAKE model)',
  () => {
    let rig: Rig;
    beforeAll(async () => {
      rig = await openRig('wprojection');
    }, 60_000);
    afterAll(async () => {
      if (rig) await rig.dispose();
    }, 30_000);

    it('shows its snapshot, event pages and list entry, with one epoch and the committed receipt', async () => {
      const seeded = await rig.seed('direct_nested', 'worker-projection-1');
      // The scope deploys the expert harness, as a promotion would have; the worker refuses a job pinned to anything else.
      await new DeploymentRepository(rig.env.service).initialize(
        seeded.actor,
        'worker',
        seeded.bundleHashes.expert,
        1,
      );
      const jobId = 'job-worker-projection-1';
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
          EXPUNGE_WORKER_ID: 'worker-projection-1',
          EXPUNGE_WORKER_LEASE_MS: '20000',
          EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '15000',
        }),
      });
      const result = await dispatcher.runJob(jobId);
      expect(result).toMatchObject({ outcome: 'succeeded' });
      const config = {
        owner: { ownerId: 'owner', scope: seeded.binding },
        tokens: { read: 'r'.repeat(32) },
        previewTtlMs: 60_000,
      };
      const serve = async (key: 'GET jobs' | 'GET events', path: string, id?: string) =>
        (
          await serveProjection(
            rig.domain,
            config,
            { key, ...(id ? { id } : {}) },
            new URL(`http://domain.test/internal/projection${path}`),
          )
        ).body;

      const snapshot = snapshotSchema.parse(await serve('GET jobs', `/jobs/${jobId}`, jobId));
      expect(snapshot).toMatchObject({ jobId, status: 'succeeded', kind: 'cleanup', runId: `run-${jobId}` });
      expect(snapshot.receipt?.receiptId).toBe(result.receiptId);
      expect(snapshot.harness).toMatchObject({ hash: seeded.bundleHashes.expert }); // the deployed harness the worker verified
      expect(snapshot.cost.modelCalls).toBeGreaterThan(0); // the job's carried meter
      const page = parseEventsPage(
        await serve('GET events', `/jobs/${jobId}/events?afterSequence=0`, jobId),
        jobId,
        0,
      );
      expect(page.streamEpoch).toBe(snapshot.streamEpoch);
      expect(page.events.at(-1)?.sequence).toBe(snapshot.sequence);
      expect(page.events.map((e) => e.kind)).toContain('receipt_committed');
      const list = jobListSchema.parse(await serve('GET jobs', '/jobs'));
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({
        jobId,
        status: 'succeeded',
        receiptId: result.receiptId,
        receiptSequence: snapshot.receipt?.sequence,
        receiptDomainStatus: 'complete_in_registered_scope',
      });
    }, 60_000);
  },
);
