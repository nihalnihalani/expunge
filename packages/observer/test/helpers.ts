import type { ObserverCursor, ObserverQueryIdentity, ScopeKey } from '@expunge/contracts';
import type { LeakGuard } from '@expunge/observability';
import type { ClientSession } from 'mongodb';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import {
  InMemoryEvidenceStore,
  ObserverRunner,
  RaindropQueryClient,
  buildQueryIdentity,
  type CursorStore,
} from '../src/index.js';

/** The subject literal every observer test treats as forbidden. */
export const LITERAL = 'syn_subject_maria_rossi';
export const GUARD: LeakGuard = { forbiddenLiterals: [LITERAL] };
export const SCOPE: ScopeKey = { tenantId: 'tenant-1', env: 'evaluation', scopeId: 'scope-1' };

/** In-memory CursorStore with ObserverCursorRepository's semantics (identity pinning, CAS revision). */
export class InMemoryCursorStore implements CursorStore {
  readonly rows = new Map<string, ObserverCursor>();
  checkpoints = 0;
  private digest(query: ObserverQueryIdentity) {
    return JSON.stringify([
      query.projectId,
      query.observerVersion,
      query.filterHash,
      query.windowStart,
      query.windowEnd,
      query.overlapMs,
      query.backfillPolicy,
    ]);
  }
  async initialize(query: ObserverQueryIdentity): Promise<ObserverCursor> {
    const key = `${query.projectId}\u0000${query.observerVersion}`;
    const existing = this.rows.get(key);
    if (existing) {
      if (existing._id !== this.digest(query))
        throw Object.assign(new Error('ObserverQueryIdentityChanged'), { name: 'ProtocolError' });
      return structuredClone(existing);
    }
    const row: ObserverCursor = {
      ...query,
      _id: this.digest(query),
      revision: 0,
      providerCursor: null,
      pendingEnrichmentIds: [],
      lastCommittedProcessingAt: new Date(0),
    };
    this.rows.set(key, row);
    return structuredClone(row);
  }
  async checkpoint(
    query: ObserverQueryIdentity,
    expectedRevision: number,
    providerCursor: string | null,
    pending: string[],
    _session: ClientSession,
  ) {
    const row = this.rows.get(`${query.projectId}\u0000${query.observerVersion}`);
    if (!row || row.revision !== expectedRevision) throw new Error('StaleObserverCursor');
    row.providerCursor = providerCursor;
    row.pendingEnrichmentIds = pending;
    row.revision += 1;
    row.lastCommittedProcessingAt = new Date();
    this.checkpoints += 1;
  }
}

export function makeRig(fake: FakeRaindrop, over: { sleeps?: number[]; maxAttempts?: number } = {}) {
  const client = new RaindropQueryClient({
    queryKey: fake.keys().queryKey,
    projectId: 'proj-1',
    baseUrl: fake.queryUrl,
    sleep: async (ms) => void over.sleeps?.push(ms),
    random: () => 0.5,
    maxAttempts: over.maxAttempts ?? 4,
  });
  const cursors = new InMemoryCursorStore();
  const evidence = new InMemoryEvidenceStore();
  const runner = new ObserverRunner({
    client,
    cursors,
    evidence,
    transaction: (work) => work(undefined as never),
    scope: SCOPE,
    guard: GUARD,
  });
  return { client, cursors, evidence, runner };
}

export const identity = (over: Partial<Parameters<typeof buildQueryIdentity>[0]> = {}) =>
  buildQueryIdentity({
    projectId: 'proj-1',
    observerVersion: 'v1',
    filter: { eventName: 'expunge.worker', properties: { role: 'worker' } },
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2099-01-01T00:00:00.000Z',
    overlapMs: 60_000,
    ...over,
  });

/** Seeds N worker events with strictly increasing timestamps. */
export function seedWorkerEvents(fake: FakeRaindrop, count: number, enriched = true) {
  const base = Date.UTC(2026, 5, 1);
  for (let i = 0; i < count; i++)
    fake.seedEvent({
      id: `evt-${String(i).padStart(3, '0')}`,
      timestamp: new Date(base + i * 1000).toISOString(),
      properties: { role: 'worker', run_id: `run-${i}`, harness_hash: 'h'.repeat(64) },
      user_input: 'cleanup job',
      assistant_output: '{"status":"failed"}',
      ...(enriched
        ? {
            tool_calls: [{ name: 'inspect_scope' }],
            signals: [{ id: 'sig-1', name: 'cleanup_not_verified', score: null }],
          }
        : {}),
    });
}

