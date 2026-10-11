import { describe, expect, it } from 'vitest';
import { REJECTION_CODES } from '../src/index.js';
import { REJECTION_CATALOG } from './rejection-catalog.js';

// Self-contained: every case builds its own candidate, so any single case runs alone with `-t <code>`.
describe('rejection catalog: one unsafe candidate per rejection category', () => {
  it('covers exactly the rejection vocabulary', () => {
    expect(Object.keys(REJECTION_CATALOG).sort()).toEqual([...REJECTION_CODES].sort());
  });
  it.each(REJECTION_CODES)('%s', (code) => {
    const result = REJECTION_CATALOG[code]();
    expect(result.ok, `${code} candidate was accepted`).toBe(false);
    if (result.ok) return;
    expect(result.rejection.codes, JSON.stringify(result.rejection.issues)).toContain(code);
    // A rejection names vocabulary paths and fixed messages only: nothing from the bundle text is echoed.
    expect(JSON.stringify(result.rejection)).not.toMatch(/syn_subject_|order_77|Bad Rule/);
  });
});
