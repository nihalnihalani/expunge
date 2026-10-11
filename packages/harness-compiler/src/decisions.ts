// The decision ledger row replay reads. It carries mongodb-authority's `DecisionRecord` fields plus the as-of
// inputs the gateway used (proposed additive fields `toolId` and `inputs`; see the hand-off to B1). Evaluation
// only ever reads `inputs` as of `decidedAt`; `outcome` is a label for analysing flips afterwards.
import type { PolicyDecision } from '@expunge/contracts';
import type { DecisionInput } from './semantics.js';

export interface DecisionInputs {
  facts: Record<string, unknown>;
  bindings: Record<string, unknown>;
  prior: Record<string, unknown>;
  /** ISO time each fact, binding or prior-effect value was observed. A value observed after the decision is future. */
  observedAt?: Record<string, string>;
}
export interface DecisionLedgerRow {
  decisionId: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  stepId: string;
  batchOrdinal: number;
  argsDigest: string;
  decision: PolicyDecision;
  decidedAt: string;
  toolId: string;
  inputs: DecisionInputs;
  /** What happened afterwards. Never read by the evaluator. */
  outcome?: DecisionOutcome;
}
export type OutcomeClass = 'legitimate' | 'harmful' | 'blocked_legitimate' | 'blocked_harmful';
export interface DecisionOutcome {
  class: OutcomeClass;
  recordedAt: string;
}

export interface AsOfInput {
  input: DecisionInput;
  /** Keys (`facts.x`, `bindings.y`, `prior.z`) dropped because they were observed after the decision. */
  futureDropped: string[];
}

/** The inputs exactly as the gateway had them when it decided: later observations become unknown (null). */
export function asOfInput(row: DecisionLedgerRow): AsOfInput {
  const decidedAt = Date.parse(row.decidedAt);
  const futureDropped: string[] = [];
  const clip = (group: 'facts' | 'bindings' | 'prior'): Record<string, unknown> => {
    const clipped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row.inputs[group])) {
      const observed = row.inputs.observedAt?.[`${group}.${key}`];
      if (observed !== undefined && Date.parse(observed) > decidedAt) {
        futureDropped.push(`${group}.${key}`);
        clipped[key] = null;
      } else {
        clipped[key] = value;
      }
    }
    return clipped;
  };
  return {
    input: { toolId: row.toolId, facts: clip('facts'), bindings: clip('bindings'), prior: clip('prior') },
    futureDropped,
  };
}
