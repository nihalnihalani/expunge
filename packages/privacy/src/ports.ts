import type {
  ArtifactEligibility,
  ExternalErasureJob,
  JsonValue,
  ProvenanceEdge,
  ScopeKey,
} from '@expunge/contracts';
import type { ClosureBounds, ProvenanceClosure, RevokeResult } from '@expunge/mongo';

/**
 * Ports of the privacy package. Everything here is an interface over storage or a provider, so the protocols
 * (retraction, scan, erasure) are pure logic that runs against the real repositories or against labeled fakes.
 */

/** The slice of `ProvenanceRepository` (packages/mongo/src/provenance.ts) the privacy package uses. */
export interface ProvenancePort {
  append(key: ScopeKey, fromId: string, toId: string, kind: ProvenanceEdge['kind']): Promise<void>;
  revoke(
    key: ScopeKey,
    sourceId: string,
    policyHash: string,
    reasonCode: string,
    options?: ClosureBounds,
  ): Promise<RevokeResult>;
  closure(key: ScopeKey, sourceId: string): Promise<ProvenanceClosure | null>;
  permitted(key: ScopeKey, hashes: string[]): Promise<string[]>;
}

/** Closed vocabulary of what the privacy package can be asked to register or retract. */
export const SOURCE_KINDS = [
  'telemetry_event',
  'trace',
  'transcript',
  'evidence_bundle',
  'tool_output',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type RawSource = {
  sourceId: string;
  kind: SourceKind;
  /** sha256 of the content. Hash-only sources keep nothing else. */
  contentSha256: string;
  sizeBytes: number;
  /** `raw`: the bytes are in `raw_artifacts` (deletable); `hash_only`: only the hash and size are kept. */
  retention: 'raw' | 'hash_only';
  registeredAt: Date;
};

/**
 * What remains after a source is deleted. Deliberately NO content hash (a hash of low-entropy personal content is
 * still a handle on it), no size and no content: only that the source existed, when it was removed and why.
 */
export type Tombstone = {
  sourceId: string;
  kind: SourceKind;
  deletedAt: Date;
  /** One of RETRACTION_REASONS. */
  reasonCode: string;
  policyHash: string;
  /** The `provenance_closures` `_id` of the closure that reached this source, or null when none ran. */
  closureId: string | null;
};

export interface RawArtifactStore {
  put(scope: ScopeKey, source: RawSource, content: string | null): Promise<'created' | 'exists'>;
  get(scope: ScopeKey, sourceId: string): Promise<{ source: RawSource; content: string | null } | null>;
  /** Replaces the row (record and bytes) with a tombstone. Idempotent. */
  tombstone(scope: ScopeKey, tombstone: Tombstone): Promise<void>;
  getTombstone(scope: ScopeKey, sourceId: string): Promise<Tombstone | null>;
}

export type SubjectTokenEntry = {
  /** A subject literal. It never leaves the privacy controller's collection. */
  subjectHandle: string;
  provider: string;
  tokenGeneration: number;
  /** Opaque provider-side identities the handle maps to (e.g. Raindrop telemetry user ids). */
  tokens: string[];
  registeredAt: Date;
};
export interface SubjectTokenStore {
  put(scope: ScopeKey, entry: SubjectTokenEntry): Promise<'created' | 'exists'>;
  /** At most `limit` entries (the repository caps it at 5000). */
  list(scope: ScopeKey, limit?: number): Promise<SubjectTokenEntry[]>;
  tokensFor(scope: ScopeKey, subjectHandle: string, provider: string): Promise<string[]>;
}

export type LessonRecord = {
  lessonId: string;
  moduleId: string;
  family: string;
  /** Structural learning only: closed-vocabulary ids, counts, hashes. Never raw source text. */
  structure: JsonValue;
  retention: 'structural';
  sourceIds: string[];
  policyHash: string;
  registeredAt: Date;
};
export interface LessonStore {
  put(scope: ScopeKey, lesson: LessonRecord): Promise<'created' | 'exists'>;
  get(scope: ScopeKey, lessonId: string): Promise<LessonRecord | null>;
  list(scope: ScopeKey): Promise<LessonRecord[]>;
}

/** `artifact_eligibility` as the privacy controller writes it. */
export interface EligibilityStore {
  permit(scope: ScopeKey, artifactHash: string, policyHash: string, reasonCode: string): Promise<void>;
  get(scope: ScopeKey, artifactHash: string): Promise<ArtifactEligibility | null>;
  /** Rows revoked on behalf of `sourceId`, in a stable order, after the given hash. */
  listBySource(
    scope: ScopeKey,
    sourceId: string,
    after: string | null,
    limit: number,
  ): Promise<ArtifactEligibility[]>;
  markSourceDeleted(
    scope: ScopeKey,
    artifactHash: string,
    policyHash: string,
    reasonCode: string,
  ): Promise<void>;
}

/** What kind of thing an affected id is, so the owner policy can decide what happens to it. */
export type ArtifactKind = 'raw_source' | 'lesson' | 'evidence_bundle' | 'candidate' | 'harness' | 'unknown';
export interface ArtifactCatalog {
  classify(scope: ScopeKey, id: string): Promise<ArtifactKind>;
}

/** Ids of live runs already cancelled because they held revoked content (the repository cancels them). */
export interface RunObserver {
  cancelledRuns(scope: ScopeKey, ids: string[]): Promise<string[]>;
}

export interface ProjectionSink {
  append(
    scope: ScopeKey,
    event: {
      eventId: string;
      jobId: string;
      runId: string;
      artifactIds: string[];
      kind: string;
      payload: unknown;
    },
  ): Promise<unknown>;
}

/** Persistence of `ExternalErasureJob` rows (`external_deletions`). */
export interface ErasureStore {
  insert(job: ExternalErasureJob): Promise<'created' | 'exists'>;
  get(scope: ScopeKey, requestKey: string): Promise<ExternalErasureJob | null>;
  /** Compare-and-swap on the history length, so two pollers cannot both append the same transition. */
  replace(job: ExternalErasureJob, expectedHistoryLength: number): Promise<boolean>;
  /**
   * Jobs of one PROVIDER ORGANIZATION (across every scope) whose subjects' telemetry export is still suppressed locally
   * (until explicitly released). The provider erasure is organization-wide, so the suppression is too.
   */
  listSuppressing(providerOrganizationId: string): Promise<ExternalErasureJob[]>;
}

export type RetentionBoundary = ScopeKey & {
  provider: string;
  /** Never `deleted`: no purge API exists for this provider, so only the boundary is recorded. */
  state: 'retention_boundary_registered';
  note: string;
  registeredAt: Date;
};
export interface RetentionBoundaryStore {
  put(boundary: RetentionBoundary): Promise<'created' | 'exists'>;
  list(scope: ScopeKey): Promise<RetentionBoundary[]>;
}

/** Queue of artifacts whose lineage lost a source and that the owner policy wants regenerated from what remains. */
export interface RegenerationQueue {
  /** Idempotent by (scope, artifactHash, sourceId). */
  enqueue(
    scope: ScopeKey,
    request: { artifactHash: string; kind: ArtifactKind; sourceId: string; policyHash: string },
  ): Promise<void>;
}

/**
 * Removes the BYTES of an artifact or lesson (or replaces them with a non-personal tombstone) whatever its eligibility
 * state: a revoked artifact still holds its bytes until this runs. Idempotent. `not_found` means there was nothing of
 * ours to remove (never a pass for content that exists elsewhere).
 */
export interface ContentPurger {
  purge(
    scope: ScopeKey,
    artifactId: string,
    kind: ArtifactKind,
    reasonCode: string,
  ): Promise<'purged' | 'tombstoned' | 'not_found'>;
}
