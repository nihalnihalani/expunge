import type { Document, ObjectId } from 'mongodb';
import { contentHash, type JsonValue, type ScopeKey } from '@expunge/contracts';
import { assertCampaignScope } from './campaign.js';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';
import { ProjectionRepository } from './events.js';

export type CampaignKind = 'meta' | 'hider';
export type CampaignRowResult = 'measured' | 'null' | 'invalid';
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_ROWS = 4096;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

export type CampaignRowInput = {
  rowId: string;
  kind: CampaignKind;
  manifestHash: string;
  result: CampaignRowResult;
  admitted?: boolean;
  w0ResetProof?: string;
  budgetHash?: string;
  payload: JsonValue;
};
export type StoredCampaignRow = ScopeKey & {
  campaignId: string;
  rowId: string;
  kind: CampaignKind;
  manifestHash: string;
  result: CampaignRowResult;
  admitted?: boolean;
  w0ResetProof?: string;
  budgetHash?: string;
  payload: JsonValue;
  payloadDigest: string;
  committedAt: Date;
};
export type CampaignSummaryInput = {
  kind: CampaignKind;
  manifestHash: string;
  rowIds: string[];
  payload: JsonValue;
};
export type StoredCampaignSummary = ScopeKey & {
  artifactId: string;
  kind: CampaignKind;
  campaignId: string;
  manifestHash: string;
  rowIds: string[];
  payload: JsonValue;
  payloadDigest: string;
  committedAt: Date;
};

const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
const without = <T extends Document>(row: T & { _id?: unknown }): Omit<T, '_id'> => {
  const { _id: _ignored, ...rest } = row;
  return rest as Omit<T, '_id'>;
};
function assertIds(campaignId: string, rowId?: string): void {
  if (!IDENTIFIER.test(campaignId) || (rowId !== undefined && !IDENTIFIER.test(rowId)))
    fail('InvalidCampaignId');
}

/** The replica set's own clock, so a commit time never comes from the caller's machine. */
async function serverNow(service: MongoService): Promise<Date> {
  const hello = await service.control.command({ hello: 1 });
  return hello.localTime instanceof Date ? hello.localTime : new Date();
}

/**
 * The immutable result of a meta or Hider campaign: one insert-only row per measured, null or invalid trial, and one
 * insert-only summary that lists exactly the rows it stands on. Written by the grader, served by the projection. Nothing
 * here is ever updated or removed (the grader holds no UPDATE or REMOVE on either collection); a second write with
 * different bytes is a typed conflict, never an overwrite. Outside a campaign scope (evaluation env, no worker
 * deployment pointer) every call is refused.
 */
export class CampaignArtifactRepository {
  constructor(readonly service: MongoService) {}

  private get rows() {
    return this.service.control.collection<StoredCampaignRow & { _id: string }>('campaign_artifact_rows');
  }
  private get summaries() {
    return this.service.control.collection<StoredCampaignSummary & { _id: string }>('campaign_artifacts');
  }

