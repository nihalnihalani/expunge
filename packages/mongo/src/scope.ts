import type { ClientSession, Decimal128, Document, Long, ObjectId } from 'mongodb';
import {
  FIELD_PATH_WILDCARD,
  contentHash,
  isRecordKeyPath,
  isRegistryFieldPath,
  parseFieldPath,
  type DomainAddress,
  type FieldDescriptor,
  type ScopeKey,
  type ScopeRegistry,
} from '@expunge/contracts';
import { addressId, bsonPreimageHash, typedAddress } from './hashes.js';
import { assertWorldKey, type WorldKey } from './worldkey.js';
import {
  fail,
  requirePrincipal,
  scopeFilter,
  worldFilter,
  type MongoService,
  type Principal,
  type RuntimeDocument,
} from './client.js';

/**
 * Field path compilation.
 *
 * A registered field path is a typed segment list (see `isFieldPath` in `@expunge/contracts`). The literal `*`
 * means "every element of the array at this position". Reads and writes compile separately:
 *
 * - Read: MongoDB already matches any array element through a dotted path, so `*` is dropped.
 * - Write: dropping `*` would make `$set`/`$unset` replace or delete the whole array, so a wildcard path
 *   compiles to a filtered positional `$set` or an element-level `$pull` and never names the bare array.
 */

const MAX_STRING_VALUE_LENGTH = 4096;
const ARRAY_FILTER_IDENTIFIER = 'target';
const BSON_SCALAR_TAGS = new Set(['ObjectId', 'Long', 'Int32', 'Double', 'Decimal128', 'Timestamp']);

/** A value that is compared by equality or written verbatim. Never an object holding query operators. */
export type ScalarValue = string | number | boolean | null | Date | ObjectId | Long | Decimal128;
export type FieldMutation =
  /** Replace the matched value (redact with a placeholder, tombstone with `null`). */
  | { kind: 'replace'; replacement: ScalarValue }
  /** Remove the matched array element, or unset the matched non-array field. */
  | { kind: 'remove' };
export type WritePlan = {
  /** Generated predicate. The repository ANDs it with the trusted tenant/env/world/record binding. */
  filter: Document;
  update: Document;
  arrayFilters?: Document[];
  /** Index of the wildcard segment in the registered path, or null for a plain path. */
  wildcardIndex: number | null;
};
export type WritePlanInput = {
  /** The exact value that identifies the subject inside the field. */
  match: ScalarValue;
  mutation: FieldMutation;
  /** Optimistic document version; when set, only a record at this `_rev` is written. */
  expectedRev?: number;
  /**
   * Name of the array filter identifier for a wildcard path. Distinct identifiers let several fields be written
   * by one update (`mergeWritePlans`). Lowercase letter first, then letters and digits.
   */
  arrayIdentifier?: string;
  /** Whether the plan increments `_rev`. Default true; a merged update increments once. */
  advanceRevision?: boolean;
};
export type FieldWriteResult = { matched: number; modified: number };
export type ScannedRecord = { address: DomainAddress; document: RuntimeDocument };
export type RecordEffect =
  | { kind: 'delete'; expectedRev: number }
  | { kind: 'restrict'; expectedRev: number }
  | {
      kind: 'redact' | 'tombstone';
      expectedRev: number;
      replacement: string | null;
      writes: Array<{ fieldId: string; match: ScalarValue }>;
    };
const WORLD_READERS: Principal[] = ['domain_executor', 'grader', 'promoter', 'fixture_builder', 'setup'];

function describeScalar(value: unknown, allowNull: boolean): ScalarValue {
  if (value === null) {
    if (allowNull) return null;
    fail('UnsafeMatchValue');
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_VALUE_LENGTH) fail('UnsafeMatchValue');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('UnsafeMatchValue');
    return value;
  }
  if (value instanceof Date) return value;
  const tag =
    typeof value === 'object' && value !== null ? (value as { _bsontype?: unknown })._bsontype : null;
  if (typeof tag === 'string' && BSON_SCALAR_TAGS.has(tag)) return value as ScalarValue;
  // Plain objects and arrays could smuggle query operators such as {$ne: null} into an equality match.
  return fail('UnsafeMatchValue');
}

