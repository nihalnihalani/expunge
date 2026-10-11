import type { ChangeStream, ChangeStreamDocument, ClientSession, Document, ResumeToken } from 'mongodb';
import {
  contentHash,
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
    validateProjectionPayload(event.kind, event.payload);
    const execute = async (active: ClientSession) => {
      const existing = await this.service.control
        .collection<ProjectionEvent & { _id: string }>('projection_events')
        .findOne({ _id: event.eventId, ...scopeFilter(key) }, { session: active });
      if (existing) {
        const { _id: _ignored, sequence: _sequence, createdAt: _createdAt, ...prior } = existing;
        if (
          contentHash(prior, 'projection-event') !==
          contentHash({ ...scopeFilter(key), ...event }, 'projection-event')
        )
          fail('EventIdConflict');
        const { _id: _ignoredId, ...result } = existing;
        return result;
      }
      const counter = await this.service.control
        .collection<{ _id: string; sequence: number }>('projection_sequences')
        .findOneAndUpdate(
          { _id: projectionStreamId(key, event.jobId) },
          { $inc: { sequence: 1 } },
          { session: active, upsert: true, returnDocument: 'after', includeResultMetadata: false },
        );
      if (!counter) fail('SequenceAllocationFailed');
      const result: ProjectionEvent = {
        ...scopeFilter(key),
        ...event,
        payload: event.payload as unknown as JsonValue,
        sequence: counter.sequence,
        createdAt: new Date(),
      };
      await this.service.control
        .collection<import('mongodb').Document & { _id: string }>('projection_events')
        .insertOne({ _id: event.eventId, ...result }, { session: active });
      return result;
    };
    return session ? execute(session) : this.service.transaction(execute);
  }
  /** One job's events after `afterSequence`, in order. Sequences are per job, so the job is required. */
  async read(key: ScopeKey, afterSequence: number, jobId: string, limit = 500): Promise<ProjectionEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || limit < 1 || limit > 1000 || !jobId)
      fail('InvalidEventWindow');
    const events = await this.service.control
      .collection<ProjectionEvent & { _id: string }>('projection_events')
      .find({ ...scopeFilter(key), jobId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .limit(limit)
      .toArray();
    return events.map(({ _id, ...event }) => event);
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
        const { _id: _recordId, ...event } = change.fullDocument as ProjectionEvent & { _id: string };
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
