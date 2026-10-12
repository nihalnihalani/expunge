import type { ClientSession, Document } from 'mongodb';
import { contentHash, type DomainAddress } from '@expunge/contracts';
import {
  assertWorldKey,
  fail,
  requirePrincipal,
  scopeFilter,
  type MongoService,
  type WorldKey,
} from '@expunge/mongo';

/** Sentinel node id of the marker row that says the edge index for a world revision is fully written. */
export const EDGE_INDEX_COMPLETE_NODE = '0'.repeat(64);
export const EDGE_INDEX_COMPLETE_ID = '__index_complete__';
export const MAX_REACH_HOPS = 5;
/** The registry an edge index was derived from: an index is valid only for that registry (the validator requires it). */
export const registryHashOf = (registry: unknown): string =>
  contentHash(registry as never, 'edge-index-registry');

export type EdgeDirection = 'incoming' | 'outgoing' | 'both';
export type EdgeRow = {
  edgeId: string;
  /** The registered field whose values produced the edge (the referencing side). */
  fieldId: string;
  from: DomainAddress;
  to: DomainAddress;
  fromNode: string;
  toNode: string;
};
export type Reached = {
  address: DomainAddress;
  node: string;
  hop: number;
  edgeId: string;
  direction: 'incoming' | 'outgoing';
};
type StoredEdge = EdgeRow & Document;

/**
 * Source-derived reference edges between records of one world, versioned by the world revision they were derived
 * at. Edges come from visible registered data only, never from an oracle. A traversal reads exactly one revision:
 * edges of an older revision cannot support a claim about the current state.
 */
export class IdentityEdgeRepository {
  constructor(readonly service: MongoService) {}

  private get collection() {
    return this.service.world.collection<StoredEdge>('identity_edges');
  }
  private bind(world: WorldKey, worldRevision: number) {
    assertWorldKey(world);
    if (!Number.isSafeInteger(worldRevision) || worldRevision < 0) fail('InvalidWorldRevision');
    return { ...scopeFilter(world), worldId: world.worldId, worldRevision };
  }

  /**
   * True when the edge index for this revision was fully written (the marker row exists). With `registryHash`, only an
   * index derived from that registry counts.
   */
  async isComplete(
    world: WorldKey,
    worldRevision: number,
    session?: ClientSession,
    registryHash?: string,
  ): Promise<boolean> {
    requirePrincipal(this.service, ['domain_executor', 'fixture_builder', 'setup']);
    const marker = await this.collection.findOne(
      {
        ...this.bind(world, worldRevision),
        edgeId: EDGE_INDEX_COMPLETE_ID,
        ...(registryHash === undefined ? {} : { registryHash }),
      },
      { session, projection: { _id: 1 } },
    );
    return marker !== null;
  }

  /**
   * Idempotent: an edge already present for this revision is kept. The marker is written separately. Every row carries
   * the hash of the registry it was derived from (`registryHashOf`), which the `identity_edges` validator requires.
   */
  async insertEdges(
    world: WorldKey,
    worldRevision: number,
    edges: EdgeRow[],
    registryHash: string,
  ): Promise<number> {
    requirePrincipal(this.service, ['domain_executor', 'fixture_builder', 'setup']);
    const binding = this.bind(world, worldRevision);
    const rows = edges.map((edge) => {
      const edgeKey = contentHash(
        { ...binding, registryHash, edgeId: edge.edgeId, fromNode: edge.fromNode, toNode: edge.toNode },
        'identity-edge',
      );
      return {
        _id: edgeKey,
        edgeKey,
        ...binding,
        scopeRevision: world.scopeRevision,
        registryHash,
        ...edge,
        createdAt: new Date(),
      };
    });
    let inserted = 0;
    for (let index = 0; index < rows.length; index += 500) {
      const part = rows.slice(index, index + 500);
      try {
        const result = await this.collection.insertMany(part as never[], { ordered: false });
        inserted += result.insertedCount;
      } catch (error) {
        const writeErrors = (error as { writeErrors?: Array<{ code?: number }> }).writeErrors;
        const insertedCount = (error as { result?: { insertedCount?: number } }).result?.insertedCount ?? 0;
        if (!writeErrors || writeErrors.some((entry) => entry.code !== 11000)) throw error;
        inserted += insertedCount;
      }
    }
    return inserted;
  }

  async markComplete(world: WorldKey, worldRevision: number, registryHash: string): Promise<void> {
    requirePrincipal(this.service, ['domain_executor', 'fixture_builder', 'setup']);
    const binding = this.bind(world, worldRevision);
    const markerKey = contentHash({ ...binding, registryHash, marker: true }, 'identity-edge-index');
    const marker: Document = {
      _id: markerKey,
      edgeKey: markerKey,
      ...binding,
      scopeRevision: world.scopeRevision,
      registryHash,
      edgeId: EDGE_INDEX_COMPLETE_ID,
      fieldId: '',
      fromNode: EDGE_INDEX_COMPLETE_NODE,
      toNode: EDGE_INDEX_COMPLETE_NODE,
      from: { collectionId: 'marker', recordId: 'marker', recordIdBsonType: 'string' },
      to: { collectionId: 'marker', recordId: 'marker', recordIdBsonType: 'string' },
      createdAt: new Date(),
    };
    try {
      await this.collection.insertOne(marker as never);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
    }
  }

