import { createHash } from 'node:crypto';
import { contentHash, type JsonValue, type ScopeKey } from '@expunge/contracts';
import {
  detectLeak,
  isTelemetryUserId,
  requireGuard,
  type LeakGuard,
  type PrivateIdSet,
} from '@expunge/observability';
import { PrivacyError } from './errors.js';
import {
  SOURCE_KINDS,
  type EligibilityStore,
  type LessonRecord,
  type LessonStore,
  type ProvenancePort,
  type RawArtifactStore,
  type RawSource,
  type SourceKind,
  type SubjectTokenEntry,
  type SubjectTokenStore,
} from './ports.js';
import { classifyRetention } from './structure.js';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Clock = { now?: () => Date };

/**
 * Registers a raw source. `raw` retention stores the bytes in `raw_artifacts` (the only place raw evidence may live,
 * and the only one the privacy controller can delete from); `hash_only` stores the digest and size and nothing else.
 * The source also gets a `permitted` eligibility row so it can take part in provenance. Registering the same id with
 * the same content again is a no-op; with different content it is a conflict, never an overwrite.
 */
export async function registerRawSource(
  deps: { raw: RawArtifactStore; eligibility: EligibilityStore; policyHash: string } & Clock,
  scope: ScopeKey,
  input: { sourceId: string; kind: SourceKind; content: string; retention: 'raw' | 'hash_only' },
): Promise<RawSource> {
  if (!ID.test(input.sourceId) || !(SOURCE_KINDS as readonly string[]).includes(input.kind))
    throw new PrivacyError('InvalidSource');
  const source: RawSource = {
    sourceId: input.sourceId,
    kind: input.kind,
    contentSha256: sha256(input.content),
    sizeBytes: Buffer.byteLength(input.content),
    retention: input.retention,
    registeredAt: (deps.now ?? (() => new Date()))(),
  };
  const existing = await deps.raw.get(scope, input.sourceId);
  if (existing) {
    if (existing.source.contentSha256 !== source.contentSha256) throw new PrivacyError('SourceIdConflict');
    return existing.source;
  }
  if (await deps.raw.getTombstone(scope, input.sourceId))
    throw new PrivacyError('SourceIdConflict', 'deleted');
  await deps.raw.put(scope, source, input.retention === 'raw' ? input.content : null);
  await deps.eligibility.permit(scope, input.sourceId, deps.policyHash, 'registered');
  return source;
}

/**
 * Maps a subject handle to the opaque provider identities its telemetry carries. The handle is a subject literal and
 * stays in this collection; what leaves it is only the opaque ids. For Raindrop the ids must be opaque telemetry ids
 * (a namespace and a hex digest), never anything derived from a name.
 */
export async function registerSubjectTokens(
  deps: { tokens: SubjectTokenStore } & Clock,
  scope: ScopeKey,
  input: { subjectHandle: string; provider: string; tokenGeneration: number; tokens: string[] },
): Promise<SubjectTokenEntry> {
  if (
    !input.subjectHandle.trim() ||
    !ID.test(input.provider) ||
    !Number.isInteger(input.tokenGeneration) ||
    input.tokenGeneration < 1 ||
    input.tokens.length < 1 ||
    input.tokens.length > 100 ||
    new Set(input.tokens).size !== input.tokens.length
  )
    throw new PrivacyError('InvalidSubjectToken');
  if (input.provider === 'raindrop' && !input.tokens.every(isTelemetryUserId))
    throw new PrivacyError('InvalidSubjectToken', 'not opaque');
  const entry: SubjectTokenEntry = {
    subjectHandle: input.subjectHandle,
    provider: input.provider,
    tokenGeneration: input.tokenGeneration,
    tokens: [...input.tokens].sort(),
    registeredAt: (deps.now ?? (() => new Date()))(),
  };
  await deps.tokens.put(scope, entry);
  return entry;
}

export const GUARD_LIST_LIMIT = 5000;

/**
 * The leak guard for a scope: every registered subject handle is a forbidden literal, plus the grader's salted private
 * id set when there is one. With neither, the guard cannot exist (MissingForbiddenLiterals): a scan with nothing to
 * look for would pass everything, so it refuses to start.
 */
