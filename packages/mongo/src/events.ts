import { randomUUID } from 'node:crypto';
import type { ChangeStream, ChangeStreamDocument, ClientSession, Document, ResumeToken } from 'mongodb';
import {
  contentHash,
  environmentSchema,
  isProjectionEventKind,
  sameScope,
  validateProjectionPayload,
  type JsonValue,
  type ProjectionEvent,
  type ProjectionEventKind,
  type ProjectionPayloadByKind,
  type ScopeKey,
} from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

/** An event to append: the payload type follows the kind, so a mismatched payload fails to compile. */
export type ProjectionEventInput = {
  [K in ProjectionEventKind]: {
    eventId: string;
    jobId: string;
    runId: string;
    artifactIds: string[];
    kind: K;
    payload: ProjectionPayloadByKind[K];
  };
}[ProjectionEventKind];

const INPUT_KEYS = new Set(['eventId', 'jobId', 'runId', 'artifactIds', 'kind', 'payload']);
const ENVELOPE_KEYS = new Set(['_id', 'tenantId', 'env', 'scopeId', 'sequence', 'createdAt', ...INPUT_KEYS]);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const objectRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function checkedScope(input: ScopeKey): ScopeKey {
  const env = environmentSchema.safeParse(input.env);
  if (!identifier(input.tenantId) || !identifier(input.scopeId) || !env.success)
    fail('InvalidProjectionHistoryEnvelope');
  return { tenantId: input.tenantId, env: env.data, scopeId: input.scopeId };
}
function checkedInput(input: unknown): ProjectionEventInput {
  if (
    !objectRecord(input) ||
    Object.keys(input).some((key) => !INPUT_KEYS.has(key)) ||
    !identifier(input.eventId) ||
    !identifier(input.jobId) ||
    !identifier(input.runId) ||
    !Array.isArray(input.artifactIds) ||
    input.artifactIds.length > 256 ||
    !Array.from(input.artifactIds).every(identifier) ||
    !isProjectionEventKind(input.kind)
  )
    fail('InvalidProjectionHistoryEnvelope');
  let payload: unknown;
  try {
    payload = validateProjectionPayload(input.kind, input.payload);
  } catch {
    fail('InvalidProjectionHistoryPayload');
  }
  return {
    eventId: input.eventId,
    jobId: input.jobId,
    runId: input.runId,
    artifactIds: [...input.artifactIds],
    kind: input.kind,
    payload,
  } as ProjectionEventInput;
}

/** New producers never receive the legacy waiver. Deep validated payload and scope copies precede every await. */
export function captureProjectionEventInput(
  scope: ScopeKey,
  input: ProjectionEventInput,
): { scope: ScopeKey; event: ProjectionEventInput } {
  return { scope: checkedScope(scope), event: checkedInput(input) };
}

/** Versionless persisted history supports only the complete documented legacy shapes; unknown history fails closed. */
export function decodeStoredProjectionEvent(
  input: unknown,
  expected?: { scope: ScopeKey; jobId?: string },
): ProjectionEvent {
  if (
    !objectRecord(input) ||
    Object.keys(input).some((key) => !ENVELOPE_KEYS.has(key)) ||
    !Number.isSafeInteger(input.sequence) ||
    Number(input.sequence) < 1 ||
    !(input.createdAt instanceof Date) ||
    !Number.isFinite(input.createdAt.getTime()) ||
    (Object.hasOwn(input, '_id') && input._id !== input.eventId)
  )
    fail('InvalidProjectionHistoryEnvelope');
  const scope = checkedScope(input as unknown as ScopeKey);
  if (
    expected &&
    (!sameScope(scope, checkedScope(expected.scope)) ||
      (expected.jobId !== undefined && input.jobId !== expected.jobId))
  )
    fail('InvalidProjectionHistoryScope');
  let payload = input.payload;
  if (objectRecord(payload) && input.kind === 'trial_completed') {
    const legacy = payload;
    const retired = ['split', 'parentUseful', 'candidateUseful'];
    if (retired.some((key) => Object.hasOwn(legacy, key))) {
      if (
        !retired.every((key) => Object.hasOwn(legacy, key)) ||
        typeof legacy.split !== 'string' ||
        !['train', 'protected', 'validation', 'final'].includes(legacy.split) ||
        typeof legacy.parentUseful !== 'boolean' ||
        typeof legacy.candidateUseful !== 'boolean'
      )
        fail('UnsupportedProjectionHistory');
      payload = Object.fromEntries(Object.entries(legacy).filter(([key]) => !retired.includes(key)));
    }
  } else if (
    objectRecord(payload) &&
    input.kind === 'campaign_row_committed' &&
    Object.hasOwn(payload, 'admitted')
  ) {
    if (typeof payload.admitted !== 'boolean') fail('UnsupportedProjectionHistory');
    payload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'admitted'));
  }
  const event = checkedInput({
    eventId: input.eventId,
    jobId: input.jobId,
    runId: input.runId,
    artifactIds: input.artifactIds,
    kind: input.kind,
    payload,
  });
  return {
    ...scope,
    ...event,
    payload: event.payload as unknown as JsonValue,
    sequence: Number(input.sequence),
    createdAt: new Date(input.createdAt.getTime()),
  };
}

