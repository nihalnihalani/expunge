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
  type PromotionReceipt,
} from '@expunge/contracts';
import { ArtifactRepository } from './artifacts.js';
import { AuthorityRepository } from './authority.js';
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
    await this.service.control
      .collection<IdDocument>('approvals')
      .insertOne({ _id: grant.grantId, ...grant });
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
        if (requiresApproval) await this.consumeGrant(input, key, promotionId, session);
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
    input: PromotionInput,
    key: DeploymentKey,
    promotionId: string,
    session: ClientSession,
  ): Promise<void> {
    if (!input.grantId) fail('ApprovalRequired');
    const grant = await this.service.control
      .collection<ApprovalGrant & { _id: string }>('approvals')
      .findOne({ _id: input.grantId, $expr: { $gt: ['$expiresAt', '$$NOW'] } }, { session });
    const bound =
      grant &&
      grant.tenantId === key.tenantId &&
      grant.env === key.env &&
      grant.scopeId === key.scopeId &&
      grant.target === key.target &&
      grant.proposalId === input.candidateId &&
      grant.parentHash === input.parentHash &&
      grant.childHash === input.childHash &&
      grant.parentRevision === input.parentRevision &&
      grant.scopeRevision === input.scopeRevision &&
      grant.authorizationRevision === input.actor.authorizationRevision &&
      grant.flipSetDigest === input.flipSetDigest &&
      grant.gateReportId === input.gateReportId &&
      grant.gateReportDigest === input.gateReportDigest &&
      !grant.consumedAt &&
      // Canonical comparison: BSON field order must not decide whether a descriptor "matches".
      contentHash(grant.approvedDescriptor, 'approved-descriptor') ===
        contentHash(input.approvedDescriptor, 'approved-descriptor');
    if (!bound) fail('ApprovalInvalidOrConsumed');
    const consumptions = this.service.control.collection<GrantConsumption>('grant_consumptions');
    if (await consumptions.findOne({ _id: input.grantId }, { session })) fail('ApprovalInvalidOrConsumed');
    try {
      await consumptions.insertOne(
        {
          _id: input.grantId,
          ...key,
          grantId: input.grantId,
          promotionId,
          candidateId: input.candidateId,
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
   */
  async rollback(
    actor: ActorContext,
    key: DeploymentKey,
    expectedHash: string,
    expectedRevision: number,
    toHash: string,
    reason: string,
    validateAuthority: (session: ClientSession) => Promise<void>,
  ): Promise<PromotionReceipt> {
    requirePrincipal(this.service, ['promoter', 'setup']);
    key = { ...scopeFilter(key), target: key.target };
    if (actor.tenantId !== key.tenantId || actor.env !== key.env || actor.scopeId !== key.scopeId)
      fail('UnauthorizedScope');
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
      const next = await this.service.control.collection<Deployment>('deployments').findOneAndUpdate(
        {
          _id: deploymentIdentity(key),
          ...key,
          activeHash: expectedHash,
          revision: expectedRevision,
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
        gateReportDigest: contentHash({ expectedHash, toHash, reason }, 'rollback'),
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
