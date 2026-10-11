import { describe, expect, it, vi } from 'vitest';
import { createWorldSpec } from '@expunge/fixtures';
import { keyedDerivation } from '@expunge/fixtures/sealed';

/** TEST DOUBLE (labelled): the second solver is made to miss a record, as a defective indexed traversal would. */
vi.mock('../src/reference2.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/reference2.js')>();
  return {
    ...original,
    referenceSolveIndexed: (...args: Parameters<typeof original.referenceSolveIndexed>) => {
      const plan = original.referenceSolveIndexed(...args);
      return { ...plan, actions: plan.actions.slice(1) };
    },
  };
});

import { admitWorld, publicAdmissionVerdict } from '../src/index.js';

describe('admission quarantines a world on which the two solvers disagree', () => {
  it('reports solver_disagreement and admits nothing', () => {
    const seed = 'disagreement-world';
    const derivation = keyedDerivation(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 3 + 9) & 0xff)),
      'key_disagree',
    );
    const admission = admitWorld(createWorldSpec({ family: 'mixed_eligibility', seed }), seed, undefined, {
      allowLowEntropySeed: true,
      derivation,
    });
    expect(admission.admitted).toBe(false);
    const verdict = publicAdmissionVerdict(admission);
    expect(verdict.reasonCodes).toEqual(['solver_disagreement']);
    expect(verdict.referenceResultHash).toBeNull();
  });
});
