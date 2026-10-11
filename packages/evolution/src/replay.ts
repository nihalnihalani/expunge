// As-of DECISION REPLAY. Each recorded decision is re-evaluated under a candidate's guardrails using only the
// facts that were known when it was made (later-observed facts become unknown). It answers how a candidate policy
// treats recorded decisions. It cannot say what a new agent would do with the candidate: fresh paired trials do.
//
// Two separations keep the numbers honest. IN-SAMPLE rows are decisions from the incident run(s) the proposal was
// mined from: a candidate that fixes them has shown only that it addresses its own incident, so those counts are
// reported apart and never called "fixes". HELD-OUT rows come from other runs and are the only basis for selection.
// And a flip is ATTRIBUTED only when the rule that caused it cites evidence bound to the run the row came from.
import { canonicalJson, type GuardrailAst } from '@expunge/contracts';
import {
  asOfInput,
  compileDecisionExpression,
  decide,
  evaluateMongoExpression,
  type DecisionLedgerRow,
  type EvidenceCatalog,
  type OutcomeClass,
} from '@expunge/harness-compiler';

export type Verdict = 'allow' | 'ask' | 'deny';
const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

export type Sample = 'in_sample' | 'held_out';

export interface ReplayFlip {
  decisionId: string;
  toolId: string;
  jobId: string;
  runId: string;
  from: Verdict;
  to: Verdict;
  firedRuleIds: string[];
  /** What happened after the recorded decision. Used only to label the flip, never to evaluate it. */
  outcome: OutcomeClass | null;
  /** The candidate permits more than the recorded decision did. */
  authorityFlip: boolean;
  /** In-sample: the row belongs to the incident run the proposal addresses. */
  sample: Sample;
  /** The flip was caused by a rule whose cited evidence is bound to this row's job and run. */
  attributed: boolean;
  /** The evidence identifiers that attribute it (empty when not attributed). */
  attributedTo: string[];
}

/** Counts for one side of the in-sample / held-out split. */
export interface SampleCounts {
  rows: number;
  flips: number;
  fixes: number;
  regressions: number;
  knownAuthorityFlips: number;
}

export interface ReplayScope {
  /** The incident run(s) the proposal addresses. Decisions from these runs are in-sample. Must not be empty. */
  incidentRuns: ReadonlyArray<{ jobId: string; runId: string }>;
  /** Evidence bound to jobs and runs; without it nothing can be attributed. */
  evidence?: EvidenceCatalog;
  /** Evidence cited by the candidate's patches: the fallback when a flip has no changed rule that fired on it. */
  candidateCitations?: readonly string[];
}

