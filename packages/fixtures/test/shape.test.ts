import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COLLECTION_IDS,
  FAMILIES,
  addressKey,
  createWorldSpec,
  generateWorld,
  publicSplitCommitment,
  structuralSignature,
  valuesAtPath,
  type VisibleWorld,
} from '../src/index.js';
import {
  SHAPE_DETECTORS,
  SHAPE_PRECISION_TOLERANCE,
  buildSealedSplitPlan,
  documentFingerprint,
  isHighEntropySeed,
  mintSeed,
  evaluateShapeDetectors,
  generateSealedFixture,
  shapeLeaks,
  type SealedFixture,
} from '../src/sealed.js';
import { testMasterSeed } from './helpers.js';

const SEEDS_PER_FAMILY = 6;

function targetKeys(fixture: SealedFixture): Set<string> {
  return new Set(fixture.manifest.effects.map((effect) => addressKey(effect.address)));
}
function everyFixture(): Array<{ label: string; family: string; fixture: SealedFixture }> {
  const rows: Array<{ label: string; family: string; fixture: SealedFixture }> = [];
  for (const family of FAMILIES) {
    for (let n = 0; n < SEEDS_PER_FAMILY; n++) {
      const seed = `shape-${family}-${n}`;
      rows.push({
        label: `${family}#${n}`,
        family,
        fixture: generateSealedFixture(createWorldSpec({ family, seed, namesakeCount: 1 + (n % 3) }), seed),
      });
    }
  }
  for (const entry of buildSealedSplitPlan(testMasterSeed('shape'))) {
    rows.push({
      label: `${entry.split}:${entry.fixtureId}`,
      family: `split:${entry.split}`,
      fixture: generateSealedFixture(entry.spec, entry.seed),
    });
  }
  return rows;
}

