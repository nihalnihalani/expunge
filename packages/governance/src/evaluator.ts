import type { HarnessBundle, PolicyDecision } from '@expunge/contracts';
import {
  SEVERITY,
  decide,
  type DecisionInput,
  type RuleOutcome,
  type Severity,
} from '@expunge/harness-compiler';
import type { AuthorityFloor } from './floor.js';
import { buildDecisionInput, type JobSnapshot } from './facts.js';

/** Reason ids the gateway itself adds to a decision, next to the bundle's own rule ids. */
export const GATEWAY_RULES = {
  toolNotInFloor: 'gateway:tool_not_in_floor',
  toolNotGranted: 'gateway:tool_not_granted',
  effectNotInFloor: 'gateway:effect_not_in_floor',
  /** The floor stored for the scope is not the floor this run was pinned to (and the evaluator holds). */
  floorMismatch: 'gateway:floor_mismatch',
  /** An effect tool was decided without a known batch: the effect kind cannot be checked, so it is denied. */
  batchUnknown: 'gateway:batch_unknown',
  prerequisite: (artifact: string) => `gateway:prerequisite_${artifact}`,
} as const;

/** Tools that change the world. Their decision needs the batch (its effect kind) or it is a deny. */
export const EFFECT_TOOLS: readonly string[] = ['apply_cleanup_batch'];
const EFFECT_KINDS: readonly string[] = ['delete', 'redact', 'restrict', 'tombstone'];

/** The floor handed to an evaluator is not the one the run's bundle names. A configuration error, never a default. */
export class FloorMismatch extends Error {
  constructor() {
    super('FloorMismatch');
    this.name = 'FloorMismatch';
  }
}

export interface Verdict {
  decision: PolicyDecision;
  /** The exact inputs the guardrails saw, for the decision ledger. */
  input: DecisionInput;
  outcomes: RuleOutcome[];
}

const WORST: Severity[] = ['allow', 'ask', 'deny'];

/**
 * One policy decision per tool call: the owner floor, the bundle's grants, the bundle's tool prerequisites and the
 * compiled guardrails, merged by severity (deny > ask > allow). The inputs come from committed job state, so a model
 * cannot supply a fact, and a fact that is not known yet is unknown to the guardrails, which fail closed.
 */
export class PolicyEvaluator {
  /**
   * @throws FloorMismatch unless `floor` is exactly the floor the bundle names. The evaluator never enforces a floor
   * the pinned bundle is not bound to.
   */
  constructor(
    private readonly bundle: HarnessBundle,
    private readonly floor: AuthorityFloor,
  ) {
    if (bundle.authorityFloorHash !== floor.hash) throw new FloorMismatch();
  }

  /**
   * @param storedFloorHash the floor hash currently stored for the scope (`authority_revisions.floorHash`), read by
   * the caller for this call. A run whose floor is no longer the stored one is denied.
   */
  decide(snapshot: JobSnapshot, authorizationRevision: number, storedFloorHash: string): Verdict {
    const input = buildDecisionInput(snapshot);
    const { decision: guardrails, outcomes } = decide(this.bundle.guardrails, input, authorizationRevision);
    let worst = SEVERITY[guardrails.result];
    const ruleIds = [...guardrails.ruleIds];
    const deny = (ruleId: string) => {
      worst = SEVERITY.deny;
      if (!ruleIds.includes(ruleId)) ruleIds.push(ruleId);
    };
    if (storedFloorHash !== this.floor.hash) deny(GATEWAY_RULES.floorMismatch);
    if (!this.floor.allowedTools.includes(snapshot.toolId)) deny(GATEWAY_RULES.toolNotInFloor);
    if (!this.bundle.toolPolicy.grants.includes(snapshot.toolId)) deny(GATEWAY_RULES.toolNotGranted);
    if (EFFECT_TOOLS.includes(snapshot.toolId)) {
      // Fail closed: an effect whose batch is not known, or names an effect kind the contract does not, is denied.
      // A stored plan with no batches (everything retained or unclassified) has nothing to effect: the call commits
      // nothing, so it is not an unknown batch (lead ruling, PKT-16). A missing plan is still unknown.
      const emptyPlan = !snapshot.batch && snapshot.plan !== null && snapshot.plan.batchCount === 0;
      if (emptyPlan) {
        // nothing to check against the floor's effects
      } else if (!snapshot.batch || !EFFECT_KINDS.includes(snapshot.batch.effectKind))
        deny(GATEWAY_RULES.batchUnknown);
      else if (!this.floor.allowedEffects.includes(snapshot.batch.effectKind))
        deny(GATEWAY_RULES.effectNotInFloor);
    } else if (snapshot.batch && !this.floor.allowedEffects.includes(snapshot.batch.effectKind))
      deny(GATEWAY_RULES.effectNotInFloor);
    for (const prerequisite of this.bundle.toolPolicy.prerequisites) {
      if (prerequisite.toolId !== snapshot.toolId) continue;
      if (input.bindings[prerequisite.requiredArtifact] !== 'valid')
        deny(GATEWAY_RULES.prerequisite(prerequisite.requiredArtifact));
    }
    return {
      decision: { result: WORST[worst]!, ruleIds, authorizationRevision },
      input,
      outcomes,
    };
  }
}
