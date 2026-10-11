import { randomUUID } from 'node:crypto';
import type { ClientSession, Document } from 'mongodb';
import {
  contentHash,
  deploymentIdentity,
  type ActorContext,
  type ApprovalGrant,
  type Deployment,
  type DeploymentKey,
  type GateReport,
  type JsonValue,
  type MutationClass,
  type PromotionReceipt,
} from '@expunge/contracts';
import { classifyMutation } from '@expunge/harness-compiler';
import { ArtifactRepository } from './artifacts.js';
import { AuthorityRepository } from './authority.js';
import { deriveFlipSetDigest, deriveGrantBinding, sameDescriptor, type GrantBinding } from './grants.js';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';
import { AuthorityPolicyRepository, approvalRequired } from './policy.js';
import { ProvenanceRepository } from './provenance.js';

/** A grant is a short-lived decision. Longer expiries are refused at issue time. */
export const MAX_GRANT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type PromotionInput = {
  actor: ActorContext;
  target: DeploymentKey['target'];
  candidateId: string;
  parentHash: string;
  childHash: string;
  parentRevision: number;
  gateReportId: string;
  gateReportDigest: string;
  runtimeHash: string;
  evaluatorHash: string;
  scopeRevision: number;
  flipSetDigest: string;
  approvedDescriptor: JsonValue;
  /**
   * The grant to consume when approval is required. Whether it is required is never an input: it is derived
   * inside the transaction from the gate report's trusted `computedClass` and the stored authority policy.
   */
  grantId?: string;
  reason: string;
  validateAuthority: (session: ClientSession) => Promise<void>;
};
type IdDocument = Document & { _id: string };
export type GrantConsumption = DeploymentKey & {
  _id: string;
  grantId: string;
  promotionId: string;
  candidateId: string;
  consumedAt: Date;
};

/** The grant a rollback that expands authority needs, as the caller names it. Everything but the id is cross-checked. */
export type RollbackGrantRef = {
  grantId: string;
  /** Optional claims; each must equal what the repository derives from the two stored bundles, or the rollback fails. */
  reverseClass?: MutationClass;
  approvedDescriptor?: JsonValue;
};
export type RollbackOptions = {
  /** The scope revision the caller read; the pointer must still be bound to it (compare-and-set in the transaction). */
  expectedScopeRevision: number;
  grant?: RollbackGrantRef;
};
/** Why a rollback was refused, as recorded in `rollback_refusals`. */
export const ROLLBACK_REFUSAL_CODES = [
  'RollbackNeedsGrant',
  'StaleParent',
  'StaleScopeRevision',
  'RollbackTargetIsActive',
  'ApprovalInvalidOrConsumed',
] as const;

/**
 * The class of the REVERSE transition (active -> target) and the binding a grant for it must carry, derived from the
 * two stored bundles. Neither the caller nor a model supplies any of it. There is no gate report for a rollback, so the
 * "report" half of the binding is a digest of the exact transition.
 */
export async function deriveRollbackBinding(
  artifacts: ArtifactRepository,
  activeHash: string,
  toHash: string,
  session?: ClientSession,
): Promise<{ reverseClass: MutationClass; binding: GrantBinding }> {
  const active = await artifacts.read(activeHash, session);
  const target = await artifacts.read(toHash, session);
  const reverse = classifyMutation(active.payload, target.payload);
  if (!reverse.mutationClass) fail('RollbackClassMissing');
  const flips = reverse.components
    .filter((component) => component.kind === 'authority_expansion')
    .map((component) => component.unit);
  const digest = contentHash({ kind: 'rollback', activeHash, toHash }, 'rollback-binding');
  return {
    reverseClass: reverse.mutationClass,
    binding: {
      proposalId: `rollback:${digest.slice(0, 32)}`,
      parentHash: activeHash,
      childHash: toHash,
      gateReportId: 'rollback',
      gateReportDigest: digest,
      flipSetDigest: deriveFlipSetDigest(flips),
      approvedDescriptor: {
        computedClass: reverse.mutationClass,
        parentHash: activeHash,
        childHash: toHash,
        flips: [...flips].sort(),
      },
    },
  };
}

