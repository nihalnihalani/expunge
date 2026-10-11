import { describe, expect, it } from 'vitest';
import * as visibleExports from '@expunge/fixtures';
import { contentHash } from '@expunge/contracts';
import {
  FAMILIES,
  createWorldSpec,
  generateWorld,
  publicSplitCommitment,
  validateWorldSpec,
} from '@expunge/fixtures';
import {
  assertManifestIntegrity,
  buildSealedSplitPlan,
  generateSealedFixture,
  type SealedFixture,
} from '@expunge/fixtures/sealed';
import {
  gradeWorld,
  publicAdmissionVerdict,
  MIN_AGGREGATE_RUNS,
  aggregateGradeReports,
  publicGradeReport,
  referenceSolve,
  runReference,
} from '../src/index.js';
import { admit } from './helpers.js';

/** TEST-ONLY deterministic master seed for the 42-world split plan (never a campaign secret). */
const MASTER = contentHash({ label: 'canary' }, 'test-master-seed');

/** Every held-out value a visible API must never emit, labelled for the failure message. */
function privateValues(fixture: SealedFixture, seed: string): Map<string, string> {
  const { manifest } = fixture;
  const values = new Map<string, string>();
  values.set('seed', seed);
  values.set('manifestHash', manifest.manifestHash);
  values.set('expectedStateHash', manifest.expectedStateHash);
  values.set('initialStateHash', manifest.initialStateHash);
  values.set('scopeRegistryHash', manifest.scopeRegistryHash);
  values.set('visibleSchemaHash', manifest.visibleSchemaHash);
  manifest.untouchedHashes.forEach((entry, i) => values.set(`untouchedHash#${i}`, entry.hash));
  manifest.preservationHashes.forEach((entry, i) => values.set(`preservationHash#${i}`, entry.hash));
  // The subject root is visible by design (it is the authorized subject); every other target ID is held out.
  for (const effect of manifest.effects) {
    if (effect.address.recordId !== manifest.subjectHandle) {
      values.set(`target:${effect.address.collectionId}`, effect.address.recordId);
    }
  }
  return values;
}
/** Real scan of a serialized output against the private manifest values. */
function leaks(output: unknown, values: Map<string, string>): string[] {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return [...values].filter(([, value]) => text.includes(value)).map(([label]) => label);
}
function thrown(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
  throw new Error('expected the call to throw');
}

