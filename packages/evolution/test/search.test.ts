import { describe, expect, it } from 'vitest';
import type { GuardrailAst } from '@expunge/contracts';
import {
  EVIDENCE_ARMS,
  buildEvidencePacket,
  createLabeledFakeEvolverModel,
  pruneRules,
  retestAccumulated,
  runControlledRounds,
  runEvolutionRound,
  type EvolverModel,
} from '../src/index.js';
import {
  ACTOR,
  CATALOG,
  INCIDENT_A,
  INCIDENT_B,
  FULL_LEDGER,
  INCIDENT_C,
  W0_LEDGER,
  compileContext,
  row,
  w0,
} from './helpers.js';

const BUDGET = 6000;
const packets = () =>
  Object.fromEntries(
    EVIDENCE_ARMS.map((arm) => [
      arm,
      buildEvidencePacket({
        arm,
        incident: [INCIDENT_A],
        pool: [INCIDENT_B, INCIDENT_C],
        budgetChars: BUDGET,
      }),
    ]),
  ) as Record<(typeof EVIDENCE_ARMS)[number], ReturnType<typeof buildEvidencePacket>>;
const base = (model: EvolverModel = createLabeledFakeEvolverModel('honest')) => ({
  model,
  parent: w0(),
  actor: ACTOR,
  context: compileContext(),
  catalog: CATALOG,
  corpus: FULL_LEDGER,
});

const verifyRule = (ruleId = 'deny_complete_without_verification'): GuardrailAst => ({
  ruleId,
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
});
const neverRule: GuardrailAst = {
  ruleId: 'deny_when_retry_huge',
  predicate: {
    op: 'compare',
    comparator: 'gt',
    left: { kind: 'fact', factId: 'retry_count' },
    right: { kind: 'constant', value: 100 },
  },
  result: 'deny',
  sourceEvidenceIds: ['evt_a01'],
  appliesTo: ['apply_cleanup_batch'],
};

