import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Document } from 'mongodb';
import {
  contentHash,
  sameScope,
  type ActorContext,
  type ActionIntent,
  type ActionReceipt,
  type AppliedEffect,
  type CompletionReceipt,
  type DomainAddress,
  type ScopeRegistry,
} from '@expunge/contracts';
import { fail, requirePrincipal, worldFilter, type MongoService, type RuntimeDocument } from './client.js';
import { AuthorityRepository } from './authority.js';
import { DecisionRepository, deriveDecisionId } from './decisions.js';
import { addressId, canonicalAddress, nodeKey } from './hashes.js';
import { JobRepository, type LeaseBinding } from './jobs.js';
import { ScopeRepository } from './scope.js';
import { WorldRepository } from './worlds.js';

/** The hash of a target set. Order is part of the plan; every spelling of an address is canonicalized. */
export function deriveTargetHash(targets: readonly DomainAddress[]): string {
  return contentHash(targets.map(canonicalAddress), 'targets');
}
/**
 * Logical identity of one batch of one approved plan. It excludes the lease fence, a model tool-call id and the
 * world revision, so a retry after takeover, or under a different tool-call id, names the same effect.
 */
export function deriveEffectKey(
  intent: Pick<ActionIntent, 'jobId' | 'approvedPlanHash' | 'stepId' | 'batchOrdinal'>,
): string {
  return contentHash(
    {
      jobId: intent.jobId,
      approvedPlanHash: intent.approvedPlanHash,
      stepId: intent.stepId,
      batchOrdinal: intent.batchOrdinal,
    },
    'effect-key',
  );
}
/** Digest of what the effect does. A different target set or effect kind under the same key is a conflict. */
export function deriveArgsDigest(
  intent: Pick<
    ActionIntent,
    | 'jobId'
    | 'runId'
    | 'harnessHash'
    | 'stepId'
    | 'approvedPlanHash'
    | 'batchOrdinal'
    | 'targetAddresses'
    | 'effectKind'
  >,
): string {
  return contentHash(
    {
      jobId: intent.jobId,
      runId: intent.runId,
      harnessHash: intent.harnessHash,
      stepId: intent.stepId,
      approvedPlanHash: intent.approvedPlanHash,
      batchOrdinal: intent.batchOrdinal,
      targetHash: deriveTargetHash(intent.targetAddresses),
      effectKind: intent.effectKind,
    },
    'effect-args',
  );
}
/** The identity fields of an intent are computed here, never accepted from the caller or a model. */
function assertDerivedIdentity(intent: ActionIntent): void {
  if (intent.effectKey !== deriveEffectKey(intent)) fail('EffectKeyMismatch');
  if (intent.targetHash !== deriveTargetHash(intent.targetAddresses)) fail('TargetHashMismatch');
  if (intent.argsDigest !== deriveArgsDigest(intent)) fail('EffectKeyMismatch');
  if (intent.decisionId !== deriveDecisionId(intent)) fail('DecisionMismatch');
}

/**
 * The versions an intent binds must be exactly its targets: every target once, with a non-negative integer version,
 * and nothing else. An intent that names a target without a version (or a version without a target) is refused
 * before any write, so a target can never be touched at a version the plan did not see.
 */
function assertVersionBinding(intent: ActionIntent): void {
  const targets = intent.targetAddresses.map(nodeKey);
  const bound = intent.expectedDocumentVersions.map((entry) => nodeKey(entry.address));
  if (
    new Set(targets).size !== targets.length ||
    new Set(bound).size !== bound.length ||
    targets.length !== bound.length ||
    !bound.every((key) => targets.includes(key)) ||
    !intent.expectedDocumentVersions.every(
      (entry) => Number.isSafeInteger(entry.version) && entry.version >= 0,
    )
  )
    fail('VersionBindingMismatch');
}
/** Every applied effect must be on a target the intent named, once, with the intent's effect kind. */
function assertAppliedWithinTargets(intent: ActionIntent, applied: readonly AppliedEffect[]): void {
  const allowed = new Set(intent.targetAddresses.map(nodeKey));
  const seen = new Set<string>();
  for (const effect of applied) {
    const key = nodeKey(effect.address);
    if (!allowed.has(key) || seen.has(key) || effect.kind !== intent.effectKind) fail('EffectOutsideTargets');
    seen.add(key);
  }
}
const exactCoverage = (claimed: readonly string[], registered: readonly string[]): boolean =>
  new Set(claimed).size === claimed.length &&
  claimed.length === registered.length &&
  registered.every((id) => claimed.includes(id));
/**
 * A completion receipt must cover exactly what the bound registry revision declares: every registered
 * collection and every registered field, carrying every declared limitation. Anything less is incomplete.
 */
function assertReceiptCoversRegistry(receipt: CompletionReceipt, registry: ScopeRegistry): void {
  const limitations = registry.discoveryCompleteness.limitations;
  if (
    !exactCoverage(receipt.inspectedCollectionIds, registry.collectionIds) ||
    !exactCoverage(
      receipt.discoveredFieldIds,
      registry.fields.map((field) => field.fieldId),
    ) ||
    !limitations.every((limitation) => receipt.limitations.includes(limitation)) ||
    (registry.discoveryCompleteness.kind === 'partial' && receipt.limitations.length === 0)
  )
    fail('ReceiptCoverageIncomplete');
}

