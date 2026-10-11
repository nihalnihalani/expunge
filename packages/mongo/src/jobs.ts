import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Document, Filter } from 'mongodb';
import {
  assertJobAccess,
  type ActorContext,
  type Job,
  type JobKind,
  type JobStatus,
  type JsonValue,
  type RunBinding,
  type ScopeKey,
} from '@expunge/contracts';
import { fail, requirePrincipal, type MongoService, type Principal } from './client.js';
import { ProvenanceRepository } from './provenance.js';
import { WorldRepository } from './worlds.js';
import { worldKeyOf, type WorldKey } from './worldkey.js';

/** A job cannot hold more recorded context inputs than this; the runtime must summarize past it. */
export const MAX_CONTEXT_INPUTS = 4096;
const MAX_CONTEXT_INPUTS_PER_CALL = 512;

function contextHashes(values: readonly string[], limit: number): string[] {
  const unique = [...new Set(values)];
  if (
    unique.length > limit ||
    unique.some((value) => typeof value !== 'string' || !value || value.length > 256)
  )
    fail('InvalidContextInputs');
  return unique;
}

/**
 * Which principal may claim and drive each job kind. A principal outside the list cannot hold a lease on, renew,
 * checkpoint or finish a job of that kind, even if it learned the owner and fence. `setup` is the local
 * administrator used by tests and migrations.
 */
export const JOB_KIND_PRINCIPALS: Record<JobKind, readonly Principal[]> = {
  cleanup: ['domain_executor'],
  observe: ['observer'],
  propose: ['observer'],
  evaluate: ['grader'],
  meta_evaluate: ['grader'],
  adversarial_generate: ['fixture_builder'],
  promote: ['promoter'],
  rollback: ['promoter'],
  redact: ['privacy_controller'],
  external_delete: ['privacy_controller'],
};
const NON_TERMINAL_WAITING = ['waiting_evidence', 'waiting_approval', 'waiting_external'] as const;

