import { describe, expect, it } from 'vitest';
import { contentHash, type GuardrailAst } from '@expunge/contracts';
import { decide, asOfInput } from '@expunge/harness-compiler';
import { ReplayScopeMissing, replayCandidate } from '../src/index.js';
import { EXPERT_LEDGER, FULL_LEDGER, INCIDENT_A_SCOPE, W0_LEDGER, expert, row, w0 } from './helpers.js';

const verifyRule: GuardrailAst = {
  ruleId: 'deny_complete_without_verification',
  predicate: {
    op: 'not',
    predicate: {
      op: 'compare',
      comparator: 'eq',
      left: { kind: 'fact', factId: 'verification_status' },
      right: { kind: 'constant', value: 'valid' },
    },
  },
  result: 'deny',
  sourceEvidenceIds: ['evt_a01'],
  appliesTo: ['complete_cleanup'],
};
const replay = (parentRules: GuardrailAst[], childRules: GuardrailAst[], corpus = W0_LEDGER) =>
  replayCandidate({
    parentRules,
    childRules,
    parentHash: contentHash(w0()),
    childHash: 'c'.repeat(64),
    corpus,
    scope: INCIDENT_A_SCOPE,
  });

describe('as-of decision replay', () => {
  it('is labelled decision replay and never claims to be behavioral proof', () => {
    const report = replay([], [verifyRule]);
    expect(report.label).toBe('decision replay');
    expect(report.behavioralProof).toBe(false);
    expect(report.statement).toMatch(/not behavioral proof/);
    expect(report.semanticsParity).toBe(true);
    expect(report.rows).toBe(W0_LEDGER.length);
  });

  it('a good guardrail flips the recorded harmful completions and nothing else', () => {
    const report = replay([], [verifyRule]);
    expect(report.flips.map((flip) => [flip.decisionId, flip.from, flip.to])).toEqual([
      ['fixture_dec_complete_unverified', 'allow', 'deny'],
      ['fixture_dec_complete_unverified_2', 'allow', 'deny'],
    ]);
    expect(report.flips[0]!.firedRuleIds).toEqual(['deny_complete_without_verification']);
    // W0_LEDGER is the incident's own run: these are in-sample fixes, not "fixes" in the selection sense.
    expect(report.inSampleFixes).toHaveLength(2);
    expect(report.heldOutFixes).toEqual([]);
    expect(report.regressions).toEqual([]);
    expect(report.knownAuthorityFlips).toEqual([]);
    expect(report.unchanged).toBe(4);
    expect(report.parentMismatches).toBe(0);
  });

  it('reproduces a known regression: a plausible rule that blocks recorded legitimate completions', () => {
    const retried: GuardrailAst = {
      ruleId: 'deny_complete_after_retry',
      predicate: {
        op: 'compare',
        comparator: 'gt',
        left: { kind: 'fact', factId: 'retry_count' },
        right: { kind: 'constant', value: 0 },
      },
      result: 'deny',
      sourceEvidenceIds: ['evt_a01'],
      appliesTo: ['complete_cleanup'],
    };
    const report = replay([], [retried]);
    expect(report.regressions.map((flip) => [flip.decisionId, flip.outcome])).toEqual([
      ['fixture_dec_complete_verified_retry', 'legitimate'],
    ]);
    expect(report.inSampleFixes).toEqual([]);
    expect(report.heldOutFixes).toEqual([]);
  });

  it('known authority flips: a candidate that permits what the record blocked', () => {
    const report = replayCandidate({
      parentRules: expert().guardrails,
      childRules: [],
      parentHash: contentHash(expert()),
      childHash: 'c'.repeat(64),
      corpus: EXPERT_LEDGER,
      scope: INCIDENT_A_SCOPE,
    });
    expect(report.parentMismatches).toBe(0);
    expect(report.knownAuthorityFlips.map((flip) => [flip.decisionId, flip.from, flip.to])).toEqual([
      ['fixture_dec_apply_invalid_plan', 'deny', 'allow'],
      ['fixture_dec_apply_no_plan', 'deny', 'allow'],
    ]);
    // Both permitted calls were recorded as correctly blocked, so each is also a regression.
    expect(report.regressions).toHaveLength(2);
  });

  it('uses only facts known when the decision was made: later observations become unknown', () => {
    const later = row(
      'complete_late_verification',
      'complete_cleanup',
      { verification_status: 'valid' },
      'allow',
      undefined,
      {
        decidedAt: '2026-10-11T10:00:00.000Z',
        observedAt: { 'facts.verification_status': '2026-10-11T10:30:00.000Z' },
      },
    );
    // Had the future value been used, the rule would not fire (valid); as-of, the value is unknown and the rule fires.
    const withFuture = decide([verifyRule], { ...asOfInput(later).input, facts: later.inputs.facts }).decision
      .result;
    const asOf = decide([verifyRule], asOfInput(later).input).decision.result;
    expect(withFuture).toBe('allow');
    expect(asOf).toBe('deny');
    const report = replay([], [verifyRule], [later]);
    expect(report.futureFactsDropped).toBe(1);
    expect(report.flips).toHaveLength(1);
    expect(report.flips[0]!.to).toBe('deny');
  });

  it('observations at or before the decision are kept', () => {
    const earlier = row(
      'complete_early',
      'complete_cleanup',
      { verification_status: 'valid' },
      'allow',
      undefined,
      {
        observedAt: { 'facts.verification_status': '2026-10-11T09:59:59.000Z' },
      },
    );
    const report = replay([], [verifyRule], [earlier]);
    expect(report.futureFactsDropped).toBe(0);
    expect(report.flips).toEqual([]);
  });

  it('outcome labels annotate flips but never change an evaluation', () => {
    const labelled = W0_LEDGER.map((entry) => ({ ...entry }));
    const stripped = W0_LEDGER.map(({ outcome: _outcome, ...entry }) => entry);
    const withLabels = replay([], [verifyRule], labelled);
    const without = replay([], [verifyRule], stripped);
    expect(without.flips.map((flip) => [flip.decisionId, flip.to])).toEqual(
      withLabels.flips.map((flip) => [flip.decisionId, flip.to]),
    );
    expect(without.inSampleFixes).toEqual([]);
    expect(withLabels.inSampleFixes).toHaveLength(2);
  });
});

