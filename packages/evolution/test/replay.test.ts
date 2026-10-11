import { describe, expect, it } from 'vitest';
import { contentHash, type GuardrailAst } from '@expunge/contracts';
import { decide, asOfInput } from '@expunge/harness-compiler';
import { replayCandidate } from '../src/index.js';
import { EXPERT_LEDGER, W0_LEDGER, expert, row, w0 } from './helpers.js';

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
    expect(report.fixes).toHaveLength(2);
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
    expect(report.fixes).toEqual([]);
  });

  it('known authority flips: a candidate that permits what the record blocked', () => {
    const report = replayCandidate({
      parentRules: expert().guardrails,
      childRules: [],
      parentHash: contentHash(expert()),
      childHash: 'c'.repeat(64),
      corpus: EXPERT_LEDGER,
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
    expect(without.fixes).toEqual([]);
    expect(withLabels.fixes).toHaveLength(2);
  });
});