/**
 * Dotted MongoDB path for reads. `*` is dropped because dotted paths already traverse arrays. Accepts the
 * read-only record key `_id` and any path inside the `data` subtree; envelope fields are rejected.
 */
export function compileReadPath(field: Pick<FieldDescriptor, 'path'>): string {
  const path: unknown = field.path;
  if (!isRegistryFieldPath(path)) fail('UnsafeFieldPath');
  if (isRecordKeyPath(path)) return path[0]!;
  return parseFieldPath(path)
    .segments.filter((segment) => segment !== FIELD_PATH_WILDCARD)
    .join('.');
}
/** Dotted path of a business field. Unlike `compileReadPath` it refuses the record key. */
export function compileFieldPath(field: Pick<FieldDescriptor, 'path'>): string {
  if (isRecordKeyPath(field.path)) fail('UnsafeFieldPath');
  return compileReadPath(field);
}

/** Equality predicate for locating records whose field holds `value` in any array element. */
export function compileReadFilter(field: Pick<FieldDescriptor, 'path'>, value: ScalarValue): Document {
  return { [compileReadPath(field)]: describeScalar(value, false) };
}

/** A registered field declares an array exactly when its path carries the `*` wildcard. */
export function assertDeclaredArrayShape(field: Pick<FieldDescriptor, 'path' | 'isArray'>): void {
  const declaresWildcard = Array.isArray(field.path) && field.path.includes(FIELD_PATH_WILDCARD);
  if (typeof field.isArray !== 'boolean' || field.isArray !== declaresWildcard) fail('InvalidFieldRegistry');
}

/** Equality on `match` that never matches when the stored value is itself an array. */
const exactlyScalar = (match: ScalarValue): Document => ({ $eq: match, $not: { $type: 'array' } });

/**
 * Compiles a targeted write for one registered field and one exact subject value.
 *
 * - No wildcard: `$set` or `$unset` of the dotted path, guarded so it only fires when the stored value equals
 *   `match` and is not an array.
 * - Wildcard, replace: `$set` of `array.$[target].tail` with an `arrayFilters` entry on the exact value, so
 *   other elements (and other fields of the same element) keep their original bytes.
 * - Wildcard, remove: `$pull` of the matching element only.
 *
 * Every plan also advances the record's `_rev`. The record key `_id` is never writable, and the field must be
 * declared consistently (`isArray` exactly when the path has `*`).
 */
export function compileWritePlan(field: FieldDescriptor, input: WritePlanInput): WritePlan {
  if (!field.sanitized) fail('UnregisteredField');
  const path: unknown = field.path;
  if (!isRegistryFieldPath(path) || isRecordKeyPath(path)) fail('UnsafeFieldPath');
  assertDeclaredArrayShape(field);
  const { segments, wildcardIndex } = parseFieldPath(path);
  const match = describeScalar(input.match, false);
  const mutation = input.mutation;
  if (mutation.kind !== 'replace' && mutation.kind !== 'remove') fail('UnsafeMutation');
  const replacement = mutation.kind === 'replace' ? describeScalar(mutation.replacement, true) : null;
  if (input.expectedRev !== undefined && (!Number.isSafeInteger(input.expectedRev) || input.expectedRev < 0))
    fail('InvalidExpectedRevision');
  const revision = input.expectedRev === undefined ? {} : { _rev: input.expectedRev };
  const advance = input.advanceRevision === false ? {} : { $inc: { _rev: 1 } };
  const identifier = input.arrayIdentifier ?? ARRAY_FILTER_IDENTIFIER;
  if (!/^[a-z][A-Za-z0-9]{0,15}$/.test(identifier)) fail('InvalidArrayIdentifier');

  if (wildcardIndex === null) {
    const dotted = segments.join('.');
    return {
      filter: { [dotted]: exactlyScalar(match), ...revision },
      update:
        mutation.kind === 'replace'
          ? { $set: { [dotted]: replacement }, ...advance }
          : { $unset: { [dotted]: '' }, ...advance },
      wildcardIndex,
    };
  }
  const filter = { [compileReadPath(field)]: match, ...revision };
  const arrayPath = segments.slice(0, wildcardIndex).join('.');
  const tail = segments.slice(wildcardIndex + 1).join('.');
  if (mutation.kind === 'remove') {
    const condition = tail ? { [tail]: exactlyScalar(match) } : exactlyScalar(match);
    return { filter, update: { $pull: { [arrayPath]: condition }, ...advance }, wildcardIndex };
  }
  const element = `${arrayPath}.$[${identifier}]${tail ? `.${tail}` : ''}`;
  const arrayFilterKey = tail ? `${identifier}.${tail}` : identifier;
  return {
    filter,
    update: { $set: { [element]: replacement }, ...advance },
    arrayFilters: [{ [arrayFilterKey]: exactlyScalar(match) }],
    wildcardIndex,
  };
}