const citing = (evidenceId: string): GuardrailAst => ({ ...verifyRule, sourceEvidenceIds: [evidenceId] });

describe('in-sample and held-out are reported apart (a candidate is not selected on its own incident)', () => {
  it('splits rows and flips by run: the incident run is in-sample, every other run is held out', () => {
    const report = replay([], [verifyRule], FULL_LEDGER);
    expect(report.inSample).toEqual({ rows: 6, flips: 2, fixes: 2, regressions: 0, knownAuthorityFlips: 0 });
    expect(report.heldOut).toEqual({ rows: 4, flips: 1, fixes: 1, regressions: 0, knownAuthorityFlips: 0 });
    expect(report.inSampleFixes.map((flip) => flip.runId)).toEqual(['run_a01', 'run_a01']);
    expect(report.heldOutFixes.map((flip) => [flip.decisionId, flip.runId])).toEqual([
      ['fixture_dec_v_complete_unverified', 'run_v01'],
    ]);
    expect(report.flips.map((flip) => flip.sample)).toEqual(['in_sample', 'in_sample', 'held_out']);
    expect(report.rows).toBe(report.inSample.rows + report.heldOut.rows);
  });

  it('a corpus holding only the incident run has no held-out rows, so nothing can count out of sample', () => {
    const report = replay([], [verifyRule], W0_LEDGER);
    expect(report.heldOut.rows).toBe(0);
    expect(report.heldOutFixes).toEqual([]);
    expect(report.inSample.fixes).toBe(2);
  });

  it('a regression on either side is reported as a regression', () => {
    const retried: GuardrailAst = {
      ruleId: 'deny_complete_after_retry',
      predicate: {
        op: 'compare',
        comparator: 'gt',
        left: { kind: 'fact', factId: 'retry_count' },
        right: { kind: 'constant', value: 0 },
      },
      result: 'deny',
      sourceEvidenceIds: ['evt_a01'],
      appliesTo: ['complete_cleanup'],
    };
    const heldOutRetry = row(
      'v_retry',
      'complete_cleanup',
      { verification_status: 'valid', retry_count: 3 },
      'allow',
      { class: 'legitimate', recordedAt: '2026-10-11T11:00:00.000Z' },
      { jobId: 'job_v01', runId: 'run_v01' },
    );
    const report = replay([], [retried], [...W0_LEDGER, heldOutRetry]);
    expect(report.inSample.regressions).toBe(1);
    expect(report.heldOut.regressions).toBe(1);
    expect(report.regressions).toHaveLength(2);
  });

  it('refuses to replay without naming the incident run: an empty scope could make every row look held out', () => {
    expect(() =>
      replayCandidate({
        parentRules: [],
        childRules: [verifyRule],
        parentHash: null,
        childHash: 'c'.repeat(64),
        corpus: FULL_LEDGER,
        scope: { incidentRuns: [], evidence: INCIDENT_A_SCOPE.evidence },
      }),
    ).toThrow(ReplayScopeMissing);
  });
});

