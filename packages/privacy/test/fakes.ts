/**
 * FAKE in-memory doubles for the privacy ports. Every class here is a labeled test stand-in: none of it is evidence
 * about MongoDB, Atlas or Raindrop. The Mongo-backed suites use the real repositories instead.
 */
import type { ArtifactEligibility, ExternalErasureJob, ScopeKey } from '@expunge/contracts';
import type { ClosureBounds, ProvenanceClosure, RevokeResult } from '@expunge/mongo';
import type {
  ArtifactCatalog,
  ArtifactKind,
  EligibilityStore,
  ErasureStore,
  LessonRecord,
  LessonStore,
  ProjectionSink,
  ProvenancePort,
  RawArtifactStore,
  RawSource,
  RegenerationQueue,
  RetentionBoundary,
  RetentionBoundaryStore,
  RunObserver,
  SubjectTokenEntry,
  SubjectTokenStore,
  Tombstone,
} from '../src/index.js';

export const SCOPE: ScopeKey = { tenantId: 'tenant-p', env: 'evaluation', scopeId: 'scope-p' };
export const POLICY = 'owner-policy-v1';
const k = (id: string) => id;

export class FakeEligibility implements EligibilityStore {
  readonly rows = new Map<string, ArtifactEligibility>();
  readonly log: string[] = [];
  async permit(scope: ScopeKey, hash: string, policyHash: string, reasonCode: string) {
    this.log.push(`permit:${hash}`);
    if (!this.rows.has(k(hash)))
      this.rows.set(k(hash), {
        ...scope,
        artifactHash: hash,
        state: 'permitted',
        policyHash,
        reasonCode,
        sourceIds: [],
        updatedAt: new Date(),
      });
  }
  async get(_scope: ScopeKey, hash: string) {
    return this.rows.get(k(hash)) ?? null;
  }
  async listBySource(_scope: ScopeKey, sourceId: string, after: string | null, limit: number) {
    return [...this.rows.values()]
      .filter((row) => row.sourceIds.includes(sourceId) && (after === null || row.artifactHash > after))
      .sort((a, b) => (a.artifactHash < b.artifactHash ? -1 : 1))
      .slice(0, limit);
  }
  async markSourceDeleted(_scope: ScopeKey, hash: string, policyHash: string, reasonCode: string) {
    const row = this.rows.get(k(hash));
    if (row) Object.assign(row, { state: 'source_deleted', policyHash, reasonCode });
  }
  revoke(scope: ScopeKey, hash: string, sourceId: string, policyHash: string, reasonCode: string) {
    const row =
      this.rows.get(k(hash)) ??
      ({
        ...scope,
        artifactHash: hash,
        state: 'permitted',
        policyHash,
        reasonCode,
        sourceIds: [],
        updatedAt: new Date(),
      } as ArtifactEligibility);
    row.state = 'revoked';
    row.policyHash = policyHash;
    row.reasonCode = reasonCode;
    if (!row.sourceIds.includes(sourceId)) row.sourceIds.push(sourceId);
    this.rows.set(k(hash), row);
  }
}

