import {
  contentHash,
  type ActorContext,
  type CompletionReceipt,
  type HarnessBundle,
  type Job,
} from '@expunge/contracts';
import { batchesOf } from '@expunge/domain';
import { ArtifactRepository, JobRepository, type MongoService } from '@expunge/mongo';
import type { CommittedEpisode, EpisodeEvidence, EpisodeJobHost, SeededInstance } from './episode-port.js';

/**
 * Mongo implementation of the privileged half of the worker EpisodePort. It needs more rights than the worker has and
 * so belongs to the campaign process (never the worker): `setup` installs authority, artifacts and jobs; `builder`
 * (fixture_builder) writes the world. `subjects` is the domain store of the worker's own gateway (a job's subject
 * handle is stored there, not in the job row).
 */
export type EpisodeHostDeps = {
  setup: MongoService;
  subjects: {
    putSubject(
      actor: ActorContext,
      jobId: string,
      subject: { idType: 'string'; value: string },
    ): Promise<unknown>;
  };
  /** Hash recorded as the eligibility policy of the pinned bundle's `artifact_eligibility` row. */
  eligibilityPolicyHash: string;
};

/** The stored plan row, as far as the port reads it (the gateway owns the full shape). */
type StoredPlan = { planHash: string; targets: Parameters<typeof batchesOf>[1] };

const isDuplicate = (error: unknown) =>
  Boolean(
    error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 11000,
  );

export class MongoEpisodeJobHost implements EpisodeJobHost {
  constructor(private readonly deps: EpisodeHostDeps) {}

  async pinBundle(instance: SeededInstance, bundle: HarnessBundle, bundleHash: string): Promise<void> {
    const { setup, eligibilityPolicyHash } = this.deps;
    const envelope = await new ArtifactRepository(setup).insert(bundle);
    if (envelope._id !== bundleHash) {
      const error = new Error('BundleHashMismatch');
      error.name = 'BundleHashMismatch';
      throw error;
    }
    try {
      await setup.control.collection('artifact_eligibility').insertOne({
        tenantId: instance.actor.tenantId,
        env: instance.actor.env,
        scopeId: instance.actor.scopeId,
        artifactHash: bundleHash,
        state: 'permitted',
        policyHash: eligibilityPolicyHash,
        reasonCode: 'campaign_pinned',
        sourceIds: [],
        updatedAt: new Date(),
      } as never);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
  }

  async createJob(
    instance: SeededInstance,
    job: Parameters<EpisodeJobHost['createJob']>[1],
    subjectHandle: string,
  ): Promise<void> {
    await new JobRepository(this.deps.setup).create(instance.actor, {
      jobId: job.jobId,
      kind: 'cleanup',
      binding: job.binding,
    });
    await this.deps.subjects.putSubject(instance.actor, job.jobId, {
      idType: 'string',
      value: subjectHandle,
    });
  }
}

/**
 * Committed-state reader for the EpisodePort: every read is at read concern `majority`, with a principal that may read
 * jobs, completion_receipts, effects, preview_plans and the world counters (setup or a dedicated grader reader).
 */
export class MongoEpisodeEvidence implements EpisodeEvidence {
  constructor(private readonly service: MongoService) {}
  async read(instance: SeededInstance, jobId: string, runId: string): Promise<CommittedEpisode | null> {
    const majority = { readConcern: { level: 'majority' as const } };
    const scope = {
      'actor.tenantId': instance.actor.tenantId,
      'actor.env': instance.actor.env,
      'actor.scopeId': instance.actor.scopeId,
    };
    const { control, world } = this.service;
    const job = await control
      .collection<Job & { _id: string }>('jobs')
      .findOne({ _id: jobId, ...scope }, majority);
    if (!job) return null;
    const saved = await control
      .collection<CompletionReceipt & { _id: string; actor: ActorContext; createdAt: Date }>(
        'completion_receipts',
      )
      .findOne({ jobId, runId, harnessHash: job.binding.harnessHash, ...scope }, majority);
    let receipt: CompletionReceipt | null = null;
    if (saved) {
      const { _id: _id, actor: _actor, createdAt: _createdAt, ...body } = saved;
      receipt = body;
    }
    const counter = await world
      .collection<{ _id: string; revision: number }>('world_revisions')
      .findOne({ _id: instance.worldId }, majority);
    const plan = await control.collection<StoredPlan>('preview_plans').findOne(
      {
        tenantId: instance.actor.tenantId,
        env: instance.actor.env,
        scopeId: instance.actor.scopeId,
        jobId,
        runId,
      },
      { ...majority, sort: { createdAt: -1, _id: -1 } },
    );
    let plannedBatches = 0;
    let committedBatches = 0;
    if (plan) {
      plannedBatches = batchesOf({ collectionIds: instance.collectionIds }, plan.targets).length;
      committedBatches = await control
        .collection('effects')
        .countDocuments(
          { jobId, planHash: plan.planHash, 'actor.scopeId': instance.actor.scopeId },
          majority,
        );
    }
    return { job, receipt, worldRevision: counter?.revision ?? 0, plannedBatches, committedBatches };
  }
}

/** The grader recomputes this over the receipt; exported so a campaign can check what a port reported. */
export const receiptHash = (receipt: CompletionReceipt): string =>
  contentHash(receipt as never, 'completion-receipt');