  /**
   * Commits one row and, in the same transaction, announces it on the campaign's projection stream
   * (`campaign_row_committed`, ids and hashes only). The same bytes again commit nothing and announce nothing new.
   */
  async commitRow(
    scope: ScopeKey,
    campaignId: string,
    row: CampaignRowInput,
  ): Promise<{ committed: boolean }> {
    requirePrincipal(this.service, ['grader']);
    assertIds(campaignId, row.rowId);
    if (!HEX64.test(row.manifestHash) || (row.budgetHash !== undefined && !HEX64.test(row.budgetHash)))
      fail('InvalidCampaignRow');
    await assertCampaignScope(this.service, scope);
    const payloadDigest = contentHash(
      {
        rowId: row.rowId,
        kind: row.kind,
        manifestHash: row.manifestHash,
        result: row.result,
        admitted: row.admitted ?? null,
        w0ResetProof: row.w0ResetProof ?? null,
        budgetHash: row.budgetHash ?? null,
        payload: row.payload,
      },
      'campaign-row',
    );
    const committedAt = await serverNow(this.service);
    const projection = new ProjectionRepository(this.service);
    return this.service.transaction(async (session) => {
      const _id = `${campaignId}:${row.rowId}`;
      const existing = await this.rows.findOne({ _id, ...scopeFilter(scope) }, { session });
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) fail('CampaignRowConflict');
        return { committed: false };
      }
      const { rowId, kind, manifestHash, result, payload } = row;
      await this.rows.insertOne(
        {
          _id,
          ...scopeFilter(scope),
          campaignId,
          rowId,
          kind,
          manifestHash,
          result,
          ...(row.admitted === undefined ? {} : { admitted: row.admitted }),
          ...(row.w0ResetProof === undefined ? {} : { w0ResetProof: row.w0ResetProof }),
          ...(row.budgetHash === undefined ? {} : { budgetHash: row.budgetHash }),
          payload,
          payloadDigest,
          committedAt,
        },
        { session },
      );
      await projection.append(
        scope,
        {
          eventId: `campaign-row:${campaignId}:${rowId}`,
          jobId: `campaign:${campaignId}`,
          runId: 'campaign',
          artifactIds: [],
          kind: 'campaign_row_committed',
          payload: {
            campaignId,
            manifestHash,
            kind,
            rowId,
            result,
            ...(row.admitted === undefined ? {} : { admitted: row.admitted }),
            ...(row.w0ResetProof === undefined ? {} : { w0ResetProof: row.w0ResetProof }),
            ...(row.budgetHash === undefined ? {} : { budgetHash: row.budgetHash }),
          },
        },
        session,
      );
      return { committed: true };
    });
  }

  /**
   * Commits the campaign's summary, `campaign:<campaignId>`, once. It refuses unless every row it lists is already
   * committed for this campaign; the same bytes again return the stored summary, other bytes are a conflict.
   */
  async commitSummary(
    scope: ScopeKey,
    campaignId: string,
    input: CampaignSummaryInput,
  ): Promise<{ artifactId: string; created: boolean; committedAt: Date }> {
    requirePrincipal(this.service, ['grader']);
    assertIds(campaignId);
    if (
      !HEX64.test(input.manifestHash) ||
      !Array.isArray(input.rowIds) ||
      input.rowIds.length > MAX_ROWS ||
      new Set(input.rowIds).size !== input.rowIds.length ||
      input.rowIds.some((id) => !IDENTIFIER.test(id))
    )
      fail('InvalidCampaignSummary');
    await assertCampaignScope(this.service, scope);
    const rowIds = [...input.rowIds].sort();
    const payloadDigest = contentHash(
      { kind: input.kind, manifestHash: input.manifestHash, rowIds, payload: input.payload },
      'campaign-summary',
    );
    const artifactId = `campaign:${campaignId}`;
    const committedAt = await serverNow(this.service);
    return this.service.transaction(async (session) => {
      const existing = await this.summaries.findOne({ _id: artifactId, ...scopeFilter(scope) }, { session });
      if (existing) {
        if (existing.payloadDigest !== payloadDigest) fail('CampaignSummaryConflict');
        return { artifactId, created: false, committedAt: existing.committedAt };
      }
      const found = await this.rows.countDocuments(
        { ...scopeFilter(scope), campaignId, rowId: { $in: rowIds } },
        { session },
      );
      if (found !== rowIds.length) fail('CampaignRowsMissing');
      await this.summaries.insertOne(
        {
          _id: artifactId,
          ...scopeFilter(scope),
          artifactId,
          kind: input.kind,
          campaignId,
          manifestHash: input.manifestHash,
          rowIds,
          payload: input.payload,
          payloadDigest,
          committedAt,
        },
        { session },
      );
      return { artifactId, created: true, committedAt };
    });
  }

  async readSummary(scope: ScopeKey, campaignId: string): Promise<StoredCampaignSummary | null> {
    requirePrincipal(this.service, ['grader', 'projection_reader', 'domain_executor', 'setup']);
    assertIds(campaignId);
    const row = await this.summaries.findOne({ _id: `campaign:${campaignId}`, ...scopeFilter(scope) });
    return row ? (without(row) as StoredCampaignSummary) : null;
  }

  async listRows(
    scope: ScopeKey,
    campaignId: string,
    options: { afterRowId?: string; limit?: number } = {},
  ): Promise<StoredCampaignRow[]> {
    requirePrincipal(this.service, ['grader', 'projection_reader', 'domain_executor', 'setup']);
    assertIds(campaignId, options.afterRowId);
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE)));
    const found = await this.rows
      .find({
        ...scopeFilter(scope),
        campaignId,
        ...(options.afterRowId === undefined ? {} : { rowId: { $gt: options.afterRowId } }),
      })
      .sort({ rowId: 1 })
      .limit(limit)
      .toArray();
    return found.map((row) => without(row) as StoredCampaignRow);
  }
}