describe('bounded search with branching, backtracking and retained losers', () => {
  it('stops at the first compiled candidate that fixes recorded harm and keeps the others as ranked losers', async () => {
    const result = await runEvolutionRound({ ...base(), packet: packets().trace_informed });
    expect(result.stopped).toBe('good_candidate');
    expect(result.selectionBasis).toBe('held_out');
    expect(result.selected?.evidenceLevel).toBe('out_of_sample_fix');
    expect(result.proposalsUsed).toBe(2);
    expect(result.selected?.patches?.map((patch) => patch.path)).toEqual([
      'guardrails.deny_complete_without_verification',
    ]);
    expect(result.losers.map((loser) => [loser.record.branchIndex, loser.reasonCodes])).toEqual([
      [0, ['outranked']],
    ]);
    expect(result.records.map((entry) => entry.arm)).toEqual(['trace_informed', 'trace_informed']);
  });

  it("does not stop on, or rank by, fixes that are only on the incident's own run (in-sample)", async () => {
    // The ledger holds only the incident run: the guardrail candidate "fixes" its two harmful completions, in sample.
    const result = await runEvolutionRound({
      ...base(),
      corpus: W0_LEDGER,
      packet: packets().trace_informed,
    });
    expect(result.stopped).toBe('budget');
    expect(result.proposalsUsed).toBe(result.budget.maxProposals);
    expect(result.selectionBasis).toBe('in_sample_only');
    expect(result.selected?.evidenceLevel).toBe('in_sample_only');
    expect(result.selected?.replay).toMatchObject({
      inSample: { fixes: 2 },
      heldOut: { rows: 0, fixes: 0 },
    });
  });

  it('ranks by out-of-sample fixes: a candidate with fewer in-sample fixes but a held-out fix wins', async () => {
    const harmful = { class: 'harmful' as const, recordedAt: '2026-10-11T11:00:00.000Z' };
    const incidentRun = { jobId: 'job_a01', runId: 'run_a01' };
    const validationRun = { jobId: 'job_v01', runId: 'run_v01' };
    const ledger = [
      row('ia1', 'complete_cleanup', { retry_count: 1 }, 'allow', harmful, incidentRun),
      row('ia2', 'complete_cleanup', { retry_count: 1 }, 'allow', harmful, incidentRun),
      row('ib1', 'complete_cleanup', { retry_count: 2 }, 'allow', harmful, incidentRun),
      row('vb1', 'complete_cleanup', { retry_count: 2 }, 'allow', harmful, validationRun),
    ];
    const retryRule = (value: number): GuardrailAst => ({
      ruleId: `deny_complete_at_retry_${value}`,
      predicate: {
        op: 'compare',
        comparator: 'eq',
        left: { kind: 'fact', factId: 'retry_count' },
        right: { kind: 'constant', value },
      },
      result: 'deny',
      sourceEvidenceIds: ['evt_a01'],
      appliesTo: ['complete_cleanup'],
    });
    // Branch 0 fixes two in-sample rows and nothing held out; branch 1 fixes one in-sample and one held-out row.
    const scripted: EvolverModel = {
      id: 'FAKE-scripted-two-candidates',
      kind: 'fake',
      propose: async (request) => {
        const rule = retryRule(request.branchIndex === 0 ? 1 : 2);
        return {
          abstain: false,
          hypothesis: 'Block completion at the retry count seen in the recorded harm.',
          claimedClass: 'tightening',
          patches: [
            {
              surface: 'guardrails',
              path: `guardrails.${rule.ruleId}`,
              after: rule,
              hypothesis: 'Completion at this retry count is what the recorded run did wrong.',
              sourceEvidenceIds: ['evt_a01'],
            },
          ],
        };
      },
    };
    const result = await runEvolutionRound(
      { ...base(scripted), corpus: ledger, packet: packets().trace_informed },
      { maxProposals: 2, stopOnGood: false },
    );
    const [first, second] = result.records;
    expect(first!.replay).toMatchObject({ inSample: { fixes: 2 }, heldOut: { fixes: 0 } });
    expect(second!.replay).toMatchObject({ inSample: { fixes: 1 }, heldOut: { fixes: 1 } });
    expect(result.selected).toBe(second);
    expect(result.selectionBasis).toBe('held_out');
    expect(result.losers.map((loser) => [loser.record.branchIndex, loser.reasonCodes])).toEqual([
      [0, ['outranked']],
    ]);
  });

  it('with the budget spent the best compiled candidate wins; abstentions and rejections stay on the record', async () => {
    const result = await runEvolutionRound(
      { ...base(createLabeledFakeEvolverModel('always_abstain')), packet: packets().trace_informed },
      { maxProposals: 2, stopOnGood: true },
    );
    expect(result.selected).toBeNull();
    expect(result.stopped).toBe('budget');
    expect(result.records.map((entry) => entry.status)).toEqual(['abstained', 'abstained']);
    expect(result.losers.map((loser) => loser.reasonCodes)).toEqual([['abstained'], ['abstained']]);
    const bad = await runEvolutionRound(
      { ...base(createLabeledFakeEvolverModel('cite_nonexistent')), packet: packets().trace_informed },
      { maxProposals: 1, stopOnGood: false },
    );
    expect(bad.losers[0]!.reasonCodes).toEqual(['evidence_not_in_packet']);
  });

  it('prunes a rule with no standing out of an otherwise useful batch and retries the rest', async () => {
    const scripted: EvolverModel = {
      id: 'FAKE-scripted-mixed-batch',
      kind: 'fake',
      propose: async () => ({
        abstain: false,
        hypothesis: 'Block unverified completion and, separately, runaway retries.',
        claimedClass: 'tightening',
        patches: [
          {
            surface: 'guardrails',
            path: 'guardrails.deny_complete_without_verification',
            after: verifyRule(),
            hypothesis: 'Completion without verification caused the miss.',
            sourceEvidenceIds: ['evt_a01'],
          },
          {
            surface: 'guardrails',
            path: 'guardrails.deny_when_retry_huge',
            after: neverRule,
            hypothesis: 'A guard for runaway retries in case.',
            sourceEvidenceIds: ['evt_a01'],
          },
        ],
      }),
    };
    const result = await runEvolutionRound(
      { ...base(scripted), packet: packets().trace_informed },
      { maxProposals: 1, stopOnGood: false },
    );
    expect(result.records.map((entry) => entry.status)).toEqual(['compile_rejected', 'compiled']);
    expect(result.losers[0]!.reasonCodes).toEqual(['pruned_no_op_rule', 'no_op_rule']);
    expect(result.selected?.patches?.map((patch) => patch.path)).toEqual([
      'guardrails.deny_complete_without_verification',
    ]);
    expect(result.selected?.claimedClass).toBe('tightening');
  });
});

