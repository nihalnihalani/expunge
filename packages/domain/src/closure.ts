import type { ScannedRecord, ScopeRepository, WorldKey } from '@expunge/mongo';
import type { DomainAddress, ScopeRegistry } from '@expunge/contracts';
import { MAX_REACH_HOPS, type IdentityEdgeRepository } from './edge-repository.js';
import type { FieldRole } from './fields.js';
import { ensureEdgeIndex, scanWorld } from './edge-index.js';
import type { ResolutionPayload, SelectedRecord } from './rows.js';
import type { ToolRuntime } from './runtime.js';
import { seedEvidence } from './tools/discover-references.js';

export type ClosureMember = { address: DomainAddress; hop: number };
/**
 * The reach, and whether it is the whole reach. `truncated` is true when the walk was cut by a limit (the scan cap,
 * the edge walk's own cap, or an owner depth the edge index cannot walk) and the members are therefore a lower bound.
 * A truncated closure never supports a completion claim.
 */
export type Closure = { members: ClosureMember[]; truncated: boolean };

export type ClosureDeps = {
  scopes: ScopeRepository;
  edges: IdentityEdgeRepository;
  world: WorldKey;
  registry: ScopeRegistry;
  roles: ReadonlyMap<string, FieldRole>;
  worldRevision: number;
  /** The owner's widest bounds: the floor's depth and scan limits, not the run's. */
  ceiling: { scannedDocuments: number; traversalDepth: number };
};

/**
 * The subject's reach as the OWNER bounds it, not as the run's context policy shows it: every registered field, both
 * directions, up to the ceiling's depth and scan limits, from the subject's record and every record holding the
 * subject's exact identity. Read only (the derived edge index of this world revision is the one thing it may write).
 */
export async function closureOf(
  deps: ClosureDeps,
  resolution: { root: { address: DomainAddress }; identityBindings: readonly string[] },
): Promise<Closure> {
  const { registry, ceiling, world, worldRevision } = deps;
  const maxDocuments = Math.min(ceiling.scannedDocuments, registry.documentLimits.maxScanned);
  const records: ReadonlyMap<string, readonly ScannedRecord[]> = await scanWorld(
    deps.scopes,
    world,
    registry,
    maxDocuments,
  );
  await ensureEdgeIndex({
    edges: deps.edges,
    scopes: deps.scopes,
    world,
    registry,
    worldRevision,
    maxDocuments,
    records,
  });
  const selected = new Map<string, SelectedRecord>();
  seedEvidence(
    selected,
    { root: resolution.root, bindings: [...resolution.identityBindings] },
    registry,
    records,
    registry.fields,
    deps.roles,
  );
  const found = await deps.edges.reach(world, worldRevision, [...selected.keys()], {
    direction: 'both',
    maxHops: Math.min(ceiling.traversalDepth, MAX_REACH_HOPS),
    edgeIds: registry.referenceEdges.map((edge) => edge.edgeId),
    limit: Math.max(1000, maxDocuments * 4),
  });
  const members: ClosureMember[] = [...selected.values()].map((entry) => ({
    address: entry.address,
    hop: entry.hop,
  }));
  const seen = new Set(selected.keys());
  let truncated = found.truncated || ceiling.traversalDepth > MAX_REACH_HOPS;
  for (const reached of found.reached) {
    if (seen.has(reached.node)) continue;
    if (members.length >= maxDocuments) {
      truncated = true;
      break;
    }
    seen.add(reached.node);
    members.push({ address: reached.address, hop: reached.hop });
  }
  return { members, truncated };
}

/** The closure of a run's subject, bounded by the floor its pinned bundle names. */
export async function computeClosure(
  rt: ToolRuntime,
  resolution: Pick<ResolutionPayload, 'root' | 'identityBindings'>,
): Promise<Closure> {
  return closureOf(
    {
      scopes: rt.env.scopes,
      edges: rt.env.edges,
      world: rt.world,
      registry: await rt.registry(),
      roles: await rt.fieldRoles(),
      worldRevision: await rt.worldRevision(),
      ceiling: rt.env.floorFor(rt.bundle.authorityFloorHash).maxLimits,
    },
    resolution,
  );
}
