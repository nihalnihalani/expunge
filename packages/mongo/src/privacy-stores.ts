import { bumpSubjectSetGeneration } from './guard-exports.js';
import type { ClientSession, Document } from 'mongodb';
import { contentHash, type JsonValue, type ScopeKey } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

/**
 * Repositories for the collections the privacy controller owns: raw evidence and its tombstones, the subject-token map,
 * structural lessons, and the narrow export-suppression read. The shapes are the privacy package's ports
 * (`packages/privacy/src/ports.ts`); this file is where they meet the strict validators. Nothing here deletes a row
 * outright except what the privacy controller is explicitly granted to REMOVE, and a tombstone never carries a content
 * hash, a size or content.
 */
export const SOURCE_KINDS = [
  'telemetry_event',
  'trace',
  'transcript',
  'evidence_bundle',
  'tool_output',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const ERASURE_REASONS = [
  'source_retracted',
  'subject_erasure_request',
  'owner_withdrawal',
  'scan_SubjectLiteral',
  'scan_HeldOutLeak',
  'scan_PrivateIdLeak',
  'scan_raw_retention',
] as const;

const HEX64 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,256}$/;
const PRIVACY_PRINCIPALS = ['privacy_controller', 'setup'] as const;
const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
const strip = <T extends Document>(row: T): Omit<T, '_id' | 'tenantId' | 'env' | 'scopeId'> => {
  const { _id: _a, tenantId: _b, env: _c, scopeId: _d, ...rest } = row;
  return rest as never;
};
/** A row id is the hash of a structured object, never a joined string, so no two distinct keys can alias. */
const rowId = (kind: string, scope: ScopeKey, id: JsonValue): string =>
  contentHash({ kind, ...scopeFilter(scope), id }, 'privacy-row');
function assertIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) fail('InvalidIdentifier');
}

export type RawSource = {
  sourceId: string;
  kind: SourceKind;
  contentSha256: string;
  sizeBytes: number;
  retention: 'raw' | 'hash_only';
  registeredAt: Date;
};
export type Tombstone = {
  sourceId: string;
  kind: SourceKind;
  deletedAt: Date;
  reasonCode: (typeof ERASURE_REASONS)[number];
  policyHash: string;
  closureId: string | null;
};

