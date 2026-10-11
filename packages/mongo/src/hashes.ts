import { BSON, ObjectId, Long, Decimal128, Binary, Timestamp } from 'mongodb';
import { contentHash, type DomainAddress } from '@expunge/contracts';

/** BSON retains explicit type tags. Field ordering is canonical; array ordering is preserved. */
export function bsonPreimageHash(value: unknown): string {
  const tagged = BSON.EJSON.serialize(value, { relaxed: false });
  return contentHash(tagged, 'bson-preimage');
}
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
/** One spelling per value: no sign padding, leading zeros, exponent, hex or whitespace. */
const CANONICAL_DECIMAL = /^-?(0|[1-9][0-9]*)$/;
const CANONICAL_OBJECT_ID = /^[a-f0-9]{24}$/;

function canonicalInt(recordId: unknown): number {
  const value =
    typeof recordId === 'number'
      ? recordId
      : typeof recordId === 'string' && CANONICAL_DECIMAL.test(recordId)
        ? Number(recordId)
        : Number.NaN;
  if (!Number.isInteger(value) || Object.is(value, -0) || value < INT32_MIN || value > INT32_MAX)
    throw new Error('InvalidIntAddress');
  return value;
}
/** Resolves a typed address to the exact BSON `_id` value. Rejects every non-canonical spelling. */
export function addressId(address: DomainAddress): string | number | ObjectId | Long {
  if (address.recordIdBsonType === 'string') {
    if (typeof address.recordId !== 'string') throw new Error('InvalidStringAddress');
    return address.recordId;
  }
  if (address.recordIdBsonType === 'objectId') {
    if (typeof address.recordId !== 'string' || !CANONICAL_OBJECT_ID.test(address.recordId))
      throw new Error('InvalidObjectIdAddress');
    return new ObjectId(address.recordId);
  }
  if (address.recordIdBsonType === 'int') return canonicalInt(address.recordId);
  if (address.recordIdBsonType !== 'long') throw new Error('UnsupportedAddressType');
  if (typeof address.recordId !== 'string' || !CANONICAL_DECIMAL.test(address.recordId))
    throw new Error('InvalidLongAddress');
  const parsed = Long.fromString(address.recordId);
  if (parsed.toString() !== address.recordId) throw new Error('InvalidLongAddress');
  return parsed;
}
function bsonValue(id: unknown): number | null {
  if (typeof id !== 'object' || id === null) return null;
  const wrapper = id as { _bsontype?: unknown; value?: unknown };
  return (wrapper._bsontype === 'Int32' || wrapper._bsontype === 'Double') &&
    typeof wrapper.value === 'number'
    ? wrapper.value
    : null;
}
/**
 * Typed address of a stored `_id`. Reads that keep BSON types (promoteValues:false) hand back `Int32` and
 * `Double` wrappers; an integral value in int32 range is an `int` address either way.
 */
export function typedAddress(collectionId: string, id: unknown): DomainAddress {
  if (id instanceof ObjectId)
    return { collectionId, recordId: id.toHexString(), recordIdBsonType: 'objectId' };
  if (id instanceof Long) return { collectionId, recordId: id.toString(), recordIdBsonType: 'long' };
  if (typeof id === 'string') return { collectionId, recordId: id, recordIdBsonType: 'string' };
  const numeric = typeof id === 'number' ? id : bsonValue(id);
  if (numeric !== null) {
    try {
      return { collectionId, recordId: canonicalInt(numeric), recordIdBsonType: 'int' };
    } catch {
      throw new Error('UnsupportedAddressType');
    }
  }
  throw new Error('UnsupportedAddressType');
}
/** Stable node identity: every spelling of the same stored `_id` maps to one key. */
export function canonicalAddress(address: DomainAddress): DomainAddress {
  const id = addressId(address);
  return typedAddress(address.collectionId, id);
}
export function nodeKey(address: DomainAddress): string {
  return contentHash(canonicalAddress(address), 'node-address');
}
export { ObjectId, Long, Decimal128, Binary, Timestamp };