describe('hidden-data canary', () => {
  it('the scanner has teeth: planted private values are detected in every serialization it checks', () => {
    const seed = 'canary-positive';
    const fixture = generateSealedFixture(createWorldSpec({ family: 'mixed_eligibility', seed }), seed);
    const values = privateValues(fixture, seed);
    expect(values.size).toBeGreaterThan(20);
    expect(leaks(fixture.manifest, values).length).toBeGreaterThan(20);
    expect(leaks({ note: `see ${fixture.manifest.manifestHash}` }, values)).toEqual(['manifestHash']);
    const targetId = [...values].find(([label]) => label.startsWith('target:'))![1];
    expect(leaks(`failed at ${targetId}`, values)).toHaveLength(1);
    expect(leaks({ seed: `${seed}!` }, values)).toEqual(['seed']);
    expect(leaks({ nothing: 'to see' }, values)).toEqual([]);
    // The full, unredacted admission and grade objects do carry private values: the public views must not.
    const admission = admit(createWorldSpec({ family: 'mixed_eligibility', seed }), seed);
    expect(leaks(admission, values).length).toBeGreaterThan(20);
    const grade = gradeWorld(fixture.manifest, fixture.world, { terminalStatus: 'complete' });
    expect(leaks(grade, values)).toEqual(expect.arrayContaining(['expectedStateHash', 'manifestHash']));
  });

  it('public fixture exports: no sealed API, and nothing private in any visible output', () => {
    const exported = Object.keys(visibleExports);
    for (const sealedOnly of [
      'generateSealedFixture',
      'buildSealedSplitPlan',
      'assertManifestIntegrity',
      'stateHash',
      'evaluateShapeDetectors',
      'shapeLeaks',
      'SHAPE_DETECTORS',
      'documentFingerprint',
    ]) {
      expect(exported, sealedOnly).not.toContain(sealedOnly);
    }
    const constants = Object.fromEntries(
      Object.entries(visibleExports).filter(([, value]) => typeof value !== 'function'),
    );
    for (const family of FAMILIES) {
      const seed = `canary-${family}`;
      const spec = createWorldSpec({ family, seed });
      const fixture = generateSealedFixture(spec, seed);
      const values = privateValues(fixture, seed);
      expect(leaks(constants, values), family).toEqual([]);
      // The visible world, and the spec a Hider may see, carry no manifest value or seed.
      const world = generateWorld(spec, seed);
      expect(world).toEqual(fixture.world);
      const { collections, ...envelope } = world;
      expect(leaks(envelope, values), `${family} registry/schema`).toEqual([]);
      // Held-out target IDs appear in the collections only as ordinary record IDs and reference values.
      const withoutIdentity = JSON.stringify(collections, (key, value) =>
        key === '_id' ? undefined : value,
      );
      const targetLeaks = leaks(
        withoutIdentity,
        new Map([...values].filter(([label]) => !label.startsWith('target:'))),
      );
      expect(targetLeaks, `${family} documents`).toEqual([]);
      expect(leaks(spec, values), `${family} spec`).toEqual([]);
      expect(Object.keys(world)).toEqual([
        'worldId',
        'specHash',
        'scope',
        'subjectHandle',
        'collections',
        'schema',
      ]);
    }
  });

  it('no record carries a per-document target flag: eligibility, revision and access are uniform per collection', () => {
    for (const family of FAMILIES) {
      const seed = `flag-${family}`;
      const world = generateWorld(createWorldSpec({ family, seed }), seed);
      for (const rows of Object.values(world.collections)) {
        const shapes = new Set(
          rows.map((row) => JSON.stringify([row._rev, row.access, row.lifecycle, row.eligibility])),
        );
        expect(shapes.size, family).toBe(1);
      }
    }
  });

  it('publicSplitCommitment: no seed, spec, target ID or manifest value of any of the 42 worlds', () => {
    const plan = buildSealedSplitPlan(MASTER);
    const commitment = publicSplitCommitment(plan);
    const text = JSON.stringify(commitment);
    expect(commitment.entries).toHaveLength(42);
    for (const entry of plan) {
      const values = privateValues(generateSealedFixture(entry.spec, entry.seed), entry.seed);
      values.set('masterSeed', MASTER);
      const hits = leaks(text, values);
      expect(hits, entry.fixtureId).toEqual([]);
      // Held-out field names (derived from the private seed) are not in the public commitment either.
      for (const layout of entry.spec.collectionLayouts) {
        for (const segment of [...layout.identityPath, ...layout.referencePath]) {
          if (/^[vt][0-9a-f]{10}$/.test(segment))
            expect(text, `${entry.fixtureId} ${segment}`).not.toContain(segment);
        }
      }
    }
  });

  it('publicAdmissionVerdict: admitted and quarantined verdicts expose no private value', () => {
    for (const family of FAMILIES) {
      const seed = `verdict-${family}`;
      const spec = createWorldSpec({ family, seed });
      const admission = admit(spec, seed);
      expect(admission.admitted).toBe(true);
      const values = privateValues(generateSealedFixture(spec, seed), seed);
      const verdict = publicAdmissionVerdict(admission);
      expect(Object.keys(verdict).sort()).toEqual([
        'admitted',
        'reasonCodes',
        'referenceResultHash',
        'referenceSolverHash',
        'specHash',
      ]);
      expect(leaks(verdict, values), family).toEqual([]);
      // The result hash is recomputable from public pieces only: it is not a function of any private hash.
      const solved = runReference(generateSealedFixture(spec, seed).world, spec.resourceBounds).world;
      const manifest = generateSealedFixture(spec, seed).manifest;
      const publicReport = publicGradeReport(
        gradeWorld(manifest, solved, { terminalStatus: 'complete' }),
        'train',
      );
      expect(verdict.referenceResultHash).toBe(
        contentHash(
          {
            specHash: verdict.specHash,
            referenceSolverHash: verdict.referenceSolverHash,
            publicReport: publicReport.publicReportHash,
          },
          'reference-admission',
        ),
      );
    }
    const quarantined = [
      {
        ...createWorldSpec({ family: 'archive_bridge', seed: 'q1' }),
        resourceBounds: { maxDocuments: 501, maxReferenceHops: 5 },
      },
      (() => {
        const spec = createWorldSpec({ family: 'archive_bridge', seed: 'q2' });
        spec.resourceBounds.maxReferenceHops = 2;
        spec.referenceTopology.maxHops = 2;
        return spec;
      })(),
    ];
    for (const [index, spec] of quarantined.entries()) {
      const seed = `q${index + 1}`;
      const verdict = publicAdmissionVerdict(admit(spec, seed));
      expect(verdict.admitted).toBe(false);
      expect(verdict.reasonCodes.length).toBeGreaterThan(0);
      expect(verdict.referenceResultHash).toBeNull();
      const values = privateValues(
        generateSealedFixture(
          createWorldSpec({ family: spec.family as (typeof FAMILIES)[number], seed }),
          seed,
        ),
        seed,
      );
      expect(leaks(verdict, values)).toEqual([]);
    }
  });

  it('the public grade report withholds the sealed manifest and poststate hashes and its hash is independent of them', () => {
    const grades = [];
    for (const [family, seed] of [
      ['mixed_eligibility', 'grade-a'],
      ['mixed_eligibility', 'grade-b'],
    ] as const) {
      const fixture = generateSealedFixture(createWorldSpec({ family, seed }), seed);
      const values = privateValues(fixture, seed);
      const solved = runReference(fixture.world).world;
      const worlds = {
        solved,
        untouched: fixture.world,
        blanket: Object.assign(structuredClone(solved), {}),
      };
      for (const id of Object.keys(worlds.blanket.collections) as Array<
        keyof typeof worlds.blanket.collections
      >)
        worlds.blanket.collections[id] = [];
      for (const [name, world] of Object.entries(worlds)) {
        for (const terminalStatus of ['complete', 'incomplete', 'refused'] as const) {
          const full = gradeWorld(fixture.manifest, world, { terminalStatus });
          const view = publicGradeReport(full, 'train');
          expect(Object.keys(view), name).not.toEqual(expect.arrayContaining(['manifestHash']));
          for (const hidden of ['manifestHash', 'actualStateHash', 'expectedStateHash', 'reportHash']) {
            expect(Object.keys(view)).not.toContain(hidden);
          }
          expect(leaks(view, values), `${name}/${terminalStatus}`).toEqual([]);
          expect(JSON.stringify(view)).not.toContain(full.actualStateHash);
          expect(JSON.stringify(view)).not.toContain(full.reportHash);
          grades.push({ seed, name, terminalStatus, view, full });
        }
      }
    }
    // Public hash independence: the same public outcome on two different sealed worlds has the same public hash,
    // while the private hashes differ. So the public hash cannot be used as an offline answer-check oracle.
    const a = grades.find(
      (row) => row.seed === 'grade-a' && row.name === 'solved' && row.terminalStatus === 'complete',
    )!;
    const b = grades.find(
      (row) => row.seed === 'grade-b' && row.name === 'solved' && row.terminalStatus === 'complete',
    )!;
    expect(a.full.manifestHash).not.toBe(b.full.manifestHash);
    expect(a.full.reportHash).not.toBe(b.full.reportHash);
    expect(a.view.publicReportHash).toBe(b.view.publicReportHash);
    // And it is a hash over exactly the public fields.
    const { publicReportHash, ...publicFields } = a.view;
    expect(publicReportHash).toBe(contentHash(publicFields, 'public-grade-report'));
  });

  it('error messages thrown by visible and grader APIs carry codes only: no held-out value', () => {
    const seed = 'canary-errors';
    const spec = createWorldSpec({ family: 'diamond_alias', seed });
    const fixture = generateSealedFixture(spec, seed);
    const values = privateValues(fixture, seed);
    const solved = runReference(fixture.world).world;
    const forgedBinding = { tenantId: '', env: 'dev', scopeId: 'x' };
    const damaged = (mutate: (world: typeof solved) => void) => {
      const world = structuredClone(solved);
      mutate(world);
      return world;
    };
    const messages = [
      thrown(() => generateWorld(spec, 'wrong-seed')),
      thrown(() => generateWorld({ ...spec, expectedAnswer: [] } as typeof spec, seed)),
      thrown(() => generateWorld(spec, seed, forgedBinding as never)),
      thrown(() => generateWorld(null as never, seed)),
      thrown(() => buildSealedSplitPlan(seed)),
      thrown(() =>
        gradeWorld(
          fixture.manifest,
          damaged((w) => void (w.worldId = 'other')),
          { terminalStatus: 'complete' },
        ),
      ),
      thrown(() =>
        gradeWorld(
          fixture.manifest,
          damaged((w) => void (w.scope.tenantId = 'other')),
          { terminalStatus: 'complete' },
        ),
      ),
      thrown(() =>
        gradeWorld(
          fixture.manifest,
          damaged((w) => void (w.subjectHandle = 'other')),
          { terminalStatus: 'complete' },
        ),
      ),
      thrown(() =>
        gradeWorld(
          fixture.manifest,
          damaged((w) => void (w.collections.notes[0]!.tenantId = 'other')),
          { terminalStatus: 'complete' },
        ),
      ),
      thrown(() => gradeWorld(fixture.manifest, solved, { terminalStatus: 'bogus' as never })),
      thrown(() =>
        gradeWorld({ ...fixture.manifest, manifestHash: '0'.repeat(64) }, solved, {
          terminalStatus: 'complete',
        }),
      ),
      thrown(() =>
        assertManifestIntegrity({
          ...fixture.manifest,
          effects: [fixture.manifest.effects[0]!, fixture.manifest.effects[0]!],
        }),
      ),
      thrown(() => referenceSolve(damaged((w) => void (w.collections.customers = [])))),
      thrown(() => referenceSolve(damaged((w) => void (w.collections.notes[0]!.worldId = 'other')))),
    ];
    for (const message of messages) {
      expect(leaks(message, values), message).toEqual([]);
      // Stable error vocabulary: a PascalCase code or a quarantine reason list, never free text with data.
      expect(message).toMatch(
        /^[A-Za-z]*Error: ([A-Z][A-Za-z]+|WorldSpec quarantined: [A-Za-z_:, 0-9]+|InvalidMasterSeed)$/,
      );
    }
    // Reason codes from every quarantine path are likewise opaque identifiers.
    const reasonCodes = [
      ...validateWorldSpec({ ...spec, family: 'nope' } as never, seed),
      ...publicAdmissionVerdict(admit({ ...spec, ['x'.repeat(200)]: 1 } as never, seed)).reasonCodes,
    ];
    for (const code of reasonCodes) expect(code).toMatch(/^[a-z_]+(:[A-Za-z0-9_]{1,32})?$/);
  });

  it('per-world reports leave only for training worlds; withheld splits leave as campaign aggregates (DA-2 F2)', () => {
    const seed = 'aggregate-split';
    const fixture = generateSealedFixture(createWorldSpec({ family: 'mixed_eligibility', seed }), seed);
    const solved = runReference(fixture.world).world;
    const good = gradeWorld(fixture.manifest, solved, { terminalStatus: 'complete' });
    const bad = gradeWorld(fixture.manifest, fixture.world, { terminalStatus: 'complete' });
    expect(() => publicGradeReport(good, 'train')).not.toThrow();
    for (const split of ['protected', 'validation', 'final'] as const) {
      expect(() => publicGradeReport(good, split), split).toThrow('PerWorldReportWithheld');
    }
    // A campaign must be large enough that its totals cannot be read as one world's counts.
    expect(() => aggregateGradeReports([good], 'validation')).toThrow('AggregateTooSmall');
    expect(() => aggregateGradeReports([], 'train')).toThrow('AggregateEmpty');
    const runs = [...Array(MIN_AGGREGATE_RUNS - 2).fill(good), bad, bad];
    const aggregate = aggregateGradeReports(runs, 'validation');
    expect(aggregate).toMatchObject({
      split: 'validation',
      runs: MIN_AGGREGATE_RUNS,
      usefulCompletions: MIN_AGGREGATE_RUNS - 2,
      falseCompletions: 2,
      targetedResiduals: 12,
    });
    // Nothing per world and nothing private: no hash of a world, manifest or poststate, no reason codes.
    const text = JSON.stringify(aggregate);
    const values = privateValues(fixture, seed);
    expect(leaks(aggregate, values)).toEqual([]);
    for (const hidden of [
      'manifestHash',
      'actualStateHash',
      'expectedStateHash',
      'reportHash',
      'reasonCodes',
    ]) {
      expect(text).not.toContain(hidden);
    }
    expect(text).not.toContain(good.reportHash);
  });
});
