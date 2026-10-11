import type { ClientSession, Document } from 'mongodb';
import {
  contentHash,
  type ArtifactEligibility,
  type ProvenanceEdge,
  type ScopeKey,
} from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

/**
 * Provenance graph traversal and revocation.
 *
 * Edges point from a source (`fromId`) to what was derived from it (`toId`). Revoking a source must reach
 * every descendant, however many there are. The closure is therefore a bounded, resumable breadth-first walk:
 * each call does a limited amount of work, persists its frontier in `provenance_closures`, and reports
 * `complete: false` until nothing is left to expand. Incomplete never means "nothing more to revoke":
 * `permitted` re-derives ancestry at read time and denies everything that has a revoked or unresolved ancestor.
 */

export type ClosureBounds = {
  /** Edge queries per call. */
  maxRounds?: number;
  /** Newly discovered nodes (and edges read per query) per call. */
  maxNodes?: number;
  /** Parent nodes expanded by one edge query. */
  batchSize?: number;
  /** Recent edges the final settling scan may read before it gives up and leaves the closure open. */
  maxSettleEdges?: number;
};
export type ClosureResult = {
  /** Descendants discovered by this call, excluding the source for `descendants`. */
  ids: string[];
  complete: boolean;
  /** Discovered nodes whose children have not been read yet. */
  frontier: string[];
};
export type RevokeOptions = ClosureBounds & {
  /** Called after every persisted round. A seam for progress reporting and fault injection in tests. */
  onRound?: (progress: { round: number; frontier: string[]; discovered: number }) => Promise<void>;
};
export type RevokeResult = ClosureResult & {
  closureId: string;
  /** Nodes revoked so far for this source across all calls, including the source. */
  discovered: number;
  rounds: number;
  /** Why the walk cannot make progress, or null. */
  stalledReason: string | null;
};
export type ClosureStatus = 'open' | 'complete';
export type ProvenanceClosure = ScopeKey & {
  _id: string;
  sourceId: string;
  policyHash: string;
  reasonCode: string;
  status: ClosureStatus;
  /** Discovered, not yet expanded. Excludes the chunk named by `expanding`. */
  frontier: string[];
  /** Parents whose child edges are being read in pages, with the edge key already consumed. */
  expanding: { parents: string[]; after: string | null } | null;
  stalledReason: string | null;
  discovered: number;
  rounds: number;
  revision: number;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export const CLOSURE_DEFAULT_BOUNDS = {
  maxRounds: 32,
  maxNodes: 5000,
  batchSize: 200,
  maxSettleEdges: 50_000,
} as const;
/** The persisted frontier is part of one document, so it is capped well below the 16 MB document limit. */
export const CLOSURE_MAX_FRONTIER = 20_000;
/** Ancestry checked by `permitted`: edges read and levels climbed before the answer becomes "deny". */
export const ANCESTRY_MAX_EDGES = 10_000;
export const ANCESTRY_MAX_LEVELS = 32;
export const RETRIEVAL_MAX_HASHES = 500;
/** Edges created this long before a closure started are still re-checked when settling, for clock skew. */
export const SETTLE_CLOCK_SKEW_MS = 10_000;

const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled'];
const WRITE_CHUNK = 1000;
const QUERY_TIME_MS = 5000;

type Bounds = Required<ClosureBounds>;
type EdgeRow = { edgeKey: string; fromId: string; toId: string };
type Expanding = ProvenanceClosure['expanding'];
type Eligibility = Document & ArtifactEligibility & { _id?: unknown };

function resolveBounds(bounds: ClosureBounds = {}): Bounds {
  const merged = { ...CLOSURE_DEFAULT_BOUNDS, ...bounds };
  const check = (value: number, max: number) => {
    if (!Number.isInteger(value) || value < 1 || value > max) fail('TraversalBounds');
  };
  check(merged.maxRounds, 1000);
  check(merged.maxNodes, 100_000);
  check(merged.batchSize, 1000);
  check(merged.maxSettleEdges, 5_000_000);
  return merged;
}
function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
}

export class ProvenanceRepository {
  constructor(readonly service: MongoService) {}

  private get edges() {
    return this.service.control.collection<EdgeRow & Document>('provenance_edges');
  }
  private get eligibility() {
    return this.service.control.collection<Eligibility>('artifact_eligibility');
  }
  private get closures() {
    return this.service.control.collection<ProvenanceClosure>('provenance_closures');
  }