  /** Edges (not counting the marker) written for this revision. */
  async count(world: WorldKey, worldRevision: number): Promise<number> {
    requirePrincipal(this.service, ['domain_executor', 'fixture_builder', 'setup']);
    return this.collection.countDocuments({
      ...this.bind(world, worldRevision),
      edgeId: { $ne: EDGE_INDEX_COMPLETE_ID },
    });
  }

  /**
   * Records reachable from `frontier` within `maxHops`, through the allowed edge declarations only, using a bounded
   * `$graphLookup` over the stored edges. Returns the nearest hop of each reached record and `truncated` when
   * `limit` stopped the walk. The frontier itself is never returned. Each direction is walked on its own, from the
   * frontier, and never turns back: a record is reached outgoing or incoming, and the result says which.
   */
  async reach(
    world: WorldKey,
    worldRevision: number,
    frontier: readonly string[],
    options: { direction: EdgeDirection; maxHops: number; edgeIds: readonly string[]; limit: number },
  ): Promise<{ reached: Reached[]; truncated: boolean }> {
    requirePrincipal(this.service, ['domain_executor', 'fixture_builder', 'setup']);
    const { direction, maxHops, edgeIds, limit } = options;
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > MAX_REACH_HOPS) fail('TraversalBounds');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) fail('TraversalBounds');
    if (frontier.length === 0 || edgeIds.length === 0) return { reached: [], truncated: false };
    if (frontier.length > 5000) fail('TraversalBounds');
    const binding = this.bind(world, worldRevision);
    const scope = { ...binding, edgeId: { $in: [...edgeIds] } };
    const frontierSet = new Set(frontier);
    const best = new Map<string, Reached>();
    let truncated = false;
    const directions: Array<'incoming' | 'outgoing'> =
      direction === 'both' ? ['outgoing', 'incoming'] : [direction];
    for (const way of directions) {
      const start = way === 'outgoing' ? 'fromNode' : 'toNode';
      const far = way === 'outgoing' ? 'toNode' : 'fromNode';
      const farAddress = way === 'outgoing' ? 'to' : 'from';
      const pipeline: Document[] = [
        { $match: { ...scope, [start]: { $in: [...frontier] } } },
        { $limit: limit + 1 },
      ];
      if (maxHops > 1) {
        pipeline.push({
          $graphLookup: {
            from: 'identity_edges',
            startWith: `$${far}`,
            connectFromField: far,
            connectToField: start,
            as: 'deeper',
            maxDepth: maxHops - 2,
            depthField: 'depth',
            restrictSearchWithMatch: scope,
          },
        });
      }
      pipeline.push({
        $project: {
          _id: 0,
          edgeId: 1,
          [farAddress]: 1,
          [far]: 1,
          ...(maxHops > 1
            ? {
                deeper: {
                  $map: {
                    input: '$deeper',
                    as: 'edge',
                    in: {
                      edgeId: '$$edge.edgeId',
                      [farAddress]: `$$edge.${farAddress}`,
                      [far]: `$$edge.${far}`,
                      depth: '$$edge.depth',
                    },
                  },
                },
              }
            : {}),
        },
      });
      const rows = await this.collection.aggregate<Document>(pipeline, { maxTimeMS: 10_000 }).toArray();
      if (rows.length > limit) truncated = true;
      const consider = (node: string, address: DomainAddress, hop: number, edgeId: string) => {
        if (frontierSet.has(node)) return;
        // One entry per node AND direction: a node reached by walking outgoing and again by walking incoming is two
        // facts, and a caller that continues from it must continue the way it came, never turn back.
        const key = `${way}|${node}`;
        const known = best.get(key);
        if (known && known.hop <= hop) return;
        best.set(key, { address, node, hop, edgeId, direction: way });
      };
      for (const row of rows.slice(0, limit)) {
        consider(row[far] as string, row[farAddress] as DomainAddress, 1, row.edgeId as string);
        for (const deeper of (row.deeper ?? []) as Document[])
          consider(
            deeper[far] as string,
            deeper[farAddress] as DomainAddress,
            (deeper.depth as number) + 2,
            deeper.edgeId as string,
          );
      }
    }
    const reached = [...best.values()].sort((a, b) => a.hop - b.hop || a.node.localeCompare(b.node));
    if (reached.length > limit) truncated = true;
    return { reached: reached.slice(0, limit), truncated };
  }
}