export type EffectRecord = {
  _id: string;
  effectKey: string;
  argsDigest: string;
  planHash: string;
  jobId: string;
  actor: ActorContext;
  receiptId: string;
  createdAt: Date;
};
export type EffectCommitInput = {
  actor: ActorContext;
  lease: LeaseBinding;
  intent: ActionIntent;
  outbox?: Array<Document & { _id: string }>;
  apply: (session: ClientSession, resultingWorldRevision: number) => Promise<AppliedEffect[]>;
  validate?: (session: ClientSession) => Promise<void>;
};
/** A callback is trusted, bounded database work only; never model/vendor I/O. */
export class EffectRepository {
  readonly jobs: JobRepository;
  readonly effects: Collection<EffectRecord>;
  readonly receipts: Collection<ActionReceipt & { _id: string }>;
  readonly authority: AuthorityRepository;
  readonly decisions: DecisionRepository;
  readonly worlds: WorldRepository;
  constructor(readonly service: MongoService) {
    this.jobs = new JobRepository(service);
    this.authority = new AuthorityRepository(service);
    this.decisions = new DecisionRepository(service);
    this.worlds = new WorldRepository(service);
    this.effects = service.control.collection<EffectRecord>('effects');
    this.receipts = service.control.collection<ActionReceipt & { _id: string }>('action_receipts');
  }
  async replay(
    actor: ActorContext,
    intent: ActionIntent,
    session?: ClientSession,
  ): Promise<ActionReceipt | null> {
    const job = await this.jobs.readAuthorized(actor, intent.jobId, session);
    if (job.binding.runId !== intent.runId || job.binding.harnessHash !== intent.harnessHash)
      fail('IntentBindingMismatch');
    const effect = await this.effects.findOne({ effectKey: intent.effectKey }, { session });
    if (!effect) return null;
    if (
      !sameScope(actor, effect.actor) ||
      effect.actor.actorId !== actor.actorId ||
      effect.jobId !== intent.jobId
    )
      fail('UnauthorizedEffect');
    if (effect.argsDigest !== intent.argsDigest || effect.planHash !== intent.approvedPlanHash)
      fail('IdempotencyConflict');
    const saved = await this.receipts.findOne({ _id: effect.receiptId }, { session });
    if (!saved) fail('CommittedReceiptMissing');
    const { _id: _ignored, ...receipt } = saved;
    return receipt;
  }
  async commitEffect(input: EffectCommitInput): Promise<ActionReceipt> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    const { actor, lease, intent } = input;
    if (
      lease.jobId !== intent.jobId ||
      intent.policyDecision.result !== 'allow' ||
      actor.authorizationRevision !== intent.policyDecision.authorizationRevision
    )
      fail('EffectNotAuthorized');
    assertDerivedIdentity(intent);
    assertVersionBinding(intent);
    const saved = await this.replay(actor, intent);
    if (saved) return saved;
    const receiptId = randomUUID(),
      intentHash = contentHash(intent, 'action-intent');
    try {
      return await this.service.transaction(async (session) => {
        // This lookup must precede lease/world checks, including on driver callback retry.
        const raced = await this.replay(actor, intent, session);
        if (raced) return raced;
        const job = await this.jobs.fence(actor, lease, session);
        if (job.binding.scopeRevision < 1) fail('InvalidScopeRevision');
        // Live authorization: the stored revision must still be the one this run and this decision were made under.
        await this.authority.fence(actor, intent.policyDecision.authorizationRevision, session);
        await this.decisions.verify(actor, intent, session);
        if (input.validate) await input.validate(session);
        await this.worlds.assertRunnable(actor, job.binding.worldId, job.binding.scopeRevision, session);
        // Every target must still be at the version the plan saw, read in this transaction's snapshot. A write that
        // lands between this read and the commit conflicts with the transaction, so the check cannot go stale.
        for (const expected of intent.expectedDocumentVersions) {
          const current = await this.service.world
            .collection<RuntimeDocument>(expected.address.collectionId)
            .findOne(worldFilter(actor, job.binding.worldId, { _id: addressId(expected.address) }), {
              session,
              projection: { _rev: 1 },
            });
          if (!current || current._rev !== expected.version) fail('StaleDocumentVersion');
        }
        const resultingWorldRevision = await this.worlds.advance(
          actor,
          job.binding.worldId,
          intent.worldRevision,
          session,
        );
        const appliedEffects = await input.apply(session, resultingWorldRevision);
        if (appliedEffects.length > intent.targetAddresses.length) fail('UnboundedEffectResult');
        assertAppliedWithinTargets(intent, appliedEffects);
        // Every target needs an applied effect. A batch where some target matched nothing aborts as a whole: nothing
        // is committed, and the caller learns which kind of failure it was.
        if (appliedEffects.length < intent.targetAddresses.length) fail('PartialEffect');
        const receipt: ActionReceipt = {
          receiptId,
          effectKey: intent.effectKey,
          intentHash,
          jobId: intent.jobId,
          runId: intent.runId,
          harnessHash: intent.harnessHash,
          appliedEffects,
          resultingWorldRevision,
          leaseFence: lease.fence,
          status: 'committed',
          evidenceRefs: [],
        };
        await this.service.control
          .collection<import('mongodb').Document & { _id: string }>('action_intents')
          .insertOne({ _id: intent.intentId, ...intent, actor, createdAt: new Date() }, { session });
        await this.effects.insertOne(
          {
            _id: intent.effectKey,
            effectKey: intent.effectKey,
            argsDigest: intent.argsDigest,
            planHash: intent.approvedPlanHash,
            jobId: intent.jobId,
            actor,
            receiptId,
            createdAt: new Date(),
          },
          { session },
        );
        await this.receipts.insertOne({ _id: receiptId, ...receipt }, { session });
        for (const item of input.outbox ?? [])
          await this.service.control
            .collection<import('mongodb').Document & { _id: string }>('telemetry_outbox')
            .insertOne(item, { session });
        return receipt;
      });
    } catch (error) {
      // Any ambiguity is reconciled by authorized saved receipt lookup. Never rerun blindly.
      const committed = await this.replay(actor, intent);
      if (committed) return committed;
      throw error;
    }
  }
  /** Commits a complete operational receipt and finishes the job as `succeeded`, in one transaction. */
  async complete(
    actor: ActorContext,
    lease: LeaseBinding,
    receipt: CompletionReceipt,
    validate?: (session: ClientSession) => Promise<void>,
  ): Promise<CompletionReceipt> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    if (receipt.domainStatus !== 'complete_in_registered_scope' || receipt.operationalResiduals !== 0)
      fail('IncompleteReceipt');
    return this.commitReceipt(actor, lease, receipt, 'succeeded', validate);
  }

  /**
   * Commits an honest operational receipt for a run whose verification found residuals, and finishes the job as
   * `failed` with that receipt as its output. The receipt covers the registry exactly like a complete one; only its
   * verdict differs. This is how a narrative-mode run's claim of success meets the actual verification result.
   */
  async completeIncomplete(
    actor: ActorContext,
    lease: LeaseBinding,
    receipt: CompletionReceipt,
    validate?: (session: ClientSession) => Promise<void>,
  ): Promise<CompletionReceipt> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    if (receipt.domainStatus !== 'incomplete' || receipt.operationalResiduals < 1)
      fail('ReceiptNotIncomplete');
    return this.commitReceipt(actor, lease, receipt, 'failed', validate);
  }

  private async commitReceipt(
    actor: ActorContext,
    lease: LeaseBinding,
    receipt: CompletionReceipt,
    finalStatus: 'succeeded' | 'failed',
    validate?: (session: ClientSession) => Promise<void>,
  ): Promise<CompletionReceipt> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    const replay = async (session?: ClientSession): Promise<CompletionReceipt | null> => {
      await this.jobs.readAuthorized(actor, lease.jobId, session);
      const saved = await this.service.control
        .collection<CompletionReceipt & { _id: string; actor: ActorContext; createdAt: Date }>(
          'completion_receipts',
        )
        .findOne({ _id: receipt.receiptId }, { session });
      if (!saved) return null;
      if (!sameScope(actor, saved.actor) || saved.actor.actorId !== actor.actorId)
        fail('UnauthorizedReceipt');
      const { _id: _ignored, actor: _actor, createdAt: _createdAt, ...payload } = saved;
      if (contentHash(payload, 'completion-receipt') !== contentHash(receipt, 'completion-receipt'))
        fail('ReceiptIdConflict');
      return payload;
    };
    const existing = await replay();
    if (existing) return existing;
    return this.service.transaction(async (session) => {
      const existing = await replay(session);
      if (existing) return existing;
      const job = await this.jobs.fence(actor, lease, session);
      if (
        receipt.jobId !== job._id ||
        receipt.runId !== job.binding.runId ||
        receipt.harnessHash !== job.binding.harnessHash ||
        receipt.scopeId !== actor.scopeId ||
        receipt.scopeRevision !== job.binding.scopeRevision
      )
        fail('ReceiptBindingMismatch');
      // Coverage is checked against the registry stored for the bound revision, not against the receipt's claim.
      const registry = await new ScopeRepository(this.service).read(
        actor,
        job.binding.scopeRevision,
        session,
      );
      assertReceiptCoversRegistry(receipt, registry);
      await this.authority.fence(actor, actor.authorizationRevision, session);
      await this.worlds.assertRunnable(actor, job.binding.worldId, receipt.scopeRevision, session);
      await this.worlds.markVerified(actor, job.binding.worldId, receipt.verifiedWorldRevision, session);
      if (validate) await validate(session);
      await this.service.control
        .collection<import('mongodb').Document & { _id: string }>('completion_receipts')
        .insertOne({ _id: receipt.receiptId, ...receipt, actor, createdAt: new Date() }, { session });
      await this.jobs.finish(actor, lease, finalStatus, [receipt.receiptId], session);
      return receipt;
    });
  }
}
