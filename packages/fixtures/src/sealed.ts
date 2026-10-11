/** TRUSTED GENERATOR/GRADER ONLY. Never bundle this module, its seeds or its output into a worker. */
import { randomBytes } from 'node:crypto';
import { contentHash } from '@expunge/contracts';
import type { ScopeKey, WorldSpec } from '@expunge/contracts';
import { generateWorld } from './generator.js';
import { FIXTURE_GENERATOR_HASH, seedCommitment } from './recipes.js';
import { UNKEYED_DERIVATION, type Derivation } from './derivation.js';
import { resolveScopeKey, worldIdFor } from './scope.js';
import type { GenerateOptions } from './generator.js';
import {
  COLLECTION_IDS,
  addressKey,
  type CollectionId,
  type DocumentAddress,
  type ExpectedEffect,
  type FixtureDocument,
  type FixtureManifest,
  type JsonValue,
  type PreservationHash,
  type SealedFixture,
  type WorldCollections,
} from './types.js';
export type { FixtureManifest, PreservationHash, SealedFixture } from './types.js';
export { buildSealedSplitPlan } from './splits.js';
export type { SealedSplitEntry, SplitCommitment, SplitId } from './splits.js';
export { isHighEntropySeed } from './entropy.js';
export {
  DerivationKeyError,
  UNKEYED_DERIVATION,
  assertDerivationKey,
  keyedDerivation,
  mintDerivationKey,
  type Derivation,
} from './derivation.js';
export {
  SHAPE_DETECTORS,
  SHAPE_PRECISION_TOLERANCE,
  documentFingerprint,
  evaluateShapeDetectors,
  shapeLeaks,
  type ShapeDetectorResult,
} from './shape.js';

/** Trusted fixture/observer construction only; never a Hider/worker-supplied authority override. */
/**
 * The seed must never come from the Hider or a caller: every record ID and identity token derives from it, and the
 * world ID that carries it is visible on every document, so a guessable seed lets a worker recompute the targets.
 * The trusted service mints it and binds the spec's commitment to it.
 */
export function mintSeed(): string {
  return randomBytes(32).toString('hex');
}
export function bindMintedSeed(spec: WorldSpec): { spec: WorldSpec; seed: string } {
  const seed = mintSeed();
  return { spec: { ...structuredClone(spec), seedCommitment: seedCommitment(seed) }, seed };
}

export interface TrustedObservationRecipe {
  omitFieldIds: string[];
  limitations: string[];
}
function applyTrustedObservation(world: SealedFixture['world'], observation: TrustedObservationRecipe): void {
  if (
    !Array.isArray(observation.omitFieldIds) ||
    !observation.omitFieldIds.length ||
    !Array.isArray(observation.limitations) ||
    !observation.limitations.length ||
    observation.limitations.some((item) => typeof item !== 'string' || !item.trim()) ||
    new Set(observation.omitFieldIds).size !== observation.omitFieldIds.length
  ) {
    throw new Error('InvalidTrustedObservation');
  }
  const omitted = new Set(observation.omitFieldIds);
  for (const id of omitted) {
    const registered = world.scope.fields.some((field) => field.fieldId === id);
    if (typeof id !== 'string' || !registered || id.startsWith('customers.') || id.endsWith('.record_id')) {
      throw new Error('InvalidTrustedObservationField');
    }
  }
  world.scope.fields = world.scope.fields.filter((field) => !omitted.has(field.fieldId));
  world.scope.referenceEdges = world.scope.referenceEdges.filter(
    (edge) => !omitted.has(edge.fromFieldId) && !omitted.has(edge.toFieldId),
  );
  world.scope.revision++;
  world.scope.discoveryCompleteness = {
    kind: 'partial',
    limitations: [...world.scope.discoveryCompleteness.limitations, ...observation.limitations],
  };
  world.schema.identityFieldIds = world.schema.identityFieldIds.filter((id) => !omitted.has(id));
  world.schema.referenceFieldIds = world.schema.referenceFieldIds.filter((id) => !omitted.has(id));
}

/**
 * Independent intent recipe: no discovery, relationship walk or reference solver participates. Record IDs are
 * namespaced by the world instance, so identical seeds in different scopes never share a collection-wide _id.
 */
