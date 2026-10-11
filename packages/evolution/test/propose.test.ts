import { describe, expect, it } from 'vitest';
import { contentHash, type HarnessBundle } from '@expunge/contracts';
import {
  buildEvidencePacket,
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
  over: { maxEdits?: number } = {},
): Promise<ProposalRecord> {
  return proposeCandidate({
    model: createLabeledFakeEvolverModel(mode),
    packet: packetFor(incident),
    branchIndex,
    parent,
    actor: ACTOR,
    context: compileContext(),
    catalog: CATALOG,
    corpus: W0_LEDGER,
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
    expect(record.replay!.fixes.length).toBe(2);
    expect(record.replay!.regressions).toEqual([]);
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
