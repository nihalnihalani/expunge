import { z } from 'zod';
import type { ScopeRegistry } from '@expunge/contracts';
import { ensureEdgeIndex, scanWorld } from '../edge-index.js';
import type { EdgeDirection } from '../edge-repository.js';
import { addressKey, nodeKey } from '../keys.js';
import type { DiscoveryPayload, SelectedRecord } from '../rows.js';
import type { ToolRuntime } from '../runtime.js';
import { ToolRefusal } from '../runtime.js';
import { scalarsAt } from '../values.js';

export const discoverReferencesInput = z
  .object({
    direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
    /** Hops to explore in this call (at most what the bundle's depth allows in total). */
    maxHops: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type DiscoverReferencesInput = z.infer<typeof discoverReferencesInput>;

const SHOWN_RECORDS = 100;
type Way = 'outgoing' | 'incoming';
const WAYS: readonly Way[] = ['outgoing', 'incoming'];

/**
 * Finds the records in the subject's reach: first those carrying an exact subject identity value in an identity field
 * the run can see (hop 0), then records connected by declared, visible reference edges, hop by hop, over the
 * revision-versioned edge index with a bounded `$graphLookup`.
 *
 * Each direction is its own chain from the evidence and never turns back: a record reached walking outgoing continues
 * outgoing, one reached walking incoming continues incoming, in this call and in every later one. A record that is
 * reachable only by turning (up an edge into a record the subject does not own, then down another) is not in reach, so
 * a shared record cannot carry the walk from one subject to another.
 *
 * The depth cap is the lesser of the bundle's `referenceDepth` and the owner's `traversalDepth`; what lies beyond it is
 * reported as `frontierOpen`.
 */
export async function discoverReferences(rt: ToolRuntime, input: DiscoverReferencesInput) {
  const registry = await rt.registry();
  const roles = await rt.fieldRoles();
  const { fields, edgeIds } = await rt.visible();
  const resolution = await rt.store.latestStep(rt.actor, rt.job._id, 'subject_resolution');
  if (!resolution) throw new ToolRefusal('SubjectNotResolved');
  const limits = rt.bundle.limits;
  const cap = Math.min(rt.bundle.contextPolicy.referenceDepth, limits.traversalDepth);
  const worldRevision = await rt.worldRevision();

  const previous = await rt.store.latestStep(rt.actor, rt.job._id, 'discovery');
  // Records change when effects commit, so a discovery made at an older revision is rebuilt from the evidence.
  const resumed = previous && previous.worldRevision === worldRevision ? previous.payload : null;

  const records = await scanWorld(rt.env.scopes, rt.world, registry, limits.scannedDocuments);
  const scanned = [...records.values()].reduce((sum, list) => sum + list.length, 0);
  await ensureEdgeIndex({
    edges: rt.env.edges,
    scopes: rt.env.scopes,
    world: rt.world,
    registry,
    worldRevision,
    maxDocuments: limits.scannedDocuments,
    records,
  });

  const selected = new Map<string, SelectedRecord>();
  const frontiers: Record<Way, Set<string>> = { outgoing: new Set(), incoming: new Set() };
  const depths: Record<Way, number> = { outgoing: 0, incoming: 0 };
  const arrayFieldIds = fields.filter((field) => field.isArray).map((field) => field.fieldId);
  if (resumed) {
    for (const entry of resumed.selected) selected.set(nodeKey(entry.address), entry);
    for (const way of WAYS) for (const node of resumed.frontiers[way]) frontiers[way].add(node);
    depths.outgoing = resumed.depths.outgoing;
    depths.incoming = resumed.depths.incoming;
  } else {
    seedEvidence(selected, resolution.payload, registry, records, fields, roles);
    // The evidence is where every chain starts: it may be walked either way.
    for (const node of selected.keys()) for (const way of WAYS) frontiers[way].add(node);
  }
  const before = new Set(selected.keys());
  // A verification that found records still unhandled hands them back as new evidence: they may be reachable only
  // through records that have since been cleaned, so rediscovery from the subject alone would never find them.
  const sweep = await rt.store.latestSweep(rt.actor, rt.job._id, rt.run.runId);
  if (sweep && sweep.status === 'valid' && sweep.residuals > 0 && sweep.worldRevisionAfter === worldRevision)
    for (const residual of sweep.residualSamples) {
      const node = nodeKey(residual.address);
      if (!selected.has(node))
        selected.set(node, { address: residual.address, hop: 0, via: `residual:${residual.reason}` });
      for (const way of WAYS) frontiers[way].add(node);
    }

  const ways: readonly Way[] = (
    input.direction === 'incoming' ? ['incoming'] : input.direction === 'outgoing' ? ['outgoing'] : WAYS
  ) satisfies readonly Way[];
  let truncated = false;
  const reachLimit = Math.max(1000, limits.scannedDocuments * 4);
  for (const way of ways) {
    const remaining = cap - depths[way];
    if (remaining <= 0 || frontiers[way].size === 0) continue;
    const hops = Math.min(input.maxHops ?? remaining, remaining);
    const found = await rt.env.edges.reach(rt.world, worldRevision, [...frontiers[way]], {
      direction: way satisfies EdgeDirection,
      maxHops: hops,
      edgeIds,
      limit: reachLimit,
    });
    truncated = truncated || found.truncated;
    const next = new Set<string>();
    for (const reached of found.reached) {
      if (reached.hop === hops) next.add(reached.node);
      if (selected.has(reached.node)) continue;
      if (selected.size >= limits.scannedDocuments) {
        truncated = true;
        break;
      }
      selected.set(reached.node, {
        address: reached.address,
        hop: depths[way] + reached.hop,
        via: `edge:${reached.edgeId}:${reached.direction}`,
      });
    }
    frontiers[way] = next;
    depths[way] += hops;
  }
  const depth = Math.max(depths.outgoing, depths.incoming);

  // Unexplored neighbours of the current frontiers: references that exist beyond what has been walked.
  let frontierOpen = 0;
  const open = new Set<string>();
  for (const way of WAYS) {
    if (frontiers[way].size === 0) continue;
    const peek = await rt.env.edges.reach(rt.world, worldRevision, [...frontiers[way]], {
      direction: way,
      maxHops: 1,
      edgeIds,
      limit: reachLimit,
    });
    truncated = truncated || peek.truncated;
    for (const entry of peek.reached) if (!selected.has(entry.node)) open.add(entry.node);
  }
  frontierOpen = open.size;

  const payload: DiscoveryPayload = {
    depth,
    depths: { ...depths },
    selected: [...selected.values()],
    frontiers: { outgoing: [...frontiers.outgoing], incoming: [...frontiers.incoming] },
    frontierOpen,
    truncated,
    scannedDocuments: scanned,
    inspectedArrayFieldIds: arrayFieldIds,
  };
  const step = await rt.store.appendStep(rt.actor, rt.run, 'discovery', payload, worldRevision);
  const added = [...selected.entries()].filter(([node]) => !before.has(node));
  return {
    worldRevision,
    stepOrdinal: step.ordinal,
    depth,
    depthCap: cap,
    selectedCount: selected.size,
    newRecordCount: added.length,
    newRecords: added.slice(0, SHOWN_RECORDS).map(([node, entry]) => ({
      handle: node,
      collectionId: entry.address.collectionId,
      recordId: entry.address.recordId,
      hop: entry.hop,
      via: entry.via,
    })),
    frontierOpen,
    truncated,
    scannedDocuments: scanned,
    moreAvailable: frontierOpen > 0 && WAYS.some((way) => frontiers[way].size > 0 && depths[way] < cap),
    stoppedByDepthCap:
      frontierOpen > 0 && WAYS.every((way) => frontiers[way].size === 0 || depths[way] >= cap),
  };
}

/** Hop 0: the subject's own record and every record holding an exact subject value in a visible identity field. */
export function seedEvidence(
  selected: Map<string, SelectedRecord>,
  resolution: { root: { address: SelectedRecord['address'] }; bindings: string[] },
  registry: ScopeRegistry,
  records: ReadonlyMap<string, readonly import('@expunge/mongo').ScannedRecord[]>,
  fields: readonly import('@expunge/contracts').FieldDescriptor[],
  roles: ReadonlyMap<string, string>,
): void {
  selected.set(nodeKey(resolution.root.address), {
    address: resolution.root.address,
    hop: 0,
    via: 'subject',
  });
  const bindings = new Set(resolution.bindings);
  const identity = fields.filter((field) => roles.get(field.fieldId) === 'identity');
  for (const collectionId of registry.collectionIds) {
    const collectionFields = identity.filter((field) => field.collectionId === collectionId);
    for (const record of records.get(collectionId) ?? []) {
      const key = nodeKey(record.address);
      if (selected.has(key)) continue;
      const hit = collectionFields.find((field) =>
        scalarsAt(record.document, field).some((scalar) => bindings.has(scalar.key)),
      );
      if (hit) selected.set(key, { address: record.address, hop: 0, via: `evidence:${hit.fieldId}` });
    }
  }
}
export { addressKey };
