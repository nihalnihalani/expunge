import { contentHash, type OutboxState, type ScopeKey, type TelemetryOutbox } from '@expunge/contracts';
import {
  IngestClient,
  telemetryPayloadSchema,
  type IngestFailure,
  type TelemetryPayload,
} from '@expunge/observability';
import type { ClientSession } from 'mongodb';
import { missingFields, observeEvent, type EvidenceStore } from './evidence.js';
import { RaindropQueryClient, RaindropQueryError, type RaindropEvent } from './query-client.js';
import type { RunInTransaction } from './scan.js';

/** The slice of OutboxRepository the dispatcher uses; the real repository satisfies it structurally. */
export interface OutboxPort {
  claim(key: ScopeKey, ownerId: string, durationMs?: number): Promise<TelemetryOutbox | null>;
  advance(
    key: ScopeKey,
    operationId: string,
    ownerId: string,
    fence: number,
    state: OutboxState,
    proof: { contentHash: string; externalReceiptId?: string; presentFields?: string[] },
    session?: ClientSession,
  ): Promise<void>;
  retry(
    key: ScopeKey,
    operationId: string,
    ownerId: string,
    fence: number,
    errorCode: string,
    delayMs: number,
    dead?: boolean,
  ): Promise<void>;
}

export type DispatchOutcome = {
  operationId: string;
  result: 'evidence_ready' | 'retrying' | 'hold' | 'dead_letter' | 'blocked';
  attained: OutboxState[];
  detail?: string;
};

export type DispatcherOptions = {
  ownerId: string;
  leaseMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Visible but incomplete evidence is re-read for this long, then dead-lettered (never released as evidence). */
  holdTimeoutMs?: number;
  /** Delay before retrying after an auth failure; the row is HELD for an operator to fix the key, not dead-lettered. */
  authBlockDelayMs?: number;
  now?: () => Date;
  random?: () => number;
};

const BLOCKED_HOLD_MS = 15 * 60_000;

/**
 * Dispatches telemetry outbox intents AFTER the domain transaction that wrote them, and walks each through
 *   pending/leased -> sdk_enqueued -> ingest_accepted -> query_visible -> evidence_ready
 * recording every attained state with its own time and content hash. Each state is separate evidence:
 *  - sdk_enqueued: the payload was handed to the ingestion client;
 *  - ingest_accepted: the provider answered 2xx for the ingestion request (HTTP 204);
 *  - query_visible: the Query API returned the event by ID;
 *  - evidence_ready: every REQUIRED remote field (signals, tool_calls, ...) is present, and the evidence is stored.
 * A visible but incomplete event is HELD (re-read with backoff, then dead-lettered); it is never promoted.
 */
export class OutboxDispatcher {
  private readonly opts: Required<Omit<DispatcherOptions, 'ownerId'>> & { ownerId: string };
  constructor(
    private readonly deps: {
      outbox: OutboxPort;
      ingest: IngestClient;
      query: RaindropQueryClient;
      evidence: EvidenceStore;
      transaction: RunInTransaction;
      scope: ScopeKey;
      projectId: string;
    },
    options: DispatcherOptions,
  ) {
    this.opts = {
      leaseMs: 30_000,
      maxAttempts: 8,
      baseDelayMs: 1_000,
      maxDelayMs: 600_000,
      holdTimeoutMs: 30 * 60_000,
      authBlockDelayMs: BLOCKED_HOLD_MS,
      now: () => new Date(),
      random: Math.random,
      ...options,
    };
  }

