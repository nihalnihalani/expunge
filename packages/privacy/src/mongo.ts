import {
  contentHash,
  type ArtifactEligibility,
  type ExternalErasureJob,
  type ScopeKey,
} from '@expunge/contracts';
import { scopeFilter, type MongoService } from '@expunge/mongo';
import type { Document } from 'mongodb';
import type { EligibilityStore, ErasureStore, RunObserver } from './ports.js';

/**
 * Mongo adapters for the collections whose shape already exists in packages/mongo. They are written for the
 * `privacy_controller` principal (the role manifest grants it exactly these reads and writes). The adapters for
 * `raw_artifacts`, `subject_tokens` and `lessons` are NOT here: the privacy controller has no insert right on them
 * yet and their documents belong to mongodb-authority, so the package keeps them behind ports until they exist.
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

const erasureId = (scope: ScopeKey, requestKey: string) =>
  contentHash(
    { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, requestKey },
    'external-deletion',
  );

export class MongoErasureStore implements ErasureStore {
  constructor(private readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document & { _id: string }>('external_deletions');
  }
  async insert(job: ExternalErasureJob): Promise<'created' | 'exists'> {
    try {
      await this.rows.insertOne({ _id: erasureId(job, job.requestKey), ...job });
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
    const result = await this.rows.updateOne(
      { _id: erasureId(job, job.requestKey), history: { $size: expectedHistoryLength } },
      { $set: fields },
    );
    return result.matchedCount === 1;
  }
  async listSuppressing(providerOrganizationId: string): Promise<ExternalErasureJob[]> {
    const rows = await this.rows.find({ providerOrganizationId, localExportSuppression: 'active' }).toArray();
    return rows.map(({ _id: _ignored, ...job }) => job as unknown as ExternalErasureJob);
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