export class ReplayScopeMissing extends Error {
  constructor() {
    super('ReplayScopeMissing');
  }
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
  /** Every flip, each tagged with its sample and attribution. */
  flips: ReplayFlip[];
  /** Flips where the candidate permits what the recorded decision blocked (deny/ask -> less restrictive). */
  knownAuthorityFlips: ReplayFlip[];
  /** Flips the recorded outcome shows were wrong, in either sample. A regression anywhere rejects the candidate. */
  regressions: ReplayFlip[];
  /** Flips on the incident's own rows the outcome shows were right. Evidence that it addresses its incident, only. */
  inSampleFixes: ReplayFlip[];
  /** Flips on other runs' rows the outcome shows were right: the only fix counts selection may use. */
  heldOutFixes: ReplayFlip[];
  inSample: SampleCounts;
  heldOut: SampleCounts;
  attribution: {
    /** Guardrail rules were added, edited or removed. Candidates that edit no guardrail have nothing to attribute. */
    applicable: boolean;
    changedRuleIds: string[];
    attributedFlips: number;
    unattributedFlips: number;
  };
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

/** Rules that are new in the child or differ from the parent's rule of the same ID. */
export function changedGuardrails(
  parentRules: readonly GuardrailAst[],
  childRules: readonly GuardrailAst[],
): GuardrailAst[] {
  const before = new Map(parentRules.map((rule) => [rule.ruleId, canonicalJson(rule)]));
  return childRules.filter((rule) => before.get(rule.ruleId) !== canonicalJson(rule));
}

/**
 * The evidence identifiers that attribute `row` to the evidence a rule cites: those whose catalog binding is the
 * row's own job and run. Citing evidence from another run attributes nothing, however many rows the rule flips.
 */
export function attributingEvidence(
  citations: readonly string[],
  row: Pick<DecisionLedgerRow, 'jobId' | 'runId'>,
  evidence: EvidenceCatalog | undefined,
): string[] {
  if (!evidence) return [];
  return [...new Set(citations)]
    .filter((id) => {
      const entry = evidence.get(id);
      return entry !== undefined && entry.jobId === row.jobId && entry.runId === row.runId;
    })
    .sort();
}

const counts = (rows: number, flips: ReplayFlip[]): SampleCounts => ({
  rows,
  flips: flips.length,
  fixes: flips.filter(isFix).length,
  regressions: flips.filter(isRegression).length,
  knownAuthorityFlips: flips.filter((flip) => flip.authorityFlip).length,
});

export function replayCandidate(input: {
  parentRules: readonly GuardrailAst[];
  childRules: readonly GuardrailAst[];
  parentHash: string | null;
  childHash: string;
  corpus: readonly DecisionLedgerRow[];
  scope: ReplayScope;
}): ReplayReport {
  if (!input.scope.incidentRuns.length) throw new ReplayScopeMissing();
  // Rows are in-sample by run: a row from the incident's run is in-sample whatever its job label says.
  const incidentRunIds = new Set(input.scope.incidentRuns.map((entry) => entry.runId));
  const changed = changedGuardrails(input.parentRules, input.childRules);
  const childIds = new Set(input.childRules.map((rule) => rule.ruleId));
  const removed = input.parentRules.filter((rule) => !childIds.has(rule.ruleId));
  const edited = changed.length + removed.length > 0;
  const changedById = new Map(changed.map((rule) => [rule.ruleId, rule]));
  const fallback = input.scope.candidateCitations ?? [];

  const flips: ReplayFlip[] = [];
  let parentMismatches = 0;
  let futureFactsDropped = 0;
  const rowsBySample: Record<Sample, number> = { in_sample: 0, held_out: 0 };
  for (const row of input.corpus) {
    const sample: Sample = incidentRunIds.has(row.runId) ? 'in_sample' : 'held_out';
    rowsBySample[sample]++;
    const parent = decideBothWays(input.parentRules, row);
    const child = decideBothWays(input.childRules, row);
    futureFactsDropped += child.dropped;
    if (parent.verdict !== row.decision.result) parentMismatches++;
    // Flips are measured against what actually happened: the recorded decision.
    const recorded = row.decision.result;
    if (child.verdict === recorded) continue;
    // The rules responsible are the changed rules that fired on this row; when none did (a loosening by removal or
    // an edit of an existing rule), the evidence the candidate's patches cite.
    const responsible = child.ruleIds.filter((id) => changedById.has(id));
    const citations = responsible.length
      ? responsible.flatMap((id) => changedById.get(id)!.sourceEvidenceIds)
      : [...fallback];
    const attributedTo = edited ? attributingEvidence(citations, row, input.scope.evidence) : [];
    flips.push({
      decisionId: row.decisionId,
      toolId: row.toolId,
      jobId: row.jobId,
      runId: row.runId,
      from: recorded,
      to: child.verdict,
      firedRuleIds: child.ruleIds,
      outcome: row.outcome?.class ?? null,
      authorityFlip: RANK[child.verdict] < RANK[recorded],
      sample,
      attributed: attributedTo.length > 0,
      attributedTo,
    });
  }
  const inSampleFlips = flips.filter((flip) => flip.sample === 'in_sample');
  const heldOutFlips = flips.filter((flip) => flip.sample === 'held_out');
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
    inSampleFixes: inSampleFlips.filter(isFix),
    heldOutFixes: heldOutFlips.filter(isFix),
    inSample: counts(rowsBySample.in_sample, inSampleFlips),
    heldOut: counts(rowsBySample.held_out, heldOutFlips),
    attribution: {
      applicable: edited,
      changedRuleIds: [...changed, ...removed].map((rule) => rule.ruleId).sort(),
      attributedFlips: flips.filter((flip) => flip.attributed).length,
      unattributedFlips: edited ? flips.filter((flip) => !flip.attributed).length : 0,
    },
    semanticsParity: true,
  };
}
