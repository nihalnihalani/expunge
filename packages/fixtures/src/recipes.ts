import { contentHash } from '@expunge/contracts';
import type { EffectKind, WorldSpec } from '@expunge/contracts';
import {
  COLLECTION_IDS,
  FAMILIES,
  type CollectionId,
  type FixtureFamily,
  type FixtureOptions,
} from './types.js';
import { fixtureSourceCommitment } from './source.js';
import { isRecipePath } from './paths.js';

export const FIXTURE_GENERATOR_VERSION = 'expunge.synthetic.generator.v1';
/** Safety envelope enforced by validation and hashed into the generator commitment. */
export const FIXTURE_BOUNDS = { collections: 6, maxDocuments: 500, maxHops: 5 } as const;
const GENERATOR_SOURCES = [
  'generator.ts',
  'entropy.ts',
  'recipes.ts',
  'paths.ts',
  'scope.ts',
  'types.ts',
  'sealed.ts',
  'shape.ts',
  'splits.ts',
  'source.ts',
  '../../contracts/src/index.ts',
];
export const FIXTURE_GENERATOR_HASH = contentHash(
  {
    version: FIXTURE_GENERATOR_VERSION,
    families: FAMILIES,
    sourceHash: fixtureSourceCommitment(GENERATOR_SOURCES, 'fixture-source'),
    safety: { syntheticOnly: true, maxDocuments: 500, maxHops: 5, collections: COLLECTION_IDS },
  },
  'fixture-generator',
);
export const ELIGIBILITY_POLICY_ID = 'synthetic-owner-policy-v1';
export const ELIGIBILITY_POLICY_HASH = contentHash(
  {
    id: ELIGIBILITY_POLICY_ID,
    delete: 'remove-target-only-record',
    redact: 'replace-exact-bindings-and-private-payload',
    restrict: 'preserve-record-and-restrict-access',
    tombstone: 'null-exact-bindings-and-private-payload-preserve-business',
  },
  'eligibility-policy',
);

export function seedCommitment(seed: string): string {
  return contentHash({ seed }, 'fixture-seed');
}
/**
 * Record IDs are unique per world instance. MongoDB `_id` uniqueness is collection-wide, so two worlds built
 * from the same seed in different scopes must not share an ID. `instance` is the world ID, which is itself a
 * deterministic hash of (spec, seed, selected ScopeKey): resetting the same world reproduces the same IDs.
 */
export function seededId(seed: string, collection: CollectionId, role: string, instance: string): string {
  // Opaque on purpose: an ID must not name its collection or role, or a reference value would reveal its kind.
  return `syn_${contentHash({ seed, collection, role, instance }, 'fixture-record').slice(0, 24)}`;
}
/** Subject and alias bindings are translated through the same instance mapping as record IDs. */
export function identityTokens(
  seed: string,
  subjectOrdinal: number,
  aliasCount: number,
  instance: string,
): string[] {
  const token = contentHash({ seed, subjectOrdinal, instance }, 'synthetic-identity').slice(0, 20);
  return [
    `syn_subject_${token}`,
    `synthetic-${token}@example.invalid`,
    ...Array.from({ length: aliasCount }, (_, i) => `syn_alias_${token}_${i}`),
  ];
}
export function effectFor(family: FixtureFamily, collection: CollectionId): EffectKind {
  if (family === 'mixed_eligibility' || family === 'composed_holdout' || family === 'archive_bridge') {
    return (
      {
        customers: 'tombstone',
        accounts: 'restrict',
        messages: 'redact',
        events: 'delete',
        notes: 'redact',
        archives: 'tombstone',
      } as const
    )[collection];
  }
  return collection === 'messages' || collection === 'notes' ? 'redact' : 'delete';
}

