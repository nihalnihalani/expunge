import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import { COLLECTION_IDS, FAMILIES, createWorldSpec, addressKey } from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture, keyedDerivation } from '@expunge/fixtures/sealed';
import {
  INDEXED_SOLVER_HASH,
  REFERENCE_SOLVER_HASH,
  plansAgree,
  referenceSolve,
  referenceSolveIndexed,
} from '../src/index.js';

const derivation = keyedDerivation(
  new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 13 + 2) & 0xff)),
  'key_solver_tests',
);
const master = contentHash({ label: 'solvers' }, 'test-master-seed');

describe('two independently implemented reference solvers', () => {
  it('share no traversal code: the second imports neither the first nor the shared path walker', () => {
    const source = readFileSync(new URL('../src/reference2.ts', import.meta.url), 'utf8');
    const imports = [...new Set([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]))];
    expect(imports.sort()).toEqual(['@expunge/contracts', '@expunge/fixtures', 'node:fs']);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/valuesAtPath|reference\.js|referenceSolve\(/);
    expect(INDEXED_SOLVER_HASH).not.toBe(REFERENCE_SOLVER_HASH);
  });

  it('select exactly the same records, effects and bindings in every family, keyed and unkeyed', () => {
    for (const family of FAMILIES) {
      for (const options of [undefined, { derivation }]) {
        const seed = `solvers-${family}`;
        const fixture = generateSealedFixture(
          createWorldSpec({ family, seed }),
          seed,
          undefined,
          undefined,
          options,
        );
        const first = referenceSolve(fixture.world);
        const second = referenceSolveIndexed(fixture.world);
        expect(second.actions, family).toHaveLength(6);
        expect(plansAgree(first, second), family).toBe(true);
        // And both agree with the independent oracle's expected targets.
        const targets = new Set(fixture.manifest.effects.map((effect) => addressKey(effect.address)));
        expect(new Set(second.actions.map((action) => addressKey(action.address)))).toEqual(targets);
      }
    }
  });

  it('agree on all 42 predeclared split worlds and on a trusted partial observation', () => {
    for (const entry of buildSealedSplitPlan(master)) {
      const fixture = generateSealedFixture(entry.spec, entry.seed, undefined, undefined, { derivation });
      expect(
        plansAgree(referenceSolve(fixture.world), referenceSolveIndexed(fixture.world)),
        entry.fixtureId,
      ).toBe(true);
    }
    const seed = 'solvers-partial';
    const partial = generateSealedFixture(
      createWorldSpec({ family: 'alias_two_hop', seed }),
      seed,
      undefined,
      {
        omitFieldIds: ['archives.record_reference'],
        limitations: ['Archive relationship field unavailable to this registered observation.'],
      },
    );
    expect(plansAgree(referenceSolve(partial.world), referenceSolveIndexed(partial.world))).toBe(true);
    expect(referenceSolveIndexed(partial.world).actions).toHaveLength(5);
  });

  it('respect the hop bound and the document budget', () => {
    const seed = 'solvers-bounds';
    const fixture = generateSealedFixture(createWorldSpec({ family: 'archive_bridge', seed }), seed);
    expect(referenceSolveIndexed(fixture.world).levels).toBeLessThanOrEqual(5);
    expect(
      referenceSolveIndexed(fixture.world, { maxDocuments: 500, maxReferenceHops: 2 }).actions.length,
    ).toBeLessThan(6);
    expect(() => referenceSolveIndexed(fixture.world, { maxDocuments: 10, maxReferenceHops: 5 })).toThrow(
      'IndexedDocumentBudget',
    );
    const stripped = structuredClone(fixture.world);
    stripped.collections.customers = [];
    expect(() => referenceSolveIndexed(stripped)).toThrow('IndexedSubjectMissing');
  });

  it('disagree when the world is ambiguous: a record reachable only by one reading is detected', () => {
    const seed = 'solvers-ambiguous';
    const fixture = generateSealedFixture(createWorldSpec({ family: 'diamond_alias', seed }), seed);
    const first = referenceSolve(fixture.world);
    const dropped = referenceSolveIndexed(fixture.world);
    dropped.actions = dropped.actions.slice(1);
    expect(plansAgree(first, dropped)).toBe(false);
    const wrongBindings = referenceSolveIndexed(fixture.world);
    wrongBindings.exactBindings = wrongBindings.exactBindings.slice(1);
    expect(plansAgree(first, wrongBindings)).toBe(false);
    const otherEffect = referenceSolveIndexed(fixture.world);
    otherEffect.actions = otherEffect.actions.map((action, index) =>
      index === 0 ? { ...action, effect: action.effect === 'delete' ? 'redact' : 'delete' } : action,
    );
    expect(plansAgree(first, otherEffect)).toBe(false);
    expect(COLLECTION_IDS).toHaveLength(6);
  });
});