export class ApprovalRepository {
  constructor(readonly service: MongoService) {}
  async issue(actor: ActorContext, grant: ApprovalGrant): Promise<void> {
    requirePrincipal(this.service, ['approval_issuer', 'setup']);
    if (
      grant.approverId !== actor.actorId ||
      grant.tenantId !== actor.tenantId ||
      grant.env !== actor.env ||
      grant.scopeId !== actor.scopeId ||
      grant.authorizationRevision !== actor.authorizationRevision ||
      grant.consumedAt ||
      grant.consumedBy
    )
      fail('InvalidApprovalBinding');
    if (!(grant.expiresAt instanceof Date) || grant.expiresAt.getTime() > Date.now() + MAX_GRANT_LIFETIME_MS)
      fail('InvalidApprovalExpiry');
    // A grant may only say what the stored gate report says: hashes, class, flips and descriptor are derived
    // from it, never accepted from the request that builds the grant.
    const report = await this.service.control
      .collection<GateReport & { _id: string }>('gate_reports')
      .findOne({ _id: grant.gateReportId });
    if (!report) fail('GateReportMissing');
    const { _id: _reportId, ...reportBody } = report;
    if (report.verdict !== 'admit' || !report.computedClass) fail('InvalidApprovalBinding');
    const expected = deriveGrantBinding(report, contentHash(reportBody, 'gate-report'));
    if (
      grant.proposalId !== expected.proposalId ||
      grant.parentHash !== expected.parentHash ||
      grant.childHash !== expected.childHash ||
      grant.gateReportDigest !== expected.gateReportDigest ||
      grant.flipSetDigest !== expected.flipSetDigest ||
      !sameDescriptor(grant.approvedDescriptor, expected.approvedDescriptor)
    )
      fail('InvalidApprovalBinding');
    await this.service.control
      .collection<IdDocument>('approvals')
      .insertOne({ _id: grant.grantId, ...grant });
  }
  /**
   * Issues the grant a rollback needs. Like `issue`, nothing in it comes from the request: the transition and the
   * descriptor are derived from the stored pointer and the two stored bundles, and the grant is bound to the pointer's
   * current revisions, so it is dead once the pointer moves.
   */
  async issueRollback(
    actor: ActorContext,
    input: {
      target: DeploymentKey['target'];
      toHash: string;
      expiresAt: Date;
      grantId?: string;
      nonce?: string;
    },
  ): Promise<ApprovalGrant> {
    requirePrincipal(this.service, ['approval_issuer', 'setup']);
    if (!(input.expiresAt instanceof Date) || input.expiresAt.getTime() > Date.now() + MAX_GRANT_LIFETIME_MS)
      fail('InvalidApprovalExpiry');
    const key: DeploymentKey = { ...scopeFilter(actor), target: input.target };
    const pointer = await new DeploymentRepository(this.service).read(key);
    if (!pointer) fail('DeploymentMissing');
    if (input.toHash === pointer.activeHash) fail('RollbackTargetIsActive');
    const { binding } = await deriveRollbackBinding(
      new ArtifactRepository(this.service),
      pointer.activeHash,
      input.toHash,
    );
    const grant: ApprovalGrant = {
      ...key,
      grantId: input.grantId ?? randomUUID(),
      proposalId: binding.proposalId,
      parentHash: binding.parentHash,
      childHash: binding.childHash,
      parentRevision: pointer.revision,
      approvedDescriptor: binding.approvedDescriptor,
      authorizationRevision: actor.authorizationRevision,
      scopeRevision: pointer.scopeRevision,
      flipSetDigest: binding.flipSetDigest,
      gateReportId: binding.gateReportId,
      gateReportDigest: binding.gateReportDigest,
      approverId: actor.actorId,
      expiresAt: input.expiresAt,
      nonce: input.nonce ?? randomUUID(),
      createdAt: new Date(),
    };
    await this.service.control
      .collection<IdDocument>('approvals')
      .insertOne({ _id: grant.grantId, ...grant });
    return grant;
  }
  /** A grant is consumed when, and only when, the promoter's insert-only consumption row exists. */
  async consumption(grantId: string): Promise<GrantConsumption | null> {
    return this.service.control.collection<GrantConsumption>('grant_consumptions').findOne({ _id: grantId });
  }
}
export class DeploymentRepository {
  readonly artifacts: ArtifactRepository;
  readonly policies: AuthorityPolicyRepository;
  readonly authority: AuthorityRepository;
  constructor(readonly service: MongoService) {
    this.artifacts = new ArtifactRepository(service);
    this.policies = new AuthorityPolicyRepository(service);
    this.authority = new AuthorityRepository(service);
  }
  async read(key: DeploymentKey, session?: ClientSession): Promise<Deployment | null> {
    return this.service.control
      .collection<Deployment>('deployments')
      .findOne({ _id: deploymentIdentity(key), ...scopeFilter(key), target: key.target }, { session });
  }
  async initialize(
    actor: ActorContext,
    target: DeploymentKey['target'],
    hash: string,
    scopeRevision: number,
  ): Promise<Deployment> {
    requirePrincipal(this.service, ['promoter', 'setup']);
    await this.artifacts.read(hash);
    const key = { ...scopeFilter(actor), target } as DeploymentKey;
    const pointer: Deployment = {
      ...key,
      _id: deploymentIdentity(key),
      activeHash: hash,
      revision: 0,
      scopeRevision,
      authorizationRevision: actor.authorizationRevision,
      updatedAt: new Date(),
    };
    await this.service.control.collection<Deployment>('deployments').insertOne(pointer);
    return pointer;
  }
  /** An already committed promotion for this exact candidate transition, if any (lost-acknowledgment replay). */
  private async committedPromotion(
    input: PromotionInput,
    key: DeploymentKey,
    session?: ClientSession,
  ): Promise<PromotionReceipt | null> {
    const row = await this.service.control.collection<PromotionReceipt & IdDocument>('promotions').findOne(
      {
        ...key,
        fromHash: input.parentHash,
        toHash: input.childHash,
        fromRevision: input.parentRevision,
        gateReportId: input.gateReportId,
        gateReportDigest: input.gateReportDigest,
      },
      { session },
    );
    if (!row) return null;
    const { _id: _ignored, ...receipt } = row;
    return receipt;
  }

