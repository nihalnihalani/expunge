import { describe, expect, it } from 'vitest';
import { contentHash, type GuardrailAst, type HarnessBundle } from '@expunge/contracts';
import {
  buildEvidencePacket,
  isGoodCandidate,
  createLabeledFakeEvolverModel,
  proposeCandidate,
  type FakeMode,
  type ProposalRecord,
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
  w0,
} from './helpers.js';

const BUDGET = 6000;
const packetFor = (
  incident = INCIDENT_A,
  arm: 'trace_informed' | 'score_only' | 'wrong_incident' = 'trace_informed',
) =>
  buildEvidencePacket({
    arm,
    incident: [incident],
    pool: [INCIDENT_A, INCIDENT_B, INCIDENT_C],
    budgetChars: BUDGET,
  });
async function propose(
  mode: FakeMode,
  branchIndex: number,
  incident = INCIDENT_A,
  parent: HarnessBundle = w0(),
  over: { maxEdits?: number; corpus?: typeof W0_LEDGER } = {},
): Promise<ProposalRecord> {
  return proposeCandidate({
    model: createLabeledFakeEvolverModel(mode),
    packet: packetFor(incident),
    branchIndex,
    parent,
    actor: ACTOR,
    context: compileContext(),
    catalog: CATALOG,
    corpus: FULL_LEDGER,
    ...over,
  });
}

describe('one generated candidate per surface against W0', () => {
  it('context: wider discovery from the nested-array incident is behavioral and cites real IDs', async () => {
    const record = await propose('honest', 0);
    expect(record.status).toBe('compiled');
    expect(record.computedClass).toBe('behavioral');
    expect(record.patches?.map((patch) => patch.path)).toEqual([
      'contextPolicy.includeNestedArrays',
      'contextPolicy.referenceDepth',
      'limits.traversalDepth',
    ]);
    expect(record.child!.contextPolicy.includeNestedArrays).toBe(true);
    expect(record.child!.limits.traversalDepth).toBe(5);
  });
  it('guardrails: the unverified-completion incident yields a tightening that fixes recorded harm', async () => {
    const record = await propose('honest', 1);
    expect(record.status).toBe('compiled');
    expect(record.computedClass).toBe('tightening');
    expect(record.patches?.map((patch) => patch.path)).toEqual([
      'guardrails.deny_complete_without_verification',
    ]);
    expect(record.replay!.label).toBe('decision replay');
    // In-sample (the incident's own run) and out-of-sample (a disjoint validation run) are separate fields.
    expect(record.replay!.inSample.fixes).toBe(2);
    expect(record.replay!.heldOut.fixes).toBe(1);
    expect(record.replay!.regressions).toEqual([]);
    expect(record.evidenceLevel).toBe('out_of_sample_fix');
    expect(isGoodCandidate(record)).toBe(true);
  });
  it('guardrails: with only the incident run to replay against, the same candidate is merely a candidate for gate', async () => {
    const record = await propose('honest', 1, INCIDENT_A, w0(), { corpus: W0_LEDGER });
    expect(record.status).toBe('compiled');
    expect(record.replay!.inSample.fixes).toBe(2);
    expect(record.replay!.heldOut).toMatchObject({ rows: 0, fixes: 0 });
    expect(record.evidenceLevel).toBe('in_sample_only');
    expect(isGoodCandidate(record)).toBe(false);
  });
  it('edits replay cannot see (context, workflow, tool policy) carry no replay signal and no fix claim', async () => {
    const record = await propose('honest', 0);
    expect(record.evidenceLevel).toBe('no_replay_signal');
    expect(record.replay!.attribution.applicable).toBe(false);
    expect(isGoodCandidate(record)).toBe(false);
  });
  it('workflow: the open-frontier incident yields a bounded discovery loop (behavioral)', async () => {
    const record = await propose('honest', 0, INCIDENT_C);
    expect(record.status).toBe('compiled');
    expect(record.computedClass).toBe('behavioral');
    expect(record.patches?.map((patch) => patch.surface)).toEqual(['workflow']);
    expect(record.artifact!.workflowPlan.loopNodes).toContain('discover');
  });
  it('tool policy: the unapproved-change incident yields an approval prerequisite (tightening)', async () => {
    const record = await propose('honest', 0, INCIDENT_B);
    expect(record.status).toBe('compiled');
    expect(record.computedClass).toBe('tightening');
    expect(record.patches?.map((patch) => patch.path)).toEqual(['toolPolicy.prerequisites']);
  });
});