type Walk = { found: boolean; value: unknown };
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** Follows `segments` through plain objects only. An array on the way is an undeclared traversal. */
function walkDeclared(root: unknown, segments: readonly string[]): Walk {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(cursor)) fail('UndeclaredArrayTraversal');
    if (!isPlainObject(cursor) || !(segment in cursor)) return { found: false, value: undefined };
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}
/**
 * Checks a stored document against the shape a registered field declares, before any write:
 * a plain path must not cross or end on an array, and a wildcard path must hold an array at the `*` whose
 * elements neither contain nested arrays on the tail nor end on one.
 */
export function assertStoredShape(document: unknown, field: Pick<FieldDescriptor, 'path'>): void {
  const { segments, wildcardIndex } = parseFieldPath(field.path);
  if (wildcardIndex === null) {
    const leaf = walkDeclared(document, segments);
    if (leaf.found && Array.isArray(leaf.value)) fail('ScalarWriteOnArray');
    return;
  }
  const container = walkDeclared(document, segments.slice(0, wildcardIndex));
  if (!container.found || container.value === null || container.value === undefined) return;
  if (!Array.isArray(container.value)) fail('ExpectedArray');
  const tail = segments.slice(wildcardIndex + 1);
  for (const element of container.value) {
    if (tail.length === 0) {
      if (Array.isArray(element)) fail('ScalarWriteOnArray');
      continue;
    }
    const leaf = walkDeclared(element, tail);
    if (leaf.found && Array.isArray(leaf.value)) fail('ScalarWriteOnArray');
  }
}

export class ScopeRepository {
  constructor(readonly service: MongoService) {}

  async read(key: ScopeKey, revision: number, session?: ClientSession): Promise<ScopeRegistry> {
    const row = await this.service.world
      .collection<ScopeRegistry & { _id: string }>('schema_registry')
      .findOne({ ...scopeFilter(key), revision }, { session });
    if (!row) fail('ScopeNotFound');
    const { _id: _ignored, ...registry } = row;
    return registry;
  }

  async insert(registry: ScopeRegistry, session?: ClientSession): Promise<void> {
    // The worker principal must never be able to widen its own registry.
    requirePrincipal(this.service, ['fixture_builder', 'setup']);
    if (
      !Number.isSafeInteger(registry.revision) ||
      registry.revision < 1 ||
      registry.collectionIds.length > 16
    )
      fail('InvalidScope');
    const ids = new Set<string>();
    for (const field of registry.fields) {
      if (ids.has(field.fieldId) || !registry.collectionIds.includes(field.collectionId) || !field.sanitized)
        fail('InvalidFieldRegistry');
      ids.add(field.fieldId);
      compileReadPath(field);
      assertDeclaredArrayShape(field);
    }
    for (const edge of registry.referenceEdges) {
      if (!ids.has(edge.fromFieldId) || !ids.has(edge.toFieldId)) fail('InvalidReferenceRegistry');
    }
    const _id = contentHash({ ...scopeFilter(registry), revision: registry.revision }, 'scope-revision');
    await this.service.world
      .collection<ScopeRegistry & { _id: string }>('schema_registry')
      .insertOne({ _id, ...registry }, { session });
  }

  field(registry: ScopeRegistry, fieldId: string): FieldDescriptor {
    const field = registry.fields.find((f) => f.fieldId === fieldId);
    if (!field) fail('UnknownFieldId');
    return field;
  }