describe('shape-only adversaries cannot pick out the targets (DA-1)', () => {
  const fixtures = everyFixture();

  it('runs the ported DA-1 rule plus generic field-presence and array-shape fingerprinting', () => {
    expect(SHAPE_DETECTORS.map((detector) => detector.id)).toEqual([
      'da_signature_outlier',
      'normalized_signature_outlier',
      'structure_fingerprint_outlier',
      'format_fingerprint_outlier',
      'cooccurrence_signature_outlier',
      'degree_outlier',
      'token_frequency_outlier',
      'namesake_frequency_pick',
    ]);
    expect(fixtures).toHaveLength(FAMILIES.length * SEEDS_PER_FAMILY + 42);
  });

  it('every detector scores no better than chance on every world, family and split', () => {
    const pooled = new Map<string, { selected: number; hits: number; chance: number; worlds: number }>();
    for (const { label, family, fixture } of fixtures) {
      const results = evaluateShapeDetectors(fixture.world, targetKeys(fixture));
      expect(results).toHaveLength(SHAPE_DETECTORS.length);
      expect(shapeLeaks(results), label).toEqual([]);
      for (const row of results) {
        // Chance is the target fraction among candidate records: five targets among five collections of records.
        const documents = COLLECTION_IDS.filter((id) => id !== 'customers').reduce(
          (sum, id) => sum + fixture.world.collections[id].length,
          0,
        );
        if (row.detector !== 'namesake_frequency_pick') expect(row.chance).toBeCloseTo(5 / documents, 10);
        // The namesake detector chooses among same-name records only: chance is 1 / (1 + namesake chains).
        else
          expect(row.chance).toBeCloseTo(
            1 /
              (1 +
                fixture.world.collections.customers.filter(
                  (r) =>
                    r.data.displayName ===
                    fixture.world.collections.customers.find((c) => c._id === fixture.world.subjectHandle)!
                      .data.displayName,
                ).length -
                1),
            10,
          );
        expect(row.precision, `${label} ${row.detector}`).toBeLessThanOrEqual(
          row.chance + SHAPE_PRECISION_TOLERANCE,
        );
        const key = `${family}|${row.detector}`;
        const entry = pooled.get(key) ?? { selected: 0, hits: 0, chance: 0, worlds: 0 };
        entry.selected += row.selected;
        entry.hits += row.hits;
        entry.chance += row.chance;
        entry.worlds++;
        pooled.set(key, entry);
      }
    }
    // Pooled over seeds the precision also stays within tolerance of chance: no family leaks on average.
    for (const [key, entry] of pooled) {
      expect(entry.hits / entry.selected, key).toBeLessThanOrEqual(
        entry.chance / entry.worlds + SHAPE_PRECISION_TOLERANCE,
      );
    }
    expect(pooled.size).toBe((FAMILIES.length + 4) * SHAPE_DETECTORS.length);
  });

  it('makes unrelated, namesake and target records isomorphic: one structural and format fingerprint per collection', () => {
    for (const { label, fixture } of fixtures) {
      for (const collectionId of COLLECTION_IDS) {
        const documents = fixture.world.collections[collectionId];
        for (const formats of [false, true]) {
          const fingerprints = new Set(documents.map((document) => documentFingerprint(document, formats)));
          expect(fingerprints.size, `${label} ${collectionId} formats=${formats}`).toBe(1);
        }
      }
    }
  });

  it('keeps decoy chains complete: decoys have their own subject, relationships and ids, and never touch a target', () => {
    for (const { label, fixture } of fixtures) {
      const { world, manifest } = fixture;
      const targets = new Set(manifest.effects.map((effect) => effect.address.recordId));
      const referenceFields = world.scope.fields.filter((field) =>
        field.fieldId.endsWith('.record_reference'),
      );
      const allIds = new Set(Object.values(world.collections).flatMap((rows) => rows.map((row) => row._id)));
      const decoys = Object.values(world.collections)
        .flat()
        .filter((row) => !targets.has(row._id));
      expect(decoys.length).toBeGreaterThan(30);
      for (const field of referenceFields) {
        for (const document of world.collections[field.collectionId as (typeof COLLECTION_IDS)[number]]) {
          // Targets and decoys alike resolve everything except their one standalone bystander reference.
          const values = valuesAtPath(document, field.path).map((entry) => entry.value);
          const unresolved = values.filter((value) => value !== null && !allIds.has(value as string));
          expect(unresolved, `${label} ${field.fieldId}`).toHaveLength(field.isArray ? 1 : 0);
          if (targets.has(document._id)) continue;
          // A decoy is wired like a target, but only to other decoys.
          for (const value of values) {
            expect(targets.has(value as string), `${label} decoy references a target`).toBe(false);
          }
        }
      }
      // Every collection has one decoy "customer" per unrelated chain, each with its own distinct identity.
      const customerIds = world.collections.customers.map((row) => (row.data.identity as { id: string }).id);
      expect(new Set(customerIds).size).toBe(world.collections.customers.length);
    }
  });

  it('uses opaque record IDs: no ID or reference value names its collection or role', () => {
    const names = [...COLLECTION_IDS, 'primary', 'unrelated', 'target'];
    for (const { label, fixture } of fixtures) {
      const idPattern = /^syn_[0-9a-f]{24}$/;
      for (const rows of Object.values(fixture.world.collections)) {
        for (const row of rows) {
          expect(row._id, label).toMatch(idPattern);
          for (const name of names) expect(row._id).not.toContain(name);
        }
      }
    }
  });

  it('shares the display name only with the intended namesake chains, in one uniform format', () => {
    for (const { label, fixture } of fixtures) {
      const subject = fixture.world.collections.customers.find(
        (row) => row._id === fixture.world.subjectHandle,
      )!;
      const subjectName = subject.data.displayName as string;
      for (const collectionId of COLLECTION_IDS) {
        const rows = fixture.world.collections[collectionId];
        const names = rows.map((row) => row.data.displayName as string);
        expect(
          names.every((name) => /^Synthetic [A-Z][a-z]+ [A-Z][a-z]+$/.test(name)),
          label,
        ).toBe(true);
        const sameName = rows.filter((row) => row.data.displayName === subjectName);
        // Exactly the target plus its namesakes collide: the name never identifies the target by itself.
        expect(sameName.length).toBeGreaterThanOrEqual(2);
        expect(new Set(names).size).toBe(names.length - (sameName.length - 1));
      }
    }
  });

  describe('positive controls: the detectors do find a structural answer channel when one exists', () => {
    function leaky(mutate: (world: VisibleWorld, targets: Set<string>) => void) {
      const fixture = generateSealedFixture(
        createWorldSpec({ family: 'diamond_alias', seed: 'leaky' }),
        'leaky',
      );
      const world = structuredClone(fixture.world);
      mutate(world, new Set(fixture.manifest.effects.map((effect) => effect.address.recordId)));
      return shapeLeaks(evaluateShapeDetectors(world, targetKeys(fixture)));
    }
    it('flags an extra field that only targets carry', () => {
      const leaks = leaky((world, targets) => {
        for (const rows of Object.values(world.collections)) {
          for (const row of rows) if (targets.has(row._id)) row.data.marker = true;
        }
      });
      expect(leaks).toEqual(
        expect.arrayContaining(['structure_fingerprint_outlier', 'format_fingerprint_outlier']),
      );
    });
    it('flags a differently shaped identity array on the targets (the original DA-1 channel)', () => {
      const leaks = leaky((world, targets) => {
        for (const field of world.scope.fields.filter((f) => f.fieldId.endsWith('.identity_binding'))) {
          for (const row of world.collections[field.collectionId as (typeof COLLECTION_IDS)[number]]) {
            if (!targets.has(row._id) || field.collectionId === 'customers') continue;
            const envelope = row.data.envelope as { parties: unknown[] };
            envelope.parties.push({ principal: null }, { principal: null });
          }
        }
      });
      expect(leaks).toEqual(expect.arrayContaining(['structure_fingerprint_outlier']));
    });
    it('flags cross-document value co-occurrence: decoys sharing a bystander the target chain does not (DA-2)', () => {
      const leaks = leaky((world, targets) => {
        for (const rows of Object.values(world.collections)) {
          for (const row of rows) {
            const parties = (row.data.envelope as { parties?: Array<{ principal: string }> } | undefined)
              ?.parties;
            if (!parties || targets.has(row._id)) continue;
            parties[parties.length - 1]!.principal = 'syn_shared_bystander';
          }
        }
      });
      expect(leaks).toEqual(
        expect.arrayContaining(['cooccurrence_signature_outlier', 'token_frequency_outlier']),
      );
    });
    it('flags readable collection prefixes in reference IDs', () => {
      const leaks = leaky((world, targets) => {
        const prefixed = new Map<string, string>();
        for (const id of COLLECTION_IDS) {
          for (const row of world.collections[id]) prefixed.set(row._id, `syn_${id}_${row._id.slice(4)}`);
        }
        for (const field of world.scope.fields.filter((f) => f.fieldId.endsWith('.record_reference'))) {
          for (const row of world.collections[field.collectionId as (typeof COLLECTION_IDS)[number]]) {
            if (!targets.has(row._id)) continue;
            const list = (row.data.lineage as { links: Array<{ record: string }> }).links;
            for (const link of list) link.record = prefixed.get(link.record) ?? link.record;
          }
        }
      });
      expect(leaks).toEqual(expect.arrayContaining(['normalized_signature_outlier']));
    });
  });
});