import type { OutboxState, TelemetryOutbox } from '@expunge/contracts';
import type { OutboxPort } from '../src/index.js';

export class Clock {
  constructor(public ms = Date.UTC(2026, 5, 2)) {}
  now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
}

const ORDER: OutboxState[] = ['sdk_enqueued', 'ingest_accepted', 'query_visible', 'evidence_ready'];

/** FAKE in-memory OutboxPort that enforces OutboxRepository's rules: delivery-proof order, fence and lease, required fields. */
export class InMemoryOutbox implements OutboxPort {
  readonly rows = new Map<string, TelemetryOutbox>();
  constructor(private readonly clock: Clock) {}
  add(
    row: Partial<TelemetryOutbox> & {
      operationId: string;
      payload: TelemetryOutbox['payload'];
      evidenceRequired: string[];
    },
  ): TelemetryOutbox {
    const full: TelemetryOutbox = {
      ...SCOPE,
      kind: 'signal',
      dedupeKey: row.operationId,
      jobId: 'job-1',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(0),
      lease: { ownerId: '', fence: 0, until: new Date(0), heartbeatAt: new Date(0) },
      attained: {},
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      ...row,
    };
    this.rows.set(row.operationId, full);
    return full;
  }
  async claim(_key: ScopeKey, ownerId: string, durationMs = 30_000): Promise<TelemetryOutbox | null> {
    const now = this.clock.now().getTime();
    const row = [...this.rows.values()]
      .filter(
        (r) =>
          !['evidence_ready', 'dead_letter'].includes(r.status) &&
          r.lease.until.getTime() <= now &&
          r.nextAttemptAt.getTime() <= now,
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())[0];
    if (!row) return null;
    row.status = 'leased';
    row.attempts += 1;
    row.lease = {
      ownerId,
      fence: row.lease.fence + 1,
      until: new Date(now + durationMs),
      heartbeatAt: this.clock.now(),
    };
    return structuredClone(row);
  }
  private live(operationId: string, ownerId: string, fence: number): TelemetryOutbox {
    const row = this.rows.get(operationId);
    if (
      !row ||
      row.lease.ownerId !== ownerId ||
      row.lease.fence !== fence ||
      row.lease.until.getTime() <= this.clock.now().getTime()
    )
      throw new Error('LostOutboxLease');
    return row;
  }
  async advance(
    _key: ScopeKey,
    operationId: string,
    ownerId: string,
    fence: number,
    state: OutboxState,
    proof: { contentHash: string; externalReceiptId?: string; presentFields?: string[] },
  ) {
    const row = this.live(operationId, ownerId, fence);
    if (!ORDER.includes(state)) throw new Error('InvalidOutboxAttainment');
    if (
      state === 'evidence_ready' &&
      (!row.attained.query_visible || row.evidenceRequired.some((f) => !proof.presentFields?.includes(f)))
    )
      throw new Error('EvidenceIncomplete');
    const previous = ORDER.indexOf(state) - 1;
    if (previous >= 0 && !row.attained[ORDER[previous]!]) throw new Error('MissingDeliveryProof');
    row.status = state;
    row.attained[state] ??= {
      at: this.clock.now(),
      contentHash: proof.contentHash,
      ...(proof.externalReceiptId ? { externalReceiptId: proof.externalReceiptId } : {}),
    };
  }
  async retry(
    _key: ScopeKey,
    operationId: string,
    ownerId: string,
    fence: number,
    errorCode: string,
    delayMs: number,
    dead = false,
  ) {
    const row = this.live(operationId, ownerId, fence);
    row.status = dead ? 'dead_letter' : 'retrying';
    row.lastErrorCode = errorCode;
    row.nextAttemptAt = new Date(this.clock.now().getTime() + delayMs);
    row.lease.until = new Date(0);
  }
}
