import { describe, expect, it } from 'vitest';
import { COMPILER_HASH } from '@expunge/harness-compiler';
import type { TrialMetrics } from '@expunge/contracts';
import {
  ADMISSION_RULE,
  REASON_CODES,
  REASON_KINDS,
  ZERO_COST,
  evaluateAdmission,
  type AdmissionInput,
  type ReasonCode,
  type TrialArm,
  type TrialRow,
} from '../src/index.js';
import { BUDGET, RUNTIME_HASH, childOf, w0 } from './support.js';

const H = (c: string) => c.repeat(64);
const metrics = (ok: boolean, over: Partial<TrialMetrics> = {}): TrialMetrics => ({
  usefulCompletion: ok,
  targetedResiduals: ok ? 0 : 1,
  unrelatedRecordChanges: 0,
  retentionViolations: 0,
  truthfulTerminal: true,
  refused: false,
  retryFailures: 0,
  cost: {
    ...ZERO_COST,
    modelCalls: 2,
    toolCalls: 3,
    inputTokens: 500,
    outputTokens: 100,
    costMicrousd: 1000,
    wallTimeMs: 900,
  },
  ...over,
});
const arm = (
  name: 'parent' | 'candidate',
  ok: boolean,
  over: Partial<TrialArm> = {},
  m: Partial<TrialMetrics> = {},
): TrialArm => ({
  arm: name,
  runId: `run-${name}`,
  outcome: 'completed',
  failureCode: null,
  metrics: metrics(ok, m),
  preservationViolations: 0,
  falseCompletion: false,
  hadResult: true,
  attestedRuntimeHash: RUNTIME_HASH,
  evidence: 'committed',
  infra: false,
  harnessDefect: null,
  worldUnread: false,
  graderBindingFailure: false,
  graded: 'readback',
  ...over,
});
type Shape = (
  split: 'train' | 'protected' | 'validation',
  fixture: number,
  repeat: number,
) => { parent: boolean; candidate: boolean };
const rowsFor = (
  shape: Shape,
  tweak: (row: TrialRow, index: number) => void = () => undefined,
): TrialRow[] => {
  const rows: TrialRow[] = [];
  for (const split of ['train', 'protected', 'validation'] as const) {
    const { fixtures, repeats } = ADMISSION_RULE.shape[split];
    for (let f = 0; f < fixtures; f++)
      for (let r = 1; r <= repeats; r++) {
        const result = shape(split, f, r);
        const row: TrialRow = {
          pairId: `${split}-${f}-${r}`,
          split,
          fixtureLabel: `${split}-${f}`,
          repeat: r,
          family: 'direct_nested',
          seedCommitment: H('1'),
          faultPlanHash: H('2'),
          parent: arm('parent', result.parent),
          candidate: arm('candidate', result.candidate),
        };
        tweak(row, rows.length);
        rows.push(row);
      }
  }
  return rows;
};
const good: Shape = (split) =>
  split === 'train' ? { parent: false, candidate: true } : { parent: true, candidate: true };
const parent = w0();
const parentHash = H('a');
const child = childOf(parent, parentHash);
const baseInput = (over: Partial<AdmissionInput> = {}): AdmissionInput => ({
  frozen: {
    evaluatorHash: H('3'),
    fixtureGeneratorHash: H('4'),
    runtimeHash: RUNTIME_HASH,
    compilerHash: COMPILER_HASH,
    workerProfileHash: H('5'),
    budgetHash: H('6'),
    splitManifestCommitment: H('7'),
    costCeilingMicrousd: 5000,
  },
  observed: {
    evaluatorHash: H('3'),
    fixtureGeneratorHash: H('4'),
    compilerHash: COMPILER_HASH,
    workerProfileHash: H('5'),
    budgetHash: H('6'),
    splitManifestCommitment: H('7'),
  },
  budget: BUDGET,
  parent,
  child,
  mutationClass: 'behavioral',
  sourcesIneligible: false,
  evidence: { portKind: 'worker', modelKind: 'provider' },
  rows: rowsFor(good),
  planned: 38,
  ...over,
});