/** Identity of one job's event stream: its sequence counter is private to (scope, job). */
export function projectionStreamId(key: ScopeKey, jobId: string): string {
  return contentHash({ ...scopeFilter(key), jobId }, 'projection-stream');
}

/**
 * The sanitized event log the operator UI replays.
 *
 * Sequences are per job and contiguous from 1: the counter increment and the event insert happen in one
 * transaction (the caller's, or one opened here), so an aborted transaction gives its number back and a reader
 * that sees sequence N and then N+2 knows an event is missing instead of assuming it never existed.
 * Payloads are validated against a strict per-kind schema before anything is written.
 */
export class ProjectionRepository {
  constructor(readonly service: MongoService) {}
  async append(
    key: ScopeKey,
    event: ProjectionEventInput,
    session?: ClientSession,
  ): Promise<ProjectionEvent> {
    requirePrincipal(this.service, [
      'domain_executor',
      'observer',
      'promoter',
      'privacy_controller',
      'grader',
      'fixture_builder',
      'setup',
    ]);
    const captured = captureProjectionEventInput(key, event);
    const boundScope = captured.scope;
    const boundEvent = captured.event;
    const execute = async (active: ClientSession) => {
      const existing = await this.service.control
        .collection<ProjectionEvent & { _id: string }>('projection_events')
        .findOne({ _id: boundEvent.eventId, ...boundScope }, { session: active });
      if (existing) {
        const decoded = decodeStoredProjectionEvent(existing, { scope: boundScope, jobId: boundEvent.jobId });
        const { sequence: _sequence, createdAt: _createdAt, ...prior } = decoded;
        if (
          contentHash(prior, 'projection-event') !==
          contentHash({ ...boundScope, ...boundEvent }, 'projection-event')
        )
          fail('EventIdConflict');
        return decoded;
      }
      const counter = await this.service.control
        .collection<{ _id: string; sequence: number }>('projection_sequences')
        .findOneAndUpdate(
          { _id: projectionStreamId(boundScope, boundEvent.jobId) },
          // The epoch is born with the stream and never changes on an append (only `resetStream` replaces it).
          { $inc: { sequence: 1 }, $setOnInsert: { epoch: randomUUID() } },
          { session: active, upsert: true, returnDocument: 'after', includeResultMetadata: false },
        );
      if (!counter) fail('SequenceAllocationFailed');
      const result: ProjectionEvent = {
        ...boundScope,
        ...boundEvent,
        payload: boundEvent.payload as unknown as JsonValue,
        sequence: counter.sequence,
        createdAt: new Date(),
      };
      await this.service.control
        .collection<import('mongodb').Document & { _id: string }>('projection_events')
        .insertOne({ _id: boundEvent.eventId, ...result }, { session: active });
      return result;
    };
    return session ? execute(session) : this.service.transaction(execute);
  }
  /**
   * The stream's epoch: an opaque value, constant for one committed history of the job's events, that CHANGES ONLY when
   * the per-job sequence is rebuilt or reset (`resetStream`: a restore, a re-sequencing, a rebuild). An append never changes
   * it. `null` while the stream has no events yet, so the field is optional on the wire.
   */
  async epochOf(key: ScopeKey, jobId: string, session?: ClientSession): Promise<string | null> {
    const row = await this.service.control
      .collection<{ _id: string; epoch?: string }>('projection_sequences')
      .findOne(
        { _id: projectionStreamId(key, jobId) },
        { ...(session ? { session } : {}), projection: { epoch: 1 } },
      );
    return typeof row?.epoch === 'string' ? row.epoch : null;
  }

