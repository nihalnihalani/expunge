import { describe, expect, it } from 'vitest';
import {
  COLLECTION_IDS,
  FAMILIES,
  FIXTURE_BOUNDS,
  createWorldSpec,
  generateWorld,
  type VisibleWorld,
} from '@expunge/fixtures';
import { bindMintedSeed, buildSealedSplitPlan, mintSeed } from '@expunge/fixtures/sealed';
import { contentHash } from '@expunge/contracts';
import { admitWorld, publicAdmissionVerdict, referenceSolve } from '../src/index.js';
import { admit } from './helpers.js';

const total = (world: VisibleWorld) =>
  Object.values(world.collections).reduce((sum, rows) => sum + rows.length, 0);

describe('fixture bounds at admission: six collections, 500 documents, five reference hops', () => {
  it('every family and every split world stays inside the bounds and is solved within five hops', () => {
    const specs = [
      ...FAMILIES.flatMap((family) =>
        [4, 8, 83].map((documentsPerCollection) => ({
          label: `${family}/${documentsPerCollection}`,
          seed: `bounds-${family}-${documentsPerCollection}`,
          spec: createWorldSpec({
            family,
            seed: `bounds-${family}-${documentsPerCollection}`,
            documentsPerCollection,
          }),
        })),
      ),
      ...buildSealedSplitPlan(contentHash({ label: 'bounds' }, 'test-master-seed')).map((entry) => ({
        label: entry.fixtureId,
        seed: entry.seed,
        spec: entry.spec,
      })),
    ];
    let deepest = 0;
    for (const { label, seed, spec } of specs) {
      const world = generateWorld(spec, seed);
      expect(Object.keys(world.collections), label).toEqual([...COLLECTION_IDS]);
      expect(total(world), label).toBeLessThanOrEqual(FIXTURE_BOUNDS.maxDocuments);
      const plan = referenceSolve(world, spec.resourceBounds);
      expect(plan.traversalDepth, label).toBeLessThanOrEqual(FIXTURE_BOUNDS.maxHops);
      expect(plan.scannedDocuments, label).toBe(total(world));
      deepest = Math.max(deepest, plan.traversalDepth);
      const admission = admit(spec, seed);
      expect(
        admission.admitted,
        `${label} ${JSON.stringify(publicAdmissionVerdict(admission).reasonCodes)}`,
      ).toBe(true);
    }
    // The longest chain actually reaches the stated bound, so the bound is exercised rather than vacuous.
    expect(deepest).toBe(FIXTURE_BOUNDS.maxHops);
  });

  it('quarantines a spec that exceeds a bound with reason codes, never a crash', () => {
    const seed = 'admission-bounds';
    const clean = createWorldSpec({ family: 'diamond_alias', seed });
    const cases: Array<[string, (spec: typeof clean) => void, string]> = [
      [
        'documents per collection',
        (s) => void (s.unrelatedRecipes.documentsPerCollection = 84),
        'documents_per_collection',
      ],
      ['document bound', (s) => void (s.resourceBounds.maxDocuments = 501), 'document_bound'],
      ['plan above the bound', (s) => void (s.resourceBounds.maxDocuments = 40), 'too_many_documents'],
      ['hop bound', (s) => void (s.resourceBounds.maxReferenceHops = 6), 'hop_bound'],
      ['topology hops', (s) => void (s.referenceTopology.maxHops = 6), 'topology_hops'],
      [
        'seventh collection',
        (s) => void s.collectionLayouts.push({ ...s.collectionLayouts[0]! }),
        'six_unique_collections',
      ],
      [
        'unknown collection',
        (s) => void (s.collectionLayouts[3]!.collectionId = 'ledger' as never),
        'collection_id',
      ],
      ['unsafe path', (s) => void (s.collectionLayouts[2]!.identityPath = ['$where']), 'unsafe_path'],
      [
        'answer injection',
        (s) => void Object.assign(s, { expectedAnswer: [] }),
        'unknown_spec_key:expectedAnswer',
      ],
    ];
    for (const [name, mutate, code] of cases) {
      const spec = structuredClone(clean);
      mutate(spec);
      const admission = admit(spec, seed);
      expect(admission.admitted, name).toBe(false);
      const verdict = publicAdmissionVerdict(admission);
      expect(verdict.reasonCodes, name).toContain(code);
      expect(verdict.reasonCodes, name).not.toContain('internal_error');
      expect(verdict.referenceResultHash).toBeNull();
    }
    // Reference-depth quarantine: a chain that needs more hops than the declared bound is not solvable.
    const shallow = createWorldSpec({ family: 'archive_bridge', seed });
    shallow.resourceBounds.maxReferenceHops = 2;
    shallow.referenceTopology.maxHops = 2;
    expect(publicAdmissionVerdict(admit(shallow, seed)).reasonCodes).toContain('reference_not_solvable');
  });

  it('structural garbage and hostile objects quarantine without an internal error', () => {
    const seed = 'admission-garbage';
    const clean = createWorldSpec({ family: 'shared_array', seed });
    const hostile = structuredClone(clean);
    Object.defineProperty(hostile, 'family', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const garbage: unknown[] = [
      null,
      undefined,
      7,
      'spec',
      [],
      {},
      { contractVersion: 1 },
      { ...clean, faults: null },
      hostile,
    ];
    for (const spec of garbage) {
      const verdict = publicAdmissionVerdict(admit(spec as typeof clean, seed));
      expect(verdict.admitted).toBe(false);
      expect(verdict.reasonCodes.length).toBeGreaterThan(0);
      expect(verdict.reasonCodes).not.toContain('internal_error');
      for (const code of verdict.reasonCodes) expect(code).toMatch(/^[A-Za-z][A-Za-z0-9_:]{0,63}$/);
    }
  });

  it('a binding that is not a trusted ScopeKey is quarantined, a valid one is admitted', () => {
    const seed = 'admission-binding';
    const spec = createWorldSpec({ family: 'mixed_eligibility', seed });
    expect(
      publicAdmissionVerdict(admit(spec, seed, { tenantId: '', env: 'dev', scopeId: 's' })).reasonCodes,
    ).toEqual(['trusted_scope_binding']);
    expect(admit(spec, seed, { tenantId: 'tenant-a', env: 'demo', scopeId: 'scope-a' }).admitted).toBe(true);
  });

  it('refuses a guessable seed: admission needs a seed minted by the trusted service (DA-2)', () => {
    const spec = createWorldSpec({ family: 'diamond_alias', seed: 'demo-3' });
    for (const weak of ['demo-3', 'seed-1', '0'.repeat(32), 'ab'.repeat(16), 'abcdef0123456789']) {
      const verdict = publicAdmissionVerdict(admitWorld(spec, weak));
      expect(verdict).toMatchObject({
        admitted: false,
        reasonCodes: ['weak_seed'],
        referenceResultHash: null,
      });
    }
    // The explicit test-only flag still admits it, and the verdict never reveals the seed either way.
    expect(admit(spec, 'demo-3').admitted).toBe(true);
    // A minted seed is admitted by default: the trusted service, not the caller or Hider, supplies the seed.
    const minted = bindMintedSeed(createWorldSpec({ family: 'diamond_alias', seed: 'ignored-by-the-hider' }));
    expect(minted.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.spec.seedCommitment).not.toBe(spec.seedCommitment);
    const admission = admitWorld(minted.spec, minted.seed);
    expect(admission.admitted).toBe(true);
    expect(new Set([mintSeed(), mintSeed(), mintSeed()]).size).toBe(3);
    // A Hider-supplied commitment for a seed the trusted service does not hold cannot be admitted.
    expect(admitWorld(spec, minted.seed).admitted).toBe(false);
  });
});
