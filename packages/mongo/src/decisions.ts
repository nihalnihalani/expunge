import type { ClientSession, Document } from 'mongodb';
import {
  contentHash,
  sameScope,
  type ActionIntent,
  type ActorContext,
  type DecisionRecord,
  type PolicyDecision,
} from '@expunge/contracts';
import { AuthorityRepository } from './authority.js';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';
import { JobRepository } from './jobs.js';

type DecisionRow = DecisionRecord & { _id: string };
type DecisionIdentity = Pick<
  ActionIntent,
  'jobId' | 'runId' | 'harnessHash' | 'stepId' | 'batchOrdinal' | 'argsDigest' | 'policyDecision'
>;

/** Id of the ledger row for an intent: a digest of the intent's identity and the decision it claims. */
export function deriveDecisionId(identity: DecisionIdentity): string {
  return contentHash(
    {
      jobId: identity.jobId,
      runId: identity.runId,
      harnessHash: identity.harnessHash,
      stepId: identity.stepId,
      batchOrdinal: identity.batchOrdinal,
      argsDigest: identity.argsDigest,
      decision: {
        result: identity.policyDecision.result,
        ruleIds: identity.policyDecision.ruleIds,
        authorizationRevision: identity.policyDecision.authorizationRevision,
      },
    },
    'policy-decision',
  );
}

/**
 * The decision ledger. The trusted gateway records a decision here before an effect commits; `commitEffect`
 * refuses an intent unless the row named by `decisionId` exists in the same scope and matches the intent exactly.
 * An intent therefore cannot assert `result: 'allow'` on its own.
 */
export class DecisionRepository {
  readonly jobs: JobRepository;
  constructor(readonly service: MongoService) {
    this.jobs = new JobRepository(service);
  }

  private get rows() {
    return this.service.control.collection<DecisionRow & Document>('decisions');
  }

  /**
   * Appends the gateway's decision for one batch of one job. Idempotent: the same decision for the same action
   * is the same row. The caller must be a worker principal for the job's kind.
   */
  async record(
    actor: ActorContext,
    identity: Omit<DecisionIdentity, 'policyDecision'>,
    decision: PolicyDecision,
  ): Promise<DecisionRecord> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    const job = await this.jobs.workerJob(actor, identity.jobId);
    if (job.binding.runId !== identity.runId || job.binding.harnessHash !== identity.harnessHash)
      fail('IntentBindingMismatch');
    if (decision.authorizationRevision !== actor.authorizationRevision) fail('DecisionMismatch');
    // A gateway running a stale run cannot even write a decision: the stored revision must still be this one.
    const stored = await new AuthorityRepository(this.service).read(actor);
    if (stored.authorizationRevision !== actor.authorizationRevision) fail('AuthorityRevisionStale');
    const decisionId = deriveDecisionId({ ...identity, policyDecision: decision });
    const record: DecisionRecord = {
      ...scopeFilter(actor),
      decisionId,
      jobId: identity.jobId,
      runId: identity.runId,
      harnessHash: identity.harnessHash,
      stepId: identity.stepId,
      batchOrdinal: identity.batchOrdinal,
      argsDigest: identity.argsDigest,
      decision,
      decidedAt: new Date(),
    };
    try {
      await this.rows.insertOne({ _id: decisionId, ...record });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
    }
    return record;
  }

  /** Throws unless the ledger holds exactly the decision this intent claims, in this scope, and it allows. */
  async verify(actor: ActorContext, intent: ActionIntent, session: ClientSession): Promise<void> {
    if (intent.decisionId !== deriveDecisionId(intent)) fail('DecisionMismatch');
    const row = await this.rows.findOne({ _id: intent.decisionId }, { session });
    if (!row) fail('DecisionNotFound');
    if (
      !sameScope(row, actor) ||
      row.decisionId !== intent.decisionId ||
      row.jobId !== intent.jobId ||
      row.runId !== intent.runId ||
      row.harnessHash !== intent.harnessHash ||
      row.stepId !== intent.stepId ||
      row.batchOrdinal !== intent.batchOrdinal ||
      row.argsDigest !== intent.argsDigest ||
      row.decision.result !== 'allow' ||
      contentHash(row.decision, 'decision-body') !== contentHash(intent.policyDecision, 'decision-body')
    )
      fail('DecisionMismatch');
  }
}
