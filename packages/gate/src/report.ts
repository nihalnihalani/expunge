import {
  contentHash,
  type CostSummary,
  type GateReport,
  type HarnessBundle,
  type MutationClass,
  type TrialMetrics,
  type TrialPair,
} from '@expunge/contracts';
import { classifyMutation } from '@expunge/harness-compiler';
import {
  ADMISSION_RULE_HASH,
  summarize,
  type AdmissionDecision,
  type AdmissionSummary,
  type ReasonCode,
} from './admission.js';
import type { CampaignFreeze } from './freeze.js';
import { addCost, ZERO_COST, type GateSplit, type TrialRow } from './types.js';

export const GATE_CONTROLS_SCHEMA = 'expunge.gate-controls.v1';

/** A measured comparison row supplied by the campaign (score-only, wrong-incident, expert-static ...). */
export type ControlRow = {
  controlId: 'score_only' | 'wrong_incident' | 'expert_static' | 'initial' | 'evolved';
  label: string;
  successes: number;
  episodes: number;
  costMicrousd: number;
};

/** What the decision stands on besides the paired rows. All of it is inside the report digest. */
export type AdmittedUnder = {
  ruleHash: string;
  gateHash: string;
  freezeHash: string;
  campaignId: string;
  /** The compiler the freeze names, and the one each bundle records. */
  compilerHash: string;
  parentCompilerHash: string;
  childCompilerHash: string;
  /** This candidate's ordinal among the parent's gate attempts, and how many the parent has had in all. */
  attempt: { ordinal: number; parentAttempts: number };
  /** How many held campaigns this candidate's claim went through before this one. */
  resumes: number;
  evidence: {
    portKind: 'worker' | 'fake';
    portLabel: string;
    modelKind: 'fake' | 'provider';
    profileId: string;
  };
};

export type GateControls = {
  schema: typeof GATE_CONTROLS_SCHEMA;
  decisionSummary: AdmissionSummary;
  /** Which gated split each pair belongs to. Pair ids are opaque labels. */
  pairSplits: Record<string, GateSplit>;
  plannedPairs: number;
  exclusions: Array<{ pairId: string; code: string }>;
  /** Failure rows that stay in the denominator, by outcome. */
  outcomes: Record<string, number>;
  /** The preservation counts the paired rows cannot carry (the contract's TrialMetrics has no such field). */
  preservation: { candidateViolations: number; parentViolations: number };
  heldRuns: Array<{
    attempt: number;
    campaignId: string;
    freezeHash: string;
    reasonCodes: string[];
    trials: number;
  }>;
  admittedUnder: AdmittedUnder;
  controls: ControlRow[];
};

const metricsOf = (metrics: TrialMetrics): TrialMetrics => ({
  usefulCompletion: metrics.usefulCompletion,
  targetedResiduals: metrics.targetedResiduals,
  unrelatedRecordChanges: metrics.unrelatedRecordChanges,
  retentionViolations: metrics.retentionViolations,
  truthfulTerminal: metrics.truthfulTerminal,
  refused: metrics.refused,
  retryFailures: metrics.retryFailures,
  cost: { ...metrics.cost },
});

export function pairedTrialsOf(rows: readonly TrialRow[], freeze: CampaignFreeze): TrialPair[] {
  return rows.map((row) => ({
    pairId: row.pairId,
    family: row.family,
    seedCommitment: row.seedCommitment,
    parentRunId: row.parent.runId,
    candidateRunId: row.candidate.runId,
    workerProfileHash: freeze.workerProfileHash,
    budgetHash: freeze.budgetHash,
    faultPlanHash: row.faultPlanHash,
    parent: metricsOf(row.parent.metrics),
    candidate: metricsOf(row.candidate.metrics),
  }));
}

/** The digest `promote` recomputes: the hash of the stored document without its `_id`. */
export const reportDigestOf = (report: GateReport): string => contentHash(report as never, 'gate-report');

