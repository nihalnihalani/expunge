import { createHash } from 'node:crypto';
import { BSON, Decimal128, Double, Int32, Long, ObjectId, type Document } from 'mongodb';
import {
  nativeScalarSchema,
  type NativeScalar,
  type NativeField,
  type NativeSourceRegistration,
} from '@expunge/contracts';
import { fail } from './client.js';

/** The native collection reader must disable numeric promotion to preserve int/long/double identity. */
export const NATIVE_BSON_OPTIONS = { promoteValues: false, promoteLongs: false, bsonRegExp: true } as const;
export function decodeNativeScalar(input: NativeScalar): unknown {
  const scalar = nativeScalarSchema.parse(input);
  switch (scalar.bsonType) {
    case 'objectId':
      return new ObjectId(scalar.value);
    case 'int':
      return new Int32(scalar.value);
    case 'long':
      return Long.fromString(scalar.value);
    case 'double':
      return new Double(scalar.value);
    case 'decimal':
      return Decimal128.fromString(scalar.value);
    case 'date':
      return new Date(scalar.value);
    default:
      return scalar.value;
  }
}
export function encodeNativeScalar(value: unknown): NativeScalar {
  if (value === null) return { bsonType: 'null', value: null };
  if (typeof value === 'string') return nativeScalarSchema.parse({ bsonType: 'string', value });
  if (typeof value === 'boolean') return { bsonType: 'bool', value };
  if (value instanceof ObjectId) return { bsonType: 'objectId', value: value.toHexString() };
  if (value instanceof Int32) return { bsonType: 'int', value: value.valueOf() };
  if (value instanceof Long && value._bsontype === 'Long')
    return { bsonType: 'long', value: value.toString() };
  if (value instanceof Double)
    return nativeScalarSchema.parse({ bsonType: 'double', value: value.valueOf() });
  if (value instanceof Decimal128)
    return nativeScalarSchema.parse({ bsonType: 'decimal', value: value.toString() });
  if (value instanceof Date)
    return nativeScalarSchema.parse({ bsonType: 'date', value: value.toISOString() });
  // A JS number from a promoted read has lost its native type. Never guess int vs double.
  fail('UnsupportedOrPromotedNativeIdentity');
}
export function nativeBsonDigest(value: Document): string {
  const bytes = BSON.serialize(value, { ignoreUndefined: false });
  if (bytes.byteLength > 8 * 1024 * 1024) fail('NativePreimageTooLarge');
  return createHash('sha256').update('expunge-native-bson:v2\0').update(bytes).digest('hex');
}
export function nativeScalarKey(value: NativeScalar): string {
  return nativeBsonDigest({ value: decodeNativeScalar(value) });
}

/** $type aggregation compares the scalar itself. Query $type would also admit an array containing that type. */
export function nativeScalarPredicate(path: readonly string[], scalar: NativeScalar): Document {
  if (path.includes('*') || !path.length) fail('NativeScalarPathRequired');
  const dotted = path.join('.');
  const expression = path.reduce<Document | string>(
    (parent, field) => ({
      $getField: { field: { $literal: field }, input: parent },
    }),
    '$$ROOT',
  );
  const type =
    scalar.bsonType === 'objectId' ? 'objectId' : scalar.bsonType === 'bool' ? 'bool' : scalar.bsonType;
  return {
    $and: [
      { [dotted]: { $exists: true, $eq: decodeNativeScalar(scalar) } },
      {
        $expr: {
          $and: [
            { $eq: [{ $type: expression }, type] },
            { $eq: [expression, { $literal: decodeNativeScalar(scalar) }] },
          ],
        },
      },
    ],
  };
}
export function nativeTenantPredicate(source: NativeSourceRegistration, namespaceId: string): Document {
  const boundary = source.tenantBoundaries.find((value) => value.namespaceId === namespaceId);
  const field = source.fields.find((value) => value.fieldId === boundary?.fieldId);
  if (!boundary || !field || field.namespaceId !== namespaceId || !field.protected)
    fail('NativeTenantBoundaryMissing');
  return nativeScalarPredicate(field.path, boundary.equals);
}

