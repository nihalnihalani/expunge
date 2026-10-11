import type { JsonValue } from '@expunge/contracts';

/**
 * Structural learning vs raw retention. A lesson may keep closed-vocabulary identifiers, counts, booleans and hashes
 * (generalized structure, recorded by policy). It may not keep source text: any string leaf that is not a short
 * identifier or a hex digest means the value still carries raw source material.
 *
 * This is a conservative heuristic, not proof of anonymity: it never accepts free text, but a short identifier can
 * still be a name. The subject-literal scan (scan.ts) is the second, independent control.
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:/-]{0,63}$/;
const DIGEST = /^[a-f0-9]{16,128}$/;

export type Retention = 'structural' | 'raw';

export function classifyRetention(value: JsonValue): Retention {
  const walk = (node: JsonValue): boolean => {
    if (typeof node === 'string') return IDENTIFIER.test(node) || DIGEST.test(node);
    if (Array.isArray(node)) return node.every(walk);
    if (node && typeof node === 'object')
      return Object.values(node).every((child) => walk(child as JsonValue));
    return true;
  };
  return walk(value) ? 'structural' : 'raw';
}