function oracleRecordId(
  seed: string,
  collectionId: CollectionId,
  instance: string,
  derivation: Derivation,
): string {
  return `syn_${derivation.recordDigest(seed, collectionId, 'primary', instance)}`;
}
function oracleBindings(
  seed: string,
  spec: WorldSpec,
  instance: string,
  derivation: Derivation,
): Set<string> {
  const suffix = derivation.tokenDigest(seed, spec.identityRecipe.subjectOrdinal, instance);
  return new Set([
    `syn_subject_${suffix}`,
    `synthetic-${suffix}@example.invalid`,
    ...Array.from({ length: spec.identityRecipe.aliasCount }, (_, n) => `syn_alias_${suffix}_${n}`),
    ...COLLECTION_IDS.map((collection) => oracleRecordId(seed, collection, instance, derivation)),
  ]);
}
function oracleEffect(
  collectionId: CollectionId,
  family: string,
): 'delete' | 'redact' | 'restrict' | 'tombstone' {
  if (['mixed_eligibility', 'composed_holdout', 'archive_bridge'].includes(family)) {
    switch (collectionId) {
      case 'customers':
      case 'archives':
        return 'tombstone';
      case 'accounts':
        return 'restrict';
      case 'events':
        return 'delete';
      default:
        return 'redact';
    }
  }
  return ['messages', 'notes'].includes(collectionId) ? 'redact' : 'delete';
}
/** Separate implementation from the executor: grader truth does not run worker effect code. */
function rewriteOracle(value: JsonValue, bindings: Set<string>, eraseValue: null | string): JsonValue {
  if (typeof value === 'string' && bindings.has(value)) return eraseValue;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (let i = 0; i < value.length; i++) result.push(rewriteOracle(value[i]!, bindings, eraseValue));
    return result;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) result[key] = rewriteOracle(value[key]!, bindings, eraseValue);
    return result;
  }
  return value;
}

function carriesBinding(value: JsonValue, bindings: Set<string>): boolean {
  if (typeof value === 'string') return bindings.has(value);
  if (Array.isArray(value)) return value.some((child) => carriesBinding(child, bindings));
  if (value && typeof value === 'object')
    return Object.values(value).some((child) => carriesBinding(child, bindings));
  return false;
}
/**
 * Array elements that carry no subject binding. A targeted effect must leave each of them byte-identical; an
 * effect that deletes the array wholesale or rewrites a neighbour is a preservation violation, not just a residual.
 */
function unrelatedArrayElements(
  value: JsonValue,
  bindings: Set<string>,
  path: string[],
): Array<{ path: string[]; value: JsonValue }> {
  if (Array.isArray(value)) {
    return value.flatMap((element, index) =>
      carriesBinding(element, bindings)
        ? unrelatedArrayElements(element, bindings, [...path, String(index)])
        : [{ path: [...path, String(index)], value: element }],
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      unrelatedArrayElements(child, bindings, [...path, key]),
    );
  }
  return [];
}

/** Hash exactly the fields (and mixed-array neighbours) that an eligible effect must not change. */
function preservationFor(
  address: DocumentAddress,
  initial: FixtureDocument,
  effect: ExpectedEffect['effect'],
  bindings: Set<string>,
): PreservationHash[] {
  const hashes: PreservationHash[] = [];
  const add = (path: string[], value: unknown): void => {
    hashes.push({ address, path, hash: contentHash(value, 'fixture-preserved-value') });
  };
  for (const path of [['data', 'business'], ['data', 'displayName'], ['eligibility']]) {
    let value: unknown = initial;
    for (const part of path) value = (value as Record<string, unknown>)[part];
    add(path, value);
  }
  if (effect === 'restrict') add(['data'], initial.data);
  if (effect === 'redact' || effect === 'tombstone') {
    for (const element of unrelatedArrayElements(initial.data, bindings, ['data']))
      add(element.path, element.value);
  }
  return hashes;
}

/** Poststate of one eligible target under owner policy, built without any executor code. */
function expectedPoststate(
  initial: FixtureDocument,
  effect: ExpectedEffect['effect'],
  bindings: Set<string>,
): FixtureDocument {
  const copy = structuredClone(initial);
  copy._rev = 2;
  if (effect === 'restrict') {
    copy.access = 'restricted';
    return copy;
  }
  const eraseValue = effect === 'redact' ? '[redacted]' : null;
  copy.data = rewriteOracle(copy.data, bindings, eraseValue) as FixtureDocument['data'];
  copy.data.payload = eraseValue;
  if (effect === 'tombstone') copy.lifecycle = 'tombstoned';
  return copy;
}

