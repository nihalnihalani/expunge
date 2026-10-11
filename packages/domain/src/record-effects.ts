import type { EffectKind, ScopeRegistry } from '@expunge/contracts';
import type { RecordEffect, ScalarValue } from '@expunge/mongo';
import type { OwnerPolicy } from '@expunge/governance';
import type { FieldRole } from './fields.js';
import { scalarsAt, stringValuesAt } from './values.js';

/**
 * The owner policy's meaning of one effect on one record, as a `RecordEffect` the Mongo layer applies as a single
 * conditional update:
 * - delete: remove the record;
 * - restrict: keep it and set `access` to `restricted`;
 * - redact / tombstone: replace every exact binding in every registered field of the record (and its private
 *   payload) with the policy's replacement, or null for a tombstone, leaving every other byte as it was.
 *
 * What gets written is decided by the registry and the policy, never by the model: the model chooses which records
 * the run targets, not what an effect does to one.
 */
export function recordEffectFor(input: {
  registry: ScopeRegistry;
  policy: OwnerPolicy;
  roles: ReadonlyMap<string, FieldRole>;
  collectionId: string;
  document: Record<string, unknown>;
  effect: EffectKind;
  expectedRev: number;
  bindings: ReadonlySet<string>;
}): RecordEffect {
  const { effect, expectedRev } = input;
  if (effect === 'delete' || effect === 'restrict') return { kind: effect, expectedRev };
  const writes: Array<{ fieldId: string; match: ScalarValue }> = [];
  for (const field of input.registry.fields) {
    if (field.collectionId !== input.collectionId) continue;
    const role = input.roles.get(field.fieldId);
    if (role === 'key') continue;
    if (role === 'payload') {
      const stored = stringValuesAt(input.document, field);
      // A private payload is replaced whole, whatever it holds; a missing or non-string one has nothing to replace.
      for (const value of stored) writes.push({ fieldId: field.fieldId, match: value });
      continue;
    }
    for (const scalar of scalarsAt(input.document, field))
      if (input.bindings.has(scalar.key)) writes.push({ fieldId: field.fieldId, match: scalar.value });
  }
  return {
    kind: effect,
    expectedRev,
    replacement: effect === 'redact' ? input.policy.redactionReplacement : null,
    writes,
  };
}