export function createWorldSpec(options: FixtureOptions): WorldSpec {
  const nested = options.family !== 'alias_two_hop' && options.family !== 'reverse_reference';
  const heldout = ['composed_holdout', 'archive_bridge', 'diamond_alias', 'shared_array'].includes(
    options.family,
  );
  const layouts = COLLECTION_IDS.map((collectionId, index) => ({
    collectionId,
    identityPath: pickIdentityPath(index, heldout, nested),
    referencePath: heldout
      ? ['lineage', 'links', '*', 'record']
      : nested
        ? ['links', '*', 'recordId']
        : ['linkedRecord'],
    layout:
      index === 0
        ? ('direct' as const)
        : heldout
          ? ('mixed' as const)
          : nested
            ? ('array' as const)
            : ('reference' as const),
  }));
  const retryFaults = { partialAcknowledgements: 2, interruptAfterEffects: 2, transientFailures: 1 };
  const noFaults = { partialAcknowledgements: 0, interruptAfterEffects: null, transientFailures: 0 };
  return {
    contractVersion: 1,
    seedCommitment: seedCommitment(options.seed),
    family: options.family,
    identityRecipe: { subjectOrdinal: options.subjectOrdinal ?? 1, aliasCount: options.aliasCount ?? 2 },
    collectionLayouts: layouts,
    referenceTopology: {
      maxHops: FIXTURE_BOUNDS.maxHops,
      includeCycles: ['cycle_namesake', 'composed_holdout', 'diamond_alias'].includes(options.family),
      duplicateReferences: ['cycle_namesake', 'diamond_alias', 'shared_array'].includes(options.family),
    },
    unrelatedRecipes: {
      documentsPerCollection: options.documentsPerCollection ?? 8,
      namesakeCount: options.namesakeCount ?? 2,
    },
    eligibilityPolicy: {
      id: ELIGIBILITY_POLICY_ID,
      hash: ELIGIBILITY_POLICY_HASH,
      effects: ['delete', 'redact', 'restrict', 'tombstone'],
    },
    faults: options.faults ?? (options.family === 'partial_retry' ? retryFaults : noFaults),
    resourceBounds: { maxDocuments: FIXTURE_BOUNDS.maxDocuments, maxReferenceHops: FIXTURE_BOUNDS.maxHops },
  };
}

function pickIdentityPath(index: number, heldout: boolean, nested: boolean): string[] {
  if (index === 0) return ['identity', 'id'];
  if (heldout) return ['envelope', 'parties', '*', 'principal'];
  return nested && index % 2 ? ['participants', '*', 'subject'] : ['subjectKey'];
}

type PlainObject = Record<string, unknown>;
/** A layout list longer than this is rejected before any per-entry work happens. */
const MAX_LAYOUT_ENTRIES = 64;
function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const SPEC_SECTIONS = [
  'identityRecipe',
  'referenceTopology',
  'unrelatedRecipes',
  'eligibilityPolicy',
  'faults',
  'resourceBounds',
] as const;

/** Structural precondition: every nested section is an object, so the field checks below cannot throw. */
function hasSpecShape(spec: unknown): spec is WorldSpec {
  if (!isPlainObject(spec) || !SPEC_SECTIONS.every((key) => isPlainObject(spec[key]))) return false;
  const { effects } = spec.eligibilityPolicy as PlainObject;
  const layouts = spec.collectionLayouts;
  return (
    Array.isArray(effects) &&
    effects.every((effect) => typeof effect === 'string') &&
    Array.isArray(layouts) &&
    layouts.length <= MAX_LAYOUT_ENTRIES &&
    layouts.every((layout) => isPlainObject(layout))
  );
}

const SPEC_KEYS = [
  'contractVersion',
  'seedCommitment',
  'family',
  'identityRecipe',
  'collectionLayouts',
  'referenceTopology',
  'unrelatedRecipes',
  'eligibilityPolicy',
  'faults',
  'resourceBounds',
];
function reportUnknownKeys(
  object: object,
  allowed: readonly string[],
  label: string,
  problems: string[],
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) problems.push(`unknown_${label}_key:${key.slice(0, 32)}`);
  }
}
function boundedInteger(value: unknown, low: number, high: number, name: string, problems: string[]): void {
  if (!Number.isInteger(value) || (value as number) < low || (value as number) > high) problems.push(name);
}