  /**
   * Promotes `childHash` over `parentHash` in one transaction: verify the immutable artifacts and the gate
   * report, derive whether a grant is required from the gate's classification and the stored authority policy,
   * fence the child's source eligibility, consume the exact grant with an insert-only row, move the pointer by
   * compare-and-swap and append the receipt. Any failure, including a stale parent, rolls everything back.
   */
  async promote(input: PromotionInput): Promise<PromotionReceipt> {
    requirePrincipal(this.service, ['promoter', 'setup']);
    const key: DeploymentKey = {
      ...scopeFilter(input.actor),
      target: input.target,
    };
    const replayed = await this.committedPromotion(input, key);
    if (replayed) return replayed;
    const promotionId = randomUUID();
    try {
      return await this.service.transaction(async (session) => {
        const raced = await this.committedPromotion(input, key, session);
        if (raced) return raced;
        const parent = await this.artifacts.read(input.parentHash);
        const child = await this.artifacts.read(input.childHash);
        if (
          child.payload.parentHash !== parent._id ||
          child.payload.target !== input.target ||
          child.payload.runtimeAdapterHash !== input.runtimeHash
        )
          fail('CandidateArtifactMismatch');
        const report = await this.service.control
          .collection<GateReport & { _id: string }>('gate_reports')
          .findOne({ _id: input.gateReportId }, { session });
        if (!report) fail('GateReportMissing');
        const { _id: _reportId, ...payload } = report;
        if (
          contentHash(payload, 'gate-report') !== input.gateReportDigest ||
          report.verdict !== 'admit' ||
          report.candidateId !== input.candidateId ||
          report.parentHash !== input.parentHash ||
          report.childHash !== input.childHash ||
          report.runtimeHash !== input.runtimeHash ||
          report.evaluatorHash !== input.evaluatorHash
        )
          fail('GateReportMismatch');
        // Only the grader principal can write a gate report, so its class is the only trusted classification.
        if (!report.computedClass) fail('GateReportClassMissing');
        // Live authorization and the owner floor, read and fenced in this transaction.
        const authority = await this.authority.fence(key, input.actor.authorizationRevision, session);
        if (child.payload.authorityFloorHash !== authority.floorHash) fail('AuthorityFloorMismatch');
        await input.validateAuthority(session);
        const tainted = await new ProvenanceRepository(this.service).tainted(key, [input.childHash], session);
        if (tainted.has(input.childHash)) fail('ArtifactIneligible');
        const policy = await this.policies.read(key, session);
        const requiresApproval = approvalRequired(report.computedClass, policy);
        if (requiresApproval)
          await this.consumeGrant(
            {
              grantId: input.grantId,
              proposalId: input.candidateId,
              flipSetDigest: input.flipSetDigest,
              approvedDescriptor: input.approvedDescriptor,
              parentRevision: input.parentRevision,
              scopeRevision: input.scopeRevision,
              authorizationRevision: input.actor.authorizationRevision,
            },
            key,
            promotionId,
            deriveGrantBinding(report, input.gateReportDigest),
            session,
          );
        const pointer = await this.service.control.collection<Deployment>('deployments').findOneAndUpdate(
          {
            _id: deploymentIdentity(key),
            ...key,
            activeHash: input.parentHash,
            revision: input.parentRevision,
            scopeRevision: input.scopeRevision,
          },
          {
            $set: { activeHash: input.childHash, authorizationRevision: input.actor.authorizationRevision },
            $inc: { revision: 1 },
            $currentDate: { updatedAt: true },
          },
          { session, returnDocument: 'after', includeResultMetadata: false },
        );
        if (!pointer) fail('StaleParent');
        // Lifecycle mirror only: nothing above read the candidate row, so it cannot influence authorization.
        await this.service.control
          .collection<Document>('candidates')
          .updateOne({ candidateId: input.candidateId }, { $set: { state: 'promoted' } }, { session });
        const receipt: PromotionReceipt = {
          ...key,
          promotionId,
          fromHash: input.parentHash,
          toHash: input.childHash,
          fromRevision: input.parentRevision,
          toRevision: pointer.revision,
          gateReportId: input.gateReportId,
          gateReportDigest: input.gateReportDigest,
          ...(requiresApproval ? { consumedGrantId: input.grantId } : {}),
          runtimeHash: input.runtimeHash,
          evaluatorHash: input.evaluatorHash,
          reason: input.reason,
          createdAt: new Date(),
        };
        await this.appendReceipt(receipt, session);
        return receipt;
      });
    } catch (error) {
      // A commit whose acknowledgment was lost is answered with the saved receipt, never re-executed.
      const committed = await this.committedPromotion(input, key);
      if (committed) return committed;
      throw error;
    }
  }

