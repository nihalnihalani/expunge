import { contentHash, type HarnessBundle, type MutationClass, type ResourceLimits } from '@expunge/contracts';
import type { CampaignFreeze } from './freeze.js';
import { GATE_SPLITS, type GateSplit, type TrialRow } from './types.js';

/**
 * The frozen admission rule (ACCEPTANCE.md "Promotion utility"; PREREGISTRATION "Conditions and counts"). The numbers
 * are executor settings: nothing a model, a candidate or a caller of `runGate` can edit.
 */
export const ADMISSION_RULE = {
  version: 'expunge.gate-rule.v1',
  requiredTriggerGain: 2,
  shape: {
    train: { fixtures: 2, repeats: 3 },
    protected: { fixtures: 8, repeats: 2 },
    validation: { fixtures: 8, repeats: 2 },
  },
} as const;
export const ADMISSION_RULE_HASH = contentHash(ADMISSION_RULE, 'admission-rule');
export const PLANNED_PAIRS = GATE_SPLITS.reduce(
  (total, split) => total + ADMISSION_RULE.shape[split].fixtures * ADMISSION_RULE.shape[split].repeats,
  0,
);

/**
 * Every reason the gate can state, and what kind of statement it is.
 * - `reject`: a definitive failure of the rule or of an integrity check. A reject ends the candidate.
 * - `hold_validity`: the evidence is not trustworthy enough to decide anything (fake, unattested, defective, invalid
 *   infrastructure, incomplete). It dominates every reject: bad data cannot reject a candidate.
 * - `hold_coverage`: the rule cannot be fully applied yet (unknown pricing, no measured ceiling). A reject that
 *   stands on its own still stands; otherwise the dollar gate cannot pass, so the verdict is hold, not admit.
 */
export const REASON_KINDS = {
  evaluator_hash_mismatch: 'reject',
  fixture_generator_hash_mismatch: 'reject',
  compiler_hash_mismatch: 'reject',
  bundle_compiler_mismatch: 'reject',
  runtime_hash_mismatch: 'reject',
  split_commitment_mismatch: 'reject',
  worker_profile_mismatch: 'reject',
  budget_mismatch: 'reject',
  limits_exceed_budget: 'reject',
  authority_boundary_mismatch: 'reject',
  parent_child_mismatch: 'reject',
  no_executable_change: 'reject',
  source_ineligible: 'reject',
  trigger_gain_insufficient: 'reject',
  protected_regression: 'reject',
  validation_decline: 'reject',
  preservation_violation: 'reject',
  retention_violation: 'reject',
  untruthful_terminal: 'reject',
  limits_exceeded: 'reject',
  cost_ceiling_exceeded: 'reject',
  fake_evidence: 'hold_validity',
  runtime_unattested: 'hold_validity',
  trial_pair_incomplete: 'hold_validity',
  harness_defect_pair: 'hold_validity',
  infra_invalid: 'hold_validity',
  campaign_cancelled: 'hold_validity',
  cost_unpriced: 'hold_coverage',
  cost_ceiling_unset: 'hold_coverage',
} as const;
export type ReasonCode = keyof typeof REASON_KINDS;
export const REASON_CODES = Object.keys(REASON_KINDS) as ReasonCode[];

export type AdmissionSummary = {
  triggerGain: number;
  triggerRequiredGain: number;
  splits: Partial<Record<GateSplit, { trials: number; parentSuccesses: number; candidateSuccesses: number }>>;
  protectedRegressedWorlds: number;
};

export type AdmissionInput = {
  frozen: Pick<
    CampaignFreeze,
    | 'evaluatorHash'
    | 'fixtureGeneratorHash'
    | 'runtimeHash'
    | 'compilerHash'
    | 'workerProfileHash'
    | 'budgetHash'
    | 'splitManifestCommitment'
    | 'costCeilingMicrousd'
  >;
  /** What the executing modules and the run itself report, never copied from the freeze. */
  observed: {
    evaluatorHash: string;
    fixtureGeneratorHash: string;
    compilerHash: string;
    workerProfileHash: string;
    budgetHash: string;
    splitManifestCommitment: string;
  };
  budget: ResourceLimits;
  parent: HarnessBundle;
  child: HarnessBundle;
  mutationClass: MutationClass | null;
  /** True when any evidence reference of the child is revoked, display-only or taint-derived. */
  sourcesIneligible: boolean;
  evidence: { portKind: 'worker' | 'fake'; modelKind: 'fake' | 'provider' };
  rows: TrialRow[];
  /** The number of pairs the plan calls for. A different count of rows is an incomplete campaign. */
  planned: number;
  /** The campaign was cancelled while it ran. Its cancelled arms stay as rows, but it decides nothing. */
  cancelled?: boolean;
};

