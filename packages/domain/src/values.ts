import { Long, ObjectId } from 'mongodb';
import type { ScalarValue } from '@expunge/mongo';
import { isRecordKeyPath, type FieldDescriptor } from '@expunge/contracts';

export interface FoundValue {
  /** Concrete path with array indexes in place of `*`, e.g. ['data','parties','1','principal']. */
  path: string[];
  value: unknown;
}

/**
 * Values of a registered field in one record. `*` visits every element of the array at that position; a missing
 * segment, a non-object where an object is needed, or a non-array at a `*` yields nothing. The record key `_id`
 * reads the record's own key.
 */
export function valuesAt(
  record: Record<string, unknown>,
  field: Pick<FieldDescriptor, 'path'>,
): FoundValue[] {
  if (isRecordKeyPath(field.path)) return [{ path: ['_id'], value: record._id }];
  const found: FoundValue[] = [];
  const walk = (cursor: unknown, remaining: readonly string[], actual: string[]): void => {
    if (remaining.length === 0) {
      found.push({ path: actual, value: cursor });
      return;
    }
    const [head, ...tail] = remaining as [string, ...string[]];
    if (head === '*') {
      if (Array.isArray(cursor))
        cursor.forEach((item, index) => walk(item, tail, [...actual, String(index)]));
      return;
    }
    if (
      cursor !== null &&
      typeof cursor === 'object' &&
      !Array.isArray(cursor) &&
      Object.hasOwn(cursor, head)
    )
      walk((cursor as Record<string, unknown>)[head], tail, [...actual, head]);
  };
  walk(record, field.path, []);
  return found;
}

/** String values only, deduplicated: what identity and reference matching compares. */
export function stringValuesAt(
  record: Record<string, unknown>,
  field: Pick<FieldDescriptor, 'path'>,
): string[] {
  return [
    ...new Set(
      valuesAt(record, field)
        .map((found) => found.value)
        .filter((value): value is string => typeof value === 'string'),
    ),
  ];
}

/**
 * The typed key of a value that can name a subject or a record: the BSON type is part of it, so the string "5", the
 * number 5 and an ObjectId never match one another. Keys are what bindings are made of and what every comparison uses.
 * `s:` string, `o:` ObjectId (hex), `l:` Long, `n:` number. Anything else (a date, an object) cannot be a binding.
 */
export function scalarKey(value: unknown): string | null {
  if (typeof value === 'string') return `s:${value}`;
  if (value instanceof ObjectId) return `o:${value.toHexString()}`;
  if (value instanceof Long) return `l:${value.toString()}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `n:${value}`;
  return null;
}
/** The raw text behind a typed key, for places that must recognize the literal (diagnostic sanitizing). */
export const keyText = (key: string): string => key.slice(2);

/** Distinct scalar values of a field, each with its typed key and the raw value to match when writing. */
export function scalarsAt(
  record: Record<string, unknown>,
  field: Pick<FieldDescriptor, 'path'>,
): Array<{ key: string; value: ScalarValue }> {
  const seen = new Map<string, ScalarValue>();
  for (const found of valuesAt(record, field)) {
    const key = scalarKey(found.value);
    if (key !== null && !seen.has(key)) seen.set(key, found.value as ScalarValue);
  }
  return [...seen].map(([key, value]) => ({ key, value }));
}

const OBJECT_ID_HEX = /^[a-f0-9]{24}$/;
export type ReferenceRule = 'same_bson_type' | 'string_to_objectId' | 'objectId_to_string';
/** Comparison keys of a stored value for one side of a reference edge, or [] when it cannot take part. */
export function referenceKeys(value: unknown, rule: ReferenceRule, side: 'from' | 'to'): string[] {
  const typed = (v: unknown): string | null => {
    if (typeof v === 'string') return `s:${v}`;
    if (v instanceof ObjectId) return `o:${v.toHexString()}`;
    if (v instanceof Long) return `l:${v.toString()}`;
    if (typeof v === 'number' && Number.isFinite(v)) return `n:${v}`;
    return null;
  };
  const key = typed(value);
  if (key === null) return [];
  if (rule === 'same_bson_type') return [key];
  if (rule === 'string_to_objectId') {
    // The referencing side holds a string, the referenced side an ObjectId.
    if (side === 'from') return typeof value === 'string' && OBJECT_ID_HEX.test(value) ? [`o:${value}`] : [];
    return value instanceof ObjectId ? [key] : [];
  }
  // objectId_to_string: the referencing side holds an ObjectId, the referenced side a string.
  if (side === 'from') return value instanceof ObjectId ? [`s:${value.toHexString()}`] : [];
  return typeof value === 'string' ? [key] : [];
}