  /**
   * Verifies the exact grant and consumes it by inserting a unique row. The promoter holds no update right on
   * `approvals`, so it cannot edit a grant, only record that one was used.
   */
  private async consumeGrant(
    claim: {
      grantId: string | undefined;
      /** The request's own claims; each must agree with what is derived from stored rows. */
      proposalId: string;
      flipSetDigest: string;
      approvedDescriptor: JsonValue;
      parentRevision: number;
      scopeRevision: number;
      authorizationRevision: number;
    },
    key: DeploymentKey,
    promotionId: string,
    expected: GrantBinding,
    session: ClientSession,
  ): Promise<void> {
    if (!claim.grantId) fail('ApprovalRequired');
    // The request's own claims must agree with what the stored rows say; they cannot choose the binding.
    if (
      claim.proposalId !== expected.proposalId ||
      claim.flipSetDigest !== expected.flipSetDigest ||
      !sameDescriptor(claim.approvedDescriptor, expected.approvedDescriptor)
    )
      fail('ApprovalInvalidOrConsumed');
    const grant = await this.service.control
      .collection<ApprovalGrant & { _id: string }>('approvals')
      .findOne({ _id: claim.grantId, $expr: { $gt: ['$expiresAt', '$$NOW'] } }, { session });
    const bound =
      grant &&
      grant.tenantId === key.tenantId &&
      grant.env === key.env &&
      grant.scopeId === key.scopeId &&
      grant.target === key.target &&
      grant.proposalId === expected.proposalId &&
      grant.parentHash === expected.parentHash &&
      grant.childHash === expected.childHash &&
      grant.parentRevision === claim.parentRevision &&
      grant.scopeRevision === claim.scopeRevision &&
      grant.authorizationRevision === claim.authorizationRevision &&
      grant.flipSetDigest === expected.flipSetDigest &&
      grant.gateReportId === expected.gateReportId &&
      grant.gateReportDigest === expected.gateReportDigest &&
      !grant.consumedAt &&
      sameDescriptor(grant.approvedDescriptor, expected.approvedDescriptor);
    if (!bound) fail('ApprovalInvalidOrConsumed');
    const consumptions = this.service.control.collection<GrantConsumption>('grant_consumptions');
    if (await consumptions.findOne({ _id: claim.grantId }, { session })) fail('ApprovalInvalidOrConsumed');
    try {
      await consumptions.insertOne(
        {
          _id: claim.grantId,
          ...key,
          grantId: claim.grantId,
          promotionId,
          candidateId: claim.proposalId,
          consumedAt: new Date(),
        },
        { session },
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000)
        fail('ApprovalInvalidOrConsumed');
      throw error;
    }
  }