export type AdmissionDecision = {
  verdict: 'admit' | 'reject' | 'hold';
  reasonCodes: ReasonCode[];
  summary: AdmissionSummary;
  /** The runtime hash the decision stands on: the single attested value, else null. */
  attestedRuntimeHash: string | null;
};

const LIMIT_KEYS: Array<keyof ResourceLimits> = [
  'modelCalls',
  'toolCalls',
  'scannedDocuments',
  'changedDocuments',
  'traversalDepth',
  'graphNodes',
  'graphEdges',
  'wallTimeMs',
  'totalTokens',
  'maxCostMicrousd',
];
const within = (limits: ResourceLimits, ceiling: ResourceLimits): boolean =>
  LIMIT_KEYS.every((key) => limits[key] <= ceiling[key]);

export function summarize(rows: readonly TrialRow[]): AdmissionSummary {
  const splits: AdmissionSummary['splits'] = {};
  for (const split of GATE_SPLITS) {
    const part = rows.filter((row) => row.split === split);
    if (!part.length) continue;
    splits[split] = {
      trials: part.length,
      parentSuccesses: part.filter((row) => row.parent.metrics.usefulCompletion).length,
      candidateSuccesses: part.filter((row) => row.candidate.metrics.usefulCompletion).length,
    };
  }
  const train = splits.train;
  const byWorld = new Map<string, { parent: number; candidate: number }>();
  for (const row of rows.filter((item) => item.split === 'protected')) {
    const tally = byWorld.get(row.fixtureLabel) ?? { parent: 0, candidate: 0 };
    tally.parent += row.parent.metrics.usefulCompletion ? 1 : 0;
    tally.candidate += row.candidate.metrics.usefulCompletion ? 1 : 0;
    byWorld.set(row.fixtureLabel, tally);
  }
  return {
    triggerGain: train ? train.candidateSuccesses - train.parentSuccesses : 0,
    triggerRequiredGain: ADMISSION_RULE.requiredTriggerGain,
    splits,
    protectedRegressedWorlds: [...byWorld.values()].filter((tally) => tally.candidate < tally.parent).length,
  };
}

type IntegrityInput = Pick<
  AdmissionInput,
  'frozen' | 'observed' | 'budget' | 'parent' | 'child' | 'mutationClass' | 'sourcesIneligible'
>;

/**
 * The checks that need no episode: what is about to run is what was frozen, and the child is a real, eligible change of
 * the parent inside the same authority boundary. A candidate that fails one is rejected before any episode is spent.
 */
export function evaluateIntegrity(input: IntegrityInput): Set<ReasonCode> {
  const reasons = new Set<ReasonCode>();
  const { frozen, observed } = input;
  if (observed.evaluatorHash !== frozen.evaluatorHash) reasons.add('evaluator_hash_mismatch');
  if (observed.fixtureGeneratorHash !== frozen.fixtureGeneratorHash)
    reasons.add('fixture_generator_hash_mismatch');
  if (observed.compilerHash !== frozen.compilerHash) reasons.add('compiler_hash_mismatch');
  if (input.parent.compilerHash !== frozen.compilerHash || input.child.compilerHash !== frozen.compilerHash)
    reasons.add('bundle_compiler_mismatch');
  if (observed.splitManifestCommitment !== frozen.splitManifestCommitment)
    reasons.add('split_commitment_mismatch');
  if (observed.workerProfileHash !== frozen.workerProfileHash) reasons.add('worker_profile_mismatch');
  if (observed.budgetHash !== frozen.budgetHash) reasons.add('budget_mismatch');
  if (!within(input.parent.limits, input.budget) || !within(input.child.limits, input.budget))
    reasons.add('limits_exceed_budget');
  if (
    input.child.target !== input.parent.target ||
    input.child.authorityFloorHash !== input.parent.authorityFloorHash ||
    input.child.eligibilityPolicyHash !== input.parent.eligibilityPolicyHash ||
    input.child.vocabularyHash !== input.parent.vocabularyHash ||
    input.child.runtimeAdapterHash !== input.parent.runtimeAdapterHash
  )
    reasons.add('authority_boundary_mismatch');
  if (input.child.parentHash === null) reasons.add('parent_child_mismatch');
  if (input.mutationClass === null) reasons.add('no_executable_change');
  if (input.sourcesIneligible) reasons.add('source_ineligible');
  // Both bundles were built for one runtime, and it is the frozen one.
  if (
    input.parent.runtimeAdapterHash !== frozen.runtimeHash ||
    input.child.runtimeAdapterHash !== frozen.runtimeHash
  )
    reasons.add('runtime_hash_mismatch');
  return reasons;
}

/**
 * The pure rule. It reads only what it is handed and has no I/O, so it can be exercised case by case; whether
 * `runGate` can produce those inputs end to end is proved separately by the runGate-level cases.
 */
