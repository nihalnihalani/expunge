import { contentHash, type EffectKind, type ScopeRegistry } from '@expunge/contracts';

/**
 * A fixed owner eligibility policy: which effect applies to which record and what each effect means. The registry
 * names a policy by id and hash; the gateway implements only policies it knows and refuses a registry whose hash
 * differs from the text below, so a registry cannot ask for semantics the gateway never reviewed.
 */
export interface OwnerPolicy {
  readonly id: string;
  readonly hash: string;
  /** The collection that holds the authorized subject's own record. */
  readonly subjectCollectionId: string;
  readonly redactionReplacement: string;
  /** Registered field id that holds the record's private payload, or null when the collection has none. */
  payloadFieldId(collectionId: string): string | null;
  /**
   * Whether a registered field carries identity: a value that names the subject exactly (an id, an alias, an e-mail).
   * Only identity fields seed discovery, resolve the subject's bindings and select other records. A free field
   * (a country code, a status) never does, however many records share its value.
   */
  isIdentityField(fieldId: string): boolean;
}

const SYNTHETIC_V1 = {
  id: 'synthetic-owner-policy-v1',
  delete: 'remove-target-only-record',
  redact: 'replace-exact-bindings-and-private-payload',
  restrict: 'preserve-record-and-restrict-access',
  tombstone: 'null-exact-bindings-and-private-payload-preserve-business',
} as const;
/** Same text, same domain separator and same digest as the fixture generator's policy. */
export const SYNTHETIC_OWNER_POLICY_V1: OwnerPolicy = Object.freeze({
  id: SYNTHETIC_V1.id,
  hash: contentHash(SYNTHETIC_V1, 'eligibility-policy'),
  subjectCollectionId: 'customers',
  redactionReplacement: '[redacted]',
  payloadFieldId: (collectionId: string) => `${collectionId}.private_payload`,
  // The synthetic registries name their identity-bearing fields by convention; a policy for another registry names its own.
  isIdentityField: (fieldId: string) =>
    fieldId.endsWith('.identity_binding') ||
    fieldId === 'customers.aliases' ||
    fieldId === 'customers.identity_email',
});

const POLICIES: readonly OwnerPolicy[] = [SYNTHETIC_OWNER_POLICY_V1];

export class UnknownOwnerPolicy extends Error {
  constructor() {
    super('UnknownOwnerPolicy');
    this.name = 'UnknownOwnerPolicy';
  }
}
/** The implemented policy the registry names, or throws when the id or the hash is not one the gateway reviewed. */
export function ownerPolicyFor(
  registry: Pick<ScopeRegistry, 'eligibilityPolicyId' | 'eligibilityPolicyHash'>,
): OwnerPolicy {
  const policy = POLICIES.find((candidate) => candidate.id === registry.eligibilityPolicyId);
  if (!policy || policy.hash !== registry.eligibilityPolicyHash) throw new UnknownOwnerPolicy();
  return policy;
}

export type EligibilityVerdict =
  | { eligible: true; effect: EffectKind }
  | { eligible: false; reason: 'policy_mismatch' | 'effect_not_allowed' | 'missing_metadata' };
/**
 * The effect the owner policy assigns to one record, read from its trusted envelope. A record under another
 * policy, with an effect the scope does not allow, or without metadata is retained, never touched.
 */
export function eligibilityOf(
  registry: Pick<ScopeRegistry, 'eligibilityPolicyId' | 'allowedEffectKinds'>,
  record: { eligibility?: { effect?: unknown; policyId?: unknown } },
): EligibilityVerdict {
  const metadata = record.eligibility;
  if (!metadata || typeof metadata.effect !== 'string' || typeof metadata.policyId !== 'string')
    return { eligible: false, reason: 'missing_metadata' };
  if (metadata.policyId !== registry.eligibilityPolicyId)
    return { eligible: false, reason: 'policy_mismatch' };
  const effect = metadata.effect as EffectKind;
  if (!registry.allowedEffectKinds.includes(effect)) return { eligible: false, reason: 'effect_not_allowed' };
  return { eligible: true, effect };
}
