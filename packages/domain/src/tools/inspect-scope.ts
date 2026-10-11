import { z } from 'zod';
import type { ToolRuntime } from '../runtime.js';
import { ToolRefusal } from '../runtime.js';

export const inspectScopeInput = z
  .object({
    /** `inspect_then_select` only: registered field ids to add to what this run can see. */
    select: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .strict();
export type InspectScopeInput = z.infer<typeof inspectScopeInput>;

/** Registered scope, as far as the bundle's context policy lets this run see it. Reads only the stored registry. */
export async function inspectScope(rt: ToolRuntime, input: InspectScopeInput) {
  const registry = await rt.registry();
  const policy = rt.bundle.contextPolicy;
  if (input.select?.length) {
    if (policy.schemaMode !== 'inspect_then_select') throw new ToolRefusal('SelectionNotAllowed');
    const known = new Set(registry.fields.map((field) => field.fieldId));
    if (input.select.some((id) => !known.has(id))) throw new ToolRefusal('UnknownFieldId');
    const merged = [...new Set([...(await rt.selection()), ...input.select])].sort();
    await rt.store.appendStep(
      rt.actor,
      rt.run,
      'scope_selection',
      { fieldIds: merged },
      await rt.worldRevision(),
    );
  }
  const roles = await rt.fieldRoles();
  const { fields, edgeIds } = await rt.visible();
  const visibleIds = new Set(fields.map((field) => field.fieldId));
  const perCollection = registry.collectionIds.map((collectionId) => ({
    collectionId,
    // Counts only what this run may see: a registered total would say how much structure its policy hides (DG13).
    visibleFieldCount: fields.filter((field) => field.collectionId === collectionId).length,
    visibleFieldIds: fields
      .filter((field) => field.collectionId === collectionId)
      .map((field) => field.fieldId),
  }));
  return {
    scope: {
      scopeId: registry.scopeId,
      scopeRevision: registry.revision,
      eligibilityPolicyId: registry.eligibilityPolicyId,
      allowedEffectKinds: registry.allowedEffectKinds,
      documentLimits: registry.documentLimits,
      discoveryCompleteness: registry.discoveryCompleteness,
    },
    world: { worldRevision: await rt.worldRevision() },
    schemaMode: policy.schemaMode,
    includeNestedArrays: policy.includeNestedArrays,
    collections: perCollection,
    fields: fields.map((field) => ({
      fieldId: field.fieldId,
      collectionId: field.collectionId,
      path: field.path,
      isArray: field.isArray,
      role: roles.get(field.fieldId) ?? 'content',
    })),
    referenceEdges: registry.referenceEdges
      .filter((edge) => edgeIds.includes(edge.edgeId))
      .map((edge) => ({
        edgeId: edge.edgeId,
        fromCollectionId: edge.fromCollectionId,
        fromFieldId: edge.fromFieldId,
        toCollectionId: edge.toCollectionId,
        toFieldId: edge.toFieldId,
      })),
    // Only a run that chooses fields to see (`inspect_then_select`) is told that more exist; the others learn nothing
    // about what their context policy hides.
    ...(policy.schemaMode === 'inspect_then_select'
      ? { hiddenFieldCount: registry.fields.filter((field) => !visibleIds.has(field.fieldId)).length }
      : {}),
  };
}