  private async appendReceipt(receipt: PromotionReceipt, session: ClientSession): Promise<void> {
    const { tenantId, env, scopeId, target } = receipt;
    await this.service.control
      .collection<IdDocument>('promotions')
      .insertOne({ _id: receipt.promotionId, ...receipt }, { session });
    await this.service.control.collection<IdDocument>('deployment_outbox').insertOne(
      {
        _id: receipt.promotionId,
        tenantId,
        env,
        scopeId,
        target,
        kind: 'harness_promoted',
        dedupeKey: receipt.promotionId,
        promotionId: receipt.promotionId,
        createdAt: new Date(),
      },
      { session },
    );
  }

  /**
   * Rollback is a new audited CAS, never a rewrite of historical artifacts. The target must be a hash that was
   * active in this same DeploymentKey before (the target or source of an earlier receipt), must not be the
   * hash already active, and must not have a revoked or deleted source, all checked inside the transaction.
   *
   * One transaction: the pointer moves only if its hash, its revision AND the scope revision the caller read are all
   * still current (a promotion or a rebinding that landed first makes this lose, rolled back). The class of the
   * reverse transition (active -> target) is derived here from the two stored bundles and the stored policy; when it
   * needs approval, `opts.grant` must name a grant bound to exactly this transition and the pointer's current
   * revisions, and it is consumed once by an insert-only row. A post-CAS abort leaves the grant unconsumed because
   * the consumption is inside the same transaction. A refused rollback is recorded in `rollback_refusals`.
   */
  async rollback(
    actor: ActorContext,
    key: DeploymentKey,
    expectedHash: string,
    expectedRevision: number,
    toHash: string,
    reason: string,
    validateAuthority: (session: ClientSession) => Promise<void>,
    opts?: RollbackOptions,
  ): Promise<PromotionReceipt> {
    requirePrincipal(this.service, ['promoter', 'setup']);
    key = { ...scopeFilter(key), target: key.target };
    if (actor.tenantId !== key.tenantId || actor.env !== key.env || actor.scopeId !== key.scopeId)
      fail('UnauthorizedScope');
    try {
      return await this.rollbackOnce(
        actor,
        key,
        expectedHash,
        expectedRevision,
        toHash,
        reason,
        validateAuthority,
        opts,
      );
    } catch (error) {
      await this.recordRefusal(actor, key, toHash, error);
      throw error;
    }
  }

  private async recordRefusal(actor: ActorContext, key: DeploymentKey, toHash: string, error: unknown) {
    const code = error instanceof Error ? error.message : '';
    if (!(ROLLBACK_REFUSAL_CODES as readonly string[]).includes(code)) return;
    try {
      await this.service.control.collection<IdDocument>('rollback_refusals').insertOne({
        _id: randomUUID(),
        tenantId: key.tenantId,
        env: key.env,
        scopeId: key.scopeId,
        target: key.target,
        toHash,
        code,
        at: new Date(),
        actor: { actorId: actor.actorId, authorizationRevision: actor.authorizationRevision },
      });
    } catch {
      // The audit row is best effort: it never replaces the refusal the caller must see.
    }
  }