  /**
   * One page of a job's events together with the epoch they belong to. The page always comes from ONE epoch: the epoch
   * is read before and after the events, and a reset in between makes the read start over, so a client never receives
   * rows of two histories under one epoch.
   */
  async readPage(
    key: ScopeKey,
    afterSequence: number,
    jobId: string,
    limit = 500,
  ): Promise<{ events: ProjectionEvent[]; streamEpoch: string | null }> {
    const boundScope = checkedScope(key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.epochOf(boundScope, jobId);
      const events = await this.read(boundScope, afterSequence, jobId, limit);
      if ((await this.epochOf(boundScope, jobId)) === before) return { events, streamEpoch: before };
    }
    fail('StreamEpochUnstable');
  }

  /**
   * Replaces a job's event history. In ONE transaction: the job's events are removed, the sequence counter restarts at 0 under
   * a NEW epoch (recording why, as a hash, never the text), and `rebuild` may append the events again from committed state
   * with the same session. Clients that hold an older epoch see it change and re-page from 0. Restricted to `setup`: the
   * projection roles grant no delete on `projection_events`, and a reset is an administrator's act.
   */
  async resetStream(
    key: ScopeKey,
    jobId: string,
    reason: 'restore' | 'resequence' | 'backfill_rebuild',
    rebuild?: (session: ClientSession) => Promise<void>,
  ): Promise<{ streamEpoch: string; removed: number }> {
    requirePrincipal(this.service, ['setup']);
    if (!['restore', 'resequence', 'backfill_rebuild'].includes(reason)) fail('InvalidReset');
    return this.service.transaction(async (session) => {
      const removed = await this.service.control
        .collection('projection_events')
        .deleteMany({ ...scopeFilter(key), jobId }, { session });
      const streamEpoch = randomUUID();
      await this.service.control
        .collection<import('mongodb').Document & { _id: string }>('projection_sequences')
        .updateOne(
          { _id: projectionStreamId(key, jobId) },
          {
            $set: {
              sequence: 0,
              epoch: streamEpoch,
              resetAt: new Date(),
              resetReasonHash: contentHash({ reason }, 'stream-reset'),
            },
          },
          { session, upsert: true },
        );
      if (rebuild) await rebuild(session);
      return { streamEpoch, removed: removed.deletedCount };
    });
  }

  /**
   * The committed completion receipt of a job as the list needs it, from the job's own `receipt_committed` event (so it is
   * a committed fact with its projection sequence), or `null` when no receipt has been committed. Never inferred.
   */
  async receiptReference(
    key: ScopeKey,
    jobId: string,
  ): Promise<{ receiptId: string; receiptSequence: number; verifiedWorldRevision: number } | null> {
    const boundScope = checkedScope(key);
    const row = await this.service.control
      .collection<ProjectionEvent & { _id: string }>('projection_events')
      .findOne({ ...boundScope, jobId, kind: 'receipt_committed' }, { sort: { sequence: -1 } });
    if (!row) return null;
    const decoded = decodeStoredProjectionEvent(row, { scope: boundScope, jobId });
    if (decoded.kind !== 'receipt_committed') fail('InvalidProjectionHistoryPayload');
    const payload = decoded.payload as unknown as ProjectionPayloadByKind['receipt_committed'];
    return {
      receiptId: payload.receiptId,
      receiptSequence: decoded.sequence,
      verifiedWorldRevision: payload.verifiedWorldRevision,
    };
  }