  /** Records of one registered collection whose registered field currently holds `value`. Bounded. */
  async findByField(
    world: WorldKey,
    registry: ScopeRegistry,
    fieldId: string,
    value: ScalarValue,
    limit = 100,
    session?: ClientSession,
  ): Promise<DomainAddress[]> {
    requirePrincipal(this.service, WORLD_READERS);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('InvalidScanLimit');
    const field = this.boundField(world, registry, fieldId);
    const rows = await this.service.world
      .collection<RuntimeDocument>(field.collectionId)
      .find(worldFilter(world, world.worldId, compileReadFilter(field, value)), {
        session,
        projection: { _id: 1 },
        limit,
        sort: { _id: 1 },
        promoteValues: false,
        promoteLongs: false,
      })
      .toArray();
    return rows.map((row) => typedAddress(field.collectionId, row._id));
  }

  /**
   * One page of records of a registered collection in `_id` order, with the envelope and the `data` subtree
   * the registry describes. `afterId` continues from the last record of the previous page. Bounded.
   */
  async scan(
    world: WorldKey,
    registry: ScopeRegistry,
    collectionId: string,
    options: { afterId?: unknown; limit?: number } = {},
    session?: ClientSession,
  ): Promise<ScannedRecord[]> {
    requirePrincipal(this.service, WORLD_READERS);
    assertWorldKey(world);
    if (!this.sameScopeAs(world, registry) || !registry.collectionIds.includes(collectionId))
      fail('UnauthorizedCollection');
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('InvalidScanLimit');
    const after = options.afterId === undefined ? {} : { _id: { $gt: options.afterId } };
    const rows = await this.service.world
      .collection<RuntimeDocument>(collectionId)
      .find(worldFilter(world, world.worldId, after), { session, sort: { _id: 1 }, limit })
      .toArray();
    return rows.map((document) => ({ address: typedAddress(collectionId, document._id), document }));
  }

  /** One record by address, or null. */
  async readRecord(
    world: WorldKey,
    registry: ScopeRegistry,
    address: DomainAddress,
    session?: ClientSession,
  ): Promise<RuntimeDocument | null> {
    requirePrincipal(this.service, WORLD_READERS);
    assertWorldKey(world);
    if (!this.sameScopeAs(world, registry) || !registry.collectionIds.includes(address.collectionId))
      fail('UnauthorizedCollection');
    return this.service.world
      .collection<RuntimeDocument>(address.collectionId)
      .findOne(worldFilter(world, world.worldId, { _id: addressId(address) }), { session });
  }

