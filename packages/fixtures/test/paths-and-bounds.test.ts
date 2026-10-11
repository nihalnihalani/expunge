import { describe, expect, it } from 'vitest';
import { isFieldPath, isRegistryFieldPath, parseFieldPath, RECORD_KEY_PATH } from '@expunge/contracts';
import {
  COLLECTION_IDS,
  FAMILIES,
  FIXTURE_BOUNDS,
  RECIPE_PATH_MAX_SEGMENTS,
  WorldSpecError,
  createWorldSpec,
  generateWorld,
  isRecipePath,
  validateWorldSpec,
  type VisibleWorld,
} from '../src/index.js';
import { buildSealedSplitPlan, generateSealedFixture } from '../src/sealed.js';
import { testMasterSeed } from './helpers.js';

function everyRegistry(): Array<{ label: string; world: VisibleWorld }> {
  const worlds = FAMILIES.map((family) => ({
    label: family,
    world: generateWorld(createWorldSpec({ family, seed: `grammar-${family}` }), `grammar-${family}`),
  }));
  // Validation and test splits use different field compositions: they must satisfy the same grammar.
  const split = buildSealedSplitPlan(testMasterSeed('grammar')).map((entry) => ({
    label: entry.fixtureId,
    world: generateWorld(entry.spec, entry.seed),
  }));
  return [...worlds, ...split];
}

describe('shared field path grammar (@expunge/contracts)', () => {
  it('every path emitted by every family and split registry passes the shared grammar', () => {
    const registries = everyRegistry();
    expect(registries).toHaveLength(FAMILIES.length + 42);
    let wildcardFields = 0;
    for (const { label, world } of registries) {
      expect(world.scope.fields.length).toBeGreaterThan(0);
      for (const field of world.scope.fields) {
        const where = `${label}:${field.fieldId}`;
        expect(isRegistryFieldPath(field.path), where).toBe(true);
        if (field.path.length === 1 && field.path[0] === RECORD_KEY_PATH[0]) {
          expect(field.fieldId, where).toMatch(/\.record_id$/);
          continue;
        }
        expect(isFieldPath(field.path), where).toBe(true);
        const parsed = parseFieldPath(field.path);
        expect(parsed.segments).toEqual(field.path);
        // The declared isArray flag always agrees with the presence of the wildcard.
        expect(field.isArray, where).toBe(parsed.wildcardIndex !== null);
        expect(parsed.wildcardIndex === null || parsed.wildcardIndex > 0).toBe(true);
        if (parsed.wildcardIndex !== null) wildcardFields++;
      }
    }
    expect(wildcardFields).toBeGreaterThan(50);
  });

  it('keeps the recipe bound as a fixture-specific tightening layered on the shared grammar', () => {
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', '*'];
    expect(isFieldPath(seven)).toBe(true);
    expect(seven.length).toBeGreaterThan(RECIPE_PATH_MAX_SEGMENTS);
    expect(isRecipePath(seven)).toBe(false);
    expect(isRecipePath(seven.slice(0, RECIPE_PATH_MAX_SEGMENTS))).toBe(true);
    const clean = createWorldSpec({ family: 'direct_nested', seed: 'tight' });
    const tooLong = structuredClone(clean);
    tooLong.collectionLayouts[1]!.identityPath = seven;
    expect(validateWorldSpec(tooLong, 'tight')).toContain('unsafe_path');
    // Anything the shared grammar rejects is rejected by the recipe check as well.
    const bad: unknown[] = [
      [],
      ['*'],
      ['a', '*', '*'],
      ['1a'],
      ['a-b'],
      ['a.b'],
      ['_id'],
      [''],
      ['a', 3],
      'a.b',
      null,
      undefined,
    ];
    for (const path of bad) {
      expect(isFieldPath(path), JSON.stringify(path)).toBe(false);
      expect(isRecipePath(path), JSON.stringify(path)).toBe(false);
    }
    // Every recipe layout path the generator can emit satisfies both checks.
    for (const { world } of everyRegistry()) {
      for (const field of world.scope.fields) {
        if (field.path[0] !== 'data') continue;
        expect(isRecipePath(field.path.slice(1)) && isFieldPath(field.path)).toBe(true);
      }
    }
  });
});

