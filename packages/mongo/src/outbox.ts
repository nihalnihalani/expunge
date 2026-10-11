import type { ClientSession } from 'mongodb';
import {
  contentHash,
  type OutboxState,
  type ScopeKey,
  type TelemetryOutbox,
  type JsonValue,
  type ObserverCursor,
  type ObserverQueryIdentity,
} from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

const proofOrder = ['sdk_enqueued', 'ingest_accepted', 'query_visible', 'evidence_ready'] as const;
export class OutboxRepository {
  constructor(readonly service: MongoService) {}
  async enqueue(
    key: ScopeKey,
    input: {
      operationId: string;
      kind: string;
      dedupeKey: string;
      jobId: string;
      payload: JsonValue;
      evidenceRequired: string[];
    },
    session?: ClientSession,
  ): Promise<TelemetryOutbox> {
    requirePrincipal(this.service, [
      'domain_executor',
      'observer',
      'promoter',
      'privacy_controller',
      'grader',
      'fixture_builder',
      'setup',
    ]);
    const now = new Date();
    const row: TelemetryOutbox = {
      ...scopeFilter(key),
      ...input,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(0),
      lease: { ownerId: '', fence: 0, until: new Date(0), heartbeatAt: new Date(0) },
      attained: {},
      createdAt: now,
      updatedAt: now,
    };
    await this.service.control
      .collection<import('mongodb').Document & { _id: string }>('telemetry_outbox')
      .insertOne({ _id: input.operationId, ...row }, { session });
    return row;
  }
  async claim(key: ScopeKey, ownerId: string, durationMs = 30000): Promise<TelemetryOutbox | null> {
    requirePrincipal(this.service, ['observer', 'privacy_controller', 'setup']);
    if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 120000)
      fail('InvalidLeaseDuration');
    const row = await this.service.control
      .collection<TelemetryOutbox & { _id: string }>('telemetry_outbox')
      .findOneAndUpdate(
        {
          ...scopeFilter(key),
          status: { $nin: ['evidence_ready', 'dead_letter'] },
          $expr: { $and: [{ $lte: ['$lease.until', '$$NOW'] }, { $lte: ['$nextAttemptAt', '$$NOW'] }] },
        },
        [
          {
            $set: {
              status: { $literal: 'leased' },
              attempts: { $add: ['$attempts', 1] },
              'lease.ownerId': { $literal: ownerId },
              'lease.fence': { $add: ['$lease.fence', 1] },
              'lease.until': { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: durationMs } },
              'lease.heartbeatAt': '$$NOW',
              updatedAt: '$$NOW',
            },
          },
        ],
        { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after', includeResultMetadata: false },
      );
    if (!row) return null;
    const { _id, ...result } = row;
    return result;
  }
  async advance(
    key: ScopeKey,
    operationId: string,
    ownerId: string,
    fence: number,
    state: OutboxState,
    proof: { contentHash: string; externalReceiptId?: string; presentFields?: string[] },
    session?: ClientSession,
  ): Promise<void> {
    requirePrincipal(this.service, ['observer', 'privacy_controller', 'setup']);
    if (!proofOrder.includes(state as (typeof proofOrder)[number])) fail('InvalidOutboxAttainment');
    const collection = this.service.control.collection<TelemetryOutbox & { _id: string }>('telemetry_outbox');
    const row = await collection.findOne({ _id: operationId, ...scopeFilter(key) }, { session });
    if (!row) fail('OutboxNotFound');
    if (
      state === 'evidence_ready' &&
      (!row.attained.query_visible || row.evidenceRequired.some((f) => !proof.presentFields?.includes(f)))
    )
      fail('EvidenceIncomplete');
    const previous = proofOrder.indexOf(state as (typeof proofOrder)[number]) - 1;
    if (previous >= 0 && !row.attained[proofOrder[previous]!]) fail('MissingDeliveryProof');
    const result = await collection.updateOne(
      {
        _id: operationId,
        ...scopeFilter(key),
        'lease.ownerId': ownerId,
        'lease.fence': fence,
        $expr: { $gt: ['$lease.until', '$$NOW'] },
      },
      {
        $set: {
          status: state,
          ...(!row.attained[state]
            ? {
                [`attained.${state}`]: {
                  at: new Date(),
                  contentHash: proof.contentHash,
                  ...(proof.externalReceiptId ? { externalReceiptId: proof.externalReceiptId } : {}),
                },
              }
            : {}),
        },
        $currentDate: { updatedAt: true },
      },
      { session },
    );
    if (!result.matchedCount) fail('LostOutboxLease');
  }
  async retry(
    key: ScopeKey,
    operationId: string,
    ownerId: string,
    fence: number,
    errorCode: string,
    delayMs: number,
    dead = false,
  ): Promise<void> {
    if (delayMs < 0 || delayMs > 3600000) fail('InvalidBackoff');
    const result = await this.service.control
      .collection<import('mongodb').Document & { _id: string }>('telemetry_outbox')
      .updateOne(
        {
          _id: operationId,
          ...scopeFilter(key),
          'lease.ownerId': ownerId,
          'lease.fence': fence,
          $expr: { $gt: ['$lease.until', '$$NOW'] },
        },
        [
          {
            $set: {
              status: { $literal: dead ? 'dead_letter' : 'retrying' },
              lastErrorCode: { $literal: errorCode },
              nextAttemptAt: { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: delayMs } },
              'lease.until': new Date(0),
              updatedAt: '$$NOW',
            },
          },
        ],
      );
    if (!result.modifiedCount) fail('LostOutboxLease');
  }
}
export function queryIdentityDigest(query: ObserverQueryIdentity): string {
  const { filterHash, ...rest } = query;
  if (contentHash(query.filterSnapshot, 'observer-filter') !== filterHash) fail('ObserverFilterMismatch');
  return contentHash(rest, 'observer-query');
}
export class ObserverCursorRepository {
  constructor(readonly service: MongoService) {}
  async initialize(query: ObserverQueryIdentity): Promise<ObserverCursor> {
    requirePrincipal(this.service, ['observer', 'setup']);
    const _id = queryIdentityDigest(query);
    const existing = await this.service.control
      .collection<ObserverCursor>('observer_cursors')
      .findOne({ projectId: query.projectId, observerVersion: query.observerVersion });
    if (existing) {
      if (existing._id !== _id) fail('ObserverQueryIdentityChanged');
      return existing;
    }
    const row: ObserverCursor = {
      ...query,
      _id,
      revision: 0,
      providerCursor: null,
      pendingEnrichmentIds: [],
      lastCommittedProcessingAt: new Date(0),
    };
    await this.service.control.collection<ObserverCursor>('observer_cursors').insertOne(row);
    return row;
  }
  /** Evidence/event dedupe writes and this CAS must share the caller's transaction. */
  async checkpoint(
    query: ObserverQueryIdentity,
    expectedRevision: number,
    providerCursor: string | null,
    pendingEnrichmentIds: string[],
    session: ClientSession,
  ): Promise<void> {
    requirePrincipal(this.service, ['observer', 'setup']);
    const result = await this.service.control.collection<ObserverCursor>('observer_cursors').updateOne(
      { _id: queryIdentityDigest(query), revision: expectedRevision, filterHash: query.filterHash },
      {
        $set: { providerCursor, pendingEnrichmentIds },
        $inc: { revision: 1 },
        $currentDate: { lastCommittedProcessingAt: true },
      },
      { session },
    );
    if (!result.modifiedCount) fail('StaleObserverCursor');
  }
}