export async function guardFor(
  deps: { tokens: SubjectTokenStore },
  scope: ScopeKey,
  extra: { literals?: readonly string[]; privateIds?: PrivateIdSet } = {},
): Promise<LeakGuard> {
  // A guard missing a handle would let that subject's text through, so a list that may have been cut off is refused.
  const listed = await deps.tokens.list(scope, GUARD_LIST_LIMIT);
  if (listed.length >= GUARD_LIST_LIMIT)
    throw new PrivacyError('GuardIncomplete', `${GUARD_LIST_LIMIT} entries`);
  const handles = listed.map((entry) => entry.subjectHandle);
  const guard: LeakGuard = {
    forbiddenLiterals: [...new Set([...handles, ...(extra.literals ?? [])])],
    ...(extra.privateIds ? { privateIds: extra.privateIds } : {}),
  };
  requireGuard(guard);
  return guard;
}

/**
 * Records a structural lesson and its derivation edges. The lesson must be structure (identifiers, counts, hashes), must
 * carry no subject literal or private id in any key or value (or encoded form), and its `derived_from` edges are written
 * BEFORE it becomes permitted, so a lesson is never retrievable while its lineage is unknown.
 */
export async function registerLesson(
  deps: {
    lessons: LessonStore;
    eligibility: EligibilityStore;
    provenance: ProvenancePort;
    policyHash: string;
  } & Clock,
  scope: ScopeKey,
  input: { moduleId: string; family: string; structure: JsonValue; sourceIds: string[] },
  guard: LeakGuard,
): Promise<LessonRecord> {
  if (!ID.test(input.moduleId) || !ID.test(input.family) || input.sourceIds.some((id) => !ID.test(id)))
    throw new PrivacyError('InvalidSource');
  if (classifyRetention(input.structure) === 'raw') throw new PrivacyError('LessonNotStructural');
  const finding = detectLeak(input.structure, guard);
  if (finding) throw new PrivacyError('LessonRejected', finding.code);
  const sourceIds = [...new Set(input.sourceIds)].sort();
  const lesson: LessonRecord = {
    lessonId: contentHash(
      { moduleId: input.moduleId, family: input.family, structure: input.structure, sourceIds },
      'lesson',
    ),
    moduleId: input.moduleId,
    family: input.family,
    structure: input.structure,
    retention: 'structural',
    sourceIds,
    policyHash: deps.policyHash,
    registeredAt: (deps.now ?? (() => new Date()))(),
  };
  for (const sourceId of sourceIds)
    await deps.provenance.append(scope, sourceId, lesson.lessonId, 'derived_from');
  await deps.lessons.put(scope, lesson);
  await deps.eligibility.permit(scope, lesson.lessonId, deps.policyHash, 'registered');
  return lesson;
}

/** A derivation recorded at creation time (e.g. evidence bundle from a source, candidate from a lesson). */
export function recordDerivation(
  deps: { provenance: ProvenancePort },
  scope: ScopeKey,
  fromId: string,
  toId: string,
): Promise<void> {
  return deps.provenance.append(scope, fromId, toId, 'derived_from');
}

export type RawRetrieval =
  | { status: 'ok'; source: RawSource; content: string | null }
  | { status: 'denied'; reason: 'not_permitted' | 'deleted' | 'unknown' };

/**
 * The retrieval gate for raw sources: only a `permitted` source with no revoked or unresolved ancestor can be read. A
 * revoked (or not yet resolved) source, an incomplete closure over it, and a deleted source all answer `denied`.
 */
export async function retrieveRawSource(
  deps: { raw: RawArtifactStore; provenance: ProvenancePort },
  scope: ScopeKey,
  sourceId: string,
): Promise<RawRetrieval> {
  if (await deps.raw.getTombstone(scope, sourceId)) return { status: 'denied', reason: 'deleted' };
  if (!(await deps.provenance.permitted(scope, [sourceId])).includes(sourceId))
    return { status: 'denied', reason: 'not_permitted' };
  const found = await deps.raw.get(scope, sourceId);
  return found ? { status: 'ok', ...found } : { status: 'denied', reason: 'unknown' };
}