export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  const reasons = evaluateIntegrity(input);
  const { frozen, rows } = input;

  // --- runtime attestation: the worker's own, per run that returned a result ------------------------------------
  const arms = rows.flatMap((row) => [row.parent, row.candidate]);
  const attested = new Set(arms.flatMap((arm) => (arm.attestedRuntimeHash ? [arm.attestedRuntimeHash] : [])));
  // A run that executed (not failed, cancelled or timed out) must carry the attestation; one that did not is a
  // failure row and is not asked for it.
  const executedUnattested = arms.filter(
    (arm) => ['completed', 'incomplete', 'refused'].includes(arm.outcome) && arm.attestedRuntimeHash === null,
  );
  if (!attested.size || executedUnattested.length) reasons.add('runtime_unattested');
  if (
    attested.size > 1 ||
    [...attested].some(
      (hash) =>
        hash !== frozen.runtimeHash ||
        hash !== input.parent.runtimeAdapterHash ||
        hash !== input.child.runtimeAdapterHash,
    )
  )
    reasons.add('runtime_hash_mismatch');

  // --- evidence validity ----------------------------------------------------------------------------------------
  if (
    input.evidence.portKind !== 'worker' ||
    input.evidence.modelKind !== 'provider' ||
    arms.some((arm) => arm.hadResult && arm.evidence !== 'committed')
  )
    reasons.add('fake_evidence');
  if (input.cancelled) reasons.add('campaign_cancelled');
  if (rows.length !== input.planned) reasons.add('trial_pair_incomplete');
  const defectPairs = rows.filter((row) => row.parent.harnessDefect || row.candidate.harnessDefect);
  if (defectPairs.length) reasons.add('harness_defect_pair');
  for (const armName of ['parent', 'candidate'] as const) {
    const total = rows.length;
    if (!total) continue;
    const infra = rows.filter(
      (row) => row[armName].infra || row.parent.harnessDefect || row.candidate.harnessDefect,
    ).length;
    if (infra / total > 0.1) reasons.add('infra_invalid');
  }

  // --- the behavioural rule, over pairs that are not excluded ---------------------------------------------------
  const scored = rows.filter((row) => !row.parent.harnessDefect && !row.candidate.harnessDefect);
  const summary = summarize(scored);
  if (summary.triggerGain < ADMISSION_RULE.requiredTriggerGain) reasons.add('trigger_gain_insufficient');
  if (summary.protectedRegressedWorlds > 0) reasons.add('protected_regression');
  const validation = summary.splits.validation;
  if (validation && validation.candidateSuccesses < validation.parentSuccesses)
    reasons.add('validation_decline');
  if (!validation) reasons.add('trial_pair_incomplete');
  const candidates = scored.map((row) => row.candidate);
  // Collateral change to a record the cleanup never touched, or a broken preserved field, is a preservation violation.
  if (candidates.some((arm) => arm.metrics.unrelatedRecordChanges > 0 || arm.preservationViolations > 0))
    reasons.add('preservation_violation');
  if (candidates.some((arm) => arm.metrics.retentionViolations > 0)) reasons.add('retention_violation');
  if (candidates.some((arm) => !arm.metrics.truthfulTerminal)) reasons.add('untruthful_terminal');
  const limits = input.child.limits;
  if (
    candidates.some(
      (arm) =>
        arm.hadResult &&
        (arm.metrics.cost.modelCalls > limits.modelCalls ||
          arm.metrics.cost.toolCalls > limits.toolCalls ||
          arm.metrics.cost.inputTokens + arm.metrics.cost.outputTokens > limits.totalTokens ||
          arm.metrics.cost.wallTimeMs > limits.wallTimeMs ||
          arm.metrics.cost.costMicrousd > limits.maxCostMicrousd),
    )
  )
    reasons.add('limits_exceeded');

  // --- cost: unknown pricing is not free ------------------------------------------------------------------------
  if (frozen.costCeilingMicrousd === null) reasons.add('cost_ceiling_unset');
  else if (candidates.some((arm) => arm.metrics.cost.costMicrousd > frozen.costCeilingMicrousd!))
    reasons.add('cost_ceiling_exceeded');
  if (arms.some((arm) => arm.metrics.cost.unpricedCalls > 0)) reasons.add('cost_unpriced');

  const codes = REASON_CODES.filter((code) => reasons.has(code));
  const kinds = new Set(codes.map((code) => REASON_KINDS[code]));
  const verdict: AdmissionDecision['verdict'] = kinds.has('hold_validity')
    ? 'hold'
    : kinds.has('reject')
      ? 'reject'
      : kinds.has('hold_coverage')
        ? 'hold'
        : 'admit';
  return {
    verdict,
    reasonCodes: codes,
    summary,
    attestedRuntimeHash: attested.size === 1 ? [...attested][0]! : null,
  };
}
