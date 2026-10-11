import type { ClientSession } from 'mongodb';
import {
  deploymentIdentity,
  type AuthorityPolicy,
  type DeploymentKey,
  type MutationClass,
} from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

const MUTATION_CLASSES: readonly MutationClass[] = ['tightening', 'behavioral', 'authority_expansion'];

/**
 * Whether promoting a candidate of `computedClass` needs a consumed human grant.
 * `authority_expansion` always does, `tightening` never does, `behavioral` follows the stored policy.
 * The class must be the gate's trusted classification, never a value the caller supplied.
 */
export function approvalRequired(
  computedClass: MutationClass,
  policy: Pick<AuthorityPolicy, 'behavioralRequiresApproval'>,
): boolean {
  if (!MUTATION_CLASSES.includes(computedClass)) fail('UnknownMutationClass');
  if (computedClass === 'authority_expansion') return true;
  if (computedClass === 'tightening') return false;
  return policy.behavioralRequiresApproval;
}

/**
 * Stored approval policy, one row per DeploymentKey. Only the setup principal writes it; the promoter reads it
 * inside the promotion transaction, so no request can choose its own authorization result.
 */
export class AuthorityPolicyRepository {
  constructor(readonly service: MongoService) {}

  private get collection() {
    return this.service.control.collection<AuthorityPolicy & { _id: string }>('authority_policies');
  }

  /** Insert-only and idempotent for an identical value; a different stored value is a `PolicyConflict`. */
  async install(key: DeploymentKey, behavioralRequiresApproval: boolean): Promise<AuthorityPolicy> {
    requirePrincipal(this.service, ['setup']);
    if (typeof behavioralRequiresApproval !== 'boolean') fail('InvalidAuthorityPolicy');
    const row = { ...scopeFilter(key), target: key.target } as DeploymentKey;
    const policy: AuthorityPolicy = { ...row, behavioralRequiresApproval, createdAt: new Date() };
    const _id = deploymentIdentity(row);
    const result = await this.collection.updateOne(
      { _id },
      { $setOnInsert: { ...policy } },
      { upsert: true },
    );
    if (result.upsertedCount === 1) return policy;
    const stored = await this.read(row);
    if (stored.behavioralRequiresApproval !== behavioralRequiresApproval) fail('PolicyConflict');
    return stored;
  }

  /** Deliberate policy change. Kept separate from `install` so a conflicting install is never silent. */
  async replace(key: DeploymentKey, behavioralRequiresApproval: boolean): Promise<void> {
    requirePrincipal(this.service, ['setup']);
    if (typeof behavioralRequiresApproval !== 'boolean') fail('InvalidAuthorityPolicy');
    const result = await this.collection.updateOne(
      { _id: deploymentIdentity(key) },
      { $set: { behavioralRequiresApproval } },
    );
    if (result.matchedCount !== 1) fail('AuthorityPolicyMissing');
  }

  async read(key: DeploymentKey, session?: ClientSession): Promise<AuthorityPolicy> {
    const row = await this.collection.findOne(
      { _id: deploymentIdentity(key), ...scopeFilter(key), target: key.target },
      { session },
    );
    // No stored policy means no authority to decide: fail closed instead of defaulting to "no approval".
    if (!row) fail('AuthorityPolicyMissing');
    const { _id: _ignored, ...policy } = row;
    return policy;
  }
}