export class RawArtifactRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document & { _id: string }>('raw_artifacts');
  }
  /** Stores a raw source once. An existing row, raw or tombstone, is left exactly as it is: a source never comes back. */
  async put(scope: ScopeKey, source: RawSource, content: string | null): Promise<'created' | 'exists'> {
    requirePrivacy(this.service);
    assertIdentifier(source.sourceId);
    if (!HEX64.test(source.contentSha256)) fail('InvalidRawSource');
    if ((source.retention === 'raw') !== (content !== null)) fail('InvalidRawSource');
    try {
      await this.rows.insertOne({
        _id: rowId('raw', scope, source.sourceId),
        ...scopeFilter(scope),
        sourceId: source.sourceId,
        kind: source.kind,
        contentSha256: source.contentSha256,
        sizeBytes: source.sizeBytes,
        retention: source.retention,
        content,
        registeredAt: source.registeredAt,
      });
    } catch (error) {
      if (isDuplicate(error)) return 'exists';
      throw error;
    }
    return 'created';
  }
  async get(
    scope: ScopeKey,
    sourceId: string,
  ): Promise<{ source: RawSource; content: string | null } | null> {
    requirePrivacy(this.service);
    const row = await this.rows.findOne({ _id: rowId('raw', scope, sourceId), ...scopeFilter(scope) });
    if (!row || 'deletedAt' in row) return null;
    return {
      source: {
        sourceId: row.sourceId,
        kind: row.kind,
        contentSha256: row.contentSha256,
        sizeBytes: row.sizeBytes,
        retention: row.retention,
        registeredAt: row.registeredAt,
      },
      content: row.content ?? null,
    };
  }
  /** Replaces the row (record and bytes) with a tombstone. Idempotent: a tombstone already there is kept. */
  async tombstone(scope: ScopeKey, tombstone: Tombstone): Promise<void> {
    requirePrivacy(this.service);
    assertIdentifier(tombstone.sourceId);
    if (!HEX64.test(tombstone.policyHash)) fail('InvalidTombstone');
    const _id = rowId('raw', scope, tombstone.sourceId);
    const existing = await this.rows.findOne({ _id, ...scopeFilter(scope) });
    if (existing && 'deletedAt' in existing) return;
    await this.rows.replaceOne(
      { _id, ...scopeFilter(scope) },
      { _id, ...scopeFilter(scope), ...tombstone },
      { upsert: true },
    );
  }
  async getTombstone(scope: ScopeKey, sourceId: string): Promise<Tombstone | null> {
    requirePrivacy(this.service);
    const row = await this.rows.findOne({ _id: rowId('raw', scope, sourceId), ...scopeFilter(scope) });
    if (!row || !('deletedAt' in row)) return null;
    return strip(row) as unknown as Tombstone;
  }
  /**
   * The ContentPurger operation: replaces whatever the row holds with the tombstone shape. `purged` when it held a raw
   * record, `tombstoned` when it already was a tombstone, `not_found` when there is no row.
   */
  async purge(
    scope: ScopeKey,
    sourceId: string,
    kind: SourceKind,
    reasonCode: Tombstone['reasonCode'],
    extra: { policyHash: string; closureId: string | null },
  ): Promise<'purged' | 'tombstoned' | 'not_found'> {
    requirePrivacy(this.service);
    const row = await this.rows.findOne({ _id: rowId('raw', scope, sourceId), ...scopeFilter(scope) });
    if (!row) return 'not_found';
    const already = 'deletedAt' in row;
    await this.tombstone(scope, {
      sourceId,
      kind,
      deletedAt: new Date(),
      reasonCode,
      policyHash: extra.policyHash,
      closureId: extra.closureId,
    });
    return already ? 'tombstoned' : 'purged';
  }
}

export type SubjectTokenEntry = {
  subjectHandle: string;
  provider: string;
  tokenGeneration: number;
  tokens: string[];
  registeredAt: Date;
};

export class SubjectTokenRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document & { _id: string }>('subject_tokens');
  }
  /**
   * Registers one subject token entry and, in the SAME transaction, bumps the scope's subject-set generation, so a guard
   * export that read an older generation is visibly behind the moment this commits. An entry that already exists changes
   * nothing and bumps nothing.
   */
  async put(scope: ScopeKey, entry: SubjectTokenEntry): Promise<'created' | 'exists'> {
    requirePrivacy(this.service);
    assertIdentifier(entry.provider);
    const _id = rowId(
      'token',
      scope,
      `${entry.subjectHandle}\u0000${entry.provider}\u0000${entry.tokenGeneration}`,
    );
    try {
      return await this.service.transaction(async (session) => {
        if (await this.rows.findOne({ _id }, { session, projection: { _id: 1 } })) return 'exists' as const;
        await this.rows.insertOne({ _id, ...scopeFilter(scope), ...entry }, { session });
        await bumpSubjectSetGeneration(this.service, scope, session);
        return 'created' as const;
      });
    } catch (error) {
      if (isDuplicate(error)) return 'exists';
      throw error;
    }
  }
  async list(scope: ScopeKey, limit = 1000): Promise<SubjectTokenEntry[]> {
    requirePrivacy(this.service);
    const found = await this.rows
      .find(scopeFilter(scope))
      .sort({ subjectHandle: 1, provider: 1, tokenGeneration: 1 })
      .limit(Math.min(Math.max(1, limit), 5000))
      .toArray();
    return found.map((row) => strip(row) as unknown as SubjectTokenEntry);
  }
  /** The provider identities of the subject's latest token generation. */
  async tokensFor(scope: ScopeKey, subjectHandle: string, provider: string): Promise<string[]> {
    requirePrivacy(this.service);
    const row = await this.rows.findOne(
      { ...scopeFilter(scope), subjectHandle, provider },
      { sort: { tokenGeneration: -1 } },
    );
    return row ? [...(row.tokens as string[])] : [];
  }
}

