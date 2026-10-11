// As-of DECISION REPLAY. Each recorded decision is re-evaluated under a candidate's guardrails using only the
// facts that were known when it was made (later-observed facts become unknown). It answers how a candidate policy
// treats recorded decisions. It cannot say what a new agent would do with the candidate: fresh paired trials do.
import type { GuardrailAst } from '@expunge/contracts';
import {
  asOfInput,
  compileDecisionExpression,
  decide,
  evaluateMongoExpression,
  type DecisionLedgerRow,
  type OutcomeClass,
} from '@expunge/harness-compiler';

export type Verdict = 'allow' | 'ask' | 'deny';
const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

export interface ReplayFlip {
  decisionId: string;
  toolId: string;
  from: Verdict;
  to: Verdict;
  firedRuleIds: string[];
  /** What happened after the recorded decision. Used only to label the flip, never to evaluate it. */
  outcome: OutcomeClass | null;
  /** The candidate permits more than the recorded decision did. */
  authorityFlip: boolean;
}
export interface ReplayReport {
  label: 'decision replay';
  behavioralProof: false;
  statement: string;
  parentHash: string | null;
  childHash: string;
  rows: number;
  /** Rows whose recorded decision the parent policy does not reproduce (data-quality signal, not an error). */
  parentMismatches: number;
  /** Facts, bindings or effect counts observed after the decision and therefore withheld from evaluation. */
  futureFactsDropped: number;
  unchanged: number;
  flips: ReplayFlip[];
  /** Flips where the candidate permits what the recorded decision blocked (deny/ask -> less restrictive). */
  knownAuthorityFlips: ReplayFlip[];
  /** Flips that the recorded outcome shows were wrong: a legitimate call now blocked, or a blocked-harmful call now permitted. */
  regressions: ReplayFlip[];
  /** Flips that the recorded outcome shows were right: a harmful call now blocked, or a wrongly blocked call now permitted. */
  fixes: ReplayFlip[];
  /** The TypeScript evaluator and the compiled Mongo expressions agreed on every row. */
  semanticsParity: true;
}

export const REPLAY_STATEMENT =
  'Decision replay re-evaluates recorded decisions under the candidate guardrails with facts as they were at decision time. It is not behavioral proof; fresh paired trials decide admission.';

function isRegression(flip: ReplayFlip): boolean {
  if (flip.outcome === 'legitimate' && RANK[flip.to] > RANK[flip.from]) return true;
  return flip.outcome === 'blocked_harmful' && RANK[flip.to] < RANK[flip.from];
}
function isFix(flip: ReplayFlip): boolean {
  if (flip.outcome === 'harmful' && RANK[flip.to] > RANK[flip.from]) return true;
  return flip.outcome === 'blocked_legitimate' && RANK[flip.to] < RANK[flip.from];
}

/** Evaluates one row with both semantics paths and requires them to agree. */
function decideBothWays(
  rules: readonly GuardrailAst[],
  row: DecisionLedgerRow,
): { verdict: Verdict; ruleIds: string[]; dropped: number } {
  const { input, futureDropped } = asOfInput(row);
  const { decision } = decide(rules, input);
  const expression = compileDecisionExpression(rules);
  const document = { toolId: input.toolId, facts: input.facts, bindings: input.bindings, prior: input.prior };
  const mongoResult = evaluateMongoExpression(expression.result, document);
  const mongoRules = evaluateMongoExpression(expression.ruleIds, document);
  if (mongoResult !== decision.result || JSON.stringify(mongoRules) !== JSON.stringify(decision.ruleIds)) {
    throw new Error('ReplayParityViolation');
  }
  return { verdict: decision.result, ruleIds: decision.ruleIds, dropped: futureDropped.length };
}

export function replayCandidate(input: {
  parentRules: readonly GuardrailAst[];
  childRules: readonly GuardrailAst[];
  parentHash: string | null;
  childHash: string;
  corpus: readonly DecisionLedgerRow[];
}): ReplayReport {
  const flips: ReplayFlip[] = [];
  let parentMismatches = 0;
  let futureFactsDropped = 0;
  for (const row of input.corpus) {
    const parent = decideBothWays(input.parentRules, row);
    const child = decideBothWays(input.childRules, row);
    futureFactsDropped += child.dropped;
    if (parent.verdict !== row.decision.result) parentMismatches++;
    // Flips are measured against what actually happened: the recorded decision.
    const recorded = row.decision.result;
    if (child.verdict === recorded) continue;
    flips.push({
      decisionId: row.decisionId,
      toolId: row.toolId,
      from: recorded,
      to: child.verdict,
      firedRuleIds: child.ruleIds,
      outcome: row.outcome?.class ?? null,
      authorityFlip: RANK[child.verdict] < RANK[recorded],
    });
  }
  return {
    label: 'decision replay',
    behavioralProof: false,
    statement: REPLAY_STATEMENT,
    parentHash: input.parentHash,
    childHash: input.childHash,
    rows: input.corpus.length,
    parentMismatches,
    futureFactsDropped,
    unchanged: input.corpus.length - flips.length,
    flips,
    knownAuthorityFlips: flips.filter((flip) => flip.authorityFlip),
    regressions: flips.filter(isRegression),
    fixes: flips.filter(isFix),
    semanticsParity: true,
  };
}
