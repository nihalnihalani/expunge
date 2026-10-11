import { describe, expect, it } from 'vitest';
import { EVIDENCE_ARMS, EvidenceNotPermitted, buildEvidencePacket } from '../src/index.js';
import { INCIDENT_A, INCIDENT_B, INCIDENT_C } from './helpers.js';

const BUDGET = 6000;
const packet = (arm: (typeof EVIDENCE_ARMS)[number], budgetChars = BUDGET) =>
  buildEvidencePacket({ arm, incident: [INCIDENT_A], pool: [INCIDENT_B, INCIDENT_C], budgetChars });

describe('evidence packets and the control arms', () => {
  it('trace-informed carries the incident trace; score-only carries the score and no trace content', () => {
    const traced = JSON.stringify(packet('trace_informed').items);
    expect(traced).toContain('nested array copy');
    expect(traced).toContain('discover_references');
    const scored = JSON.stringify(packet('score_only').items);
    for (const trace of [
      'nested array',
      'discover_references',
      'have been removed',
      'failureWitnesses',
      'modelOutput',
      'syn_subject',
    ]) {
      expect(scored, trace).not.toContain(trace);
    }
    expect(scored).toContain('"confidence":0.9');
    expect(packet('score_only').citableIds).toContain('evt_a01');
  });

  it('wrong-incident substitutes an unrelated permitted trace under the same schema; its IDs are the only citable ones', () => {
    const wrong = packet('wrong_incident');
    const text = JSON.stringify(wrong.items);
    expect(text).toContain('retained record deleted without owner approval');
    expect(text).not.toContain('nested array');
    expect(wrong.incidentIds).toEqual(['evb_train_a01']);
    expect(wrong.citableIds).toEqual(expect.arrayContaining(['evt_b02', 'evb_train_b02']));
    expect(wrong.citableIds).not.toContain('evt_a01');
    // Same view shape as the trace-informed arm.
    expect(Object.keys(wrong.items[0]!.view as Record<string, unknown>).sort()).toEqual(
      Object.keys(packet('trace_informed').items[0]!.view as Record<string, unknown>).sort(),
    );
  });

  it('all arms share one evidence budget and none exceeds it, truncating deterministically', () => {
    for (const arm of EVIDENCE_ARMS) {
      const full = packet(arm);
      expect(full.budgetChars).toBe(BUDGET);
      expect(full.chars).toBeLessThanOrEqual(BUDGET);
      const tight = packet(arm, 700);
      expect(tight.chars, arm).toBeLessThanOrEqual(700);
      expect(packet(arm, 700)).toEqual(tight);
    }
    expect(packet('trace_informed', 700).truncated).toBe(true);
    expect(packet('trace_informed').truncated).toBe(false);
  });

  it('only sanitized training-split, training-permitted evidence can reach a proposer', () => {
    const bundles = [
      { ...INCIDENT_A, split: 'validation' as const },
      { ...INCIDENT_A, split: 'final' as const },
      { ...INCIDENT_A, split: 'protected' as const },
      { ...INCIDENT_A, sources: [{ ...INCIDENT_A.sources[0]!, permittedUse: 'gate_only' as const }] },
      { ...INCIDENT_A, sources: [{ ...INCIDENT_A.sources[0]!, permittedUse: 'revoked' as const }] },
      { ...INCIDENT_A, sources: [{ ...INCIDENT_A.sources[0]!, permittedUse: 'display_only' as const }] },
      { ...INCIDENT_A, sources: [] },
    ];
    for (const arm of EVIDENCE_ARMS) {
      for (const bundle of bundles) {
        expect(
          () => buildEvidencePacket({ arm, incident: [bundle], pool: [INCIDENT_B], budgetChars: BUDGET }),
          `${arm} ${bundle.split}`,
        ).toThrow(EvidenceNotPermitted);
      }
      // A prohibited bundle in the wrong-incident pool is refused as well.
      expect(() =>
        buildEvidencePacket({
          arm,
          incident: [INCIDENT_A],
          pool: [{ ...INCIDENT_B, split: 'validation' }],
          budgetChars: BUDGET,
        }),
      ).toThrow(EvidenceNotPermitted);
    }
  });

  it('packets never carry manifest or hidden-answer fields', () => {
    for (const arm of EVIDENCE_ARMS) {
      const text = JSON.stringify(packet(arm));
      for (const hidden of [
        'manifest',
        'expectedState',
        'preservationHashes',
        'untouchedHashes',
        'seedCommitment',
      ])
        expect(text, `${arm} ${hidden}`).not.toContain(hidden);
    }
  });

  it('the wrong-incident arm needs an unrelated incident to exist', () => {
    expect(() =>
      buildEvidencePacket({
        arm: 'wrong_incident',
        incident: [INCIDENT_A],
        pool: [INCIDENT_A],
        budgetChars: BUDGET,
      }),
    ).toThrow('NoUnrelatedIncident');
  });
});