/** Sum of every episode cost the campaign spent, held runs included: unknown pricing is not free. */
export function totalCost(
  rows: readonly TrialRow[],
  heldTrials: ReadonlyArray<{ cost?: CostSummary }> = [],
): CostSummary {
  let total: CostSummary = { ...ZERO_COST };
  for (const row of rows)
    total = addCost(addCost(total, row.parent.metrics.cost), row.candidate.metrics.cost);
  for (const held of heldTrials) if (held.cost) total = addCost(total, held.cost);
  return total;
}

/** The authority flips of the transition: each changed unit that expands authority. Same rule as the rollback binding. */
export function authorityFlipsOf(parent: HarnessBundle, child: HarnessBundle): string[] {
  return classifyMutation(parent, child)
    .components.filter((component) => component.kind === 'authority_expansion')
    .map((component) => component.unit)
    .sort();
}

export type ReportInput = {
  reportId: string;
  candidateId: string;
  parentHash: string;
  childHash: string;
  parent: HarnessBundle;
  child: HarnessBundle;
  freeze: CampaignFreeze;
  observed: { evaluatorHash: string; fixtureGeneratorHash: string };
  decision: AdmissionDecision;
  rows: TrialRow[];
  planned: number;
  heldRuns: GateControls['heldRuns'];
  heldCost: CostSummary[];
  admittedUnder: AdmittedUnder;
  controls: ControlRow[];
};

/**
 * Builds the stored report. `computedClass` is derived here from the two stored bundles and is the only classification
 * the promotion path trusts: the grader principal is the only writer of this document.
 */
export function buildGateReport(input: ReportInput): GateReport {
  const classification = classifyMutation(input.parent, input.child).mutationClass as MutationClass | null;
  const pairs = pairedTrialsOf(input.rows, input.freeze);
  const attested = input.decision.attestedRuntimeHash;
  const controls: GateControls = {
    schema: GATE_CONTROLS_SCHEMA,
    decisionSummary: input.decision.summary,
    pairSplits: Object.fromEntries(input.rows.map((row) => [row.pairId, row.split])),
    plannedPairs: input.planned,
    exclusions: input.rows
      .filter((row) => row.parent.harnessDefect || row.candidate.harnessDefect)
      .map((row) => ({ pairId: row.pairId, code: row.parent.harnessDefect ?? row.candidate.harnessDefect! })),
    outcomes: tallyOutcomes(input.rows),
    preservation: {
      candidateViolations: input.rows.reduce((n, row) => n + row.candidate.preservationViolations, 0),
      parentViolations: input.rows.reduce((n, row) => n + row.parent.preservationViolations, 0),
    },
    heldRuns: input.heldRuns,
    admittedUnder: input.admittedUnder,
    controls: input.controls,
  };
  return {
    reportId: input.reportId,
    candidateId: input.candidateId,
    parentHash: input.parentHash,
    childHash: input.childHash,
    evaluatorHash: input.observed.evaluatorHash,
    fixtureGeneratorHash: input.observed.fixtureGeneratorHash,
    runtimeHash: attested ?? input.freeze.runtimeHash,
    workerProfileHash: input.freeze.workerProfileHash,
    splitManifestCommitment: input.freeze.splitManifestCommitment,
    pairedTrials: pairs,
    trialRowsDigest: contentHash(pairs as never, 'gate-trial-rows'),
    causalControls: JSON.parse(JSON.stringify(controls)),
    knownAuthorityFlips: authorityFlipsOf(input.parent, input.child),
    cost: totalCost(
      input.rows,
      input.heldCost.map((cost) => ({ cost })),
    ),
    verdict: input.decision.verdict,
    reasonCodes: [...input.decision.reasonCodes] as ReasonCode[],
    ...(classification ? { computedClass: classification } : {}),
  };
}

function tallyOutcomes(rows: readonly TrialRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows)
    for (const arm of [row.parent, row.candidate]) out[arm.outcome] = (out[arm.outcome] ?? 0) + 1;
  return out;
}

export { ADMISSION_RULE_HASH, summarize };