export type LeaseBinding = { jobId: string; ownerId: string; fence: number };
export function liveJobFilter(lease: LeaseBinding): Filter<Job> {
  return {
    _id: lease.jobId,
    status: 'running',
    cancellationRequested: false,
    'lease.ownerId': lease.ownerId,
    'lease.fence': lease.fence,
    $expr: { $gt: ['$lease.until', '$$NOW'] },
  };
}
function leaseDuration(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 100 || ms > 120000) fail('InvalidLeaseDuration');
}
export class JobRepository {
  readonly collection: Collection<Job>;
  constructor(readonly service: MongoService) {
    this.collection = service.control.collection<Job>('jobs');
  }
  async create(
    actor: ActorContext,
    input: {
      jobId?: string;
      kind: JobKind;
      binding: Omit<RunBinding, 'jobId'>;
      parentJobId?: string;
      inputRefs?: string[];
      /** Artifact, evidence and lesson hashes already placed in context at creation. Defaults to none. */
      contextInputs?: string[];
      priority?: number;
    },
  ): Promise<Job> {
    requirePrincipal(this.service, [
      'domain_executor',
      'observer',
      'promoter',
      'privacy_controller',
      'grader',
      'fixture_builder',
      'setup',
    ]);
    // A run is bound to a world that exists under this scope, at this scope revision, outside maintenance.
    await new WorldRepository(this.service).assertRunnable(
      actor,
      input.binding.worldId,
      input.binding.scopeRevision,
    );
    const now = new Date();
    const jobId = input.jobId ?? randomUUID();
    const job: Job = {
      _id: jobId,
      kind: input.kind,
      actor,
      binding: { ...input.binding, jobId },
      parentJobId: input.parentJobId ?? null,
      checkpoint: null,
      status: 'queued',
      cancellationRequested: false,
      lease: { ownerId: '', fence: 0, until: new Date(0), heartbeatAt: new Date(0) },
      commitSeq: 0,
      eventSeq: 0,
      attempt: 0,
      priority: input.priority ?? 0,
      inputRefs: input.inputRefs ?? [],
      outputRefs: [],
      contextInputs: contextHashes(input.contextInputs ?? [], MAX_CONTEXT_INPUTS),
      createdAt: now,
      updatedAt: now,
    };
    await this.collection.insertOne(job);
    return job;
  }
  /**
   * The world capability for one job. It is minted from the job row as stored (its run binding), after the actor's
   * scope has been checked against it, so a caller can name a job handle and never a world. There is no public
   * function that brands an arbitrary job-shaped object.
   */
  async worldKey(actor: ActorContext, jobId: string, session?: ClientSession): Promise<WorldKey> {
    return worldKeyOf(await this.readAuthorized(actor, jobId, session));
  }
  async readAuthorized(actor: ActorContext, jobId: string, session?: ClientSession): Promise<Job> {
    const job = await this.collection.findOne({ _id: jobId }, { session });
    if (!job) fail('JobNotFound');
    assertJobAccess(actor, job);
    return job;
  }
  /**
   * Trusted-dispatcher read of a job without a caller ActorContext. A wake command carries only a job id, so the
   * dispatcher resolves the stored owner and then claims with it. Only a worker principal for the job's kind may
   * call it; the result is the stored row, never something the wake command asserted.
   */
  async resolveForDispatch(jobId: string): Promise<Job> {
    const job = await this.collection.findOne({ _id: jobId });
    if (!job) fail('JobNotFound');
    if (this.service.principal !== 'setup' && !JOB_KIND_PRINCIPALS[job.kind].includes(this.service.principal))
      fail('PrincipalBoundary');
    return job;
  }
  /**
   * Job ids in `key`'s scope that this principal could claim now: queued, or running with an expired lease, not
   * cancel-requested, of a kind this principal works. Ordered by priority then age. A poller uses it to reclaim
   * jobs whose worker died; the scope is a trusted binding of the poller, never a request value.
   */
  async listClaimable(
    key: ScopeKey,
    limit = 25,
  ): Promise<Array<{ jobId: string; kind: JobKind; priority: number }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('InvalidClaimableLimit');
    const kinds = (Object.keys(JOB_KIND_PRINCIPALS) as JobKind[]).filter(
      (kind) =>
        this.service.principal === 'setup' || JOB_KIND_PRINCIPALS[kind].includes(this.service.principal),
    );
    if (!kinds.length) return [];
    const rows = await this.collection
      .find(
        {
          'actor.tenantId': key.tenantId,
          'actor.env': key.env,
          'actor.scopeId': key.scopeId,
          kind: { $in: kinds },
          cancellationRequested: false,
          $or: [{ status: 'queued' }, { status: 'running', $expr: { $lte: ['$lease.until', '$$NOW'] } }],
        },
        { projection: { _id: 1, kind: 1, priority: 1 }, sort: { priority: -1, createdAt: 1 }, limit },
      )
      .toArray();
    return rows.map((row) => ({ jobId: row._id, kind: row.kind, priority: row.priority }));
  }
  /**
   * Graceful release by the lease owner: running -> queued with the lease ended, no fence bump. The next claim
   * bumps the fence. A job whose cancellation was requested cannot be released; its owner finishes it instead.
   */
  async release(actor: ActorContext, lease: LeaseBinding): Promise<void> {
    await this.workerJob(actor, lease.jobId);
    const result = await this.collection.updateOne(liveJobFilter(lease), {
      $set: { status: 'queued', 'lease.until': new Date(0) },
      $currentDate: { updatedAt: true },
    });
    if (result.matchedCount !== 1) fail('LostLease');
  }
  /** `readAuthorized` plus the per-kind principal rule: the caller must be a worker principal for this kind. */
  async workerJob(actor: ActorContext, jobId: string, session?: ClientSession): Promise<Job> {
    const job = await this.readAuthorized(actor, jobId, session);
    if (this.service.principal !== 'setup' && !JOB_KIND_PRINCIPALS[job.kind].includes(this.service.principal))
      fail('PrincipalBoundary');
    return job;
  }
  /**
   * Records hashes the run is about to place in model context so that revocation can find and cancel it.
   * Hashes must be permitted now (eligible with no revoked ancestor) and the lease must be live. Permission is
   * checked again after the write: a revocation that committed while this call was in flight cancels the job
   * instead of leaving revoked material in an active context.
   */
  async recordContextInputs(actor: ActorContext, lease: LeaseBinding, hashes: string[]): Promise<string[]> {
    const unique = contextHashes(hashes, MAX_CONTEXT_INPUTS_PER_CALL);
    const job = await this.workerJob(actor, lease.jobId);
    if (new Set([...(job.contextInputs ?? []), ...unique]).size > MAX_CONTEXT_INPUTS)
      fail('ContextInputsBounds');
    const provenance = new ProvenanceRepository(this.service);
    const allowed = async () => new Set(await provenance.permitted(actor, unique));
    const before = await allowed();
    if (unique.some((hash) => !before.has(hash))) fail('ContextInputNotPermitted');
    const result = await this.collection.updateOne(liveJobFilter(lease), {
      $addToSet: { contextInputs: { $each: unique } },
      $currentDate: { updatedAt: true },
    });
    if (!result.matchedCount) fail('LostLease');
    const after = await allowed();
    if (unique.some((hash) => !after.has(hash))) {
      await this.collection.updateOne(
        { _id: lease.jobId },
        { $set: { cancellationRequested: true }, $currentDate: { updatedAt: true } },
      );
      fail('ContextInputRevoked');
    }
    return unique;
  }
  async claim(actor: ActorContext, jobId: string, ownerId: string, durationMs = 30000): Promise<Job | null> {
    requirePrincipal(this.service, [
      'domain_executor',
      'observer',
      'promoter',
      'privacy_controller',
      'grader',
      'fixture_builder',
      'setup',
    ]);
    leaseDuration(durationMs);
    await this.workerJob(actor, jobId);
    const claimed = await this.claimEligible(actor, jobId, ownerId, durationMs);
    // A cancelled job nobody can claim is finished off here instead of lingering as `queued` forever.
    if (!claimed) await this.settleCancellation(actor, jobId);
    return claimed;
  }
  private claimEligible(
    actor: ActorContext,
    jobId: string,
    ownerId: string,
    durationMs: number,
  ): Promise<Job | null> {
    return this.collection.findOneAndUpdate(
      {
        _id: jobId,
        'actor.actorId': actor.actorId,
        'actor.tenantId': actor.tenantId,
        'actor.env': actor.env,
        'actor.scopeId': actor.scopeId,
        cancellationRequested: false,
        'lease.fence': { $lt: Number.MAX_SAFE_INTEGER },
        $or: [{ status: 'queued' }, { status: 'running', $expr: { $lte: ['$lease.until', '$$NOW'] } }],
      },
      [
        {
          $set: {
            status: { $literal: 'running' },
            'lease.ownerId': { $literal: ownerId },
            'lease.fence': { $add: ['$lease.fence', 1] },
            'lease.until': { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: durationMs } },
            'lease.heartbeatAt': '$$NOW',
            updatedAt: '$$NOW',
            attempt: { $add: ['$attempt', 1] },
          },
        },
      ],
      { returnDocument: 'after', includeResultMetadata: false },
    );
  }
  async renew(actor: ActorContext, lease: LeaseBinding, durationMs = 30000): Promise<Job> {
    leaseDuration(durationMs);
    await this.workerJob(actor, lease.jobId);
    const job = await this.collection.findOneAndUpdate(
      liveJobFilter(lease),
      [
        {
          $set: {
            'lease.until': { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: durationMs } },
            'lease.heartbeatAt': '$$NOW',
            updatedAt: '$$NOW',
          },
        },
      ],
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (!job) fail('LostLease');
    return job;
  }
  async fence(actor: ActorContext, lease: LeaseBinding, session: ClientSession): Promise<Job> {
    await this.workerJob(actor, lease.jobId, session);
    const job = await this.collection.findOneAndUpdate(
      liveJobFilter(lease),
      { $inc: { commitSeq: 1 }, $currentDate: { updatedAt: true } },
      { session, returnDocument: 'after', includeResultMetadata: false },
    );
    if (!job) fail('LostLease');
    return job;
  }
  async checkpoint(actor: ActorContext, lease: LeaseBinding, checkpoint: JsonValue): Promise<void> {
    await this.workerJob(actor, lease.jobId);
    const result = await this.collection.updateOne(liveJobFilter(lease), {
      $set: { checkpoint },
      $currentDate: { updatedAt: true },
    });
    if (!result.modifiedCount) fail('LostLease');
  }
  /**
   * Requests cancellation. A job that nobody is running (queued, waiting, or running with an expired lease)
   * reaches `cancelled` immediately, with a fence bump so a stale holder cannot write afterwards. A job with a
   * live lease keeps running until its owner observes the flag and calls `finish(..., 'cancelled')`.
   */
  async cancel(actor: ActorContext, jobId: string): Promise<void> {
    await this.readAuthorized(actor, jobId);
    await this.collection.updateOne(
      { _id: jobId, status: { $nin: ['succeeded', 'failed', 'cancelled'] } },
      { $set: { cancellationRequested: true }, $currentDate: { updatedAt: true } },
    );
    await this.settleCancellation(actor, jobId);
  }
  /** Moves a cancel-requested job with no live holder to `cancelled`. Idempotent; a no-op otherwise. */
  async settleCancellation(actor: ActorContext, jobId: string): Promise<boolean> {
    await this.readAuthorized(actor, jobId);
    const result = await this.collection.updateOne(
      {
        _id: jobId,
        cancellationRequested: true,
        $or: [
          { status: 'queued' },
          { status: { $in: [...NON_TERMINAL_WAITING] } },
          { status: 'running', $expr: { $lte: ['$lease.until', '$$NOW'] } },
        ],
      },
      [
        {
          $set: {
            status: { $literal: 'cancelled' },
            'lease.fence': { $add: ['$lease.fence', 1] },
            'lease.until': { $literal: new Date(0) },
            updatedAt: '$$NOW',
          },
        },
      ],
    );
    return result.modifiedCount === 1;
  }
  async yield(
    actor: ActorContext,
    lease: LeaseBinding,
    status: 'waiting_evidence' | 'waiting_approval' | 'waiting_external',
  ): Promise<void> {
    await this.workerJob(actor, lease.jobId);
    const result = await this.collection.updateOne(liveJobFilter(lease), {
      $set: { status, 'lease.until': new Date(0) },
      $currentDate: { updatedAt: true },
    });
    if (!result.modifiedCount) fail('LostLease');
  }
  async requeue(
    actor: ActorContext,
    jobId: string,
    from: 'waiting_evidence' | 'waiting_approval' | 'waiting_external',
  ): Promise<void> {
    await this.readAuthorized(actor, jobId);
    const result = await this.collection.updateOne(
      { _id: jobId, status: from, cancellationRequested: false },
      { $set: { status: 'queued' }, $currentDate: { updatedAt: true } },
    );
    if (!result.modifiedCount) fail('InvalidDependencyTransition');
  }
  /**
   * Ends a leased job. A cleanup job can only end as `succeeded` when a committed completion receipt bound to this
   * job, run and harness is named in `outputRefs`; in practice that is `EffectRepository.complete`, which writes
   * the receipt and this transition in one transaction.
   */
  async finish(
    actor: ActorContext,
    lease: LeaseBinding,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outputRefs: string[],
    session?: ClientSession,
  ): Promise<void> {
    const job = await this.workerJob(actor, lease.jobId, session);
    if (status === 'succeeded' && job.kind === 'cleanup') {
      const receipt = await this.service.control.collection<Document>('completion_receipts').findOne(
        {
          _id: { $in: outputRefs } as never,
          jobId: job._id,
          runId: job.binding.runId,
          harnessHash: job.binding.harnessHash,
          domainStatus: 'complete_in_registered_scope',
          operationalResiduals: 0,
        },
        { session },
      );
      if (!receipt) fail('CompletionReceiptRequired');
    }
    const filter =
      status === 'cancelled'
        ? { ...liveJobFilter(lease), cancellationRequested: true }
        : liveJobFilter(lease);
    const result = await this.collection.updateOne(
      filter,
      { $set: { status, outputRefs, 'lease.until': new Date(0) }, $currentDate: { updatedAt: true } },
      { session },
    );
    if (!result.modifiedCount) fail('LostLease');
  }
}