  /** Processes one claimable row. Returns null when there is nothing due. */
  async runOnce(): Promise<DispatchOutcome | null> {
    const { outbox, scope } = this.deps;
    const row = await outbox.claim(scope, this.opts.ownerId, this.opts.leaseMs);
    if (!row) return null;
    const lease = { operationId: row.operationId, fence: row.lease.fence };
    const attained = (): OutboxState[] => Object.keys(row.attained) as OutboxState[];

    const parsed = telemetryPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      await outbox.retry(scope, lease.operationId, this.opts.ownerId, lease.fence, 'InvalidPayload', 0, true);
      return {
        operationId: lease.operationId,
        result: 'dead_letter',
        attained: attained(),
        detail: 'InvalidPayload',
      };
    }
    const payload = parsed.data;
    const payloadHash = contentHash(payload, 'telemetry-payload');
    const advance = async (
      state: OutboxState,
      proof: { contentHash: string; externalReceiptId?: string; presentFields?: string[] },
      session?: ClientSession,
    ) => {
      if (row.attained[state]) return; // never re-advance (and so never regress) an attained state
      await outbox.advance(scope, lease.operationId, this.opts.ownerId, lease.fence, state, proof, session);
      row.attained[state] = {
        at: this.opts.now(),
        contentHash: proof.contentHash,
        ...(proof.externalReceiptId ? { externalReceiptId: proof.externalReceiptId } : {}),
      };
    };

