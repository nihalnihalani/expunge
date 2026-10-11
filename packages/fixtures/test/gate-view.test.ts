import { describe, expect, it } from 'vitest';
import { buildSealedSplitPlan, sealPlanForGate, verifyGatePlanView } from '../src/sealed.js';
import { testMasterSeed } from './helpers.js';

const plan = buildSealedSplitPlan(testMasterSeed('gate-view'));

describe('GatePlanView (the gate never holds the final split)', () => {
  it('carries the gated entries in full and no final-split seed, spec or structure', () => {
    const view = sealPlanForGate(plan);
    expect(view.entries.every((entry) => entry.split !== ('test' as never))).toBe(true);
    expect(view.entries).toHaveLength(plan.filter((entry) => entry.split !== 'test').length);
    const text = JSON.stringify(view);
    for (const entry of plan.filter((item) => item.split === 'test')) {
      expect(text).not.toContain(entry.seed);
      expect(text).not.toContain(entry.structuralHash);
    }
    expect(view.commitment.counts.test).toBe(24);
    expect(verifyGatePlanView(view)).toBe(view.commitment.splitHash);
  });
  it('keeps no reference into the plan', () => {
    const view = sealPlanForGate(plan);
    expect(view.entries[0]).not.toBe(plan[0]);
    expect(view.entries[0]!.spec).not.toBe(plan[0]!.spec);
  });
  it('refuses a final-split entry, a swapped spec, a forged hash and a wrong expected commitment', () => {
    const final = plan.find((entry) => entry.split === 'test')!;
    const withFinal = sealPlanForGate(plan);
    withFinal.entries.push(structuredClone(final) as never);
    expect(() => verifyGatePlanView(withFinal)).toThrow('GatePlanViewFinalSplitEntry');
    const swapped = sealPlanForGate(plan);
    swapped.entries[0]!.spec = structuredClone(swapped.entries[1]!.spec);
    expect(() => verifyGatePlanView(swapped)).toThrow('GatePlanViewEntryForged');
    const forged = sealPlanForGate(plan);
    forged.commitment.counts.train += 1;
    expect(() => verifyGatePlanView(forged)).toThrow('GatePlanViewCommitmentMismatch');
    expect(() => verifyGatePlanView(sealPlanForGate(plan), 'b'.repeat(64))).toThrow(
      'GatePlanViewCommitmentMismatch',
    );
    const missing = sealPlanForGate(plan);
    missing.entries.pop();
    expect(() => verifyGatePlanView(missing)).toThrow('GatePlanViewEntryMissing');
  });
});
