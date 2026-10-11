import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeRuntimeHash, runtimeHash } from '../src/index.js';

describe('runtime hash is observed from the loaded bytes', () => {
  it('is a stable 64-hex digest within a build, and memoized', () => {
    const first = computeRuntimeHash();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRuntimeHash()).toBe(first);
    expect(runtimeHash()).toBe(first);
  });

  it('follows the bytes: changing one hashed module (runtime, vendored OpenMuse or contracts) changes the digest', () => {
    // One snapshot of the bytes the function itself reads, so concurrent edits to the checkout cannot race the comparison.
    const snapshot = new Map<string, string>();
    const baseline = computeRuntimeHash((moduleId, url) => {
      const source = readFileSync(url, 'utf8');
      snapshot.set(moduleId, source);
      return source;
    });
    const withChange = (changed: string) =>
      computeRuntimeHash((moduleId) =>
        moduleId === changed ? `${snapshot.get(moduleId)}\n// one more byte` : snapshot.get(moduleId)!,
      );
    // Replaying the snapshot is the same digest.
    expect(computeRuntimeHash((moduleId) => snapshot.get(moduleId)!)).toBe(baseline);
    const ids = [...snapshot.keys()];
    const classes = {
      runtime: ids.find((id) => !id.includes('vendor-openmuse') && !id.includes('contracts')),
      vendored: ids.find((id) => id.includes('vendor-openmuse')),
      contracts: ids.find((id) => id.includes('contracts')),
    };
    for (const [label, id] of Object.entries(classes)) {
      expect(id, `a ${label} module is among the hashed modules: ${ids.join(',')}`).toBeDefined();
      const altered = withChange(id!);
      expect(altered).toMatch(/^[0-9a-f]{64}$/);
      expect(altered, `changing ${label} module ${id}`).not.toBe(baseline);
    }
  });
});