describe('fixture bounds', () => {
  it('every family stays within six collections, 500 documents and five reference hops', () => {
    expect(FIXTURE_BOUNDS).toEqual({ collections: 6, maxDocuments: 500, maxHops: 5 });
    for (const family of FAMILIES) {
      for (const documentsPerCollection of [4, 8, 83]) {
        const seed = `bounds-${family}-${documentsPerCollection}`;
        const spec = createWorldSpec({ family, seed, documentsPerCollection });
        const world = generateWorld(spec, seed);
        expect(Object.keys(world.collections)).toEqual([...COLLECTION_IDS]);
        expect(world.scope.collectionIds).toHaveLength(FIXTURE_BOUNDS.collections);
        const total = Object.values(world.collections).reduce((sum, documents) => sum + documents.length, 0);
        expect(total).toBe(documentsPerCollection * 6);
        expect(total).toBeLessThanOrEqual(FIXTURE_BOUNDS.maxDocuments);
        expect(spec.referenceTopology.maxHops).toBeLessThanOrEqual(FIXTURE_BOUNDS.maxHops);
        expect(spec.resourceBounds).toEqual({ maxDocuments: 500, maxReferenceHops: 5 });
        expect(world.scope.documentLimits.maxScanned).toBeLessThanOrEqual(FIXTURE_BOUNDS.maxDocuments);
      }
    }
    for (const entry of buildSealedSplitPlan(testMasterSeed('bounds'))) {
      const world = generateWorld(entry.spec, entry.seed);
      expect(Object.values(world.collections).flat().length).toBeLessThanOrEqual(FIXTURE_BOUNDS.maxDocuments);
      expect(entry.spec.referenceTopology.maxHops).toBeLessThanOrEqual(FIXTURE_BOUNDS.maxHops);
    }
  });

  it('refuses a WorldSpec that exceeds a bound with stable reason codes instead of crashing', () => {
    const seed = 'refuse';
    const clean = createWorldSpec({ family: 'diamond_alias', seed });
    const cases: Array<[string, (spec: typeof clean) => void, string]> = [
      [
        'too many documents per collection',
        (s) => void (s.unrelatedRecipes.documentsPerCollection = 84),
        'documents_per_collection',
      ],
      ['document bound above 500', (s) => void (s.resourceBounds.maxDocuments = 501), 'document_bound'],
      [
        'document bound below the plan',
        (s) => void (s.resourceBounds.maxDocuments = 40),
        'too_many_documents',
      ],
      ['hop bound above five', (s) => void (s.resourceBounds.maxReferenceHops = 6), 'hop_bound'],
      ['topology deeper than the bound', (s) => void (s.referenceTopology.maxHops = 6), 'topology_hops'],
      [
        'seventh collection',
        (s) => void s.collectionLayouts.push({ ...s.collectionLayouts[0]! }),
        'six_unique_collections',
      ],
      ['fifth collection only', (s) => void s.collectionLayouts.splice(4), 'six_unique_collections'],
      [
        'duplicate collection id',
        (s) => void (s.collectionLayouts[5] = { ...s.collectionLayouts[5]!, collectionId: 'customers' }),
        'six_unique_collections',
      ],
      [
        'unknown collection id',
        (s) =>
          void (s.collectionLayouts[5] = { ...s.collectionLayouts[5]!, collectionId: 'ledger' as never }),
        'collection_id',
      ],
      [
        'non-integer document count',
        (s) => void (s.unrelatedRecipes.documentsPerCollection = 8.5),
        'documents_per_collection',
      ],
      ['NaN hop bound', (s) => void (s.resourceBounds.maxReferenceHops = Number.NaN), 'hop_bound'],
    ];
    for (const [name, mutate, code] of cases) {
      const spec = structuredClone(clean);
      mutate(spec);
      expect(validateWorldSpec(spec, seed), name).toContain(code);
      expect(() => generateWorld(spec, seed), name).toThrow(WorldSpecError);
      try {
        generateWorld(spec, seed);
      } catch (error) {
        expect((error as WorldSpecError).reasonCodes, name).toContain(code);
      }
    }
  });

  it('never crashes on malformed input: structural garbage quarantines as malformed_spec', () => {
    const seed = 'garbage';
    const clean = createWorldSpec({ family: 'direct_nested', seed });
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'spec',
      [],
      {},
      { contractVersion: 1 },
      { ...clean, identityRecipe: null },
      { ...clean, faults: 'none' },
      { ...clean, eligibilityPolicy: { ...clean.eligibilityPolicy, effects: 'delete' } },
      { ...clean, eligibilityPolicy: { ...clean.eligibilityPolicy, effects: [1, 2, 3, 4] } },
      { ...clean, collectionLayouts: 'layouts' },
      { ...clean, collectionLayouts: [null, 1, 'x', [], {}, {}] },
      { ...clean, collectionLayouts: new Array(65).fill({}) },
    ];
    for (const spec of garbage) {
      expect(() => validateWorldSpec(spec as typeof clean, seed)).not.toThrow();
      expect(validateWorldSpec(spec as typeof clean, seed).length).toBeGreaterThan(0);
      expect(() => generateWorld(spec as typeof clean, seed)).toThrow(WorldSpecError);
    }
    expect(validateWorldSpec(clean, 7 as unknown as string)).toEqual(['malformed_spec']);
    // Layout entries with wrong-typed members are reported, not thrown on.
    const wrongTypes = structuredClone(clean);
    Object.assign(wrongTypes.collectionLayouts[2]!, { identityPath: 'a.b', referencePath: 7, layout: {} });
    expect(validateWorldSpec(wrongTypes, seed)).toEqual(
      expect.arrayContaining(['unsafe_path', 'layout_kind']),
    );
    // A spec carrying a non-canonical value is quarantined, not thrown from the hasher.
    const noncanonical = structuredClone(clean);
    (noncanonical.faults as Record<string, unknown>).transientFailures = 0;
    (noncanonical.identityRecipe as Record<string, unknown>).subjectOrdinal = 1;
    expect(() => generateWorld(noncanonical, seed)).not.toThrow();
  });

  it('keeps long hostile keys out of reason codes', () => {
    const seed = 'hostile';
    const clean = createWorldSpec({ family: 'direct_nested', seed });
    const hostile = { ...clean, ['k'.repeat(500)]: 1 } as typeof clean;
    const codes = validateWorldSpec(hostile, seed);
    expect(codes.some((code) => code.startsWith('unknown_spec_key:'))).toBe(true);
    expect(codes.every((code) => code.length <= 64)).toBe(true);
    // Sealed generation honors the same refusal.
    expect(() => generateSealedFixture(hostile, seed)).toThrow(WorldSpecError);
  });
});