  async append(
    key: ScopeKey,
    fromId: string,
    toId: string,
    kind: ProvenanceEdge['kind'],
    session?: ClientSession,
  ): Promise<void> {
    requirePrincipal(this.service, [
      'observer',
      'proposer',
      'promoter',
      'privacy_controller',
      'grader',
      'fixture_builder',
      'setup',
    ]);
    const edgeKey = contentHash({ ...scopeFilter(key), fromId, toId, kind }, 'provenance-edge');
    try {
      await this.service.control
        .collection<Document & { _id: string }>('provenance_edges')
        .insertOne(
          { _id: edgeKey, ...scopeFilter(key), edgeKey, fromId, toId, kind, createdAt: new Date() },
          { session },
        );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  /**
   * Bounded, read-only breadth-first closure. `complete` is false when a bound stopped the walk; `frontier`
   * then names the nodes whose children were not read. It never silently drops descendants.
   */
  async descendants(key: ScopeKey, sourceId: string, bounds?: ClosureBounds): Promise<ClosureResult> {
    const limits = resolveBounds(bounds);
    const visited = new Set<string>([sourceId]);
    const found: string[] = [];
    const frontier: string[] = [sourceId];
    let expanding: Expanding = null;
    for (let round = 0; round < limits.maxRounds && (expanding || frontier.length); round++) {
      expanding ??= { parents: frontier.splice(0, limits.batchSize), after: null };
      const room = Math.min(limits.maxNodes - found.length, CLOSURE_MAX_FRONTIER - frontier.length);
      if (room < 1) break;
      const page = await this.readChildren(key, expanding.parents, expanding.after, room);
      for (const edge of page.edges) {
        if (visited.has(edge.toId)) continue;
        visited.add(edge.toId);
        found.push(edge.toId);
        frontier.push(edge.toId);
      }
      expanding = page.exhausted ? null : { parents: expanding.parents, after: page.edges.at(-1)!.edgeKey };
    }
    return {
      ids: found,
      complete: !expanding && frontier.length === 0,
      frontier: [...(expanding?.parents ?? []), ...frontier],
    };
  }

  /**
   * Revokes `sourceId` and everything derived from it. Call again with the same arguments to resume until
   * `complete` is true; each call is bounded. Until then retrieval stays closed to the unresolved set (see
   * `permitted`). Running jobs holding any revoked hash in their harness binding or context inputs are
   * cancelled as soon as the hash is discovered.
   */
  async revoke(
    key: ScopeKey,
    sourceId: string,
    policyHash: string,
    reasonCode: string,
    options: RevokeOptions = {},
  ): Promise<RevokeResult> {
    requirePrincipal(this.service, ['privacy_controller', 'setup']);
    const limits = resolveBounds(options);
    const started = await this.startClosure(key, sourceId, policyHash, reasonCode);
    let closure = started.closure;
    const revoked: string[] = started.created ? [sourceId] : [];
    let addedThisCall = 0;
    let stalledReason: string | null = null;

    for (let round = 0; round < limits.maxRounds && closure.status === 'open'; round++) {
      try {
        const step =
          closure.expanding || closure.frontier.length
            ? await this.expandRound(key, closure, limits, addedThisCall)
            : await this.settleRound(key, closure, limits, addedThisCall);
        closure = step.closure;
        revoked.push(...step.added);
        addedThisCall += step.added.length;
        stalledReason = step.stalledReason;
      } catch (error) {
        // Another caller advanced the same closure. Continue from the stored state.
        if (!(error instanceof Error) || error.message !== 'StaleClosure') throw error;
        closure = await this.loadClosure(closure._id);
        continue;
      }
      await options.onRound?.({
        round,
        frontier: this.frontierOf(closure),
        discovered: closure.discovered,
      });
      if (stalledReason) break;
    }
    return {
      closureId: closure._id,
      ids: revoked,
      complete: closure.status === 'complete',
      frontier: this.frontierOf(closure),
      discovered: closure.discovered,
      rounds: closure.rounds,
      stalledReason: closure.status === 'complete' ? null : (stalledReason ?? closure.stalledReason),
    };
  }

  async closure(key: ScopeKey, sourceId: string): Promise<ProvenanceClosure | null> {
    return this.closures.findOne({ _id: this.closureId(key, sourceId) });
  }

  /**
   * Returns the subset of `hashes` that may enter model context now: scoped eligibility is `permitted` and no
   * ancestor is revoked, deleted or unresolvable within the ancestry bounds. Because ancestry is read here, a
   * descendant not yet reached by an incomplete revocation closure is still denied.
   */
  async permitted(key: ScopeKey, hashes: string[], session?: ClientSession): Promise<string[]> {
    if (hashes.length > RETRIEVAL_MAX_HASHES) fail('RetrievalBounds');
    const rows = await this.eligibility
      .find({ ...scopeFilter(key), artifactHash: { $in: hashes }, state: 'permitted' }, { session })
      .toArray();
    const candidates = rows.map((row) => row.artifactHash);
    const blocked = await this.blockedByAncestry(key, candidates, session);
    return candidates.filter((hash) => !blocked.has(hash));
  }

  /**
   * The subset of `hashes` that must not be activated: their own eligibility is revoked, deleted or otherwise
   * not `permitted`, or an ancestor's is, or ancestry could not be read within bounds. Unlike `permitted`, a
   * hash with no eligibility row at all is not tainted: promotion targets need not be retrieval-registered.
   */
  async tainted(key: ScopeKey, hashes: string[], session?: ClientSession): Promise<Set<string>> {
    if (hashes.length > RETRIEVAL_MAX_HASHES) fail('RetrievalBounds');
    const own = await this.nonPermittedAmong(key, hashes, session);
    const rest = hashes.filter((hash) => !own.has(hash));
    const lineage = await this.blockedByAncestry(key, rest, session);
    return new Set([...own, ...lineage]);
  }

  /** Candidates with a non-permitted ancestor, or whose ancestry could not be fully read within bounds. */
  private async blockedByAncestry(
    key: ScopeKey,
    candidates: string[],
    session?: ClientSession,
  ): Promise<Set<string>> {
    const blocked = new Set<string>();
    const traced = new Map<string, Set<string>>();
    let level = new Map<string, Set<string>>(candidates.map((hash) => [hash, new Set([hash])]));
    let edgeBudget = ANCESTRY_MAX_EDGES;

    for (let depth = 0; depth < ANCESTRY_MAX_LEVELS && level.size > 0; depth++) {
      const parents = new Map<string, Set<string>>();
      for (const nodes of chunks([...level.keys()], 500)) {
        const rows = await this.edges
          .find(
            { ...scopeFilter(key), toId: { $in: nodes } },
            {
              projection: { _id: 0, fromId: 1, toId: 1 },
              limit: edgeBudget + 1,
              maxTimeMS: QUERY_TIME_MS,
              session,
            },
          )
          .toArray();
        edgeBudget -= rows.length;
        if (edgeBudget < 0) {
          for (const owners of level.values()) for (const hash of owners) blocked.add(hash);
          return blocked;
        }
        for (const edge of rows) {
          for (const hash of level.get(edge.toId) ?? []) {
            if (blocked.has(hash) || traced.get(edge.fromId)?.has(hash)) continue;
            if (!traced.has(edge.fromId)) traced.set(edge.fromId, new Set());
            traced.get(edge.fromId)!.add(hash);
            if (!parents.has(edge.fromId)) parents.set(edge.fromId, new Set());
            parents.get(edge.fromId)!.add(hash);
          }
        }
      }
      const barred = await this.nonPermittedAmong(key, [...parents.keys()], session);
      level = new Map();
      for (const [parent, owners] of parents) {
        if (barred.has(parent)) {
          for (const hash of owners) blocked.add(hash);
          continue;
        }
        const remaining = new Set([...owners].filter((hash) => !blocked.has(hash)));
        if (remaining.size > 0) level.set(parent, remaining);
      }
    }
    // Levels exhausted with ancestry still unread: deny rather than assume the rest is clean.
    for (const owners of level.values()) for (const hash of owners) blocked.add(hash);
    return blocked;
  }

  private async nonPermittedAmong(
    key: ScopeKey,
    ids: string[],
    session?: ClientSession,
  ): Promise<Set<string>> {
    const barred = new Set<string>();
    for (const part of chunks(ids, 1000)) {
      const rows = await this.eligibility
        .find(
          { ...scopeFilter(key), artifactHash: { $in: part }, state: { $ne: 'permitted' } },
          { projection: { artifactHash: 1 }, session },
        )
        .toArray();
      for (const row of rows) barred.add(row.artifactHash);
    }
    return barred;
  }

  private closureId(key: ScopeKey, sourceId: string): string {
    return contentHash({ ...scopeFilter(key), sourceId }, 'provenance-closure');
  }
  private frontierOf(closure: ProvenanceClosure): string[] {
    return [...(closure.expanding?.parents ?? []), ...closure.frontier];
  }
  private async loadClosure(closureId: string): Promise<ProvenanceClosure> {
    const row = await this.closures.findOne({ _id: closureId });
    if (!row) fail('ClosureNotFound');
    return row;
  }

  private async startClosure(
    key: ScopeKey,
    sourceId: string,
    policyHash: string,
    reasonCode: string,
  ): Promise<{ closure: ProvenanceClosure; created: boolean }> {
    const closureId = this.closureId(key, sourceId);
    const existing = await this.closures.findOne({ _id: closureId });
    if (existing) return { closure: existing, created: false };
    const now = new Date();
    const closure: ProvenanceClosure = {
      _id: closureId,
      ...scopeFilter(key),
      sourceId,
      policyHash,
      reasonCode,
      status: 'open',
      frontier: [sourceId],
      expanding: null,
      stalledReason: null,
      discovered: 1,
      rounds: 0,
      revision: 0,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    };
    try {
      await this.service.transaction(async (session) => {
        await this.markRevoked(key, [sourceId], closure, session);
        await this.closures.insertOne(closure, { session });
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return { closure: await this.loadClosure(closureId), created: false };
    }
    await this.cancelJobs(key, [sourceId]);
    return { closure, created: true };
  }

  private async readChildren(
    key: ScopeKey,
    parents: string[],
    after: string | null,
    limit: number,
  ): Promise<{ edges: EdgeRow[]; exhausted: boolean }> {
    const rows = await this.edges
      .find(
        {
          ...scopeFilter(key),
          fromId: { $in: parents },
          ...(after === null ? {} : { edgeKey: { $gt: after } }),
        },
        { projection: { _id: 0, edgeKey: 1, fromId: 1, toId: 1 }, sort: { edgeKey: 1 }, limit: limit + 1 },
      )
      .maxTimeMS(QUERY_TIME_MS)
      .toArray();
    return { edges: rows.slice(0, limit), exhausted: rows.length <= limit };
  }

  /** Subset of `ids` already revoked on behalf of this closure's source. */
  private async knownForClosure(closure: ProvenanceClosure, ids: string[]): Promise<Set<string>> {
    const known = new Set<string>();
    for (const part of chunks(ids, 1000)) {
      const rows = await this.eligibility
        .find(
          { ...scopeFilter(closure), artifactHash: { $in: part }, sourceIds: closure.sourceId },
          { projection: { artifactHash: 1 } },
        )
        .toArray();
      for (const row of rows) known.add(row.artifactHash);
    }
    return known;
  }

  private async expandRound(
    key: ScopeKey,
    closure: ProvenanceClosure,
    limits: Bounds,
    addedThisCall: number,
  ): Promise<RoundOutcome> {
    const frontier = [...closure.frontier];
    const expanding: Expanding = closure.expanding ?? {
      parents: frontier.splice(0, limits.batchSize),
      after: null,
    };
    const room = Math.min(limits.maxNodes - addedThisCall, CLOSURE_MAX_FRONTIER - frontier.length);
    if (room < 1) {
      const reason = addedThisCall >= limits.maxNodes ? 'node_budget' : 'frontier_capacity';
      return { closure, added: [], stalledReason: reason };
    }
    const page = await this.readChildren(key, expanding.parents, expanding.after, room);
    const children = [...new Set(page.edges.map((edge) => edge.toId))];
    const known = await this.knownForClosure(closure, children);
    const added = children.filter((child) => !known.has(child));
    const next: Pick<ProvenanceClosure, 'frontier' | 'expanding'> = {
      frontier: [...frontier, ...added],
      expanding: page.exhausted ? null : { parents: expanding.parents, after: page.edges.at(-1)!.edgeKey },
    };
    return this.commitRound(key, closure, added, next);
  }

  /**
   * With the frontier empty, look for edges written since the closure began whose parent is already revoked.
   * Those derivations were added after their parent was expanded; they re-enter the frontier. When none are
   * found the closure is complete.
   */
  private async settleRound(
    key: ScopeKey,
    closure: ProvenanceClosure,
    limits: Bounds,
    addedThisCall: number,
  ): Promise<RoundOutcome> {
    const room = Math.min(limits.maxNodes - addedThisCall, CLOSURE_MAX_FRONTIER);
    if (room < 1) return { closure, added: [], stalledReason: 'node_budget' };
    const cutoff = new Date(closure.startedAt.getTime() - SETTLE_CLOCK_SKEW_MS);
    const missed = new Set<string>();
    let after: string | null = null;
    let scanned = 0;
    for (;;) {
      const page: Array<EdgeRow & Document> = await this.edges
        .find(
          {
            ...scopeFilter(key),
            createdAt: { $gte: cutoff },
            ...(after === null ? {} : { edgeKey: { $gt: after } }),
          },
          { projection: { _id: 0, edgeKey: 1, fromId: 1, toId: 1 }, sort: { edgeKey: 1 }, limit: 1000 },
        )
        .maxTimeMS(QUERY_TIME_MS)
        .toArray();
      if (page.length === 0) break;
      after = page[page.length - 1]!.edgeKey;
      scanned += page.length;
      const revokedParents = await this.knownForClosure(closure, [
        ...new Set(page.map((edge) => edge.fromId)),
      ]);
      const children = [
        ...new Set(page.filter((edge) => revokedParents.has(edge.fromId)).map((edge) => edge.toId)),
      ];
      const known = await this.knownForClosure(closure, children);
      for (const child of children) if (!known.has(child)) missed.add(child);
      if (missed.size >= room) break;
      if (scanned > limits.maxSettleEdges) {
        return { closure, added: [], stalledReason: 'settle_window' };
      }
    }
    if (missed.size === 0) return this.commitRound(key, closure, [], null);
    const added = [...missed].slice(0, room);
    return this.commitRound(key, closure, added, { frontier: added, expanding: null });
  }

  /** `next === null` closes the closure. One transaction: mark, advance the frontier, compare-and-swap. */
  private async commitRound(
    key: ScopeKey,
    closure: ProvenanceClosure,
    added: string[],
    next: Pick<ProvenanceClosure, 'frontier' | 'expanding'> | null,
  ): Promise<RoundOutcome> {
    const now = new Date();
    const patch =
      next === null
        ? { status: 'complete' as const, frontier: [], expanding: null, completedAt: now }
        : { status: 'open' as const, ...next, completedAt: null };
    await this.service.transaction(async (session) => {
      await this.markRevoked(key, added, closure, session);
      const result = await this.closures.updateOne(
        { _id: closure._id, revision: closure.revision },
        {
          $set: { ...patch, stalledReason: null, updatedAt: now },
          $inc: { revision: 1, rounds: 1, discovered: added.length },
        },
        { session },
      );
      if (result.matchedCount !== 1) fail('StaleClosure');
    });
    // A job may have recorded one of these hashes while the transaction was in flight.
    await this.cancelJobs(key, added);
    return {
      closure: {
        ...closure,
        ...patch,
        stalledReason: null,
        updatedAt: now,
        revision: closure.revision + 1,
        rounds: closure.rounds + 1,
        discovered: closure.discovered + added.length,
      },
      added,
      stalledReason: null,
    };
  }

  private async markRevoked(
    key: ScopeKey,
    ids: string[],
    closure: Pick<ProvenanceClosure, 'sourceId' | 'policyHash' | 'reasonCode'>,
    session: ClientSession,
  ): Promise<void> {
    for (const part of chunks(ids, WRITE_CHUNK)) {
      await this.eligibility.bulkWrite(
        part.map((artifactHash) => ({
          updateOne: {
            filter: { ...scopeFilter(key), artifactHash },
            update: {
              $set: {
                state: 'revoked' as const,
                policyHash: closure.policyHash,
                reasonCode: closure.reasonCode,
                updatedAt: new Date(),
              },
              $addToSet: { sourceIds: closure.sourceId },
            },
            upsert: true,
          },
        })),
        { session, ordered: false },
      );
    }
    await this.cancelJobs(key, ids, session);
  }

  /** Cancels live jobs whose pinned harness or any recorded context input is one of `ids`. */
  private async cancelJobs(key: ScopeKey, ids: string[], session?: ClientSession): Promise<void> {
    for (const part of chunks(ids, WRITE_CHUNK)) {
      await this.service.control.collection<Document>('jobs').updateMany(
        {
          'actor.tenantId': key.tenantId,
          'actor.env': key.env,
          'actor.scopeId': key.scopeId,
          status: { $nin: TERMINAL_JOB_STATES },
          $or: [{ 'binding.harnessHash': { $in: part } }, { contextInputs: { $in: part } }],
        },
        { $set: { cancellationRequested: true }, $currentDate: { updatedAt: true } },
        { session },
      );
    }
  }
}

type RoundOutcome = { closure: ProvenanceClosure; added: string[]; stalledReason: string | null };