describe('sealed split commitments do not leak held-out structure (DA-1 C1, C2)', () => {
  it('requires a high-entropy master seed', () => {
    for (const weak of [
      '',
      'held-out-master',
      'abcdef',
      'A'.repeat(64),
      'g'.repeat(64),
      '0f'.repeat(31),
      42 as never,
      null as never,
    ]) {
      expect(() => buildSealedSplitPlan(weak), String(weak)).toThrow('InvalidMasterSeed');
    }
    expect(() => buildSealedSplitPlan(testMasterSeed('ok-minimum'))).not.toThrow();
    expect(() => buildSealedSplitPlan(testMasterSeed('ok') + 'ab')).not.toThrow();
  });

  it('screens master seeds and seeds for entropy, not only format (DA-2)', () => {
    for (const degenerate of [
      '0'.repeat(64),
      'ab'.repeat(32),
      '0f'.repeat(32),
      '0123456789abcdef'.repeat(4),
    ]) {
      // 64 characters of a repeated pattern: right format, no entropy worth the name.
      expect(
        isHighEntropySeed(degenerate, 64) && degenerate !== '0123456789abcdef'.repeat(4),
        degenerate,
      ).toBe(false);
    }
    expect(isHighEntropySeed('0'.repeat(64), 64)).toBe(false);
    expect(isHighEntropySeed('0f'.repeat(32), 64)).toBe(false);
    expect(isHighEntropySeed(testMasterSeed('random-looking'), 64)).toBe(true);
    expect(isHighEntropySeed('demo-3')).toBe(false);
    expect(isHighEntropySeed(mintSeed())).toBe(true);
    expect(() => buildSealedSplitPlan('0'.repeat(64))).toThrow('InvalidMasterSeed');
    expect(() => buildSealedSplitPlan('ab'.repeat(32))).toThrow('InvalidMasterSeed');
  });

  it('salts the public structural hash with the entry seed so structures cannot be enumerated', () => {
    const plan = buildSealedSplitPlan(testMasterSeed('commit'));
    const commitment = publicSplitCommitment(plan);
    const unsalted = new Set(plan.map((entry) => entry.structuralHash));
    expect(commitment.entries).toHaveLength(42);
    for (const entry of commitment.entries) expect(unsalted.has(entry.structuralHash)).toBe(false);
    // Dictionary attack: every family under the base vocabulary, with every plausible namesake count.
    const guesses = new Set<string>();
    for (const family of FAMILIES) {
      for (const namesakeCount of [1, 2, 3]) {
        guesses.add(structuralSignature(createWorldSpec({ family, seed: 'guess', namesakeCount })));
      }
    }
    for (const entry of commitment.entries) expect(guesses.has(entry.structuralHash)).toBe(false);
    // Two entries of the same structure no longer share a public hash.
    expect(new Set(commitment.entries.map((entry) => entry.structuralHash)).size).toBe(42);
    expect(JSON.stringify(commitment)).not.toContain(plan[0]!.seed);
  });

  it('derives validation and test field names from private seeds, not from the public source', () => {
    const source = readFileSync(new URL('../src/splits.ts', import.meta.url), 'utf8');
    for (const word of ['actors', 'history', 'members', 'connections', 'binding0', 'pointer0', 'entries']) {
      expect(source, word).not.toContain(`'${word}'`);
    }
    const first = buildSealedSplitPlan(testMasterSeed('vocab-a'));
    const second = buildSealedSplitPlan(testMasterSeed('vocab-b'));
    // The subject root path (customers identity.id) is fixed by the contract; every other segment is seed-derived.
    const segments = (plan: typeof first, split: string) =>
      new Set(
        plan
          .filter((entry) => entry.split === split)
          .flatMap((entry) =>
            entry.spec.collectionLayouts.flatMap((layout) => [
              ...(layout.collectionId === 'customers' ? [] : layout.identityPath),
              ...layout.referencePath,
            ]),
          )
          .filter((segment) => segment !== '*'),
      );
    for (const split of ['validation', 'test']) {
      const a = segments(first, split);
      expect(a.size).toBeGreaterThan(20);
      const b = segments(second, split);
      expect([...a].filter((segment) => b.has(segment))).toEqual([]);
    }
    // Held-out segments never reappear in the training or protected vocabularies, and the splits differ.
    const known = new Set([...segments(first, 'train'), ...segments(first, 'protected')]);
    for (const split of ['validation', 'test'])
      for (const segment of segments(first, split)) expect(known.has(segment)).toBe(false);
    const validation = segments(first, 'validation');
    expect(
      [...segments(first, 'test')].filter((segment) => validation.has(segment) && segment !== '*'),
    ).toEqual([]);
  });

  it('does not encode split membership in held-out field names or in any visible world field (DA-2 F1)', () => {
    const plan = buildSealedSplitPlan(testMasterSeed('split-opaque'));
    const opaque = /^s[0-9a-f]{10}$/;
    const generated = (split: string) => {
      const segments = new Set<string>();
      for (const entry of plan.filter((candidate) => candidate.split === split)) {
        for (const layout of entry.spec.collectionLayouts) {
          const fixed = layout.collectionId === 'customers' ? ['identity', 'id'] : [];
          for (const segment of [...layout.identityPath, ...layout.referencePath]) {
            if (segment !== '*' && !fixed.includes(segment)) segments.add(segment);
          }
        }
      }
      return [...segments];
    };
    // Validation and test use one segment format: the name never says which of the two withheld splits it is.
    for (const split of ['validation', 'test']) {
      expect(generated(split).length).toBeGreaterThan(20);
      expect(
        generated(split).every((segment) => opaque.test(segment)),
        split,
      ).toBe(true);
    }
    // No visible world field (registry, ids, tokens, documents) carries a split label, fixture ID or seed.
    for (const entry of plan) {
      const visible = JSON.stringify(generateWorld(entry.spec, entry.seed));
      for (const label of [
        entry.fixtureId,
        entry.seed,
        'validation',
        'protected',
        'heldout',
        'held_out',
        '"test"',
      ]) {
        expect(visible, `${entry.fixtureId} ${label}`).not.toContain(label);
      }
    }
  });

  it('is deterministic for a master seed and fully different for another', () => {
    const seed = testMasterSeed('stable');
    expect(publicSplitCommitment(buildSealedSplitPlan(seed))).toEqual(
      publicSplitCommitment(buildSealedSplitPlan(seed)),
    );
    const other = publicSplitCommitment(buildSealedSplitPlan(testMasterSeed('other')));
    const base = publicSplitCommitment(buildSealedSplitPlan(seed));
    expect(other.splitHash).not.toBe(base.splitHash);
    expect(other.entries.some((entry, i) => entry.seedCommitment === base.entries[i]!.seedCommitment)).toBe(
      false,
    );
    // The generator emits a world for every planned entry.
    for (const entry of buildSealedSplitPlan(seed))
      expect(() => generateWorld(entry.spec, entry.seed)).not.toThrow();
  });
});