  /** One job's events after `afterSequence`, in order. Sequences are per job, so the job is required. */
  async read(key: ScopeKey, afterSequence: number, jobId: string, limit = 500): Promise<ProjectionEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || limit < 1 || limit > 1000 || !jobId)
      fail('InvalidEventWindow');
    const boundScope = checkedScope(key);
    const events = await this.service.control
      .collection<ProjectionEvent & { _id: string }>('projection_events')
      .find({ ...boundScope, jobId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .limit(limit)
      .toArray();
    return events.map((event) => decodeStoredProjectionEvent(event, { scope: boundScope, jobId }));
  }
}
export type StreamCheckpoint = {
  _id: string;
  pipelineVersion: string;
  resumeToken: ResumeToken;
  updatedAt: Date;
};
export type StreamRecovery = {
  kind: 'snapshot_backfill';
  consumerId: string;
  pipelineVersion: string;
  /** Present when recovery was caused by an unusable stored resume token: the server error code that rejected it. */
  cause?: { code: number };
};
/**
 * Server codes for a stored resume token the server cannot use (unparseable BSON, wrong type, not a resume token, from
 * another stream, history gone). Codes 9 and 14 are generic, so they only count while the stream is being opened from a
 * stored token and no event has been delivered yet: after events flowed they are ordinary pipeline errors and rethrow.
 */
export const RESUME_FAILURE_CODES: ReadonlySet<number> = new Set([
  9, 14, 280, 286, 40585, 40645, 40646, 40647, 40648, 50811, 50874,
]);
/** Opaque BSON tokens stay in the backend; UI resumes by durable event sequence. */
export class ProjectionStreamConsumer {
  private stream?: ChangeStream<Document, ChangeStreamDocument<Document>>;
  constructor(
    readonly service: MongoService,
    readonly consumerId: string,
    readonly pipelineVersion: string,
  ) {}
  async consume(
    onEvent: (event: ProjectionEvent) => Promise<void>,
    recover: (reason: StreamRecovery) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    requirePrincipal(this.service, ['observer', 'projection_reader', 'setup']);
    const offsets = this.service.control.collection<StreamCheckpoint>('stream_offsets');
    const previous = await offsets.findOne({ _id: this.consumerId });
    if (previous && previous.pipelineVersion !== this.pipelineVersion) {
      await recover({
        kind: 'snapshot_backfill',
        consumerId: this.consumerId,
        pipelineVersion: this.pipelineVersion,
      });
      await offsets.deleteOne({ _id: this.consumerId });
    }
    const pipeline: Document[] = [{ $match: { operationType: { $in: ['insert', 'invalidate'] } } }];
    this.stream = this.service.control
      .collection<import('mongodb').Document & { _id: string }>('projection_events')
      .watch(pipeline, {
        ...(previous?.pipelineVersion === this.pipelineVersion ? { resumeAfter: previous.resumeToken } : {}),
        maxAwaitTimeMS: 1000,
      });
    const resumedFrom = previous?.pipelineVersion === this.pipelineVersion ? previous.resumeToken : undefined;
    let received = false; // any change from the server, delivered or skipped
    const close = () => {
      void this.stream?.close();
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      for await (const change of this.stream) {
        received = true;
        if (signal.aborted) break;
        if (change.operationType === 'invalidate') {
          await recover({
            kind: 'snapshot_backfill',
            consumerId: this.consumerId,
            pipelineVersion: this.pipelineVersion,
          });
          await offsets.deleteOne({ _id: this.consumerId });
          break;
        }
        if (change.operationType !== 'insert') continue;
        const event = decodeStoredProjectionEvent(change.fullDocument);
        await onEvent(event);
        await offsets.updateOne(
          { _id: this.consumerId },
          { $set: { pipelineVersion: this.pipelineVersion, resumeToken: change._id, updatedAt: new Date() } },
          { upsert: true },
        );
      }
    } catch (error) {
      if (signal.aborted) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code === 286 || code === 280) {
        await recover({
          kind: 'snapshot_backfill',
          consumerId: this.consumerId,
          pipelineVersion: this.pipelineVersion,
        });
        await offsets.deleteOne({ _id: this.consumerId });
        return;
      }
      if (
        resumedFrom !== undefined &&
        !received &&
        typeof code === 'number' &&
        RESUME_FAILURE_CODES.has(code)
      ) {
        // The stored token was rejected while opening the stream. Record the recovery first (never only a log), then
        // forget exactly that token: a concurrent consumer that already stored a newer offset keeps it.
        await recover({
          kind: 'snapshot_backfill',
          consumerId: this.consumerId,
          pipelineVersion: this.pipelineVersion,
          cause: { code },
        });
        await offsets.deleteOne({ _id: this.consumerId, resumeToken: resumedFrom } as never);
        return;
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', close);
      await this.stream?.close();
    }
  }
}
