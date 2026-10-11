import {
  isRecordKeyPath,
  type ContextPolicy,
  type FieldDescriptor,
  type ScopeRegistry,
} from '@expunge/contracts';
import type { OwnerPolicy } from '@expunge/governance';

/**
 * What a registered field is for, read from the registry alone:
 * - key: the record's own `_id` (what references point at);
 * - reference: the referencing side of a declared reference edge;
 * - payload: the owner policy's private payload field;
 * - identity: a field the owner policy names as carrying the subject's exact identity (ids, aliases, e-mail);
 * - content: everything else (free fields such as a country code or a status).
 */
export type FieldRole = 'key' | 'reference' | 'payload' | 'identity' | 'content';

export function classifyFields(registry: ScopeRegistry, policy: OwnerPolicy): Map<string, FieldRole> {
  const referencing = new Set(registry.referenceEdges.map((edge) => edge.fromFieldId));
  const roles = new Map<string, FieldRole>();
  for (const field of registry.fields) {
    if (isRecordKeyPath(field.path)) roles.set(field.fieldId, 'key');
    else if (referencing.has(field.fieldId)) roles.set(field.fieldId, 'reference');
    else if (policy.payloadFieldId(field.collectionId) === field.fieldId) roles.set(field.fieldId, 'payload');
    else if (policy.isIdentityField(field.fieldId)) roles.set(field.fieldId, 'identity');
    else roles.set(field.fieldId, 'content');
  }
  return roles;
}

/**
 * The part of the registered schema a run may see and search, as its context policy defines it:
 * - `includeNestedArrays: false` hides every field that traverses an array;
 * - `all_registered_fields` shows the rest;
 * - `selected_fields` shows only the structural fields (keys and references), so identity content stays hidden;
 * - `inspect_then_select` shows keys plus the fields the run asked to see through `inspect_scope`.
 * Record keys are always visible: they are what references point at.
 */
export function visibleFields(
  registry: ScopeRegistry,
  policy: Pick<ContextPolicy, 'schemaMode' | 'includeNestedArrays'>,
  roles: ReadonlyMap<string, FieldRole>,
  selected: ReadonlySet<string> = new Set(),
): FieldDescriptor[] {
  return registry.fields.filter((field) => {
    const role = roles.get(field.fieldId);
    if (role === 'key') return true;
    if (!policy.includeNestedArrays && field.isArray) return false;
    switch (policy.schemaMode) {
      case 'all_registered_fields':
        return true;
      case 'selected_fields':
        return role === 'reference';
      case 'inspect_then_select':
        return selected.has(field.fieldId);
    }
  });
}

/** Reference-edge declarations whose both endpoints are visible: the only edges a run may follow. */
export function visibleEdgeIds(registry: ScopeRegistry, visible: readonly FieldDescriptor[]): string[] {
  const ids = new Set(visible.map((field) => field.fieldId));
  return registry.referenceEdges
    .filter((edge) => ids.has(edge.fromFieldId) && ids.has(edge.toFieldId))
    .map((edge) => edge.edgeId);
}
