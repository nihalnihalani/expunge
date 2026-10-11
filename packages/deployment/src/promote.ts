import type { ActorContext, ApprovalGrant, DeploymentKey, PromotionReceipt } from '@expunge/contracts';
import {
  ApprovalRepository,
  DeploymentRepository,
  MAX_GRANT_LIFETIME_MS,
  ProvenanceRepository,
  deriveGrantBinding,
  fail,
  scopeFilter,
  type MongoService,
} from '@expunge/mongo';
import { loadAdmittedReport } from './report.js';

/**
 * Seams for race tests only. They run arbitrary code inside the retried transaction, so they are NOT on the package's
 * public surface: `promoteAdmitted` and `rollbackDeployment` take none, and only the tests import `promoteWithHooks`
 * and `rollbackWithHooks` by path from this module (the package exports its entry point alone).
 */
export type RaceHooks = {
  /** Runs after this caller's own stale-parent pre-check on the pointer, before it opens the transaction. */
  afterPrecheck?: () => Promise<void>;
  /** Runs inside the transaction, after the authority fence, before the pointer compare-and-set. */
  inTransaction?: () => Promise<void>;
};

export type PromoteRequest = {
  actor: ActorContext;
  target: DeploymentKey['target'];
  reportId: string;
  parentHash: string;
  childHash: string;
  /** The grant to consume. Whether one is required is decided inside the transaction from the stored class and policy. */
  grantId?: string;
  reason: string;
  expectedDigest?: string;
};

/**
 * Promotes `childHash` over `parentHash`. Nothing but the ids comes from the caller: the report is loaded and
 * re-derived (`loadAdmittedReport`), the pointer's revisions are read here, and the grant binding is derived from the
 * stored report. `DeploymentRepository.promote` then does the one transaction (live authorization, floor, taint, class
 * and policy, grant consumption, pointer compare-and-set on the exact tested parent and revision, receipt and outbox).
 * No model or network call is made anywhere on this path.
 */
export function promoteAdmitted(service: MongoService, request: PromoteRequest): Promise<PromotionReceipt> {
  return promoteWithHooks(service, request);
}

export async function promoteWithHooks(
  service: MongoService,
  request: PromoteRequest,
  hooks: RaceHooks = {},
): Promise<PromotionReceipt> {
  const scope = scopeFilter(request.actor);
  const key: DeploymentKey = { ...scope, target: request.target };
  const admitted = await loadAdmittedReport(service, {
    reportId: request.reportId,
    parentHash: request.parentHash,
    childHash: request.childHash,
    scope,
    ...(request.expectedDigest ? { expectedDigest: request.expectedDigest } : {}),
  });
  const deployments = new DeploymentRepository(service);
  const pointer = await deployments.read(key);
  if (!pointer) fail('DeploymentMissing');
  if (pointer.activeHash !== request.parentHash) fail('StaleParent');
  await hooks.afterPrecheck?.();
  // The child and every source it cites must still be eligible AT COMMIT, in the transaction's own snapshot: a source
  // revoked after the report was loaded stops the promotion instead of riding on the earlier check.
  const evidenceHashes = [
    ...new Set([request.childHash, ...admitted.child.evidence.map((e) => e.contentHash)]),
  ];
  const binding = deriveGrantBinding(admitted.report, admitted.digest);
  const fence = deployments.authority.validator(request.actor);
  return deployments.promote({
    actor: request.actor,
    target: request.target,
    candidateId: admitted.report.candidateId,
    parentHash: request.parentHash,
    childHash: request.childHash,
    parentRevision: pointer.revision,
    gateReportId: admitted.report.reportId,
    gateReportDigest: admitted.digest,
    runtimeHash: admitted.report.runtimeHash,
    evaluatorHash: admitted.report.evaluatorHash,
    scopeRevision: pointer.scopeRevision,
    flipSetDigest: binding.flipSetDigest,
    approvedDescriptor: binding.approvedDescriptor,
    ...(request.grantId ? { grantId: request.grantId } : {}),
    reason: request.reason,
    validateAuthority: async (session) => {
      await fence(session);
      const tainted = await new ProvenanceRepository(service).tainted(scope, evidenceHashes, session);
      if (tainted.size > 0) fail('ArtifactIneligible');
      await hooks.inTransaction?.();
    },
  });
}

export type RollbackRequest = {
  actor: ActorContext;
  target: DeploymentKey['target'];
  toHash: string;
  reason: string;
  grantId?: string;
};

/**
 * A rollback is a new audited pointer move to a hash that was active in this key before. The class of the reverse
 * transition is derived inside the transaction from the two stored bundles and the stored policy; a reverse
 * transition that needs approval consumes a grant issued by `issueRollbackGrant`. A refused rollback is recorded.
 */
export function rollbackDeployment(
  service: MongoService,
  request: RollbackRequest,
): Promise<PromotionReceipt> {
  return rollbackWithHooks(service, request);
}

export async function rollbackWithHooks(
  service: MongoService,
  request: RollbackRequest,
  hooks: RaceHooks = {},
): Promise<PromotionReceipt> {
  const key: DeploymentKey = { ...scopeFilter(request.actor), target: request.target };
  const deployments = new DeploymentRepository(service);
  const pointer = await deployments.read(key);
  if (!pointer) fail('DeploymentMissing');
  await hooks.afterPrecheck?.();
  const fence = deployments.authority.validator(request.actor);
  return deployments.rollback(
    request.actor,
    key,
    pointer.activeHash,
    pointer.revision,
    request.toHash,
    request.reason,
    async (session) => {
      await fence(session);
      await hooks.inTransaction?.();
    },
    {
      expectedScopeRevision: pointer.scopeRevision,
      ...(request.grantId ? { grant: { grantId: request.grantId } } : {}),
    },
  );
}

/** The grant a rollback that expands authority needs, derived from the stored pointer and bundles (approval issuer). */
export async function issueRollbackGrant(
  service: MongoService,
  request: { actor: ActorContext; target: DeploymentKey['target']; toHash: string; lifetimeMs?: number },
): Promise<ApprovalGrant> {
  const lifetime = request.lifetimeMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1000 || lifetime > MAX_GRANT_LIFETIME_MS)
    fail('InvalidApprovalExpiry');
  return new ApprovalRepository(service).issueRollback(request.actor, {
    target: request.target,
    toHash: request.toHash,
    expiresAt: new Date(Date.now() + lifetime),
  });
}
