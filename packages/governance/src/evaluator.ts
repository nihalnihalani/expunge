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
  prerequisite: (artifact: string) => `gateway:prerequisite_${artifact}`,
} as const;

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
  constructor(
    private readonly bundle: HarnessBundle,
    private readonly floor: AuthorityFloor,
  ) {}

  decide(snapshot: JobSnapshot, authorizationRevision: number): Verdict {
    const input = buildDecisionInput(snapshot);
    const { decision: guardrails, outcomes } = decide(this.bundle.guardrails, input, authorizationRevision);
    let worst = SEVERITY[guardrails.result];
    const ruleIds = [...guardrails.ruleIds];
    const deny = (ruleId: string) => {
      worst = SEVERITY.deny;
      if (!ruleIds.includes(ruleId)) ruleIds.push(ruleId);
    };
    if (!this.floor.allowedTools.includes(snapshot.toolId)) deny(GATEWAY_RULES.toolNotInFloor);
    if (!this.bundle.toolPolicy.grants.includes(snapshot.toolId)) deny(GATEWAY_RULES.toolNotGranted);
    if (snapshot.batch && !this.floor.allowedEffects.includes(snapshot.batch.effectKind))
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