export type NativePathValue = { value: unknown; concretePath: string[] };
/** Wildcard reads preserve concrete array offsets, so a later effect cannot widen to unrelated elements. */
export function nativePathValues(document: Document, path: readonly string[]): NativePathValue[] {
  const result: NativePathValue[] = [];
  const walk = (value: unknown, index: number, concretePath: string[]) => {
    if (index === path.length) {
      result.push({ value, concretePath });
      return;
    }
    const segment = path[index];
    if (segment === '*') {
      if (!Array.isArray(value)) return;
      value.forEach((child, i) => walk(child, index + 1, [...concretePath, String(i)]));
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, segment)
    ) {
      walk((value as Document)[segment], index + 1, [...concretePath, segment]);
    }
  };
  walk(document, 0, []);
  return result;
}
export function fieldValues(document: Document, field: NativeField): NativePathValue[] {
  return nativePathValues(document, field.path);
}

function bsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof ObjectId) return 'objectId';
  if (value instanceof Int32) return 'int';
  if (value instanceof Long && value._bsontype === 'Long') return 'long';
  if (value instanceof Double) return 'double';
  if (value instanceof Decimal128) return 'decimal';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'object' && value && '_bsontype' in value) {
    const name = String(value._bsontype);
    if (name === 'Binary') return 'binData';
    if (name === 'BSONRegExp') return 'regex';
    if (name === 'Timestamp') return 'timestamp';
    fail('UnsupportedNativePreimageBsonType');
  }
  if (typeof value === 'object') return 'object';
  fail('UnsupportedNativePreimageBsonType');
}
export function assertNativeRegisteredShape(
  source: NativeSourceRegistration,
  namespaceId: string,
  document: Document,
): void {
  for (const field of source.fields.filter((value) => value.namespaceId === namespaceId)) {
    for (const { value } of fieldValues(document, field))
      if (!field.bsonTypes.includes(bsonType(value) as NativeField['bsonTypes'][number]))
        fail('NativeSourceSchemaDrift');
  }
  encodeNativeScalar(document._id);
  nativeBsonDigest(document);
}

/** Exact full preimage plus recursive BSON type checks. Mongo numeric equality alone is type-coercing. */
export function nativePreimagePredicate(document: Document): Document {
  nativeBsonDigest(document);
  let nodes = 0;
  const types = (value: unknown, expression: Document | string, depth: number): Document => {
    if (++nodes > 4096 || depth > 32) fail('NativePreimageComplexityBound');
    const type = bsonType(value);
    const check = { $eq: [{ $type: expression }, type] };
    if (type === 'array')
      return {
        $cond: [
          check,
          {
            $and: [
              { $eq: [{ $size: expression }, (value as unknown[]).length] },
              ...(value as unknown[]).map((child, i) =>
                types(child, { $arrayElemAt: [expression, i] }, depth + 1),
              ),
            ],
          },
          false,
        ],
      };
    if (type === 'object')
      return {
        $cond: [
          check,
          {
            $and: [
              check,
              ...Object.entries(value as Document).map(([field, child]) =>
                types(child, { $getField: { field: { $literal: field }, input: expression } }, depth + 1),
              ),
            ],
          },
          false,
        ],
      };
    return check;
  };
  return { $expr: { $and: [{ $eq: ['$$ROOT', { $literal: document }] }, types(document, '$$ROOT', 0)] } };
}

export function cloneNativeDocument(document: Document): Document {
  return BSON.deserialize(BSON.serialize(document), NATIVE_BSON_OPTIONS);
}
export function replaceNativePath(document: Document, path: readonly string[], value: unknown): void {
  if (!path.length || path.includes('*') || path[0] === '_id') fail('UnsupportedNativeEffectPath');
  let parent: Document | unknown[] = document;
  for (let index = 0; index < path.length - 1; index++) {
    const part = path[index];
    const next: unknown = Array.isArray(parent) ? parent[Number(part)] : parent[part];
    if (!next || typeof next !== 'object') fail('NativeEffectPathMissing');
    parent = next as Document | unknown[];
  }
  const last = path.at(-1)!;
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9][0-9]*)$/.test(last) || Number(last) >= parent.length) fail('NativeEffectPathMissing');
    parent[Number(last)] = value;
  } else {
    if (!Object.hasOwn(parent, last)) fail('NativeEffectPathMissing');
    Object.defineProperty(parent, last, { value, enumerable: true, configurable: true, writable: true });
  }
}
