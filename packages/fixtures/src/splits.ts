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
/** The hash of the split builder's own source bytes: part of every split commitment. */
export function splitBuilderHash(): string {
  return fixtureSourceCommitment(
    [
      'splits.ts',
      'recipes.ts',
      'source.ts',
      'types.ts',
      'entropy.ts',
      'derivation.ts',
      '../../contracts/src/index.ts',
    ],
    'split-builder-source',
  );
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
  const payload = { contractVersion: 1 as const, counts, splitBuilderHash: splitBuilderHash(), entries };
  return { ...payload, splitHash: contentHash(payload, 'fixture-splits') };
}

/** Splits the gate runs. The untouched final split (`test`) is not among them. */
export type GateSplitId = Exclude<SplitId, 'test'>;
export interface GatePlanEntry extends Omit<SealedSplitEntry, 'split'> {
  split: GateSplitId;
}
/**
 * What a gate run may hold of a split plan: the entries of the three gated splits in full, and the PUBLIC commitment
 * of the whole plan, final split included. The final split's seeds, specs and structure never reach the gate; its
 * entries exist here only as the commitment rows the plan already published (fixture id, seed commitment, spec hash
 * and a seed-salted structural hash). The commitment is computed once, by the fixture builder at freeze time, and
 * the gate verifies it instead of recomputing it from the plan.
 */
export interface GatePlanView {
  entries: GatePlanEntry[];
  commitment: SplitCommitment;
}
const GATE_SPLITS: readonly string[] = ['train', 'protected', 'validation'];

/** FIXTURE BUILDER, at freeze time: the view of `plan` a gate may hold. Copies; keeps no reference into `plan`. */
export function sealPlanForGate(plan: readonly SealedSplitEntry[]): GatePlanView {
  const commitment = publicSplitCommitment(plan);
  const entries = plan
    .filter((entry) => entry.split !== 'test')
    .map((entry) => structuredClone(entry) as unknown as GatePlanEntry);
  return { entries, commitment: structuredClone(commitment) };
}

/**
 * Re-derives the commitment of a view from the entries it holds and the published rows it carries, and refuses it
 * unless every part agrees: no final-split entry in full, the commitment hash and builder hash are genuine, every held
 * entry matches its published row exactly (spec hash, seed commitment, salted structural hash), no published row is
 * left without an entry (except final-split rows), fixture ids and structural signatures are unique across splits.
 * Returns the commitment hash. Throws a stable code, never a message that echoes content.
 */
export function verifyGatePlanView(view: GatePlanView, expectedSplitHash?: string): string {
  const fail = (code: string): never => {
    throw new Error(code);
  };
  if (!view || !Array.isArray(view.entries) || !view.commitment) fail('GatePlanViewMalformed');
  const { commitment } = view;
  if (commitment.contractVersion !== 1 || commitment.splitBuilderHash !== splitBuilderHash())
    fail('GatePlanViewBuilderMismatch');
  const { splitHash, ...payload } = commitment;
  if (contentHash(payload, 'fixture-splits') !== splitHash) fail('GatePlanViewCommitmentMismatch');
  if (expectedSplitHash !== undefined && splitHash !== expectedSplitHash)
    fail('GatePlanViewCommitmentMismatch');
  const published = new Map(commitment.entries.map((row) => [row.fixtureId, row] as const));
  if (published.size !== commitment.entries.length) fail('GatePlanViewDuplicateFixture');
  const counts: Record<SplitId, number> = { train: 0, protected: 0, validation: 0, test: 0 };
  for (const row of commitment.entries) counts[row.split]++;
  if (SPLIT_IDS.some((id) => counts[id] !== commitment.counts[id])) fail('GatePlanViewCountsMismatch');
  const held = new Set<string>();
  const structures = new Set<string>();
  for (const entry of view.entries) {
    if (!GATE_SPLITS.includes(entry.split as string)) fail('GatePlanViewFinalSplitEntry');
    const row = published.get(entry.fixtureId);
    if (!row || row.split !== entry.split || held.has(entry.fixtureId)) fail('GatePlanViewEntryUnpublished');
    held.add(entry.fixtureId);
    if (
      row!.seedCommitment !== entry.spec.seedCommitment ||
      row!.specHash !== contentHash(entry.spec, 'world-spec') ||
      row!.structuralHash !==
        contentHash(
          { seed: entry.seed, structure: structuralSignature(entry.spec) },
          'fixture-structure-commitment',
        ) ||
      entry.structuralHash !== structuralSignature(entry.spec)
    )
      fail('GatePlanViewEntryForged');
    if (structures.has(row!.structuralHash)) fail('GatePlanViewStructureOverlap');
    structures.add(row!.structuralHash);
  }
  for (const row of commitment.entries) {
    if (row.split !== 'test' && !held.has(row.fixtureId)) fail('GatePlanViewEntryMissing');
    if (row.split === 'test' && structures.has(row.structuralHash)) fail('GatePlanViewStructureOverlap');
  }
  return splitHash;
}
const SPLIT_IDS = ['train', 'protected', 'validation', 'test'] as const;
