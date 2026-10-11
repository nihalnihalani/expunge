import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Document } from 'mongodb';
import {
  contentHash,
  type ActorContext,
  type CompletionReceipt,
  type DomainAddress,
  type ScopeKey,
} from '@expunge/contracts';
import { deriveEffectKey, ProtocolError, requirePrincipal, type MongoService } from '@expunge/mongo';
import { identityHashOf } from './keys.js';
import type {
  CallPayload,
  DiscoveryPayload,
  FaultPayload,
  PlanTarget,
  Residual,
  ResolutionPayload,
  RetainedRecord,
  ScopeSelectionPayload,
  SubjectInput,
  SweepStatus,
  WorkflowPayload,
} from './rows.js';

export type StepKind = 'scope_selection' | 'subject_resolution' | 'discovery' | 'call' | 'workflow' | 'fault';
type StepPayloads = {
  scope_selection: ScopeSelectionPayload;
  subject_resolution: ResolutionPayload;
  discovery: DiscoveryPayload;
  call: CallPayload;
  workflow: WorkflowPayload;
  fault: FaultPayload;
};
export type StepRow<K extends StepKind = StepKind> = ScopeKey & {
  _id: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  kind: K;
  ordinal: number;
  worldId: string;
  scopeRevision: number;
  worldRevision: number;
  payload: StepPayloads[K];
  payloadDigest: string;
  createdAt: Date;
};
export type SubjectRow = ScopeKey & {
  _id: string;
  jobId: string;
  idType: SubjectInput['idType'];
  value: string;
  identityHash: string;
  createdAt: Date;
};
export type PlanRow = ScopeKey & {
  _id: string;
  planHash: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  worldId: string;
  scopeRevision: number;
  worldRevision: number;
  ownerPolicyHash: string;
  targets: PlanTarget[];
  bindings: string[];
  retained: RetainedRecord[];
  createdAt: Date;
};
export type SweepRow = ScopeKey & {
  _id: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  worldId: string;
  scopeRevision: number;
  worldRevisionBefore: number;
  worldRevisionAfter: number;
  planHash: string | null;
  status: SweepStatus;
  residuals: number;
  retainedOrExcluded: number;
  inspectedCollectionIds: string[];
  discoveredFieldIds: string[];
  residualSamples: Residual[];
  limitations: string[];
  createdAt: Date;
};
export type DiagnosticRow = ScopeKey & {
  _id: string;
  jobId: string;
  runId: string;
  origin: 'agent_self_report';
  category: string;
  message: string;
  outboxOperationId: string;
  createdAt: Date;
};

const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
const scopeOf = (actor: ScopeKey): ScopeKey => ({
  tenantId: actor.tenantId,
  env: actor.env,
  scopeId: actor.scopeId,
});

/**
 * The gateway's insert-only step log in the control database: the subject the owner submitted, what each tool step
 * established, the preview plans and the verification sweeps. Rows are never updated. Retrying a step appends the next
 * ordinal, so history stays complete and a crashed run resumes from the last committed row.
 */
export class DomainStore {
  /**
   * @param fence when present, every write runs in one transaction with this check, so a session that no longer
   * holds the job's lease cannot add a step, plan, sweep or diagnostic that the live holder would then consume.
   */
  constructor(
    readonly service: MongoService,
    private readonly fence?: (session: ClientSession) => Promise<void>,
  ) {
    requirePrincipal(service, ['domain_executor', 'setup']);
  }

  /** The same store whose writes are fenced on the job's live lease. */
  fenced(fence: (session: ClientSession) => Promise<void>): DomainStore {
    return new DomainStore(this.service, fence);
  }

  private rows<T extends Document>(name: string): Collection<T> {
    return this.service.control.collection<T>(name);
  }

  private async insert<T extends Document>(name: string, row: T): Promise<void> {
    const collection = this.rows<T>(name);
    if (!this.fence) {
      await collection.insertOne(row as never);
      return;
    }
    const fence = this.fence;
    await this.service.transaction(async (session) => {
      await fence(session);
      await collection.insertOne(row as never, { session });
    });
  }

  // ---- subject ----
  async putSubject(actor: ScopeKey, jobId: string, subject: SubjectInput): Promise<SubjectRow> {
    const row: SubjectRow = {
      _id: jobId,
      ...scopeOf(actor),
      jobId,
      idType: subject.idType,
      value: subject.value,
      identityHash: identityHashOf(subject.idType, subject.value),
      createdAt: new Date(),
    };
    try {
      await this.insert('job_subjects', row);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const stored = await this.getSubject(actor, jobId);
      if (stored.identityHash !== row.identityHash) throw new ProtocolError('SubjectConflict');
      return stored;
    }
    return row;
  }
  async getSubject(actor: ScopeKey, jobId: string): Promise<SubjectRow> {
    const row = await this.rows<SubjectRow>('job_subjects').findOne({ _id: jobId, ...scopeOf(actor) });
    if (!row) throw new ProtocolError('SubjectNotFound');
    return row;
  }