describe('a flip is attributed only through the evidence its rule cites', () => {
  it('a rule citing the incident evidence is attributed on the incident rows; its held-out flip is not', () => {
    const report = replay([], [citing('evt_a01')], FULL_LEDGER);
    expect(report.attribution).toMatchObject({
      applicable: true,
      changedRuleIds: ['deny_complete_without_verification'],
      attributedFlips: 2,
      unattributedFlips: 1,
    });
    const attributed = report.flips.filter((flip) => flip.attributed);
    expect(attributed.map((flip) => flip.sample)).toEqual(['in_sample', 'in_sample']);
    expect(attributed[0]!.attributedTo).toEqual(['evt_a01']);
  });

  it('a rule citing an unrelated incident earns no attribution however many rows it flips (negative test)', () => {
    // Incident C's evidence is bound to run_c03; every flipped row belongs to run_a01 or run_v01.
    const report = replay([], [citing('evt_c03')], FULL_LEDGER);
    expect(report.flips).toHaveLength(3);
    expect(report.attribution).toMatchObject({ applicable: true, attributedFlips: 0, unattributedFlips: 3 });
    expect(report.flips.every((flip) => !flip.attributed && flip.attributedTo.length === 0)).toBe(true);
    // The flips are still real and still counted as in-sample fixes: attribution is a separate question.
    expect(report.inSampleFixes).toHaveLength(2);
  });

  it('without an evidence catalog nothing can be attributed, and an unchanged rule set has nothing to attribute', () => {
    const noCatalog = replayCandidate({
      parentRules: [],
      childRules: [verifyRule],
      parentHash: null,
      childHash: 'c'.repeat(64),
      corpus: W0_LEDGER,
      scope: { incidentRuns: INCIDENT_A_SCOPE.incidentRuns },
    });
    expect(noCatalog.attribution.attributedFlips).toBe(0);
    const unchanged = replay([verifyRule], [verifyRule], FULL_LEDGER);
    expect(unchanged.attribution).toMatchObject({
      applicable: false,
      attributedFlips: 0,
      unattributedFlips: 0,
    });
  });

  it('a loosening by removal is attributed through the evidence the candidate cites', () => {
    const report = replayCandidate({
      parentRules: expert().guardrails,
      childRules: [],
      parentHash: null,
      childHash: 'c'.repeat(64),
      corpus: EXPERT_LEDGER,
      scope: { ...INCIDENT_A_SCOPE, candidateCitations: ['evt_a01'] },
    });
    // No rule fired on the loosened rows, so the patch citations decide: evt_a01 is bound to the rows' run.
    expect(report.attribution.applicable).toBe(true);
    expect(report.flips.every((flip) => flip.attributed)).toBe(true);
    const uncited = replayCandidate({
      parentRules: expert().guardrails,
      childRules: [],
      parentHash: null,
      childHash: 'c'.repeat(64),
      corpus: EXPERT_LEDGER,
      scope: { ...INCIDENT_A_SCOPE, candidateCitations: ['evt_c03'] },
    });
    expect(uncited.flips.every((flip) => !flip.attributed)).toBe(true);
  });
});