  /**
   * Applies one compiled field write to one record, bound to the trusted tenant/env/world and record key.
   * The caller composes this inside a fenced effect transaction; the world revision is advanced there.
   */
  async writeField(
    world: WorldKey,
    registry: ScopeRegistry,
    address: DomainAddress,
    fieldId: string,
    input: WritePlanInput,
    session?: ClientSession,
  ): Promise<FieldWriteResult> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    const field = this.boundField(world, registry, fieldId);
    if (address.collectionId !== field.collectionId) fail('AddressFieldMismatch');
    const plan = compileWritePlan(field, input);
    // Inspect the stored value in the same session as the write: refuse to write a scalar over an array.
    const stored = await this.service.world
      .collection<RuntimeDocument>(field.collectionId)
      .findOne(worldFilter(world, world.worldId, { _id: addressId(address) }), {
        session,
        projection: { data: 1 },
        promoteValues: false,
        promoteLongs: false,
      });
    if (stored) assertStoredShape(stored, field);
    const result = await this.service.world
      .collection<RuntimeDocument>(field.collectionId)
      .updateOne(
        worldFilter(world, world.worldId, { $and: [{ _id: addressId(address) }, plan.filter] }),
        plan.update,
        {
          session,
          ...(plan.arrayFilters ? { arrayFilters: plan.arrayFilters } : {}),
        },
      );
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }

  /**
   * One owner-policy effect on one record, as a single update so the record's `_rev` advances exactly once.
   * `delete` removes the record, `restrict` sets `access` to `restricted`, and `redact`/`tombstone` replace the
   * exact `writes` (registered field plus the exact value) with `replacement` (a string for redact, null for
   * tombstone; tombstone also sets `lifecycle`). Every variant is conditional on `expectedRev`, so a record that
   * changed since it was planned fails with `StaleTarget` instead of being written.
   */
  async applyEffect(
    world: WorldKey,
    registry: ScopeRegistry,
    address: DomainAddress,
    effect: RecordEffect,
    session?: ClientSession,
  ): Promise<FieldWriteResult> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    assertWorldKey(world);
    if (!this.sameScopeAs(world, registry) || !registry.collectionIds.includes(address.collectionId))
      fail('UnauthorizedCollection');
    if (!Number.isSafeInteger(effect.expectedRev) || effect.expectedRev < 0) fail('InvalidExpectedRevision');
    const collection = this.service.world.collection<Document>(address.collectionId);
    const target: Document = worldFilter(world, world.worldId, {
      _id: addressId(address),
      _rev: effect.expectedRev,
    });
    let result: FieldWriteResult;
    if (effect.kind === 'delete') {
      const deleted = await collection.deleteOne(target, { session });
      result = { matched: deleted.deletedCount, modified: deleted.deletedCount };
    } else if (effect.kind === 'restrict') {
      const updated = await collection.updateOne(
        target,
        { $set: { access: 'restricted' }, $inc: { _rev: 1 } },
        { session },
      );
      result = { matched: updated.matchedCount, modified: updated.modifiedCount };
    } else {
      if (effect.kind === 'redact' ? typeof effect.replacement !== 'string' : effect.replacement !== null)
        fail('InvalidReplacement');
      const stored = await collection.findOne(target, { session, promoteValues: false, promoteLongs: false });
      if (!stored) fail('StaleTarget');
      const set: Document = effect.kind === 'tombstone' ? { lifecycle: 'tombstoned' } : {};
      const arrayFilters: Document[] = [];
      effect.writes.forEach((write, index) => {
        const field = this.boundField(world, registry, write.fieldId);
        if (field.collectionId !== address.collectionId) fail('AddressFieldMismatch');
        assertStoredShape(stored, field);
        const plan = compileWritePlan(field, {
          match: write.match,
          mutation: { kind: 'replace', replacement: effect.replacement },
          arrayIdentifier: `t${index}`,
          advanceRevision: false,
        });
        for (const [path, value] of Object.entries((plan.update.$set ?? {}) as Document)) {
          if (path in set) fail('ConflictingWrites');
          set[path] = value;
        }
        arrayFilters.push(...(plan.arrayFilters ?? []));
      });
      const updated = await collection.updateOne(
        target,
        { ...(Object.keys(set).length ? { $set: set } : {}), $inc: { _rev: 1 } },
        { session, ...(arrayFilters.length ? { arrayFilters } : {}) },
      );
      result = { matched: updated.matchedCount, modified: updated.modifiedCount };
    }
    if (result.matched !== 1) fail('StaleTarget');
    return result;
  }

  /** Raw preimages use nonpromoted BSON values so EJSON keeps original numeric types. */
  async preimageHash(
    world: WorldKey,
    registry: ScopeRegistry,
    address: DomainAddress,
    session?: ClientSession,
  ): Promise<string> {
    assertWorldKey(world);
    if (!registry.collectionIds.includes(address.collectionId) || !this.sameScopeAs(world, registry))
      fail('UnauthorizedCollection');
    const row = await this.service.world
      .collection<RuntimeDocument>(address.collectionId)
      .findOne(worldFilter(world, world.worldId, { _id: addressId(address) }), {
        session,
        promoteValues: false,
        promoteLongs: false,
      });
    if (!row) fail('RecordNotFound');
    return bsonPreimageHash(row);
  }

  private sameScopeAs(key: ScopeKey, registry: ScopeRegistry): boolean {
    return registry.tenantId === key.tenantId && registry.env === key.env && registry.scopeId === key.scopeId;
  }

  private boundField(world: WorldKey, registry: ScopeRegistry, fieldId: string): FieldDescriptor {
    assertWorldKey(world);
    if (!this.sameScopeAs(world, registry)) fail('UnauthorizedCollection');
    const field = this.field(registry, fieldId);
    if (!registry.collectionIds.includes(field.collectionId)) fail('UnauthorizedCollection');
    return field;
  }
}
