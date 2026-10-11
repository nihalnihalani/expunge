import { BSON, Binary, Decimal128, Int32, Double, Long, ObjectId, UUID, type Document } from 'mongodb';
import { contentHash } from '@expunge/contracts';
import { fail } from './client.js';
import { addressId, typedAddress } from './hashes.js';

/**
 * Value handling for native owner-source documents: top-level documents with the owner's own field names and the
 * owner's own `_id` types. Documents are always read with `promoteValues: false` so the original BSON types
 * (int32, double, long, decimal) survive a read, a hash and a write unchanged.
 */

export type NativeIdType = 'string' | 'objectId' | 'int' | 'long' | 'uuid';
export type NativeAddress = {
  collectionId: string;
  recordId: string | number;
  recordIdBsonType: NativeIdType;
};
/** Read options that keep every BSON value as the type it was stored with. */
export const RAW_READ = { promoteValues: false, promoteLongs: false, promoteBuffers: false } as const;
export type NativeId = string | number | ObjectId | Long | UUID;
/** A value that is compared by equality or written verbatim. Never an object holding query operators. */
export type BsonScalar =
  string | number | boolean | null | Date | ObjectId | Long | Decimal128 | Int32 | Double | UUID;

const CANONICAL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_STRING_VALUE_LENGTH = 4096;

export function isUuidBinary(value: unknown): value is Binary {
  return value instanceof Binary && value.sub_type === Binary.SUBTYPE_UUID && value.buffer.length >= 16;
}
/** The exact BSON `_id` an address names, UUIDs included. Rejects every non-canonical spelling. */
export function nativeId(address: NativeAddress): NativeId {
  if (address.recordIdBsonType === 'uuid') {
    if (typeof address.recordId !== 'string' || !CANONICAL_UUID.test(address.recordId))
      throw new Error('InvalidUuidAddress');
    return new UUID(address.recordId);
  }
  return addressId(address as never);
}
/** Typed address of a stored `_id`, or `UnsupportedIdType` when the type is outside string/ObjectId/int/long/UUID. */
export function nativeAddress(collectionId: string, id: unknown): NativeAddress {
  if (isUuidBinary(id))
    return { collectionId, recordId: id.toUUID().toHexString(true), recordIdBsonType: 'uuid' };
  try {
    return typedAddress(collectionId, id);
  } catch {
    return fail('UnsupportedIdType');
  }
}
/** One key per stored `_id`, whatever spelling the caller used. */
export function nativeNodeKey(address: NativeAddress): string {
  return contentHash(nativeAddress(address.collectionId, nativeId(address)), 'native-node-address');
}

type NumericKind = Int32 | Double | Long | number;
const isNumeric = (value: unknown): value is NumericKind =>
  typeof value === 'number' || value instanceof Int32 || value instanceof Double || value instanceof Long;
const numericOf = (value: NumericKind): bigint | number => {
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : value;
  if (value instanceof Long) return value.toBigInt();
  const n = value.valueOf();
  return Number.isInteger(n) ? BigInt(n) : n;
};
const bytesOf = (value: unknown): Buffer => Buffer.from(BSON.serialize({ v: value } as Document));
/**
 * MongoDB equality for one scalar: numbers of any numeric type compare by value (as `$eq` does), everything else by
 * exact BSON bytes, so the string "5", the number 5 and an ObjectId never equal one another.
 */
export function sameNativeValue(left: unknown, right: unknown): boolean {
  if (isNumeric(left) && isNumeric(right)) {
    const a = numericOf(left);
    const b = numericOf(right);
    return typeof a === typeof b ? a === b : false;
  }
  if (isNumeric(left) !== isNumeric(right)) return false;
  return bytesOf(left).equals(bytesOf(right));
}