export function generateSealedFixture(
  spec: WorldSpec,
  seed: string,
  binding?: ScopeKey,
  observation?: TrustedObservationRecipe,
  options: GenerateOptions = {},
): SealedFixture {
  const derivation = options.derivation ?? UNKEYED_DERIVATION;
  // The trusted scope key and instance are resolved here, independently of the generator, then cross-checked.
  const trustedScope = resolveScopeKey(binding);
  const world = generateWorld(spec, seed, binding, options);
  const instance = worldIdFor(contentHash(spec, 'world-spec'), seed, trustedScope, derivation.keyId);
  if (
    world.worldId !== instance ||
    world.scope.tenantId !== trustedScope.tenantId ||
    world.scope.env !== trustedScope.env ||
    world.scope.scopeId !== trustedScope.scopeId
  ) {
    throw new Error('FixtureScopeMismatch');
  }
  if (observation) applyTrustedObservation(world, observation);
  const expectedState = structuredClone(world.collections);
  const bindings = oracleBindings(seed, spec, instance, derivation);
  const effects: ExpectedEffect[] = [];
  const untouchedHashes: FixtureManifest['untouchedHashes'] = [];
  const preservationHashes: PreservationHash[] = [];
  for (const collectionId of COLLECTION_IDS) {
    const recordId = oracleRecordId(seed, collectionId, instance, derivation);
    const expectedEffect = oracleEffect(collectionId, spec.family);
    effects.push({
      address: { collectionId, recordId, recordIdBsonType: 'string' },
      effect: expectedEffect,
      expectedRevision: 1,
    });
    expectedState[collectionId] = [];
    for (const initial of world.collections[collectionId]) {
      const address = { collectionId, recordId: initial._id, recordIdBsonType: 'string' as const };
      if (initial._id !== recordId) {
        untouchedHashes.push({ address, hash: contentHash(initial, 'fixture-document') });
        expectedState[collectionId].push(structuredClone(initial));
        continue;
      }
      if (expectedEffect === 'delete') continue;
      preservationHashes.push(...preservationFor(address, initial, expectedEffect, bindings));
      expectedState[collectionId].push(expectedPoststate(initial, expectedEffect, bindings));
    }
  }
  const payload: Omit<FixtureManifest, 'manifestHash'> = {
    contractVersion: 1,
    worldId: world.worldId,
    specHash: world.specHash,
    seedCommitment: spec.seedCommitment,
    trustedScope,
    scopeRevision: world.scope.revision,
    scopeRegistryHash: contentHash(world.scope, 'fixture-scope-registry'),
    visibleSchemaHash: contentHash(world.schema, 'fixture-visible-schema'),
    subjectHandle: world.subjectHandle,
    generatorHash: FIXTURE_GENERATOR_HASH,
    evaluatorVersion: 'expunge.fixed-oracle.v1',
    initialStateHash: contentHash(world.collections, 'fixture-world-state'),
    expectedStateHash: contentHash(expectedState, 'fixture-world-state'),
    expectedState,
    effects,
    untouchedHashes,
    preservationHashes,
  };
  return { world, manifest: { ...payload, manifestHash: contentHash(payload, 'fixture-manifest') } };
}

export function assertManifestIntegrity(manifest: FixtureManifest): void {
  const { manifestHash, ...payload } = manifest;
  if (
    contentHash(payload, 'fixture-manifest') !== manifestHash ||
    contentHash(manifest.expectedState, 'fixture-world-state') !== manifest.expectedStateHash
  ) {
    throw new Error('ManifestIntegrityError');
  }
  if (
    new Set(manifest.effects.map((effect) => addressKey(effect.address))).size !== manifest.effects.length
  ) {
    throw new Error('ManifestDuplicateTarget');
  }
  for (const collection of COLLECTION_IDS) {
    for (const document of manifest.expectedState[collection]) {
      if (
        document.tenantId !== manifest.trustedScope.tenantId ||
        document.env !== manifest.trustedScope.env ||
        document.worldId !== manifest.worldId
      ) {
        throw new Error('ManifestDocumentBinding');
      }
    }
  }
}

/** Exact BSON string IDs remain strings here; real-domain BSON canonicalization belongs to contracts/mongo. */
export function stateHash(state: WorldCollections): string {
  return contentHash(state, 'fixture-world-state');
}