describe('what the evolver guarantees about a proposal', () => {
  it('cites only IDs present in the packet it was shown and records them in the child bundle', async () => {
    const record = await propose('honest', 1);
    const packet = packetFor();
    for (const patch of record.patches!)
      for (const id of patch.sourceEvidenceIds) expect(packet.citableIds).toContain(id);
    expect(record.child!.evidence.some((reference) => reference.externalEventId === 'evt_a01')).toBe(true);
    expect(record.proposal!.sourceEvidence.map((reference) => reference.externalEventId)).toEqual([
      'evt_a01',
    ]);
  });

  it('a patch citing a nonexistent ID is rejected before compilation', async () => {
    const record = await propose('cite_nonexistent', 1);
    expect(record.status).toBe('citation_rejected');
    expect(record.reasonCodes).toEqual(['evidence_not_in_packet']);
    // Never reached the compiler: no rejection from it and no child.
    expect(record.rejection).toBeUndefined();
    expect(record.child).toBeUndefined();
  });

  it('reads `before` from the parent and rebuilds the child: the model supplies neither', async () => {
    const parent = w0();
    const record = await propose('honest', 0, INCIDENT_A, parent);
    for (const patch of record.patches!) {
      if (patch.path === 'contextPolicy.referenceDepth')
        expect(patch.before).toBe(parent.contextPolicy.referenceDepth);
    }
    expect(record.child!.parentHash).toBe(contentHash(parent));
    expect(record.proposal!.childHash).toBe(contentHash(record.child!));
  });

  it('the proposal row carries no gate verdict: no computed class and no lifecycle state', async () => {
    const record = await propose('honest', 1);
    expect(Object.keys(record.proposal!)).not.toContain('computedClass');
    expect(Object.keys(record.proposal!)).not.toContain('state');
    expect(record.computedClass).toBe('tightening');
  });

  it('the claimed class is recorded but the computed class is authoritative', async () => {
    const record = await propose('claim_tightening', 0);
    expect(record.claimedClass).toBe('tightening');
    expect(record.computedClass).toBe('behavioral');
    expect(record.artifact!.diagnostics.map((entry) => entry.code)).toEqual(['claimed_class_mismatch']);
  });

  it('malformed model output, abstentions and over-large proposals are recorded, not trusted', async () => {
    expect((await propose('bad_shape', 0)).status).toBe('schema_rejected');
    const abstained = await propose('always_abstain', 0);
    expect(abstained.status).toBe('abstained');
    expect(abstained.abstainReason).toBe('the fake always abstains');
    // Four patches exceed the proposal schema's maximum of three.
    expect((await propose('overstuffed', 1)).status).toBe('schema_rejected');
    // Within the schema but over a stricter edit budget set by the caller.
    const tight = await propose('honest', 0, INCIDENT_A, w0(), { maxEdits: 2 });
    expect(tight.status).toBe('compile_rejected');
    expect(tight.reasonCodes).toEqual(['edit_budget_exceeded']);
  });

  it('subject literals and no-op rules are rejected by the compiler and kept as losers', async () => {
    const leaked = await propose('leak_subject', 1);
    expect(leaked.status).toBe('compile_rejected');
    expect(leaked.reasonCodes).toContain('subject_literal');
    const noop = await propose('noop_rule', 1);
    expect(noop.status).toBe('compile_rejected');
    expect(noop.reasonCodes).toContain('no_op_rule');
  });

  it('a candidate that permits more than the record did must be classified as an authority expansion', async () => {
    // Parent carries a deny rule; the fake's guardrail proposal cannot remove it, so build the case directly.
    const expert = (await import('./helpers.js')).expert();
    const record = await proposeCandidate({
      model: {
        id: 'FAKE-scripted',
        kind: 'fake',
        propose: async () => ({
          abstain: false,
          hypothesis: 'Remove the plan guard',
          claimedClass: 'behavioral',
          patches: [
            {
              surface: 'guardrails',
              path: 'guardrails.deny_apply_without_valid_plan',
              after: null,
              hypothesis: 'The guard blocked recorded applies.',
              sourceEvidenceIds: ['evt_a01'],
            },
          ],
        }),
      },
      packet: packetFor(),
      branchIndex: 0,
      parent: expert,
      actor: ACTOR,
      context: compileContext({ allowAuthorityExpansion: true }),
      catalog: CATALOG,
      corpus: (await import('./helpers.js')).EXPERT_LEDGER,
    });
    // Classified as an expansion (so the flag admits it), and replay shows the known authority flips and regressions.
    expect(record.computedClass).toBe('authority_expansion');
    expect(record.status).toBe('replay_rejected');
    expect(record.reasonCodes).toEqual(['replay_regression']);
    expect(record.replay!.knownAuthorityFlips).toHaveLength(2);
  });
});

