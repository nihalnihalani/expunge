import type { EffectKind, Environment, ScopeKey, ScopeRegistry, WorldSpec } from '@expunge/contracts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const COLLECTION_IDS = ['customers', 'accounts', 'messages', 'events', 'notes', 'archives'] as const;
export type CollectionId = (typeof COLLECTION_IDS)[number];
export const FAMILIES = [
  'direct_nested',
  'alias_two_hop',
  'cycle_namesake',
  'mixed_eligibility',
  'partial_retry',
  'composed_holdout',
  'reverse_reference',
  'shared_array',
  'diamond_alias',
  'archive_bridge',
] as const;
export type FixtureFamily = (typeof FAMILIES)[number];

/** Every value is synthetic. No real subject, customer data or credentials are inputs. */
export interface FixtureDocument {
  _id: string;
  tenantId: string;
  env: Environment;
  worldId: string;
  _rev: number;
  data: JsonObject;
  eligibility: { effect: EffectKind; policyId: string };
  access: 'open' | 'restricted';
  lifecycle: 'active' | 'tombstoned';
}
export type WorldCollections = Record<CollectionId, FixtureDocument[]>;
export interface VisibleWorld {
  worldId: string;
  specHash: string;
  scope: ScopeRegistry;
  subjectHandle: string;
  collections: WorldCollections;
  /** Field roles come from schema recipes, never from an oracle's targets. */
  schema: {
    identityFieldIds: string[];
    referenceFieldIds: string[];
    referenceExpansion: 'incoming' | 'outgoing';
    aliasFieldId: string;
    redactPayloadFieldId: string;
  };
}
export interface FixtureOptions {
  family: FixtureFamily;
  seed: string;
  subjectOrdinal?: number;
  aliasCount?: number;
  documentsPerCollection?: number;
  namesakeCount?: number;
  faults?: WorldSpec['faults'];
}
export interface DocumentAddress {
  collectionId: CollectionId;
  recordId: string;
  recordIdBsonType: 'string';
}
export interface ExpectedEffect {
  address: DocumentAddress;
  effect: EffectKind;
  expectedRevision: number;
}
export interface PreservationHash {
  address: DocumentAddress;
  path: string[];
  hash: string;
}

/** Private grader-only data. Do not import this type or ./sealed from a worker image. */
export interface FixtureManifest {
  contractVersion: 1;
  worldId: string;
  specHash: string;
  seedCommitment: string;
  trustedScope: ScopeKey;
  scopeRevision: number;
  scopeRegistryHash: string;
  visibleSchemaHash: string;
  subjectHandle: string;
  generatorHash: string;
  evaluatorVersion: string;
  initialStateHash: string;
  expectedStateHash: string;
  expectedState: WorldCollections;
  effects: ExpectedEffect[];
  untouchedHashes: Array<{ address: DocumentAddress; hash: string }>;
  preservationHashes: PreservationHash[];
  manifestHash: string;
}
export interface SealedFixture {
  world: VisibleWorld;
  manifest: FixtureManifest;
}

/** Quarantine outcome for an unsafe or malformed WorldSpec/binding; carries stable reason codes only. */
export class WorldSpecError extends Error {
  constructor(public readonly reasonCodes: string[]) {
    super(`WorldSpec quarantined: ${reasonCodes.join(', ')}`);
  }
}

export function cloneWorld(world: VisibleWorld): VisibleWorld {
  return structuredClone(world);
}
export function addressKey(address: Pick<DocumentAddress, 'collectionId' | 'recordId'>): string {
  return `${address.collectionId}/${address.recordId}`;
}