/** Accepts the scalars a binding, an identity or a reference can be; refuses objects and arrays (operator smuggling). */
export function nativeScalar(value: unknown, allowNull = false): BsonScalar {
  if (value === null) return allowNull ? null : fail('UnsafeMatchValue');
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_VALUE_LENGTH) fail('UnsafeMatchValue');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fail('UnsafeMatchValue');
  if (value instanceof Date) return value;
  if (isUuidBinary(value)) return value.toUUID();
  const tag = typeof value === 'object' ? (value as { _bsontype?: unknown })._bsontype : null;
  if (typeof tag === 'string' && ['ObjectId', 'Long', 'Int32', 'Double', 'Decimal128'].includes(tag))
    return value as BsonScalar;
  return fail('UnsafeMatchValue');
}

/**
 * The typed key of a value that can name a subject or a record: the BSON type is part of the key. `s:` string,
 * `o:` ObjectId (hex), `n:` number (int32, double and long compare by value, as MongoDB equality does), `u:` UUID.
 * The gateway's `scalarKey` keeps a separate `l:` for Long; a native source follows MongoDB equality instead.
 */
export function bindingKey(value: unknown): string | null {
  if (typeof value === 'string') return `s:${value}`;
  if (value instanceof ObjectId) return `o:${value.toHexString()}`;
  if (isUuidBinary(value)) return `u:${value.toUUID().toHexString(true)}`;
  if (value instanceof Long) return `n:${value.toString()}`;
  if (value instanceof Int32 || value instanceof Double) return `n:${value.valueOf()}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `n:${value}`;
  return null;
}
export function bindingKeyOfAddress(address: NativeAddress): string {
  switch (address.recordIdBsonType) {
    case 'string':
      return `s:${address.recordId}`;
    case 'objectId':
      return `o:${address.recordId}`;
    case 'uuid':
      return `u:${address.recordId}`;
    default:
      return `n:${address.recordId}`;
  }
}

export type FoundValue = { path: string[]; value: unknown; parent: unknown; key: string };
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value as { _bsontype?: unknown })._bsontype;
/**
 * Values a registered path holds in one document. `*` visits every element of the array at that position; a missing
 * segment, a non-object where an object is needed, or a non-array at a `*` yields nothing.
 */
export function valuesAt(document: unknown, segments: readonly string[]): FoundValue[] {
  const found: FoundValue[] = [];
  const walk = (
    parent: unknown,
    key: string,
    cursor: unknown,
    remaining: readonly string[],
    actual: string[],
  ) => {
    if (remaining.length === 0) {
      found.push({ path: actual, value: cursor, parent, key });
      return;
    }
    const [head, ...tail] = remaining as [string, ...string[]];
    if (head === '*') {
      if (Array.isArray(cursor))
        cursor.forEach((item, index) => walk(cursor, String(index), item, tail, [...actual, String(index)]));
      return;
    }
    if (isObject(cursor) && Object.hasOwn(cursor, head))
      walk(cursor, head, cursor[head], tail, [...actual, head]);
  };
  walk(null, '', document, segments, []);
  return found;
}

/** Deep copy that keeps every BSON type. */
export function cloneRaw<T extends Document>(document: T): T {
  return BSON.deserialize(BSON.serialize(document), RAW_READ) as T;
}

export type ModelWrite = { segments: string[]; match: BsonScalar; replacement: BsonScalar };
/**
 * The document a set of exact-value replacements must produce: every element or field at a registered path whose
 * value equals `match` (and is not an array) becomes `replacement`; every other byte stays. This is the reference
 * the adapter compares a read-back against.
 */
export function applyModelWrites(document: Document, writes: readonly ModelWrite[]): Document {
  const next = cloneRaw(document);
  for (const write of writes)
    for (const found of valuesAt(next, write.segments)) {
      if (Array.isArray(found.value) || !sameNativeValue(found.value, write.match)) continue;
      if (Array.isArray(found.parent)) (found.parent as unknown[])[Number(found.key)] = write.replacement;
      else (found.parent as Record<string, unknown>)[found.key] = write.replacement;
    }
  return next;
}
