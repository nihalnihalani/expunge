import type { EffectKind } from '@expunge/contracts';
import type { DomainEnv } from '../env.js';
import type { ServiceConfig } from './config.js';

/** The worlds bound to the service's scope, shaped by the operator's `WorldSummary`. */
export async function listWorlds(env: DomainEnv, config: ServiceConfig) {
  const scope = config.owner.scope;
  const rows = await env.service.world
    .collection<{ _id: string }>('world_scope_bindings')
    .find(
      { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId },
      { sort: { _id: 1 }, limit: 50 },
    )
    .toArray();
  const worlds = [];
  for (const row of rows) {
    const state = await env.worlds.read(scope, row._id);
    const registry = await env.scopes.read(scope, state.scopeRevision);
    worlds.push({
      worldId: state.worldId,
      label: `Synthetic world ${state.worldId.slice(-8)}`,
      env: scope.env,
      scopeId: scope.scopeId,
      scopeRevision: state.scopeRevision,
      worldRevision: state.revision,
      maintenanceMode: state.maintenanceMode,
      collectionIds: registry.collectionIds,
      fieldCount: registry.fields.length,
      referenceEdgeCount: registry.referenceEdges.length,
      allowedEffectKinds: registry.allowedEffectKinds as EffectKind[],
      eligibilityPolicyId: registry.eligibilityPolicyId,
      eligibilityPolicyHash: registry.eligibilityPolicyHash,
      documentLimits: {
        maxScanned: registry.documentLimits.maxScanned,
        maxChanged: registry.documentLimits.maxChanged,
      },
      discoveryCompleteness: {
        kind: registry.discoveryCompleteness.kind,
        limitations: registry.discoveryCompleteness.limitations,
      },
    });
  }
  return { worlds };
}
