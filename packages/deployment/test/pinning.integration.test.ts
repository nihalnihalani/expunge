/**
 * Pinning and "a new run is decided by the child bundle", through the REAL Dispatcher and domain gateway. The model is the
 * labeled FakeChatModel following the expert workflow (protocol evidence, not model evidence). The decision rows are
 * written by the gateway during the run; the test reads them back, it does not write them.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildExpertStaticBundle, buildW0Bundle } from '@expunge/baselines';
import type { ActorContext, HarnessBundle } from '@expunge/contracts';
import {
  ArtifactRepository,
  AuthorityPolicyRepository,
  DeploymentRepository,
  JobRepository,
  ProjectionRepository,
} from '@expunge/mongo';
import { FakeChatModel, fakeText, fakeToolCalls, type FakeTurn } from '@expunge/runtime/testing';
import { HASH, describeLive } from '../../mongo/test/support.js';
import {
  openRig as openDomainRig,
  infrastructureHashes,
  type Rig as DomainRig,
} from '../../domain/test/rig.js';
import { FixedModelResolver } from '../../runtime/test/fakes.js';
import {
  Dispatcher,
  FencedProjectionSink,
  MongoCommittedReader,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  asArtifactReader,
  asDispatchJobs,
  createDomainToolWiring,
  workerConfigFromEnv,
} from '../../../apps/worker/src/index.js';
import { answerApproval, createPinnedCleanupJob, promoteAdmitted, renderDescriptor } from './api.js';
import { insertLabeledAdmitReport } from './admitted-report.js';

const OPTS = { allowTestFixtures: true };
let rig: DomainRig;

describeLive(
  'pinning: a job keeps the harness it was created under; a new run after promotion is decided by the child',
  () => {
    beforeAll(async () => {
      rig = await openDomainRig('deppin');
    }, 60_000);
    afterAll(async () => {
      if (rig) await rig.dispose();
    }, 30_000);

    it('promotes, leaves the earlier job on its pin, and runs the next job under the child bundle', async () => {
      const seeded = await rig.seed('direct_nested', 'pinning-1');
      const actor: ActorContext = seeded.actor;
      const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
      const parent: HarnessBundle = buildW0Bundle(infrastructureHashes);
      const parentHash = seeded.bundleHashes.w0;
      const child: HarnessBundle = { ...buildExpertStaticBundle(infrastructureHashes), parentHash };
      const childHash = await rig.pin(seeded, child);
      const setup = rig.env.service;
      await new DeploymentRepository(setup).initialize(
        actor,
        'worker',
        parentHash,
        seeded.world.scope.revision,
      );
      await new AuthorityPolicyRepository(setup).install({ ...scope, target: 'worker' }, true);
      const promoter = await rig.env.as('promoter');
      const issuer = await rig.env.as('approval_issuer');
      const grader = await rig.env.as('grader');
      const executor = rig.executor;
      const binding = {
        runId: 'run-pin-a',
        worldId: seeded.world.worldId,
        scopeRevision: seeded.world.scope.revision,
        workerProfileHash: HASH,
      };

      // The caller has no way to name a harness; the pin is the pointer's hash at creation.
      const early = await createPinnedCleanupJob(executor, { actor, jobId: 'job-pin-early', binding });
      expect(early.binding.harnessHash).toBe(parentHash);
      // And the repository refuses any other pin on its own.
      await expect(
        new JobRepository(executor).create(actor, {
          jobId: 'job-pin-forged',
          kind: 'cleanup',
          binding: { ...binding, runId: 'run-forged', harnessHash: childHash },
        }),
      ).rejects.toThrow('HarnessNotDeployed');

      // Promote parent -> child through the stored report and a human grant.
      const stored = await insertLabeledAdmitReport(grader, {
        candidateId: 'cand-pin',
        parentHash,
        childHash,
        parent,
        child,
      });
      const request = {
        actor,
        target: 'worker' as const,
        reportId: stored.report.reportId,
        parentHash,
        childHash,
      };
      const { descriptor } = await renderDescriptor(issuer, request, OPTS);
      const answered = await answerApproval(
        issuer,
        { ...request, answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'approve' } },
        OPTS,
      );
      if (answered.state !== 'approved') throw new Error('not approved');
      const receipt = await promoteAdmitted(
        promoter,
        { ...request, grantId: answered.grantId, reason: 'pin test' },
        OPTS,
      );
      expect(receipt.toHash).toBe(childHash);

      // The earlier job still says what it was created under; a worker that claims it now refuses it.
      const stillEarly = await new JobRepository(executor).readAuthorized(actor, 'job-pin-early');
      expect(stillEarly.binding.harnessHash).toBe(parentHash);
      await expect(new JobRepository(executor).assertHarnessDeployed(actor, 'job-pin-early')).rejects.toThrow(
        'HarnessNotDeployed',
      );

      // A new job reads the new pointer.
      const later = await createPinnedCleanupJob(executor, {
        actor,
        jobId: 'job-pin-later',
        binding: { ...binding, runId: 'run-pin-b' },
      });
      expect(later.binding.harnessHash).toBe(childHash);
      await rig.domain.store.putSubject(actor, 'job-pin-later', {
        idType: 'string',
        value: seeded.world.subjectHandle,
      });

      // Run it for real: the expert workflow, one scripted call per model turn (the model decides nothing).
      const workflow = [
        'inspect_scope',
        'resolve_subject',
        'discover_references',
        'preview_cleanup',
        'apply_cleanup_batch',
        'apply_cleanup_batch',
        'verify_registered_scope',
        'complete_cleanup',
      ];
      const turns: FakeTurn[] = [
        ...workflow.map((name) => fakeToolCalls([{ name, args: {} }])),
        fakeText('done'),
      ];
      const model = new FakeChatModel(turns);
      const jobs = new JobRepository(executor);
      const dispatcher = new Dispatcher({
        jobs: asDispatchJobs(jobs),
        resolver: new MongoJobResolver(jobs),
        artifacts: asArtifactReader(new ArtifactRepository(executor)),
        tools: createDomainToolWiring(executor).provider,
        models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: model.adapter }),
        receipts: new MongoCompletionReceiptReader(executor),
        committed: new MongoCommittedReader(executor),
        projection: new FencedProjectionSink(executor, jobs, new ProjectionRepository(executor)),
        config: workerConfigFromEnv({
          EXPUNGE_WORKER_ID: 'worker-pin',
          EXPUNGE_WORKER_LEASE_MS: '20000',
          EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '15000',
        }),
      });
      const result = await dispatcher.runJob('job-pin-later');
      expect(result.outcome).toBe('succeeded');
      const decisions = await setup.control
        .collection('decisions')
        .find({ jobId: 'job-pin-later' })
        .toArray();
      expect(decisions.length).toBeGreaterThan(0);
      // Every decision the gateway recorded for this run names the child bundle, not the parent.
      expect(decisions.every((row) => row.harnessHash === childHash)).toBe(true);
      expect(decisions.some((row) => row.harnessHash === parentHash)).toBe(false);
    }, 180_000);
  },
);
