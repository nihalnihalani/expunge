import {
  contentHash,
  type ArtifactEligibility,
  type ExternalErasureJob,
  type ScopeKey,
} from '@expunge/contracts';
import {
  ErasureSuppressionRepository,
  LessonRepository,
  RawArtifactRepository,
  scopeFilter,
  type MongoService,
} from '@expunge/mongo';
import { suppressionUserKey } from '@expunge/observer';
import type { ClientSession, Document } from 'mongodb';
import type { ArtifactKind, ContentPurger, EligibilityStore, ErasureStore, RunObserver } from './ports.js';

/**
 * Mongo adapters for the collections whose shape already exists in packages/mongo. They are written for the
 * `privacy_controller` principal (the role manifest grants it exactly these reads and writes). `raw_artifacts`,
 * `subject_tokens` and `lessons` are served by the repositories in `@expunge/mongo` (`RawArtifactRepository`,
 * `SubjectTokenRepository`, `LessonRepository`), whose methods match this package's ports and are passed in directly;
 * `MongoContentPurger` adapts the two purges behind `ContentPurger`.
 */

const chunks = <T>(values: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

export class MongoEligibilityStore implements EligibilityStore {
  constructor(private readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document & ArtifactEligibility>('artifact_eligibility');
  }
  /** Never resurrects: an existing row (revoked or deleted) is left exactly as it is. */
  async permit(scope: ScopeKey, artifactHash: string, policyHash: string, reasonCode: string): Promise<void> {
    await this.rows.updateOne(
      { ...scopeFilter(scope), artifactHash },
      { $setOnInsert: { state: 'permitted', policyHash, reasonCode, sourceIds: [], updatedAt: new Date() } },
      { upsert: true },
    );
  }
  async get(scope: ScopeKey, artifactHash: string): Promise<ArtifactEligibility | null> {
    const { _id: _id, ...row } = ((await this.rows.findOne({ ...scopeFilter(scope), artifactHash })) ??
      {}) as Document;
    return row.artifactHash ? (row as ArtifactEligibility) : null;
  }
  async listBySource(
    scope: ScopeKey,
    sourceId: string,
    after: string | null,
    limit: number,
  ): Promise<ArtifactEligibility[]> {
    const rows = await this.rows
      .find({
        ...scopeFilter(scope),
        sourceIds: sourceId,
        ...(after === null ? {} : { artifactHash: { $gt: after } }),
      })
      .sort({ artifactHash: 1 })
      .limit(limit)
      .toArray();
    return rows.map(({ _id: _ignored, ...row }) => row as ArtifactEligibility);
  }
  async markSourceDeleted(
    scope: ScopeKey,
    artifactHash: string,
    policyHash: string,
    reasonCode: string,
  ): Promise<void> {
    await this.rows.updateOne(
      { ...scopeFilter(scope), artifactHash },
      { $set: { state: 'source_deleted', policyHash, reasonCode, updatedAt: new Date() } },
    );
  }
}

export const erasureId = (scope: ScopeKey, requestKey: string) =>
  contentHash(
    { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, requestKey },
    'external-deletion',
  );

/** Whether the local export gate must hold this user id: the job is active and the subject was not revoked at the provider. */
const isSuppressed = (job: ExternalErasureJob, userId: string): boolean => {
  if (job.localExportSuppression !== 'active') return false;
  const entry = job.subjectEntries.find((e) => e.user_id === userId);
  return !entry || entry.revoked_at === null;
};

/**
 * `external_deletions` as the privacy controller writes it. The `suppression` repository is REQUIRED (a store without it would
 * fail open): every write that changes the
 * job ALSO flips that job's `erasure_suppressions` rows in the SAME transaction, so the observer's export gate (which
 * cannot read `external_deletions`) never sees an erasure request without its suppression, nor a release without it.
 */
export class MongoErasureStore implements ErasureStore {
  constructor(
    private readonly service: MongoService,
    private readonly suppression: ErasureSuppressionRepository,
  ) {}
  private get rows() {
    return this.service.control.collection<Document & { _id: string }>('external_deletions');
  }
  private async syncSuppression(job: ExternalErasureJob, session: ClientSession): Promise<void> {
    for (const userId of job.namespacedUserIds)
      await this.suppression.setActive(
        {
          tenantId: job.tenantId,
          env: job.env,
          providerOrganizationId: job.providerOrganizationId,
          userKey: suppressionUserKey(userId),
          jobId: erasureId(job, job.requestKey),
        },
        isSuppressed(job, userId),
        session,
      );
  }
  async insert(job: ExternalErasureJob): Promise<'created' | 'exists'> {
    try {
      await this.service.transaction(async (session) => {
        await this.rows.insertOne({ _id: erasureId(job, job.requestKey), ...job }, { session });
        await this.syncSuppression(job, session);
      });
      return 'created';
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return 'exists';
      throw error;
    }
  }
  async get(scope: ScopeKey, requestKey: string): Promise<ExternalErasureJob | null> {
    const row = await this.rows.findOne({ _id: erasureId(scope, requestKey) });
    if (!row) return null;
    const { _id: _ignored, ...job } = row;
    return job as unknown as ExternalErasureJob;
  }
  async replace(job: ExternalErasureJob, expectedHistoryLength: number): Promise<boolean> {
    const { requestKey: _key, ...fields } = job;
    return this.service.transaction(async (session) => {
      const result = await this.rows.updateOne(
        { _id: erasureId(job, job.requestKey), history: { $size: expectedHistoryLength } },
        { $set: fields },
        { session },
      );
      if (result.matchedCount !== 1) return false;
      await this.syncSuppression(job, session);
      return true;
    });
  }
  async listSuppressing(providerOrganizationId: string): Promise<ExternalErasureJob[]> {
    const rows = await this.rows.find({ providerOrganizationId, localExportSuppression: 'active' }).toArray();
    return rows.map(({ _id: _ignored, ...job }) => job as unknown as ExternalErasureJob);
  }
}

/**
 * Periodic repair of ONE organization's suppression rows from `external_deletions` (the source of truth), job by job: for
 * every job that still suppresses, each expected user is made active under THAT job's row, and any row that job holds
 * active but no longer expects (a subject revoked at the provider) is cleared. A job's rows are only ever set or cleared
 * under its own id, so repairing one job can never lift another job's hold on the same user. Jobs whose suppression was
 * released are not listed by the store and are not scanned (their release already cleared their own rows in the same
 * transaction); a row left active by such a job is not found here.
 */
export async function reconcileExportSuppression(
  service: MongoService,
  providerOrganizationId: string,
  options: { limit?: number } = {},
): Promise<{ expected: number; repaired: number; cleared: number }> {
  const suppression = new ErasureSuppressionRepository(service);
  const store = new MongoErasureStore(service, suppression);
  let expectedCount = 0;
  let repaired = 0;
  let cleared = 0;
  for (const job of await store.listSuppressing(providerOrganizationId)) {
    const jobId = erasureId(job, job.requestKey);
    const held = new Set(
      (await suppression.activeForJob(jobId, options.limit))
        .filter((row) => row.providerOrganizationId === providerOrganizationId)
        .map((row) => row.userKey),
    );
    const expected = new Set<string>();
    for (const userId of job.namespacedUserIds)
      if (isSuppressed(job, userId)) expected.add(suppressionUserKey(userId));
    expectedCount += expected.size;
    const entry = (userKey: string) => ({
      tenantId: job.tenantId,
      env: job.env,
      providerOrganizationId,
      userKey,
      jobId,
    });
    for (const userKey of expected)
      if (!held.has(userKey)) {
        await suppression.setActive(entry(userKey), true);
        repaired++;
      }
    for (const userKey of held)
      if (!expected.has(userKey)) {
        await suppression.setActive(entry(userKey), false);
        cleared++;
      }
  }
  return { expected: expectedCount, repaired, cleared };
}

/**
 * Removes the bytes of raw sources and lessons. `evidence_bundle`, `candidate`, `harness` and `unknown` content lives in
 * collections this package has no right to write, so those kinds report `not_found` (never a pass): the deployment-side
 * owners must purge them. The tombstone records the retraction's policy hash and closure id.
 */
export class MongoContentPurger implements ContentPurger {
  private readonly raw: RawArtifactRepository;
  private readonly lessons: LessonRepository;
  constructor(service: MongoService) {
    this.raw = new RawArtifactRepository(service);
    this.lessons = new LessonRepository(service);
  }
  async purge(
    scope: ScopeKey,
    artifactId: string,
    kind: ArtifactKind,
    reasonCode: string,
    extra: { policyHash: string; closureId: string | null },
  ): Promise<'purged' | 'tombstoned' | 'not_found'> {
    if (kind === 'lesson') return this.lessons.purge(scope, artifactId, reasonCode as never, extra);
    if (kind !== 'raw_source') return 'not_found';
    const live = await this.raw.get(scope, artifactId);
    const sourceKind = live?.source.kind ?? (await this.raw.getTombstone(scope, artifactId))?.kind;
    if (!sourceKind) return 'not_found';
    return this.raw.purge(scope, artifactId, sourceKind, reasonCode as never, extra);
  }
}

/** Which live runs the repository already cancelled for holding revoked content (`jobs.cancellationRequested`). */
export class MongoRunObserver implements RunObserver {
  constructor(private readonly service: MongoService) {}
  async cancelledRuns(scope: ScopeKey, ids: string[]): Promise<string[]> {
    const found = new Set<string>();
    for (const part of chunks(ids, 1000)) {
      const rows = await this.service.control
        .collection<Document>('jobs')
        .find(
          {
            'actor.tenantId': scope.tenantId,
            'actor.env': scope.env,
            'actor.scopeId': scope.scopeId,
            cancellationRequested: true,
            $or: [{ 'binding.harnessHash': { $in: part } }, { contextInputs: { $in: part } }],
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      for (const row of rows) found.add(String(row._id));
    }
    return [...found];
  }
}