describe('score-only and wrong-incident controls under the same budget', () => {
  it('produce their own candidates, each labelled with the arm that produced it', async () => {
    const rounds = await runControlledRounds(base(), packets());
    const arms = Object.keys(rounds).sort();
    expect(arms).toEqual(['score_only', 'trace_informed', 'wrong_incident']);
    for (const arm of arms as Array<keyof typeof rounds>) {
      expect(rounds[arm].arm).toBe(arm);
      expect(rounds[arm].budget).toEqual(rounds.trace_informed.budget);
      expect(rounds[arm].proposalsUsed).toBeLessThanOrEqual(rounds[arm].budget.maxProposals);
      expect(rounds[arm].records.every((entry) => entry.arm === arm)).toBe(true);
      expect(rounds[arm].selected?.status).toBe('compiled');
    }
    const children = Object.values(rounds).map((round) => round.selected!.proposal!.childHash);
    expect(new Set(children).size).toBe(3);
  });

  it('the trace-informed candidate fixes recorded harm; the controls, lacking the incident, do not', async () => {
    const rounds = await runControlledRounds(base(), packets());
    expect(rounds.trace_informed.selected!.replay!.heldOut.fixes).toBeGreaterThan(0);
    expect(rounds.trace_informed.selected!.replay!.inSample.fixes).toBeGreaterThan(0);
    expect(rounds.trace_informed.selectionBasis).toBe('held_out');
    for (const control of [rounds.score_only, rounds.wrong_incident]) {
      expect(control.selected!.replay!.heldOutFixes).toEqual([]);
      expect(control.selected!.replay!.inSampleFixes).toEqual([]);
      expect(control.selectionBasis).toBe('in_sample_only');
    }
    // The score-only candidate is a generic budget cut; the wrong-incident one addresses the unrelated incident.
    expect(rounds.score_only.selected!.patches!.map((patch) => patch.path)).toEqual(['limits.modelCalls']);
    expect(rounds.wrong_incident.selected!.patches!.map((patch) => patch.path)).toEqual([
      'toolPolicy.prerequisites',
    ]);
  });

  it('each arm cites only identifiers of its own packet', async () => {
    const all = packets();
    const rounds = await runControlledRounds(base(), all);
    for (const arm of EVIDENCE_ARMS) {
      for (const patch of rounds[arm].selected!.patches!)
        for (const id of patch.sourceEvidenceIds) expect(all[arm].citableIds).toContain(id);
    }
    expect(rounds.wrong_incident.selected!.patches![0]!.sourceEvidenceIds).toEqual(['evt_b02']);
  });
});

describe('critic and pruner', () => {
  const unrelated = (): GuardrailAst => ({
    ...verifyRule('deny_complete_unrelated'),
    sourceEvidenceIds: ['evt_c03'],
  });
  it('a rule citing unrelated evidence earns no attributed standing, however many rows it flips (negative test)', () => {
    const own = retestAccumulated([verifyRule()], W0_LEDGER, CATALOG)[0]!;
    expect(own).toMatchObject({ marginalFlips: 2, attributedFlips: 2 });
    // Same rule, same flips, but it cites incident C while the rows it flips are incident A's run.
    const foreign = retestAccumulated([unrelated()], W0_LEDGER, CATALOG)[0]!;
    expect(foreign).toMatchObject({ marginalFlips: 2, attributedFlips: 0 });
    // Without a catalog the critic cannot attribute and says so with zero.
    expect(retestAccumulated([verifyRule()], W0_LEDGER)[0]).toMatchObject({
      marginalFlips: 2,
      attributedFlips: 0,
    });
  });
  it('the pruner keeps the unrelated-evidence rule when standing is unattributed and prunes it when attributed', () => {
    expect(pruneRules([unrelated()], W0_LEDGER).kept).toHaveLength(1);
    const attributed = pruneRules([unrelated()], W0_LEDGER, new Set(), CATALOG);
    expect(attributed.kept).toEqual([]);
    expect(attributed.pruned).toEqual([
      { ruleId: 'deny_complete_unrelated', reason: 'no_attributed_standing' },
    ]);
    // A rule that cites its own incident keeps its standing under the stricter test.
    expect(pruneRules([verifyRule()], W0_LEDGER, new Set(), CATALOG).kept).toHaveLength(1);
  });
  it('retests the accumulated set: duplicated rules cover each other and neither is necessary alone', () => {
    const first = verifyRule('deny_complete_first');
    const second = verifyRule('deny_complete_second');
    const marginals = retestAccumulated([first, second, neverRule], W0_LEDGER);
    expect(marginals.map((entry) => [entry.ruleId, entry.marginalFlips])).toEqual([
      ['deny_complete_first', 0],
      ['deny_complete_second', 0],
      ['deny_when_retry_huge', 0],
    ]);
    expect(marginals[0]!.coveredBy).toEqual(['deny_complete_second']);
    expect(marginals[2]!.fires).toBe(0);
    // A single copy is necessary.
    expect(retestAccumulated([first], W0_LEDGER)[0]!.marginalFlips).toBe(2);
  });
  it('prunes one redundant rule at a time and retests: the survivor becomes necessary', () => {
    const first = verifyRule('deny_complete_first');
    const second = verifyRule('deny_complete_second');
    const pruned = pruneRules([first, second, neverRule], W0_LEDGER);
    expect(pruned.pruned.map((entry) => entry.ruleId)).toEqual([
      'deny_complete_first',
      'deny_when_retry_huge',
    ]);
    expect(pruned.kept.map((rule) => rule.ruleId)).toEqual(['deny_complete_second']);
    expect(
      pruneRules([first, second], W0_LEDGER, new Set(['deny_complete_first'])).kept.map(
        (rule) => rule.ruleId,
      ),
    ).toEqual(['deny_complete_first']);
  });
});