    try {
      // 1. Send (HTTP kinds only). An sdk_event was produced live by the worker's SDK; there is nothing to send.
      if (payload.type !== 'sdk_event' && !row.attained.ingest_accepted) {
        await advance('sdk_enqueued', { contentHash: payloadHash });
        const sent = await this.send(payload);
        if (!sent.ok) return await this.fail(row, sent);
        await advance('ingest_accepted', {
          contentHash: payloadHash,
          externalReceiptId: `http-${sent.status}`,
        });
      }

      // 2. Read back by ID. Absent means "not visible yet", never "nothing happened".
      const event = await this.deps.query.getEvent(payload.eventId);
      if (!event) return await this.retryWith(row, 'RemoteNotVisible', 'retrying');

      const traces = row.evidenceRequired.includes('spans')
        ? await this.deps.query.getTraces(payload.eventId)
        : undefined;
      const observation = observeEvent(this.deps.projectId, event, traces, this.opts.now());

      if (payload.type === 'sdk_event') {
        // The worker's SDK enqueue and terminal POST happen in another process and cannot be observed here, so they are
        // recorded as what they are: worker-attested and inferred from the event being visible. Never as observed.
        await advance('sdk_enqueued', {
          contentHash: payloadHash,
          externalReceiptId: 'worker-attested-not-observed',
        });
        await advance('ingest_accepted', {
          contentHash: observation.contentHash,
          externalReceiptId: 'inferred-from-query-visible',
        });
      }
      await advance('query_visible', { contentHash: observation.contentHash, externalReceiptId: event.id });

      // 3. Required remote fields, plus the specific thing this intent is about.
      const missing = [
        ...missingFields(row.evidenceRequired, observation.presentFields),
        ...this.specificGaps(payload, event),
      ];
      if (missing.length > 0) {
        const visibleAt = row.attained.query_visible?.at ?? this.opts.now();
        if (this.opts.now().getTime() - visibleAt.getTime() > this.opts.holdTimeoutMs)
          return await this.retryWith(
            row,
            `EvidenceIncompleteTimeout:${missing.join('+')}`,
            'dead_letter',
            true,
          );
        return await this.retryWith(row, `hold:${missing.join('+')}`, 'hold');
      }
      await this.deps.transaction(async (session) => {
        await this.deps.evidence.put(observation, scope, session);
        await advance(
          'evidence_ready',
          { contentHash: observation.contentHash, presentFields: observation.presentFields },
          session,
        );
      });
      return { operationId: lease.operationId, result: 'evidence_ready', attained: attained() };
    } catch (error) {
      if (error instanceof RaindropQueryError) return await this.failQuery(row, error);
      throw error;
    }
  }

  private send(payload: Exclude<TelemetryPayload, { type: 'sdk_event' }>) {
    const { ingest } = this.deps;
    if (payload.type === 'signal')
      return ingest.trackSignals([
        {
          event_id: payload.eventId,
          signal_name: payload.signalName,
          signal_type: payload.signalType,
          ...(payload.sentiment ? { sentiment: payload.sentiment } : {}),
          properties: { ...payload.properties, origin: payload.origin },
        },
      ]);
    return ingest.trackEvents([
      {
        user_id: payload.userId,
        event: payload.event,
        event_id: payload.eventId,
        properties: { ...payload.properties, origin: payload.origin },
        ai_data: {
          output: payload.output,
          ...(payload.input ? { input: payload.input } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.convoId ? { convo_id: payload.convoId } : {}),
        },
      },
    ]);
  }

  /** What this particular intent needs beyond the generic field list. */
  private specificGaps(payload: TelemetryPayload, event: RaindropEvent): string[] {
    if (payload.type === 'signal')
      return (event.signals ?? []).some((signal) => signal.name === payload.signalName)
        ? []
        : [`signal:${payload.signalName}`];
    if (payload.type === 'event') return event.assistant_output ? [] : ['assistant_output'];
    return [];
  }

  private delay(attempts: number, floor = 0): number {
    const exponential = Math.min(
      this.opts.maxDelayMs,
      this.opts.baseDelayMs * 2 ** Math.max(0, attempts - 1),
    );
    return Math.min(3_600_000, Math.max(floor, Math.round(exponential * (0.5 + this.opts.random() * 0.5))));
  }

  private async retryWith(
    row: TelemetryOutbox,
    code: string,
    result: DispatchOutcome['result'],
    dead = false,
  ): Promise<DispatchOutcome> {
    const exhausted = dead || row.attempts >= this.opts.maxAttempts;
    await this.deps.outbox.retry(
      this.deps.scope,
      row.operationId,
      this.opts.ownerId,
      row.lease.fence,
      code,
      exhausted ? 0 : this.delay(row.attempts),
      exhausted,
    );
    return {
      operationId: row.operationId,
      result: exhausted ? 'dead_letter' : result,
      attained: Object.keys(row.attained) as OutboxState[],
      detail: code,
    };
  }

  private async fail(row: TelemetryOutbox, failure: IngestFailure): Promise<DispatchOutcome> {
    if (failure.kind === 'auth') return this.block(row, `blocked_ingest_${failure.status}`);
    if (!failure.retryable)
      return this.retryWith(row, `ingest_${failure.kind}_${failure.status ?? 'none'}`, 'dead_letter', true);
    const exhausted = row.attempts >= this.opts.maxAttempts;
    await this.deps.outbox.retry(
      this.deps.scope,
      row.operationId,
      this.opts.ownerId,
      row.lease.fence,
      `ingest_${failure.kind}_${failure.status ?? 'none'}`,
      exhausted ? 0 : this.delay(row.attempts, failure.retryAfterMs ?? 0),
      exhausted,
    );
    return {
      operationId: row.operationId,
      result: exhausted ? 'dead_letter' : 'retrying',
      attained: Object.keys(row.attained) as OutboxState[],
      detail: `ingest_${failure.kind}`,
    };
  }

  private async failQuery(row: TelemetryOutbox, error: RaindropQueryError): Promise<DispatchOutcome> {
    if (error.kind === 'auth' || error.kind === 'forbidden')
      return this.block(row, `blocked_query_${error.status}`);
    const exhausted = row.attempts >= this.opts.maxAttempts;
    await this.deps.outbox.retry(
      this.deps.scope,
      row.operationId,
      this.opts.ownerId,
      row.lease.fence,
      `query_${error.kind}`,
      exhausted ? 0 : this.delay(row.attempts, error.retryAfterMs ?? 0),
      exhausted,
    );
    return {
      operationId: row.operationId,
      result: exhausted ? 'dead_letter' : 'retrying',
      attained: Object.keys(row.attained) as OutboxState[],
      detail: `query_${error.kind}`,
    };
  }

  /** A key problem is held for an operator, not dead-lettered: the evidence is pending, not absent. */
  private async block(row: TelemetryOutbox, code: string): Promise<DispatchOutcome> {
    await this.deps.outbox.retry(
      this.deps.scope,
      row.operationId,
      this.opts.ownerId,
      row.lease.fence,
      code,
      this.opts.authBlockDelayMs,
    );
    return {
      operationId: row.operationId,
      result: 'blocked',
      attained: Object.keys(row.attained) as OutboxState[],
      detail: code,
    };
  }
}
