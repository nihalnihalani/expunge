import {
  contentHash,
  type EvidenceDelivery,
  type OutboxState,
  type ScopeKey,
  type TelemetryOutbox,
} from '@expunge/contracts';
import type { ProjectionEventInput } from '@expunge/mongo';
import {
  IngestClient,
  requireGuard,
  telemetryPayloadSchema,
  type LeakGuard,
  type IngestFailure,
  type TelemetryPayload,
} from '@expunge/observability';
import type { ClientSession } from 'mongodb';
import { missingFields, observeEvent, type EvidenceObservation, type EvidenceStore } from './evidence.js';
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
 * Telemetry user ids whose export is suppressed locally because an external erasure for them is open (packages/privacy
 * `ErasureService.suppressedUserIds` satisfies this). It is keyed by the PROVIDER ORGANIZATION, not by scope: the
 * provider erasure is organization-wide, so a namespaced id is held wherever it appears. Only the HTTP `event` kind
 * carries a user id; SDK episode events are produced live in the worker before any erasure can exist, and what was
 * already exported is the provider erasure's job, not this gate's.
 */
export interface ExportSuppression {
  suppressedUserIds(providerOrganizationId: string): Promise<ReadonlySet<string>>;
}

/** The slice of ProjectionRepository the dispatcher uses; appends are best effort and never fail a dispatch. */
export interface ProjectionPort {
  append(key: ScopeKey, event: ProjectionEventInput): Promise<unknown>;
}

/** The Raindrop signal name the gateway's report_diagnostic maps to. */
export const AGENT_DIAGNOSTIC_SIGNAL = 'agent_diagnostic';
const RECEIPT_WORKER_ATTESTED = 'worker-attested-not-observed';
const RECEIPT_INFERRED = 'inferred-from-query-visible';
const RECEIPT_RESEND_SUFFIX = 'resend-unverified';

/**
 * How each delivery proof of an outbox row was obtained. Read from the receipts the dispatcher itself wrote, so a
 * consumer can tell an observed HTTP acceptance from a worker attestation, an inference or an unverified resend.
 */