export type MetaDrawCommitment = { seedCommitment: string; incidentPoolHash: string; worldPoolHash: string };
export type MetaDrawKind = 'commitment' | 'i1' | 'freeze' | 'draw';
export type StoredMetaDrawRow = {
  kind: MetaDrawKind;
  campaignId: string;
  /** The server-assigned `_id`'s timestamp: server time at one-second resolution. */
  committedAt: Date;
  commitment?: MetaDrawCommitment;
  i0Hash?: string;
  i1Hash?: string;
  freezeHash?: string;
  setHash?: string;
};
export type StoredMetaDraw = Partial<Record<MetaDrawKind, StoredMetaDrawRow>>;
/** Rows are one-second-resolution timestamps, so "strictly later than + 1 s" is checked against whole seconds apart. */
export const META_DRAW_MIN_GAP_MS = 2000;

/**
 * The meta campaign's draw record, four rows in order: the draw commitment, the I1 creation record, the freeze, the drawn set. Each is
 * written once and never changed. Every `_id` is assigned by the server (`forceServerObjectId`), so the time of each row
 * is the server's, cannot be supplied or edited by the writer, and no UPDATE is needed to stamp it. A row is refused
 * unless the one before it exists and the server's clock is already more than one second past that row's time, so the
 * I1 record is strictly later than the commitment, the freeze later than I1 and the draw later than the freeze. A second write of the same
 * kind is a typed refusal that rewrites nothing.
 */
export class MetaDrawCommitmentRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document & { _id: ObjectId }>('meta_draw_commitments');
  }

  commit(campaignId: string, input: { commitment: MetaDrawCommitment; i0Hash: string }) {
    const { seedCommitment, incidentPoolHash, worldPoolHash } = input.commitment;
    return this.write(
      campaignId,
      'commitment',
      null,
      [seedCommitment, incidentPoolHash, worldPoolHash, input.i0Hash],
      {
        commitment: { seedCommitment, incidentPoolHash, worldPoolHash },
        i0Hash: input.i0Hash,
      },
    );
  }
  recordI1(campaignId: string, input: { i1Hash: string }) {
    return this.write(campaignId, 'i1', 'commitment', [input.i1Hash], { i1Hash: input.i1Hash });
  }
  markFreeze(campaignId: string, input: { freezeHash?: string } = {}) {
    return this.write(
      campaignId,
      'freeze',
      'i1',
      input.freezeHash === undefined ? [] : [input.freezeHash],
      input.freezeHash === undefined ? {} : { freezeHash: input.freezeHash },
    );
  }

  recordDraw(campaignId: string, input: { setHash: string }) {
    return this.write(campaignId, 'draw', 'freeze', [input.setHash], { setHash: input.setHash });
  }

  private async write(
    campaignId: string,
    kind: MetaDrawKind,
    after: MetaDrawKind | null,
    hashes: string[],
    fields: Document,
  ): Promise<{ committedAt: Date }> {
    requirePrincipal(this.service, ['fixture_builder']);
    assertIds(campaignId);
    if (!hashes.every((hash) => HEX64.test(hash))) fail('InvalidMetaCommitment');
    if (after) {
      const previous = await this.readKind(campaignId, after);
      if (!previous) fail('MetaDrawOutOfOrder');
      // The new row's id will carry the server's time at insert: it must already be more than one second later.
      if ((await serverNow(this.service)).getTime() < previous.committedAt.getTime() + META_DRAW_MIN_GAP_MS)
        fail('MetaDrawTooSoon');
    }
    try {
      await this.rows.insertOne({ campaignId, kind, ...fields } as never, { forceServerObjectId: true });
    } catch (error) {
      if (isDuplicate(error)) fail('MetaDrawAlreadyCommitted');
      throw error;
    }
    const stored = await this.readKind(campaignId, kind);
    if (!stored) fail('MetaDrawCommitmentMissing');
    return { committedAt: stored.committedAt };
  }

  private async readKind(campaignId: string, kind: MetaDrawKind): Promise<StoredMetaDrawRow | null> {
    const row = await this.rows.findOne({ campaignId, kind }, { readConcern: { level: 'majority' } });
    if (!row) return null;
    const { _id, ...rest } = row;
    return { ...(rest as unknown as StoredMetaDrawRow), committedAt: _id.getTimestamp() };
  }

  /** All rows written so far for the campaign, each with its server time. */
  async read(campaignId: string): Promise<StoredMetaDraw> {
    requirePrincipal(this.service, ['fixture_builder', 'grader', 'setup']);
    assertIds(campaignId);
    const out: StoredMetaDraw = {};
    for (const kind of ['commitment', 'i1', 'freeze', 'draw'] as const) {
      const row = await this.readKind(campaignId, kind);
      if (row) out[kind] = row;
    }
    return out;
  }
}
