// Critic and pruner. A rule earns its place only by changing at least one replayed decision. Retesting the whole
// accumulated rule set (not each rule alone) finds rules that matter only in the presence of another, and rules that
// another rule makes redundant; the pruner removes rules with no standing one at a time and retests after each.
import type { GuardrailAst } from '@expunge/contracts';
import { asOfInput, decide, type DecisionLedgerRow } from '@expunge/harness-compiler';

export interface RuleMarginal {
  ruleId: string;
  /** Replayed rows on which the rule fires. */
  fires: number;
  /** Rows whose decision differs when this rule alone is removed from the accumulated set. */
  marginalFlips: number;
  /** Other rules whose firing rows cover every row this rule fires on: removing this rule alone changes nothing. */
  coveredBy: string[];
}

const results = (rules: readonly GuardrailAst[], corpus: readonly DecisionLedgerRow[]): string[] =>
  corpus.map((row) => decide(rules, asOfInput(row).input).decision.result);

/** Per-rule marginal effect inside the accumulated set. */
export function retestAccumulated(
  rules: readonly GuardrailAst[],
  corpus: readonly DecisionLedgerRow[],
): RuleMarginal[] {
  const full = results(rules, corpus);
  const firing = new Map<string, Set<string>>();
  for (const rule of rules) {
    const rows = new Set<string>();
    for (const row of corpus) {
      if (decide([rule], asOfInput(row).input).decision.ruleIds.length) rows.add(row.decisionId);
    }
    firing.set(rule.ruleId, rows);
  }
  return rules.map((rule) => {
    const without = results(
      rules.filter((candidate) => candidate.ruleId !== rule.ruleId),
      corpus,
    );
    const own = firing.get(rule.ruleId)!;
    const coveredBy = rules
      .filter(
        (other) =>
          other.ruleId !== rule.ruleId &&
          own.size > 0 &&
          [...own].every((id) => firing.get(other.ruleId)!.has(id)),
      )
      .map((other) => other.ruleId);
    return {
      ruleId: rule.ruleId,
      fires: own.size,
      marginalFlips: full.filter((verdict, index) => verdict !== without[index]).length,
      coveredBy,
    };
  });
}

export interface PruneResult {
  kept: GuardrailAst[];
  pruned: Array<{ ruleId: string; reason: 'no_standing' }>;
}
/** Removes rules without standing, one at a time, retesting the accumulated set after every removal. */
export function pruneRules(
  rules: readonly GuardrailAst[],
  corpus: readonly DecisionLedgerRow[],
  protectedIds: ReadonlySet<string> = new Set(),
): PruneResult {
  let kept = [...rules];
  const pruned: PruneResult['pruned'] = [];
  for (;;) {
    const victim = retestAccumulated(kept, corpus).find(
      (marginal) => marginal.marginalFlips === 0 && !protectedIds.has(marginal.ruleId),
    );
    if (!victim) return { kept, pruned };
    kept = kept.filter((rule) => rule.ruleId !== victim.ruleId);
    pruned.push({ ruleId: victim.ruleId, reason: 'no_standing' });
  }
}