/** A bounded breadth-first closure with the repository's observable behavior: persisted frontier, fail-closed permitted. */
export class FakeProvenance implements ProvenancePort {
  readonly edges: Array<{ fromId: string; toId: string; kind: string }> = [];
  readonly closures = new Map<
    string,
    { frontier: string[]; discovered: string[]; complete: boolean; rounds: number }
  >();
  constructor(
    readonly eligibility: FakeEligibility,
    private readonly nodesPerCall = 1000,
  ) {}
  async append(_key: ScopeKey, fromId: string, toId: string, kind: 'derived_from' | 'source_deleted') {
    if (!this.edges.some((e) => e.fromId === fromId && e.toId === toId && e.kind === kind))
      this.edges.push({ fromId, toId, kind });
  }
  async revoke(
    key: ScopeKey,
    sourceId: string,
    policyHash: string,
    reasonCode: string,
    options: ClosureBounds = {},
  ): Promise<RevokeResult> {
    const limit = options.maxNodes ?? this.nodesPerCall;
    let closure = this.closures.get(sourceId);
    const added: string[] = [];
    if (!closure) {
      closure = { frontier: [sourceId], discovered: [sourceId], complete: false, rounds: 0 };
      this.closures.set(sourceId, closure);
      this.eligibility.revoke(key, sourceId, sourceId, policyHash, reasonCode);
      added.push(sourceId);
    }
    let budget = limit;
    while (closure.frontier.length && budget > 0) {
      const parent = closure.frontier.shift()!;
      for (const edge of this.edges.filter((e) => e.fromId === parent && e.kind === 'derived_from')) {
        if (closure.discovered.includes(edge.toId)) continue;
        closure.discovered.push(edge.toId);
        closure.frontier.push(edge.toId);
        this.eligibility.revoke(key, edge.toId, sourceId, policyHash, reasonCode);
        added.push(edge.toId);
        budget--;
      }
      closure.rounds++;
    }
    closure.complete = closure.frontier.length === 0;
    return {
      closureId: `closure:${sourceId}`,
      ids: added,
      complete: closure.complete,
      frontier: [...closure.frontier],
      discovered: closure.discovered.length,
      rounds: closure.rounds,
      stalledReason: closure.complete ? null : 'node_budget',
    };
  }
  async closure(_key: ScopeKey, sourceId: string): Promise<ProvenanceClosure | null> {
    const c = this.closures.get(sourceId);
    return c ? ({ sourceId, status: c.complete ? 'complete' : 'open' } as ProvenanceClosure) : null;
  }
  /** Fail closed: a hash is permitted only if it and EVERY ancestor are permitted AND no revoked closure is still open above it. */
  async permitted(_key: ScopeKey, hashes: string[]): Promise<string[]> {
    const openSources = [...this.closures.entries()].filter(([, c]) => !c.complete).map(([id]) => id);
    const ancestors = (hash: string, seen = new Set<string>()): string[] => {
      if (seen.has(hash)) return [];
      seen.add(hash);
      return this.edges
        .filter((e) => e.toId === hash)
        .flatMap((e) => [e.fromId, ...ancestors(e.fromId, seen)]);
    };
    return hashes.filter((hash) => {
      if (this.eligibility.rows.get(hash)?.state !== 'permitted') return false;
      const above = ancestors(hash);
      if (above.some((a) => this.eligibility.rows.get(a)?.state !== 'permitted')) return false;
      return !above.some((a) => openSources.includes(a));
    });
  }
}

export class FakeRawStore implements RawArtifactStore {
  readonly rows = new Map<string, { source: RawSource; content: string | null }>();
  readonly tombstones = new Map<string, Tombstone>();
  async put(_scope: ScopeKey, source: RawSource, content: string | null) {
    if (this.rows.has(source.sourceId)) return 'exists' as const;
    this.rows.set(source.sourceId, { source, content });
    return 'created' as const;
  }
  async get(_scope: ScopeKey, sourceId: string) {
    return this.rows.get(sourceId) ?? null;
  }
  async tombstone(_scope: ScopeKey, tombstone: Tombstone) {
    this.rows.delete(tombstone.sourceId);
    this.tombstones.set(tombstone.sourceId, tombstone);
  }
  async getTombstone(_scope: ScopeKey, sourceId: string) {
    return this.tombstones.get(sourceId) ?? null;
  }
}

export class FakeSubjectTokens implements SubjectTokenStore {
  readonly entries: SubjectTokenEntry[] = [];
  async put(_scope: ScopeKey, entry: SubjectTokenEntry) {
    const exists = this.entries.some(
      (e) =>
        e.subjectHandle === entry.subjectHandle &&
        e.provider === entry.provider &&
        e.tokenGeneration === entry.tokenGeneration,
    );
    if (!exists) this.entries.push(entry);
    return exists ? ('exists' as const) : ('created' as const);
  }
  async list() {
    return [...this.entries];
  }
  async tokensFor(_scope: ScopeKey, subjectHandle: string, provider: string) {
    return this.entries
      .filter((e) => e.subjectHandle === subjectHandle && e.provider === provider)
      .flatMap((e) => e.tokens);
  }
}