/** One case per reason code: the Record type makes a missing case a compile error. */
const cases: Record<ReasonCode, () => AdmissionInput> = {
  evaluator_hash_mismatch: () => {
    const i = baseInput();
    i.observed.evaluatorHash = H('9');
    return i;
  },
  fixture_generator_hash_mismatch: () => {
    const i = baseInput();
    i.observed.fixtureGeneratorHash = H('9');
    return i;
  },
  compiler_hash_mismatch: () => {
    const i = baseInput();
    i.observed.compilerHash = H('9');
    return i;
  },
  bundle_compiler_mismatch: () => baseInput({ child: { ...child, compilerHash: H('9') } }),
  runtime_hash_mismatch: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 0) row.parent.attestedRuntimeHash = H('9');
      }),
    }),
  split_commitment_mismatch: () => {
    const i = baseInput();
    i.observed.splitManifestCommitment = H('9');
    return i;
  },
  worker_profile_mismatch: () => {
    const i = baseInput();
    i.observed.workerProfileHash = H('9');
    return i;
  },
  budget_mismatch: () => {
    const i = baseInput();
    i.observed.budgetHash = H('9');
    return i;
  },
  limits_exceed_budget: () => baseInput({ budget: { ...BUDGET, traversalDepth: 2 } }),
  authority_boundary_mismatch: () => baseInput({ child: { ...child, authorityFloorHash: H('9') } }),
  parent_child_mismatch: () => baseInput({ child: { ...child, parentHash: null } }),
  no_executable_change: () => baseInput({ mutationClass: null }),
  source_ineligible: () => baseInput({ sourcesIneligible: true }),
  trigger_gain_insufficient: () =>
    baseInput({
      rows: rowsFor((s) =>
        s === 'train' ? { parent: false, candidate: false } : { parent: true, candidate: true },
      ),
    }),
  protected_regression: () =>
    baseInput({
      rows: rowsFor((s, f) =>
        s === 'protected' && f === 0 ? { parent: true, candidate: false } : good(s, f, 1),
      ),
    }),
  validation_decline: () =>
    baseInput({
      rows: rowsFor((s, f) =>
        s === 'validation' && f === 0 ? { parent: true, candidate: false } : good(s, f, 1),
      ),
    }),
  preservation_violation: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 7) row.candidate.preservationViolations = 1;
      }),
    }),
  retention_violation: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 7) row.candidate.metrics.retentionViolations = 1;
      }),
    }),
  untruthful_terminal: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 7) row.candidate.metrics.truthfulTerminal = false;
      }),
    }),
  limits_exceeded: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 7) row.candidate.metrics.cost.modelCalls = 999;
      }),
    }),
  cost_ceiling_exceeded: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 7) row.candidate.metrics.cost.costMicrousd = 9999;
      }),
    }),
  fake_evidence: () => baseInput({ evidence: { portKind: 'fake', modelKind: 'fake' } }),
  runtime_unattested: () =>
    baseInput({
      rows: rowsFor(good, (row) => {
        row.parent.attestedRuntimeHash = null;
        row.candidate.attestedRuntimeHash = null;
      }),
    }),
  trial_pair_incomplete: () => baseInput({ rows: rowsFor(good).slice(1) }),
  harness_defect_pair: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 0) row.parent.harnessDefect = 'FaultPlanMismatch';
      }),
    }),
  infra_invalid: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i < 6) row.candidate.infra = true;
      }),
    }),
  campaign_cancelled: () => baseInput({ cancelled: true }),
  cost_unpriced: () =>
    baseInput({
      rows: rowsFor(good, (row, i) => {
        if (i === 7) row.candidate.metrics.cost.unpricedCalls = 1;
      }),
    }),
  cost_ceiling_unset: () => baseInput({ frozen: { ...baseInput().frozen, costCeilingMicrousd: null } }),
};

describe('admission rule catalog (pure rule: proves the rule, runGate-level cases are elsewhere)', () => {
  it('admits the all-good input with no reason', () => {
    expect(evaluateAdmission(baseInput())).toMatchObject({ verdict: 'admit', reasonCodes: [] });
  });
  for (const code of REASON_CODES)
    it(`${code} (${REASON_KINDS[code]}) is stated and sets the right verdict`, () => {
      const decision = evaluateAdmission(cases[code]());
      expect(decision.reasonCodes, code).toContain(code);
      const kind = REASON_KINDS[code];
      // validity holds dominate; a coverage hold yields hold only when nothing rejects.
      if (kind === 'hold_validity') expect(decision.verdict).toBe('hold');
      if (kind === 'reject') expect(decision.verdict).toBe('reject');
      if (kind === 'hold_coverage') expect(decision.verdict).toBe('hold');
    });
  it('a validity hold dominates a behavioural reject, and a standing reject beats a coverage hold', () => {
    const fakeAndBad = baseInput({
      evidence: { portKind: 'fake', modelKind: 'fake' },
      rows: rowsFor(() => ({ parent: true, candidate: false })),
    });
    expect(evaluateAdmission(fakeAndBad).verdict).toBe('hold');
    const unpricedAndBad = baseInput({
      frozen: { ...baseInput().frozen, costCeilingMicrousd: null },
      rows: rowsFor(() => ({ parent: true, candidate: false })),
    });
    expect(evaluateAdmission(unpricedAndBad).verdict).toBe('reject');
  });
  it('failed, cancelled and timed-out rows count: a pair of non-successes leaves the gain at zero', () => {
    const rows = rowsFor(good, (row) => {
      if (row.split === 'train') {
        row.candidate.outcome = 'timed_out';
        row.candidate.metrics.usefulCompletion = false;
      }
    });
    const decision = evaluateAdmission(baseInput({ rows }));
    expect(decision.reasonCodes).toContain('trigger_gain_insufficient');
    expect(decision.summary.splits.train).toMatchObject({ trials: 6, candidateSuccesses: 0 });
  });
});