function validateLayouts(spec: WorldSpec, problems: string[]): void {
  const collectionIds = spec.collectionLayouts.map((layout) => layout.collectionId);
  if (
    collectionIds.length !== FIXTURE_BOUNDS.collections ||
    new Set(collectionIds).size !== FIXTURE_BOUNDS.collections
  ) {
    problems.push('six_unique_collections');
  }
  for (const layout of spec.collectionLayouts) {
    reportUnknownKeys(
      layout,
      ['collectionId', 'identityPath', 'referencePath', 'layout'],
      'layout',
      problems,
    );
    if (!(COLLECTION_IDS as readonly string[]).includes(layout.collectionId)) problems.push('collection_id');
    if (!['direct', 'nested', 'array', 'reference', 'mixed'].includes(layout.layout))
      problems.push('layout_kind');
    const isSubjectRoot =
      isRecipePath(layout.identityPath) && layout.identityPath.join('.') === 'identity.id';
    if (layout.collectionId === 'customers' && !isSubjectRoot) problems.push('subject_root_path');
    for (const path of [layout.identityPath, layout.referencePath]) {
      if (!isRecipePath(path)) {
        problems.push('unsafe_path');
        continue;
      }
      const reserved = ['business', 'payload', 'displayName', 'identity', 'aliases'].includes(path[0]!);
      if (reserved && !(layout.collectionId === 'customers' && path.join('.') === 'identity.id')) {
        problems.push('reserved_path');
      }
    }
    if (isRecipePath(layout.identityPath) && isRecipePath(layout.referencePath)) {
      const left = layout.identityPath.filter((part) => part !== '*').join('.');
      const right = layout.referencePath.filter((part) => part !== '*').join('.');
      if (left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`)) {
        problems.push('overlapping_paths');
      }
    }
  }
}

/**
 * Hider input is data only. Unknown keys, hidden answers and arbitrary programs are rejected with stable reason
 * codes. This function never throws on malformed input: a non-object spec returns `malformed_spec`.
 */
export function validateWorldSpec(spec: WorldSpec, seed: string): string[] {
  if (!hasSpecShape(spec) || typeof seed !== 'string') return ['malformed_spec'];
  const problems: string[] = [];
  reportUnknownKeys(spec, SPEC_KEYS, 'spec', problems);
  reportUnknownKeys(spec.identityRecipe, ['subjectOrdinal', 'aliasCount'], 'identity', problems);
  reportUnknownKeys(
    spec.referenceTopology,
    ['maxHops', 'includeCycles', 'duplicateReferences'],
    'topology',
    problems,
  );
  reportUnknownKeys(
    spec.unrelatedRecipes,
    ['documentsPerCollection', 'namesakeCount'],
    'unrelated',
    problems,
  );
  reportUnknownKeys(spec.eligibilityPolicy, ['id', 'hash', 'effects'], 'eligibility', problems);
  reportUnknownKeys(
    spec.faults,
    ['partialAcknowledgements', 'interruptAfterEffects', 'transientFailures'],
    'faults',
    problems,
  );
  reportUnknownKeys(spec.resourceBounds, ['maxDocuments', 'maxReferenceHops'], 'resources', problems);

  if (spec.contractVersion !== 1) problems.push('contract_version');
  if (!(FAMILIES as readonly string[]).includes(spec.family)) problems.push('unknown_family');
  if (spec.seedCommitment !== seedCommitment(seed)) problems.push('seed_commitment');
  const policy = spec.eligibilityPolicy;
  if (policy.id !== ELIGIBILITY_POLICY_ID || policy.hash !== ELIGIBILITY_POLICY_HASH)
    problems.push('eligibility_policy');
  if (policy.effects.join(',') !== 'delete,redact,restrict,tombstone') problems.push('eligibility_effects');

  boundedInteger(spec.identityRecipe.subjectOrdinal, 0, 100_000, 'subject_ordinal', problems);
  boundedInteger(spec.identityRecipe.aliasCount, 1, 6, 'alias_count', problems);
  boundedInteger(spec.unrelatedRecipes.documentsPerCollection, 4, 83, 'documents_per_collection', problems);
  boundedInteger(spec.unrelatedRecipes.namesakeCount, 1, 3, 'namesake_count', problems);
  boundedInteger(
    spec.resourceBounds.maxDocuments,
    24,
    FIXTURE_BOUNDS.maxDocuments,
    'document_bound',
    problems,
  );
  boundedInteger(spec.resourceBounds.maxReferenceHops, 2, FIXTURE_BOUNDS.maxHops, 'hop_bound', problems);
  const hopCeiling = Number.isInteger(spec.resourceBounds.maxReferenceHops)
    ? spec.resourceBounds.maxReferenceHops
    : 2;
  boundedInteger(spec.referenceTopology.maxHops, 2, hopCeiling, 'topology_hops', problems);
  const { includeCycles, duplicateReferences } = spec.referenceTopology;
  if (typeof includeCycles !== 'boolean' || typeof duplicateReferences !== 'boolean')
    problems.push('topology_boolean');
  boundedInteger(spec.faults.partialAcknowledgements, 0, 6, 'partial_ack_bound', problems);
  boundedInteger(spec.faults.transientFailures, 0, 6, 'transient_fault_bound', problems);
  if (spec.faults.interruptAfterEffects !== null) {
    boundedInteger(spec.faults.interruptAfterEffects, 1, 6, 'interrupt_bound', problems);
  }
  if (
    spec.unrelatedRecipes.documentsPerCollection * FIXTURE_BOUNDS.collections >
    spec.resourceBounds.maxDocuments
  ) {
    problems.push('too_many_documents');
  }
  validateLayouts(spec, problems);
  return [...new Set(problems)];
}