export type LessonRecord = {
  lessonId: string;
  moduleId: string;
  family: string;
  structure: JsonValue;
  retention: 'structural';
  sourceIds: string[];
  policyHash: string;
  registeredAt: Date;
};

export class LessonRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document & { _id: string }>('lessons');
  }
  async put(scope: ScopeKey, lesson: LessonRecord): Promise<'created' | 'exists'> {
    requirePrivacy(this.service);
    assertIdentifier(lesson.lessonId);
    if (!HEX64.test(lesson.policyHash)) fail('InvalidLesson');
    try {
      await this.rows.insertOne({
        _id: rowId('lesson', scope, lesson.lessonId),
        ...scopeFilter(scope),
        ...lesson,
      });
    } catch (error) {
      if (isDuplicate(error)) return 'exists';
      throw error;
    }
    return 'created';
  }
  async get(scope: ScopeKey, lessonId: string): Promise<LessonRecord | null> {
    requirePrivacy(this.service);
    const row = await this.rows.findOne({ _id: rowId('lesson', scope, lessonId), ...scopeFilter(scope) });
    return row && !('deletedAt' in row) ? (strip(row) as unknown as LessonRecord) : null;
  }
  async list(scope: ScopeKey, limit = 1000): Promise<LessonRecord[]> {
    requirePrivacy(this.service);
    const found = await this.rows
      .find({ ...scopeFilter(scope), deletedAt: { $exists: false } })
      .sort({ lessonId: 1 })
      .limit(Math.min(Math.max(1, limit), 5000))
      .toArray();
    return found.map((row) => strip(row) as unknown as LessonRecord);
  }
  /** Replaces a lesson with a tombstone (no structure, no sources). `not_found` when there is no such lesson. */
  async purge(
    scope: ScopeKey,
    lessonId: string,
    reasonCode: Tombstone['reasonCode'],
    extra: { policyHash: string; closureId: string | null },
  ): Promise<'purged' | 'tombstoned' | 'not_found'> {
    requirePrivacy(this.service);
    const _id = rowId('lesson', scope, lessonId);
    const row = await this.rows.findOne({ _id, ...scopeFilter(scope) });
    if (!row) return 'not_found';
    if ('deletedAt' in row) return 'tombstoned';
    if (!HEX64.test(extra.policyHash)) fail('InvalidTombstone');
    await this.rows.replaceOne(
      { _id, ...scopeFilter(scope) },
      {
        _id,
        ...scopeFilter(scope),
        lessonId,
        deletedAt: new Date(),
        reasonCode,
        policyHash: extra.policyHash,
        closureId: extra.closureId,
      },
    );
    return 'purged';
  }
}

export type ErasureSuppression = {
  tenantId: string;
  env: ScopeKey['env'];
  providerOrganizationId: string;
  userKey: string;
  /** The erasure job this suppression belongs to (the privacy package's deterministic erasure id). */
  jobId: string;
};
/** More active suppressions than a reader may take in one call: the export gate holds everything rather than guess. */
const SUPPRESSION_BOUND = 10_000;

/**
 * Which provider-side users are being erased, as the one narrow read the export gate needs. One row per
 * (organization, user, erasure job): releasing or cancelling one job clears that job's row only, so a user another job
 * still erases stays suppressed. `_id` is the hash of that structured triple, so no pair of distinct triples aliases even
 * though ':' is legal in every part. Written by the privacy controller (optionally inside the transaction that updates
 * the erasure job), read by the observer and the domain service; neither can read `external_deletions`.
 */
