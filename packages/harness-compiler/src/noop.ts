import type { GuardrailAst } from '@expunge/contracts';
import { asOfInput, type DecisionLedgerRow } from './decisions.js';
import { decide } from './semantics.js';

/** The decision result of every row under a rule set, as-of the decision time. */
export function replayResults(
  rules: readonly GuardrailAst[],
  corpus: readonly DecisionLedgerRow[],
): string[] {
  return corpus.map((row) => decide(rules, asOfInput(row).input).decision.result);
}

/**
 * Rules whose removal changes no replayed decision (Phantom Guardrails: a no-op rule in a useful batch). Judged
 * rule by rule against the rest of the candidate, so two redundant rules are both flagged until one is pruned.
 */
export function findNoOpRules(
  rules: readonly GuardrailAst[],
  candidateIds: readonly string[],
  corpus: readonly DecisionLedgerRow[],
): string[] {
  const full = replayResults(rules, corpus);
  return candidateIds.filter((ruleId) => {
    const without = replayResults(
      rules.filter((rule) => rule.ruleId !== ruleId),
      corpus,
    );
    return without.every((result, index) => result === full[index]);
  });
}