  // ---- steps ----
  async appendStep<K extends StepKind>(
    actor: ScopeKey,
    run: { jobId: string; runId: string; harnessHash: string; worldId: string; scopeRevision: number },
    kind: K,
    payload: StepPayloads[K],
    worldRevision: number,
  ): Promise<StepRow<K>> {
    const collection = this.rows<StepRow>('domain_steps');
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await collection.findOne(
        { ...scopeOf(actor), jobId: run.jobId, kind },
        { sort: { ordinal: -1 }, projection: { ordinal: 1 } },
      );
      const ordinal = (last?.ordinal ?? 0) + 1;
      const row: StepRow<K> = {
        _id: contentHash({ ...scopeOf(actor), jobId: run.jobId, kind, ordinal }, 'domain-step'),
        ...scopeOf(actor),
        jobId: run.jobId,
        runId: run.runId,
        harnessHash: run.harnessHash,
        kind,
        ordinal,
        worldId: run.worldId,
        scopeRevision: run.scopeRevision,
        worldRevision,
        payload,
        payloadDigest: contentHash(payload, 'domain-step-payload'),
        createdAt: new Date(),
      };
      try {
        await this.insert('domain_steps', row);
        return row;
      } catch (error) {
        if (!isDuplicate(error)) throw error; // another writer took this ordinal: take the next one
      }
    }
    throw new ProtocolError('StepOrdinalContention');
  }
  /**
   * Appends the next step of a kind after reading what decides it, all in ONE transaction with the lease fence. `plan`
   * runs inside the transaction with its session: it reads the job's rows and returns the payload to append (or `null`
   * to append nothing) and a result for the caller. The fence bumps the job's `commitSeq`, so two overlapping calls of
   * one holder conflict and the loser plans again on the winner's row; the transaction callback may therefore run more
   * than once, and `plan` must only read. A lost lease aborts everything and throws the repository's `LostLease`.
   */
  async appendStepAfter<K extends StepKind, R>(
    actor: ScopeKey,
    run: { jobId: string; runId: string; harnessHash: string; worldId: string; scopeRevision: number },
    kind: K,
    worldRevision: number,
    plan: (session: ClientSession) => Promise<{ payload: StepPayloads[K] | null; result: R }>,
  ): Promise<{ row: StepRow<K> | null; result: R }> {
    const collection = this.rows<StepRow>('domain_steps');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.service.transaction(async (session) => {
          if (this.fence) await this.fence(session);
          const planned = await plan(session);
          if (planned.payload === null) return { row: null, result: planned.result };
          const last = await collection.findOne(
            { ...scopeOf(actor), jobId: run.jobId, kind },
            { sort: { ordinal: -1 }, projection: { ordinal: 1 }, session },
          );
          const ordinal = (last?.ordinal ?? 0) + 1;
          const row: StepRow<K> = {
            _id: contentHash({ ...scopeOf(actor), jobId: run.jobId, kind, ordinal }, 'domain-step'),
            ...scopeOf(actor),
            jobId: run.jobId,
            runId: run.runId,
            harnessHash: run.harnessHash,
            kind,
            ordinal,
            worldId: run.worldId,
            scopeRevision: run.scopeRevision,
            worldRevision,
            payload: planned.payload,
            payloadDigest: contentHash(planned.payload, 'domain-step-payload'),
            createdAt: new Date(),
          };
          await collection.insertOne(row as never, { session });
          return { row, result: planned.result };
        });
      } catch (error) {
        if (!isDuplicate(error)) throw error; // another writer took this ordinal: plan again on the new last row
      }
    }
    throw new ProtocolError('StepOrdinalContention');
  }
  async latestStep<K extends StepKind>(actor: ScopeKey, jobId: string, kind: K): Promise<StepRow<K> | null> {
    const row = await this.rows<StepRow>('domain_steps').findOne(
      { ...scopeOf(actor), jobId, kind },
      { sort: { ordinal: -1 } },
    );
    return row as StepRow<K> | null;
  }
  async listSteps<K extends StepKind>(
    actor: ScopeKey,
    jobId: string,
    kind: K,
    limit = 50,
  ): Promise<StepRow<K>[]> {
    const rows = await this.rows<StepRow>('domain_steps')
      .find({ ...scopeOf(actor), jobId, kind }, { sort: { ordinal: 1 }, limit })
      .toArray();
    return rows as StepRow<K>[];
  }

  /**
   * How many rows of a kind this job has, optionally only those whose payload has these exact field values. Used for
   * the durable per-job counters (calls, workflow visits) that must not restart when a session or a worker does.
   */
  async countSteps(
    actor: ScopeKey,
    jobId: string,
    kind: StepKind,
    payload: Record<string, string | number | boolean> = {},
  ): Promise<number> {
    const match = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [`payload.${key}`, value]),
    );
    return this.rows('domain_steps').countDocuments({ ...scopeOf(actor), jobId, kind, ...match });
  }

  // ---- plans ----
  /** Inserts a plan. The same plan (same hash) is the same row, so a retried preview returns what it made. */
  async putPlan(row: Omit<PlanRow, '_id' | 'createdAt'>): Promise<PlanRow> {
    const stored: PlanRow = { ...row, _id: row.planHash, createdAt: new Date() };
    try {
      await this.insert('preview_plans', stored);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      return this.getPlan(row, row.planHash);
    }
    return stored;
  }
  async getPlan(actor: ScopeKey, planId: string): Promise<PlanRow> {
    const row = await this.rows<PlanRow>('preview_plans').findOne({ _id: planId, ...scopeOf(actor) });
    if (!row) throw new ProtocolError('PlanNotFound');
    return row;
  }
  async latestPlan(actor: ScopeKey, jobId: string, runId: string): Promise<PlanRow | null> {
    return this.rows<PlanRow>('preview_plans').findOne(
      { ...scopeOf(actor), jobId, runId },
      { sort: { createdAt: -1, _id: -1 } },
    );
  }

  /** Every plan this run made, oldest first. A run makes a handful; the bound is a guard, not a window. */
  async listPlans(actor: ScopeKey, jobId: string, runId: string, limit = 50): Promise<PlanRow[]> {
    return this.rows<PlanRow>('preview_plans')
      .find({ ...scopeOf(actor), jobId, runId }, { sort: { createdAt: 1, _id: 1 }, limit })
      .toArray();
  }

  // ---- sweeps ----
  async putSweep(row: Omit<SweepRow, '_id' | 'createdAt'>): Promise<SweepRow> {
    const id = contentHash(
      {
        ...scopeOf(row),
        jobId: row.jobId,
        runId: row.runId,
        worldRevisionAfter: row.worldRevisionAfter,
        planHash: row.planHash,
        status: row.status,
        residuals: row.residuals,
        retainedOrExcluded: row.retainedOrExcluded,
      },
      'verification-sweep',
    );
    const stored: SweepRow = { ...row, _id: id, createdAt: new Date() };
    try {
      await this.insert('verification_sweeps', stored);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      return this.getSweep(row, id);
    }
    return stored;
  }
  async getSweep(actor: ScopeKey, sweepId: string): Promise<SweepRow> {
    const row = await this.rows<SweepRow>('verification_sweeps').findOne({ _id: sweepId, ...scopeOf(actor) });
    if (!row) throw new ProtocolError('SweepNotFound');
    return row;
  }
  async latestSweep(actor: ScopeKey, jobId: string, runId: string): Promise<SweepRow | null> {
    return this.rows<SweepRow>('verification_sweeps').findOne(
      { ...scopeOf(actor), jobId, runId },
      { sort: { createdAt: -1, _id: -1 } },
    );
  }

  // ---- diagnostics ----
  async putDiagnostic(row: Omit<DiagnosticRow, '_id' | 'createdAt'>): Promise<DiagnosticRow> {
    const stored: DiagnosticRow = { ...row, _id: randomUUID(), createdAt: new Date() };
    await this.insert('diagnostics', stored);
    return stored;
  }

  // ---- committed effects and receipts ----
  /** How many of the plan's batches have a committed effect (derived keys, so retries never miscount). */
  async committedBatchCount(
    actor: ActorContext,
    run: { jobId: string; approvedPlanHash: string; stepId: string },
    batchCount: number,
  ): Promise<number> {
    if (batchCount === 0) return 0;
    const keys = Array.from({ length: batchCount }, (_, batchOrdinal) =>
      deriveEffectKey({
        jobId: run.jobId,
        approvedPlanHash: run.approvedPlanHash,
        stepId: run.stepId,
        batchOrdinal,
      }),
    );
    const found = await this.rows<Document & { _id: string }>('effects')
      .find({
        _id: { $in: keys },
        'actor.tenantId': actor.tenantId,
        'actor.env': actor.env,
        'actor.scopeId': actor.scopeId,
        jobId: run.jobId,
      })
      .project({ _id: 1 })
      .toArray();
    const present = new Set(found.map((row) => row._id));
    // Batches commit in order, so the count is the length of the committed prefix.
    let prefix = 0;
    while (prefix < batchCount && present.has(keys[prefix]!)) prefix += 1;
    return prefix;
  }
  async committedEffectCount(actor: ActorContext, jobId: string): Promise<number> {
    return this.rows('effects').countDocuments({
      jobId,
      'actor.tenantId': actor.tenantId,
      'actor.env': actor.env,
      'actor.scopeId': actor.scopeId,
    });
  }
  async completionReceipt(
    actor: ActorContext,
    jobId: string,
    runId: string,
  ): Promise<CompletionReceipt | null> {
    const stored = await this.rows<CompletionReceipt & Document>('completion_receipts').findOne({
      jobId,
      runId,
      'actor.tenantId': actor.tenantId,
      'actor.env': actor.env,
      'actor.scopeId': actor.scopeId,
    });
    if (!stored) return null;
    const receipt: Record<string, unknown> = { ...(stored as never as Record<string, unknown>) };
    delete receipt._id;
    delete receipt.actor;
    delete receipt.createdAt;
    return receipt as unknown as CompletionReceipt;
  }
}
export type { DomainAddress };