export class ErasureSuppressionRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document & { _id: string }>('erasure_suppressions');
  }
  private idOf(entry: Pick<ErasureSuppression, 'providerOrganizationId' | 'userKey' | 'jobId'>): string {
    return contentHash(
      { providerOrganizationId: entry.providerOrganizationId, userKey: entry.userKey, jobId: entry.jobId },
      'erasure-suppression',
    );
  }
  /** Sets or clears THIS job's suppression of the user; every other job's row is left alone. */
  async setActive(entry: ErasureSuppression, active: boolean, session?: ClientSession): Promise<void> {
    requirePrivacy(this.service);
    assertIdentifier(entry.providerOrganizationId);
    assertIdentifier(entry.userKey);
    assertIdentifier(entry.jobId);
    await this.rows.updateOne(
      { _id: this.idOf(entry) },
      {
        $set: { active, updatedAt: new Date() },
        $setOnInsert: {
          tenantId: entry.tenantId,
          env: entry.env,
          providerOrganizationId: entry.providerOrganizationId,
          userKey: entry.userKey,
          jobId: entry.jobId,
        },
      },
      { upsert: true, ...(session ? { session } : {}) },
    );
  }
  /**
   * The distinct user keys with at least one active suppression for the organization, across all tenants and envs and
   * all jobs. Fails closed when there are more than `limit` (default 10 000): a truncated list would let an erased
   * user's data be exported.
   */
  async activeUserKeys(providerOrganizationId: string, limit = SUPPRESSION_BOUND): Promise<string[]> {
    requirePrincipal(this.service, ['observer', 'domain_executor', 'privacy_controller', 'setup']);
    assertIdentifier(providerOrganizationId);
    const bound = Math.min(Math.max(1, Math.trunc(limit)), 50_000);
    const found = await this.rows
      .aggregate<{ _id: string }>([
        { $match: { providerOrganizationId, active: true } },
        { $group: { _id: '$userKey' } },
        { $sort: { _id: 1 } },
        { $limit: bound + 1 },
      ])
      .toArray();
    if (found.length > bound) fail('SuppressionListTooLarge');
    return found.map((row) => row._id);
  }
  /** The active suppressions one erasure job holds, for reconciling the job with its rows. Bounded the same way. */
  async activeForJob(
    jobId: string,
    limit = SUPPRESSION_BOUND,
  ): Promise<Array<{ providerOrganizationId: string; userKey: string }>> {
    requirePrincipal(this.service, ['privacy_controller', 'setup']);
    assertIdentifier(jobId);
    const bound = Math.min(Math.max(1, Math.trunc(limit)), 50_000);
    const found = await this.rows
      .find({ jobId, active: true }, { projection: { providerOrganizationId: 1, userKey: 1 } })
      .sort({ providerOrganizationId: 1, userKey: 1 })
      .limit(bound + 1)
      .toArray();
    if (found.length > bound) fail('SuppressionListTooLarge');
    return found.map((row) => ({
      providerOrganizationId: row.providerOrganizationId as string,
      userKey: row.userKey as string,
    }));
  }
  /** The jobs that currently suppress this user in this organization. */
  async activeJobsFor(providerOrganizationId: string, userKey: string): Promise<string[]> {
    requirePrincipal(this.service, ['privacy_controller', 'setup']);
    assertIdentifier(providerOrganizationId);
    assertIdentifier(userKey);
    const found = await this.rows
      .find({ providerOrganizationId, userKey, active: true }, { projection: { jobId: 1 } })
      .sort({ jobId: 1 })
      .limit(1001)
      .toArray();
    if (found.length > 1000) fail('SuppressionListTooLarge');
    return found.map((row) => row.jobId as string);
  }
}

function requirePrivacy(service: MongoService): void {
  requirePrincipal(service, [...PRIVACY_PRINCIPALS]);
}