// A scripted proposer: the rule and its citation are chosen by the test, not by the packet text.
const scriptedRule = (citedId: string): GuardrailAst => ({
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
  sourceEvidenceIds: [citedId],
  appliesTo: ['complete_cleanup'],
});
const scriptedModel = (citedId: string) => ({
  id: 'FAKE-scripted-guardrail',
  kind: 'fake' as const,
  propose: async () => ({
    abstain: false,
    hypothesis: 'Block completion without verification.',
    claimedClass: 'tightening',
    patches: [
      {
        surface: 'guardrails',
        path: 'guardrails.deny_complete_without_verification',
        after: scriptedRule(citedId),
        hypothesis: 'Completion without verification is what the recorded run did wrong.',
        sourceEvidenceIds: [citedId],
      },
    ],
  }),
});

describe('standing is attributed to the evidence a rule cites', () => {
  const run = (arm: 'trace_informed' | 'wrong_incident', incident: typeof INCIDENT_A, citedId: string) =>
    proposeCandidate({
      model: scriptedModel(citedId),
      packet: buildEvidencePacket({
        arm,
        incident: [incident],
        pool: [INCIDENT_A, INCIDENT_B, INCIDENT_C],
        budgetChars: BUDGET,
      }),
      branchIndex: 0,
      parent: w0(),
      actor: ACTOR,
      context: compileContext(),
      catalog: CATALOG,
      // Only incident A's rows (run_a01), so a rule citing incident C or B can flip them but is not about them.
      corpus: W0_LEDGER,
    });

  it('a trace-informed rule citing the incident evidence flips its own rows and is attributed', async () => {
    const record = await run('trace_informed', INCIDENT_A, 'evt_a01');
    expect(record.status).toBe('compiled');
    expect(record.replay!.attribution).toMatchObject({ applicable: true, attributedFlips: 2 });
  });

  it('a trace-informed rule whose cited evidence is not about the rows it flips earns no standing (negative test)', async () => {
    // The packet is incident C (run_c03) and the rule cites incident C; the corpus holds only run_a01 rows.
    const record = await run('trace_informed', INCIDENT_C, 'evt_c03');
    expect(record.replay!.flips.length).toBeGreaterThan(0);
    expect(record.replay!.attribution).toMatchObject({ applicable: true, attributedFlips: 0 });
    expect(record.status).toBe('replay_rejected');
    expect(record.reasonCodes).toEqual(['no_attributed_effect']);
  });

  it('a control arm is reported with its attributed and unattributed counts, not rejected', async () => {
    // Wrong-incident arm: the packet shows incident B, the rule cites B's evidence, the corpus is A's run.
    const record = await run('wrong_incident', INCIDENT_A, 'evt_b02');
    expect(record.status).toBe('compiled');
    expect(record.replay!.attribution).toMatchObject({
      applicable: true,
      attributedFlips: 0,
      unattributedFlips: 2,
    });
    expect(record.arm).toBe('wrong_incident');
    // It still flips the incident's rows, labelled in-sample, and is a candidate for gate at most.
    expect(record.evidenceLevel).toBe('in_sample_only');
    expect(isGoodCandidate(record)).toBe(false);
  });
});
