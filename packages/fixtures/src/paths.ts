import { isFieldPath } from '@expunge/contracts';
import type { JsonObject, JsonValue } from './types.js';

export interface PathValue {
  path: string[];
  value: unknown;
}

/**
 * Fixture recipes are tighter than the shared grammar in `@expunge/contracts` (up to 16 segments): they
 * stay within 6 so the registry path, which adds a leading `data` segment, remains well inside the shared bound.
 */
export const RECIPE_PATH_MAX_SEGMENTS = 6;

/**
 * Recipe assignments start from an object field and support at most one wildcard. The shared grammar already
 * rejects leading wildcards, non-string segments, unsafe names and a second wildcard.
 */
export function isRecipePath(path: unknown): path is string[] {
  return isFieldPath(path) && path.length <= RECIPE_PATH_MAX_SEGMENTS;
}

/** '*' is a declared array wildcard, never a MongoDB operator. */
export function valuesAtPath(root: unknown, path: readonly string[]): PathValue[] {
  if (!Array.isArray(path) || path.some((part) => typeof part !== 'string')) {
    throw new Error('InvalidTraversalPath');
  }
  const found: PathValue[] = [];
  function walk(value: unknown, remaining: readonly string[], actual: string[]): void {
    if (!remaining.length) {
      found.push({ path: actual, value });
      return;
    }
    const [part, ...tail] = remaining;
    if (part === '*') {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, tail, [...actual, String(index)]));
    } else if (value !== null && typeof value === 'object' && Object.hasOwn(value, part!)) {
      walk((value as Record<string, unknown>)[part!], tail, [...actual, part!]);
    }
  }
  walk(root, path, []);
  return found;
}

/** Nested object built from `tail` with `value` at the innermost key. */
function nestedValue(tail: readonly string[], value: JsonValue): JsonValue {
  if (!tail.length) return value;
  const child: JsonObject = {};
  let cursor = child;
  tail.forEach((key, index) => {
    if (index === tail.length - 1) {
      cursor[key] = value;
    } else {
      cursor[key] = {};
      cursor = cursor[key] as JsonObject;
    }
  });
  return child;
}

export function assignRecipePath(root: JsonObject, path: readonly string[], values: JsonValue[]): void {
  if (!isRecipePath(path)) throw new Error('InvalidRecipePath');
  function set(object: JsonObject, parts: readonly string[]): void {
    const part = parts[0]!;
    if (parts.length === 1) {
      object[part] = values[0] ?? null;
      return;
    }
    if (parts[1] === '*') {
      const tail = parts.slice(2);
      object[part] = values.map((value) => nestedValue(tail, value));
      return;
    }
    if (!object[part] || typeof object[part] !== 'object' || Array.isArray(object[part])) object[part] = {};
    set(object[part] as JsonObject, parts.slice(1));
  }
  set(root, path);
}