  private async rollbackOnce(
    actor: ActorContext,
    key: DeploymentKey,
    expectedHash: string,
    expectedRevision: number,
    toHash: string,
    reason: string,
    validateAuthority: (session: ClientSession) => Promise<void>,
    opts: RollbackOptions | undefined,
  ): Promise<PromotionReceipt> {
    // Fail closed: a rollback that does not say which scope state it acted on is refused.
    if (!opts || !Number.isSafeInteger(opts.expectedScopeRevision) || opts.expectedScopeRevision < 1)
      fail('StaleScopeRevision');
    if (toHash === expectedHash) fail('RollbackTargetIsActive');
    const artifact = await this.artifacts.read(toHash);
    if (artifact.payload.target !== key.target) fail('RollbackTargetMismatch');
    const promotionId = randomUUID();
    return this.service.transaction(async (session) => {
      const everActive = await this.service.control
        .collection<IdDocument>('promotions')
        .findOne({ ...key, $or: [{ toHash }, { fromHash: toHash }] }, { session });
      if (!everActive) fail('RollbackTargetNeverDeployed');
      const tainted = await new ProvenanceRepository(this.service).tainted(key, [toHash], session);
      if (tainted.has(toHash)) fail('ArtifactIneligible');
      const authority = await this.authority.fence(key, actor.authorizationRevision, session);
      if (artifact.payload.authorityFloorHash !== authority.floorHash) fail('AuthorityFloorMismatch');
      await validateAuthority(session);
      const pointerNow = await this.read(key, session);
      if (!pointerNow || pointerNow.activeHash !== expectedHash || pointerNow.revision !== expectedRevision)
        fail('StaleParent');
      if (pointerNow.scopeRevision !== opts.expectedScopeRevision) fail('StaleScopeRevision');
      // The class of the reverse transition, from the stored bundles; nothing the caller says is used for it.
      const derived = await deriveRollbackBinding(this.artifacts, expectedHash, toHash, session);
      const policy = await this.policies.read(key, session);
      const requiresApproval = approvalRequired(derived.reverseClass, policy);
      if (requiresApproval) {
        if (!opts.grant) fail('RollbackNeedsGrant');
        if (opts.grant.reverseClass !== undefined && opts.grant.reverseClass !== derived.reverseClass)
          fail('ApprovalInvalidOrConsumed');
        await this.consumeGrant(
          {
            grantId: opts.grant.grantId,
            proposalId: derived.binding.proposalId,
            flipSetDigest: derived.binding.flipSetDigest,
            approvedDescriptor: opts.grant.approvedDescriptor ?? derived.binding.approvedDescriptor,
            parentRevision: expectedRevision,
            scopeRevision: opts.expectedScopeRevision,
            authorizationRevision: actor.authorizationRevision,
          },
          key,
          promotionId,
          derived.binding,
          session,
        );
      }
      const next = await this.service.control.collection<Deployment>('deployments').findOneAndUpdate(
        {
          _id: deploymentIdentity(key),
          ...key,
          activeHash: expectedHash,
          revision: expectedRevision,
          scopeRevision: opts.expectedScopeRevision,
        },
        {
          $set: { activeHash: toHash, authorizationRevision: actor.authorizationRevision },
          $inc: { revision: 1 },
          $currentDate: { updatedAt: true },
        },
        { session, returnDocument: 'after', includeResultMetadata: false },
      );
      if (!next) fail('StaleParent');
      const receipt: PromotionReceipt = {
        ...key,
        promotionId,
        fromHash: expectedHash,
        toHash,
        fromRevision: expectedRevision,
        toRevision: next.revision,
        gateReportId: 'rollback',
        gateReportDigest: derived.binding.gateReportDigest,
        ...(requiresApproval ? { consumedGrantId: opts.grant!.grantId } : {}),
        runtimeHash: artifact.payload.runtimeAdapterHash,
        evaluatorHash: 'rollback',
        reason,
        createdAt: new Date(),
      };
      await this.appendReceipt(receipt, session);
      return receipt;
    });
  }
}
