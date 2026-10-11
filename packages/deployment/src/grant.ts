import { contentHash, type ActorContext, type ApprovalGrant, type DeploymentKey } from '@expunge/contracts';
import {
  ApprovalRepository,
  MAX_GRANT_LIFETIME_MS,
  deriveGrantBinding,
  fail,
  scopeFilter,
  type MongoService,
} from '@expunge/mongo';
import { renderDescriptor } from './descriptor.js';

/** What the UI sends back: the digest it was shown and a decision. Never an argument, a hash or a revision. */
export type ApprovalAnswer = { descriptorDigest: string; decision: 'approve' | 'decline' };
export type ApprovalOutcome =
  | {
      accepted: true;
      state: 'approved';
      grantId: string;
      /** True when this approval already had a grant: the same answer twice issues one grant, not two. */
      reused: boolean;
      /** Present for a grant issued by this call; the stored expiry of a reused grant is not re-read. */
      expiresAt?: Date;
    }
  | { accepted: true; state: 'declined'; auditId: string };

export const DEFAULT_GRANT_LIFETIME_MS = 15 * 60 * 1000;

/**
 * Turns the human's answer into a grant. The descriptor is rendered again from storage and its digest compared with the
 * echoed one, so the grant binds to what is stored NOW (a stale view is refused, never half-honoured). Every field of the
 * grant comes from the stored report and pointer: the request supplies the digest and the decision, nothing else. A
 * decline records nothing.
 */
export async function answerApproval(
  service: MongoService,
  request: {
    reportId: string;
    parentHash: string;
    childHash: string;
    target: DeploymentKey['target'];
    actor: ActorContext;
    answer: ApprovalAnswer;
    lifetimeMs?: number;
  },
): Promise<ApprovalOutcome> {
  const { descriptor, admitted } = await renderDescriptor(service, request);
  if (request.answer.descriptorDigest !== descriptor.descriptorDigest) fail('DescriptorStale');
  const approval = {
    target: request.target,
    proposalId: descriptor.proposalId,
    gateReportDigest: descriptor.gateReportDigest,
    parentRevision: descriptor.expectedParentRevision,
    scopeRevision: descriptor.scope.scopeRevision,
    authorizationRevision: descriptor.scope.authorizationRevision,
  };
  if (request.answer.decision === 'decline') {
    // A decline is a decision somebody made: it leaves an audit row, once per (approver, binding).
    const auditId = contentHash(
      { ...approval, approverId: request.actor.actorId, ...scopeFilter(request.actor) },
      'approval-decline',
    );
    try {
      await service.control.collection('approval_declines').insertOne({
        _id: auditId,
        ...scopeFilter(request.actor),
        ...approval,
        descriptorDigest: descriptor.descriptorDigest,
        approverId: request.actor.actorId,
        at: new Date(),
      } as never);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
    }
    return { accepted: true, state: 'declined', auditId };
  }
  if (request.answer.decision !== 'approve') fail('InvalidDecision');
  const lifetime = request.lifetimeMs ?? DEFAULT_GRANT_LIFETIME_MS;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1000 || lifetime > MAX_GRANT_LIFETIME_MS)
    fail('InvalidApprovalExpiry');
  const binding = deriveGrantBinding(admitted.report, admitted.digest);
  // The grant's identity is the approval's identity: (proposal, report digest, parent revision, revisions). Approving the
  // same descriptor twice yields the same grant id and nonce, so the second insert collides instead of minting a second
  // grant that could be spent separately.
  const identity = contentHash({ ...approval, ...scopeFilter(request.actor) }, 'approval-grant-id');
  const grant: ApprovalGrant = {
    ...scopeFilter(request.actor),
    target: request.target,
    grantId: identity,
    proposalId: binding.proposalId,
    parentHash: binding.parentHash,
    childHash: binding.childHash,
    parentRevision: descriptor.expectedParentRevision,
    approvedDescriptor: binding.approvedDescriptor,
    authorizationRevision: descriptor.scope.authorizationRevision,
    scopeRevision: descriptor.scope.scopeRevision,
    flipSetDigest: binding.flipSetDigest,
    gateReportId: binding.gateReportId,
    gateReportDigest: binding.gateReportDigest,
    approverId: request.actor.actorId,
    expiresAt: new Date(Date.now() + lifetime),
    nonce: contentHash({ identity }, 'approval-nonce'),
    createdAt: new Date(),
  };
  try {
    await new ApprovalRepository(service).issue(request.actor, grant);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000)
      return { accepted: true, state: 'approved', grantId: identity, reused: true };
    throw error;
  }
  return { accepted: true, state: 'approved', grantId: identity, reused: false, expiresAt: grant.expiresAt };
}