export function deliveryOf(attained: TelemetryOutbox['attained']): EvidenceDelivery {
  const enqueued = attained.sdk_enqueued?.externalReceiptId;
  const accepted = attained.ingest_accepted?.externalReceiptId;
  return {
    sdkEnqueued: enqueued === RECEIPT_WORKER_ATTESTED ? 'worker_attested' : 'observed',
    ingestAccepted:
      accepted === RECEIPT_INFERRED
        ? 'inferred'
        : accepted?.endsWith(RECEIPT_RESEND_SUFFIX)
          ? 'resend_unverified'
          : 'observed',
    queryVisible: 'observed',
    evidenceReady: 'observed',
  };
}

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
      /** REQUIRED: subject literals and private ids no stored observation may carry. */
      guard: LeakGuard;
      projection?: ProjectionPort;
      /** REQUIRED: an `event` intent for a suppressed user id is held (never sent, never dead-lettered). */
      suppression: ExportSuppression;
      /** The provider organization of the write key, from trusted configuration; the suppression list is read for it. */
      providerOrganizationId: string;
    },
    options: DispatcherOptions,
  ) {
    requireGuard(deps.guard);
    if (!deps.suppression || !deps.providerOrganizationId) throw new Error('SuppressionRequired');
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
      if (payload.type === 'event' && !row.attained.ingest_accepted) {
        // Fail closed: when the suppression list cannot be read the event is HELD (not sent, not dead-lettered) and
        // retried later, exactly like a suppressed id. An unreadable list is never read as an empty one.
        let suppressed: ReadonlySet<string>;
        try {
          suppressed = await this.deps.suppression.suppressedUserIds(this.deps.providerOrganizationId);
        } catch {
          return await this.block(row, 'SuppressionUnavailable');
        }
        if (suppressed.has(payload.userId)) return await this.block(row, 'ExportSuppressed');
      }
      // 1. Send (HTTP kinds only). An sdk_event was produced live by the worker's SDK; there is nothing to send.
      if (payload.type !== 'sdk_event' && !row.attained.ingest_accepted) {
        // sdk_enqueued attained but ingest_accepted not: an earlier attempt may have sent and crashed before it could
        // record the acceptance. Sending again blindly could double count at the vendor, so read before sending.
        const previouslyAttempted = Boolean(row.attained.sdk_enqueued);
        if (!previouslyAttempted) await advance('sdk_enqueued', { contentHash: payloadHash });
        let resendUnverified = false;
        let delivered = false;
        if (previouslyAttempted) {
          const existing = await this.deps.query.getEvent(payload.eventId);
          if (existing && this.alreadyDelivered(payload, existing)) {
            // Visible on the remote event, so ingestion accepted it; no 2xx of OURS was seen, and the label says so.
            await advance('ingest_accepted', {
              contentHash: payloadHash,
              externalReceiptId: RECEIPT_INFERRED,
            });
            delivered = true;
          } else resendUnverified = true; // not visible: it may be lagging, so the resend is labelled unverified
        }
        if (!delivered) {
          const sent = await this.send(payload, lease.operationId);
          if (!sent.ok) return await this.fail(row, sent);
          await advance('ingest_accepted', {
            contentHash: payloadHash,
            externalReceiptId: `http-${sent.status}${resendUnverified ? `-${RECEIPT_RESEND_SUFFIX}` : ''}`,
          });
        }
      }

      // 2. Read back by ID. Absent means "not visible yet", never "nothing happened".
      const event = await this.deps.query.getEvent(payload.eventId);
      if (!event) return await this.retryWith(row, 'RemoteNotVisible', 'retrying');

      const traces = row.evidenceRequired.includes('spans')
        ? await this.deps.query.getTraces(payload.eventId)
        : undefined;
      const observation = observeEvent(this.deps.projectId, event, {
        guard: this.deps.guard,
        now: this.opts.now(),
        ...(traces ? { traces } : {}),
      });

      if (payload.type === 'sdk_event') {
        // The worker's SDK enqueue and terminal POST happen in another process and cannot be observed here, so they are
        // recorded as what they are: worker-attested and inferred from the event being visible. Never as observed.
        await advance('sdk_enqueued', {
          contentHash: payloadHash,
          externalReceiptId: RECEIPT_WORKER_ATTESTED,
        });
        await advance('ingest_accepted', {
          contentHash: observation.contentHash,
          externalReceiptId: RECEIPT_INFERRED,
        });
      }
      await advance('query_visible', { contentHash: observation.contentHash, externalReceiptId: event.id });
      if (observation.quarantined) {
        // The remote event carries held-out or subject material. Keep a structure-only record and never promote it.
        await this.deps.transaction((session) => this.deps.evidence.put(observation, scope, session));
        return await this.retryWith(
          row,
          `EvidenceQuarantined:${observation.quarantined}`,
          'dead_letter',
          true,
        );
      }

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
      await this.project(row, payload, event, observation);
      return { operationId: lease.operationId, result: 'evidence_ready', attained: attained() };
    } catch (error) {
      if (error instanceof RaindropQueryError) return await this.failQuery(row, error);
      throw error;
    }
  }

  private send(payload: Exclude<TelemetryPayload, { type: 'sdk_event' }>, operationId: string) {
    const { ingest } = this.deps;
    // `dedupe_key` is OUR convention for counting distinct sends downstream; it is not claimed to be vendor idempotency.
    const dedupe = { dedupe_key: operationId };
    if (payload.type === 'signal')
      return ingest.trackSignals([
        {
          event_id: payload.eventId,
          signal_name: payload.signalName,
          signal_type: payload.signalType,
          ...(payload.sentiment ? { sentiment: payload.sentiment } : {}),
          properties: { ...payload.properties, origin: payload.origin, ...dedupe },
        },
      ]);
    if (payload.type === 'agent_diagnostic')
      return ingest.trackSignals([
        {
          event_id: payload.eventId,
          signal_name: AGENT_DIAGNOSTIC_SIGNAL,
          signal_type: 'default',
          properties: {
            origin: 'agent_self_report',
            severity: payload.severity,
            codes: payload.codes.join(',').slice(0, 256),
            tool_call_id: payload.toolCallId,
            detail_sha256: payload.detailSha256,
            ...dedupe,
          },
        },
      ]);
    return ingest.trackEvents([
      {
        user_id: payload.userId,
        event: payload.event,
        event_id: payload.eventId,
        properties: { ...payload.properties, origin: payload.origin, ...dedupe },
        ai_data: {
          output: payload.output,
          ...(payload.input ? { input: payload.input } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.convoId ? { convo_id: payload.convoId } : {}),
        },
      },
    ]);
  }

  /** True when the remote event already shows what this intent would send. */
  private alreadyDelivered(
    payload: Exclude<TelemetryPayload, { type: 'sdk_event' }>,
    event: RaindropEvent,
  ): boolean {
    if (payload.type === 'signal') return (event.signals ?? []).some((s) => s.name === payload.signalName);
    if (payload.type === 'agent_diagnostic')
      return (event.signals ?? []).some((s) => s.name === AGENT_DIAGNOSTIC_SIGNAL);
    return event.event_name === payload.event;
  }

  /**
   * The evidence_ready projection event the operator UI replays, carrying the delivery labels. Best effort: the run id
   * comes from the remote event's own run_id property, and a failed append never changes the dispatch result.
   */
  private async project(
    row: TelemetryOutbox,
    payload: TelemetryPayload,
    event: RaindropEvent,
    observation: EvidenceObservation,
  ): Promise<void> {
    const { projection, scope } = this.deps;
    const runId = event.properties?.run_id;
    if (!projection || typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) return;
    const signalIds = observation.event.signals.map((signal) => signal.id).slice(0, 256);
    try {
      await projection.append(scope, {
        eventId: `${row.operationId}:evidence_ready`,
        jobId: row.jobId,
        runId,
        artifactIds: [],
        kind: 'evidence_ready',
        payload: {
          evidenceId: `ev:${row.operationId}`,
          provider: 'raindrop',
          externalEventId: observation.externalEventId,
          externalSignalIds: signalIds,
          origin:
            payload.type === 'sdk_event' || payload.type === 'agent_diagnostic'
              ? 'agent_self_report'
              : payload.origin,
          outboxState: 'evidence_ready',
          truncated: observation.potentiallyTruncated,
          missing: [],
          contentHash: observation.contentHash,
          permittedUse: 'display_only',
          delivery: deliveryOf(row.attained),
        },
      });
    } catch {
      /* the UI recovers from the authoritative outbox row */
    }
  }

  /** What this particular intent needs beyond the generic field list. */
  private specificGaps(payload: TelemetryPayload, event: RaindropEvent): string[] {
    if (payload.type === 'signal')
      return (event.signals ?? []).some((signal) => signal.name === payload.signalName)
        ? []
        : [`signal:${payload.signalName}`];
    if (payload.type === 'agent_diagnostic')
      return (event.signals ?? []).some((signal) => signal.name === AGENT_DIAGNOSTIC_SIGNAL)
        ? []
        : [`signal:${AGENT_DIAGNOSTIC_SIGNAL}`];
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
