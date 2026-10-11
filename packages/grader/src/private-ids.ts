// The grader's salted set of the private identifiers of one world instance, for the observer's leak guard and for the
// wrong-incident control's disjointness. The set holds hashes only; the salt is random per instance and stored with the
// instance's private rows, never with the worker's. Hashing is `privateIdHash` from contracts (NFKC, domain-separated).
import { randomBytes } from 'node:crypto';
import { privateIdHash } from '@expunge/contracts';
import { valuesAtPath, type VisibleWorld } from '@expunge/fixtures';
import type { FixtureManifest } from '@expunge/fixtures/sealed';

export interface PrivateIdSet {
  salt: string;
  /** Sorted, deduplicated hex digests. */
  hashes: string[];
}

/** A fresh 16-byte salt, hex. One per world instance. */
export function mintPrivateIdSalt(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Every identifier by which the instance's hidden truth could be named: the record ID of each document in the world and
 * in the manifest (targets, decoys, preserved and untouched records), each identity-token value in the identity fields,
 * and the world and subject handles. Values shorter than 4 characters are left out: they would match ordinary text.
 */
export function privateIdSetOf(manifest: FixtureManifest, world: VisibleWorld, salt: string): PrivateIdSet {
  if (typeof salt !== 'string' || salt.length < 16) throw new Error('InvalidPrivateIdSalt');
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length >= 4) ids.add(value);
  };
  add(manifest.worldId);
  add(world.worldId);
  add(manifest.subjectHandle);
  add(world.subjectHandle);
  for (const address of [
    ...manifest.effects.map((effect) => effect.address),
    ...manifest.untouchedHashes.map((entry) => entry.address),
    ...manifest.preservationHashes.map((entry) => entry.address),
  ])
    add(address.recordId);
  for (const collectionId of Object.keys(world.collections) as Array<keyof typeof world.collections>)
    for (const document of world.collections[collectionId]) add(document._id);
  for (const collection of Object.values(manifest.expectedState))
    for (const document of collection) add(document._id);
  const identityFields = world.scope.fields.filter((field) =>
    world.schema.identityFieldIds.includes(field.fieldId),
  );
  for (const field of identityFields)
    for (const document of world.collections[field.collectionId as keyof typeof world.collections] ?? [])
      for (const found of valuesAtPath(document, field.path)) add(found.value);
  return { salt, hashes: [...new Set([...ids].map((id) => privateIdHash(salt, id)))].sort() };
}
