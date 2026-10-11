import { contentHash, type EffectKind, type HarnessBundle, type ResourceLimits } from '@expunge/contracts';
import { OWNER_EPISODE_LIMITS, WORKER_TOOL_IDS } from '@expunge/baselines';
import { validateLimits, validateToolPolicy, type Issue, type OwnerFloor } from '@expunge/harness-compiler';

/**
 * The immutable owner ceiling. A bundle can only tighten within it: its tools must be a subset of
 * `allowedTools`, its limits no larger than `maxLimits`, and it must name this floor by hash. The hash is the
 * value the scope's authority row stores (`authority_revisions.floorHash`) and every promoted bundle carries
 * (`authorityFloorHash`), so changing the floor changes the hash and revokes every run pinned to the old one.
 */
export interface AuthorityFloor extends OwnerFloor {
  readonly allowedEffects: readonly EffectKind[];
}
export type AuthorityFloorSpec = {
  allowedTools: readonly string[];
  allowedEffects: readonly EffectKind[];
  maxLimits: ResourceLimits;
};
const EFFECT_ORDER: readonly EffectKind[] = ['delete', 'redact', 'restrict', 'tombstone'];

/** Canonical form of a floor spec: tool and effect lists sorted, so listing order never changes the hash. */
function normalized(spec: AuthorityFloorSpec) {
  return {
    allowedTools: [...spec.allowedTools].sort(),
    allowedEffects: EFFECT_ORDER.filter((effect) => spec.allowedEffects.includes(effect)),
    maxLimits: spec.maxLimits,
  };
}
export function authorityFloorHash(spec: AuthorityFloorSpec): string {
  return contentHash(normalized(spec), 'authority-floor');
}
export function createAuthorityFloor(spec: AuthorityFloorSpec): AuthorityFloor {
  const body = normalized(spec);
  return Object.freeze({ hash: authorityFloorHash(spec), ...body });
}
/** The floor of the preregistered owner episode limits: every worker tool, every effect kind. */
export const DEFAULT_AUTHORITY_FLOOR: AuthorityFloor = createAuthorityFloor({
  allowedTools: WORKER_TOOL_IDS,
  allowedEffects: EFFECT_ORDER,
  maxLimits: OWNER_EPISODE_LIMITS,
});

export class FloorViolation extends Error {
  constructor(readonly issues: readonly Issue[]) {
    super(`FloorViolation:${issues.map((entry) => entry.code).join(',')}`);
    this.name = 'FloorViolation';
  }
}
/** Issues a bundle has against the floor; empty when it is within it. */
export function floorIssues(bundle: HarnessBundle, floor: AuthorityFloor): Issue[] {
  const issues = [
    ...validateLimits(bundle.limits, floor),
    ...validateToolPolicy(bundle.toolPolicy, bundle.workflow, floor),
  ];
  if (bundle.authorityFloorHash !== floor.hash)
    issues.push({
      code: 'infrastructure_hash_mismatch',
      path: 'authorityFloorHash',
      message: 'bundle names another floor',
    });
  return issues;
}
export function assertBundleWithinFloor(bundle: HarnessBundle, floor: AuthorityFloor): void {
  const issues = floorIssues(bundle, floor);
  if (issues.length > 0) throw new FloorViolation(issues);
}
