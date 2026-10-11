import { contentHash } from '@expunge/contracts';
import type { WorldSpec } from '@expunge/contracts';
import { createWorldSpec } from './recipes.js';
import type { FixtureFamily } from './types.js';
import { fixtureSourceCommitment } from './source.js';
import { isHighEntropySeed } from './entropy.js';

export type SplitId = 'train' | 'protected' | 'validation' | 'test';
export interface SealedSplitEntry {
  fixtureId: string;
  split: SplitId;
  seed: string;
  spec: WorldSpec;
  structuralHash: string;
}
export interface SplitCommitment {
  contractVersion: 1;
  counts: Record<SplitId, number>;
  splitBuilderHash: string;
  entries: Array<{
    fixtureId: string;
    split: SplitId;
    seedCommitment: string;
    specHash: string;
    structuralHash: string;
  }>;
  splitHash: string;
}
export function structuralSignature(spec: WorldSpec): string {
  return contentHash(
    {
      family: spec.family,
      collectionLayouts: spec.collectionLayouts,
      referenceTopology: spec.referenceTopology,
      eligibilityPolicy: spec.eligibilityPolicy,
      faults: spec.faults,
      namesakeCount: spec.unrelatedRecipes.namesakeCount,
    },
    'fixture-structure',
  );
}

/** At least 256 bits of lowercase hex with random-looking spread: a guessable master seed regenerates every held-out seed. */
const MASTER_SEED_MIN_HEX = 64;

/**
 * Segment names for validation and test worlds derive from the entry's private seed alone, in one format for
 * both splits: nothing about a segment says which split its world belongs to, and none is listed in source.
 */
function opaqueSegment(seed: string, role: string): string {
  return `s${contentHash({ seed, role }, 'split-path-segment').slice(0, 10)}`;
}

/**
 * Trusted coordinator-only plan. Final seeds/specs are never evidence supplied to a proposer. The master seed must
 * be a high-entropy secret (>= 256 bits of lowercase hex); every held-out seed, target ID and held-out path name
 * derives from it.
 */
export function buildSealedSplitPlan(masterSeed: string): SealedSplitEntry[] {
  if (!isHighEntropySeed(masterSeed, MASTER_SEED_MIN_HEX)) throw new Error('InvalidMasterSeed');
  const plan: SealedSplitEntry[] = [];
  const families: Record<SplitId, FixtureFamily[]> = {
    train: ['direct_nested', 'alias_two_hop'],
    protected: [
      'direct_nested',
      'alias_two_hop',
      'cycle_namesake',
      'mixed_eligibility',
      'partial_retry',
      'direct_nested',
      'alias_two_hop',
      'mixed_eligibility',
    ],
    validation: [
      'cycle_namesake',
      'mixed_eligibility',
      'partial_retry',
      'shared_array',
      'cycle_namesake',
      'mixed_eligibility',
      'partial_retry',
      'shared_array',
    ],
    test: Array.from(
      { length: 24 },
      (_, i) =>
        (['composed_holdout', 'reverse_reference', 'diamond_alias', 'archive_bridge'] as const)[i % 4]!,
    ),
  };
  for (const split of ['train', 'protected', 'validation', 'test'] as const) {
    families[split].forEach((family, i) => {
      const fixtureId = `${split}-${String(i + 1).padStart(2, '0')}`;
      const seed = contentHash({ masterSeed, split, i }, 'sealed-split-seed');
      const spec = createWorldSpec({ family, seed, namesakeCount: split === 'train' ? 1 : 2 + (i % 2) });
      // New field compositions distinguish validation/test; new IDs alone never do. The names are seed-derived.
      if (split === 'validation' || split === 'test') {
        const segment = (role: string) => opaqueSegment(seed, role);
        for (const layout of spec.collectionLayouts) {
          if (layout.collectionId !== 'customers') {
            layout.identityPath = [
              segment('identity-root'),
              segment('identity-list'),
              '*',
              segment('identity-key'),
            ];
          }
          layout.referencePath = [
            segment('reference-root'),
            segment('reference-list'),
            '*',
            segment('reference-key'),
          ];
        }
      }
      plan.push({ fixtureId, split, seed, spec, structuralHash: structuralSignature(spec) });
    });
  }
  return plan;
}
export function publicSplitCommitment(plan: readonly SealedSplitEntry[]): SplitCommitment {
  const counts: Record<SplitId, number> = { train: 0, protected: 0, validation: 0, test: 0 };
  const entries = plan.map((entry) => {
    counts[entry.split]++;
    return {
      fixtureId: entry.fixtureId,
      split: entry.split,
      seedCommitment: entry.spec.seedCommitment,
      specHash: contentHash(entry.spec, 'world-spec'),
      // Salted by the entry's private seed: the structure of a held-out world cannot be recovered by enumeration.
      structuralHash: contentHash(
        { seed: entry.seed, structure: entry.structuralHash },
        'fixture-structure-commitment',
      ),
    };
  });
  const splitBuilderHash = fixtureSourceCommitment(
    ['splits.ts', 'recipes.ts', 'source.ts', 'types.ts', 'entropy.ts', '../../contracts/src/index.ts'],
    'split-builder-source',
  );
  const payload = { contractVersion: 1 as const, counts, splitBuilderHash, entries };
  return { ...payload, splitHash: contentHash(payload, 'fixture-splits') };
}
