import type { ClientSession } from 'mongodb';
import { contentHash, type ActorContext, type ScopeKey } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

/**
 * What a human approval of ONE effect is bound to: this job, its run's pinned harness and owner policy, this plan, this
 * batch, exactly this effect (the effect key and the derived args digest, which already bind targets and expected
 * versions) at this authorization revision. Not in it: the decision id and the rule ids, which are written or change after
 * the approval is looked up.
 */
export type EffectApprovalBound = ScopeKey & {
  jobId: string;
  runId: string;
  harnessHash: string;
  ownerPolicyHash: string;
  approvedPlanHash: string;
  batchOrdinal: number;
  effectKey: string;
  argsDigest: string;
  authorizationRevision: number;
};
export const deriveEffectApprovalBinding = (bound: EffectApprovalBound): string =>
  contentHash(bound, 'effect-approval-binding');

export const EFFECT_APPROVAL_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const EFFECT_APPROVAL_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const HEX64 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

export type StoredEffectApproval = ScopeKey & {
  _id: string;
  jobId: string;
  binding: string;
  bound: EffectApprovalBound;
  approverId: string;
  nonce: string;
  expiresAt: Date;
  createdAt: Date;
  consumedAt?: Date;
  consumedBy?: string;
};
export type EffectApprovalStatus = { status: 'valid' | 'invalid' | null; grantId: string | null };

const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

/**
 * Single-use approvals of one effect. The approver (`approval_issuer`) inserts; the gateway reads the status for a binding
 * before it decides, and consumes the grant inside the effect's own transaction, so a failed commit leaves the grant
 * unspent and a committed effect spends it exactly once. A collection grant cannot narrow the gateway's UPDATE to the
 * conditional consume; `consume` is the only code path that writes it.
 */
export class EffectApprovalRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<StoredEffectApproval>('effect_approvals');
  }

  /** Inserts a grant for exactly the effect `bound` names. The actor is the approver and must be in the bound's scope. */
  async issue(
    actor: ActorContext,
    input: { bound: EffectApprovalBound; expiresAt?: Date; grantId?: string; nonce?: string },
  ): Promise<StoredEffectApproval> {
    requirePrincipal(this.service, ['approval_issuer', 'setup']);
    const { bound } = input;
    const scope = scopeFilter(actor);
    if (
      scope.tenantId !== bound.tenantId ||
      scope.env !== bound.env ||
      scope.scopeId !== bound.scopeId ||
      actor.authorizationRevision !== bound.authorizationRevision
    )
      fail('InvalidApprovalBinding');
    if (
      !IDENTIFIER.test(bound.jobId) ||
      ![
        bound.harnessHash,
        bound.ownerPolicyHash,
        bound.approvedPlanHash,
        bound.effectKey,
        bound.argsDigest,
      ].every((v) => HEX64.test(v)) ||
      !Number.isSafeInteger(bound.batchOrdinal) ||
      bound.batchOrdinal < 0
    )
      fail('InvalidApprovalBinding');
    const now = Date.now();
    const expiresAt = input.expiresAt ?? new Date(now + EFFECT_APPROVAL_DEFAULT_LIFETIME_MS);
    if (
      !(expiresAt instanceof Date) ||
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= now ||
      expiresAt.getTime() > now + EFFECT_APPROVAL_MAX_LIFETIME_MS
    )
      fail('InvalidApprovalExpiry');
    const grantId = input.grantId ?? contentHash({ bound, at: now, n: Math.random() }, 'effect-approval-id');
    const row: StoredEffectApproval = {
      _id: grantId,
      ...scope,
      jobId: bound.jobId,
      binding: deriveEffectApprovalBinding(bound),
      bound,
      approverId: actor.actorId,
      nonce: input.nonce ?? contentHash({ grantId, at: now }, 'effect-approval-nonce'),
      expiresAt,
      createdAt: new Date(now),
    };
    try {
      await this.rows.insertOne(row as never);
    } catch (error) {
      if (isDuplicate(error)) fail('ApprovalAlreadyIssued');
      throw error;
    }
    return row;
  }

  /**
   * valid: a grant for this binding is unspent and unexpired (the server's clock decides); invalid: grants exist for it but
   * none is usable; null: none. If several exist and any is valid, valid wins and names it.
   */
  async status(actor: ScopeKey, binding: string, session?: ClientSession): Promise<EffectApprovalStatus> {
    requirePrincipal(this.service, ['domain_executor', 'grader', 'setup']);
    if (!HEX64.test(binding)) fail('InvalidApprovalBinding');
    const scope = scopeFilter(actor);
    const valid = await this.rows.findOne(
      { ...scope, binding, consumedAt: { $exists: false }, $expr: { $gt: ['$expiresAt', '$$NOW'] } },
      { session, projection: { _id: 1 } },
    );
    if (valid) return { status: 'valid', grantId: valid._id };
    const any = await this.rows.findOne({ ...scope, binding }, { session, projection: { _id: 1 } });
    return { status: any ? 'invalid' : null, grantId: null };
  }

  /**
   * Spends the grant for the effect `effectKey`, inside the effect's transaction. Refuses (aborting that transaction) when
   * the grant is missing, already spent, expired, or in another scope.
   */
  async consume(actor: ScopeKey, grantId: string, effectKey: string, session: ClientSession): Promise<void> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    if (!HEX64.test(effectKey)) fail('InvalidApprovalBinding');
    const result = await this.rows.updateOne(
      {
        _id: grantId,
        ...scopeFilter(actor),
        consumedAt: { $exists: false },
        $expr: { $gt: ['$expiresAt', '$$NOW'] },
      },
      [{ $set: { consumedAt: '$$NOW', consumedBy: { $literal: effectKey } } }],
      { session },
    );
    if (result.matchedCount !== 1) fail('ApprovalNotAvailable');
  }

  async read(actor: ScopeKey, grantId: string): Promise<StoredEffectApproval | null> {
    requirePrincipal(this.service, ['approval_issuer', 'domain_executor', 'grader', 'setup']);
    return this.rows.findOne({ _id: grantId, ...scopeFilter(actor) });
  }
}