export class FakeLessons implements LessonStore {
  readonly rows = new Map<string, LessonRecord>();
  async put(_scope: ScopeKey, lesson: LessonRecord) {
    if (this.rows.has(lesson.lessonId)) return 'exists' as const;
    this.rows.set(lesson.lessonId, lesson);
    return 'created' as const;
  }
  async get(_scope: ScopeKey, id: string) {
    return this.rows.get(id) ?? null;
  }
  async list() {
    return [...this.rows.values()];
  }
}

export class StaticCatalog implements ArtifactCatalog {
  constructor(private readonly kinds: Record<string, ArtifactKind>) {}
  async classify(_scope: ScopeKey, id: string): Promise<ArtifactKind> {
    return this.kinds[id] ?? 'unknown';
  }
}

export class FakeRuns implements RunObserver {
  constructor(private readonly jobsByHash: Record<string, string[]> = {}) {}
  async cancelledRuns(_scope: ScopeKey, ids: string[]) {
    return ids.flatMap((id) => this.jobsByHash[id] ?? []);
  }
}

export class FakeRegeneration implements RegenerationQueue {
  readonly requests: Array<{
    artifactHash: string;
    kind: ArtifactKind;
    sourceId: string;
    policyHash: string;
  }> = [];
  async enqueue(
    _scope: ScopeKey,
    request: { artifactHash: string; kind: ArtifactKind; sourceId: string; policyHash: string },
  ) {
    if (
      !this.requests.some((r) => r.artifactHash === request.artifactHash && r.sourceId === request.sourceId)
    )
      this.requests.push(request);
  }
}

export class RecordingProjection implements ProjectionSink {
  readonly events: Array<{ eventId: string; kind: string; payload: any; jobId: string }> = [];
  async append(
    _scope: ScopeKey,
    event: {
      eventId: string;
      jobId: string;
      runId: string;
      artifactIds: string[];
      kind: string;
      payload: unknown;
    },
  ) {
    this.events.push({
      eventId: event.eventId,
      kind: event.kind,
      payload: event.payload,
      jobId: event.jobId,
    });
  }
}

export class FakeErasureStore implements ErasureStore {
  readonly rows = new Map<string, ExternalErasureJob>();
  async insert(job: ExternalErasureJob) {
    if (this.rows.has(job.requestKey)) return 'exists' as const;
    this.rows.set(job.requestKey, structuredClone(job));
    return 'created' as const;
  }
  async get(_scope: ScopeKey, requestKey: string) {
    const row = this.rows.get(requestKey);
    return row ? structuredClone(row) : null;
  }
  async replace(job: ExternalErasureJob, expectedHistoryLength: number) {
    const row = this.rows.get(job.requestKey);
    if (!row || row.history.length !== expectedHistoryLength) return false;
    this.rows.set(job.requestKey, structuredClone(job));
    return true;
  }
  async listSuppressing(providerOrganizationId: string) {
    return [...this.rows.values()]
      .filter(
        (job) =>
          job.localExportSuppression === 'active' && job.providerOrganizationId === providerOrganizationId,
      )
      .map((job) => structuredClone(job));
  }
}

export class FakeBoundaries implements RetentionBoundaryStore {
  readonly rows: RetentionBoundary[] = [];
  async put(boundary: RetentionBoundary) {
    const exists = this.rows.some((r) => r.provider === boundary.provider);
    if (!exists) this.rows.push(boundary);
    return exists ? ('exists' as const) : ('created' as const);
  }
  async list() {
    return [...this.rows];
  }
}

/** FAKE purger: records every purge so a test can see which bytes were removed and why. */
export class FakePurger {
  readonly purged: Array<{ id: string; kind: string; reason: string }> = [];
  async purge(_scope: ScopeKey, id: string, kind: string, reason: string) {
    this.purged.push({ id, kind, reason });
    return 'purged' as const;
  }
}
export const ORG = 'org-1';
