import {
  contentHash,
  type JsonValue,
  type ObserverCursor,
  type ObserverQueryIdentity,
  type ScopeKey,
} from '@expunge/contracts';
import type { ClientSession } from 'mongodb';
import { missingFields, observeEvent, type EvidenceObservation, type EvidenceStore } from './evidence.js';
import {
  RaindropQueryClient,
  RaindropQueryError,
  type EventListParams,
  type RaindropEvent,
} from './query-client.js';

/** Stored in place of a provider cursor once every page of the window has been committed. */
export const WINDOW_COMPLETE = '__expunge_window_complete__';

export type ObserverFilter = {
  eventName?: string;
  properties?: Record<string, string | number | boolean>;
  /** Canonical signal UUID, resolved from the catalog beforehand. */
  signalId?: string;
};

/**
 * The fixed identity of one scan window. The filter, the scan bounds and the observer version are hashed together; a
 * provider cursor is only ever resumed under the identical identity. A new window needs a new `observerVersion`.
 */
export function buildQueryIdentity(input: {
  projectId: string;
  observerVersion: string;
  filter: ObserverFilter;
  windowStart: string;
  windowEnd: string;
  overlapMs: number;
  backfillPolicy?: ObserverQueryIdentity['backfillPolicy'];
}): ObserverQueryIdentity {
  const filterSnapshot = input.filter as unknown as JsonValue;
  return {
    projectId: input.projectId,
    observerVersion: input.observerVersion,
    filterSnapshot,
    filterHash: contentHash(filterSnapshot, 'observer-filter'),
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    overlapMs: input.overlapMs,
    backfillPolicy: input.backfillPolicy ?? 'pending_ids_and_overlap',
  };
}

/** The next window starts one overlap before the previous end: a recent-overlap reread, not a lateness guarantee. */
export function nextWindowIdentity(
  previous: ObserverQueryIdentity,
  base: string,
  now: Date,
): ObserverQueryIdentity {
  const windowStart = new Date(new Date(previous.windowEnd).getTime() - previous.overlapMs).toISOString();
  return buildQueryIdentity({
    projectId: previous.projectId,
    observerVersion: `${base}@${windowStart}`,
    filter: previous.filterSnapshot as ObserverFilter,
    windowStart,
    windowEnd: now.toISOString(),
    overlapMs: previous.overlapMs,
    backfillPolicy: previous.backfillPolicy,
  });
}

function paramsFor(query: ObserverQueryIdentity, cursor: string | null, limit: number): EventListParams {
  const filter = query.filterSnapshot as ObserverFilter;
  return {
    limit,
    cursor,
    orderBy: '+timestamp',
    timestampGte: query.windowStart,
    timestampLt: query.windowEnd,
    ...(filter.eventName ? { eventName: filter.eventName } : {}),
    ...(filter.properties ? { properties: filter.properties } : {}),
    ...(filter.signalId ? { signal: filter.signalId } : {}),
  };
}

export interface CursorStore {
  initialize(query: ObserverQueryIdentity): Promise<ObserverCursor>;
  checkpoint(
    query: ObserverQueryIdentity,
    expectedRevision: number,
    providerCursor: string | null,
    pendingEnrichmentIds: string[],
    session: ClientSession,
  ): Promise<void>;
}
export type RunInTransaction = <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;

export type ScanOptions = {
  /** Remote fields that must be present before an event's evidence is ready. */
  requiredFields: readonly string[];
  fetchTraces?: boolean;
  pageSize?: number;
  maxPages?: number;
  maxPendingRereads?: number;
  /** An event still missing required fields this long after first observation is reported HELD. */
  holdAfterMs?: number;
  now?: () => Date;
  /** Fault-injection seams for tests (crash before/after the commit of a page). */
  hooks?: { beforeCommit?: () => void | Promise<void>; afterCommit?: () => void | Promise<void> };
};

export type ScanResult = {
  status: 'complete' | 'incomplete' | 'blocked' | 'error';
  reason?: string;
  windowComplete: boolean;
  pagesCommitted: number;
  observationsStored: number;
  ready: string[];
  pending: string[];
  held: string[];
};

/**
 * Pages Raindrop events for ONE fixed query identity, commits each page's evidence and its cursor together in one
 * transaction, and keeps rereading known events whose enrichment (signals, tool calls, spans) had not arrived yet.
 * A crash before a page's commit repeats the page (hash dedupe makes that safe); a crash after resumes after it.
 */
export class ObserverRunner {
  constructor(
    private readonly deps: {
      client: RaindropQueryClient;
      cursors: CursorStore;
      evidence: EvidenceStore;
      transaction: RunInTransaction;
      scope: ScopeKey;
    },
  ) {}

  async runOnce(query: ObserverQueryIdentity, options: ScanOptions): Promise<ScanResult> {
    const { client, cursors, evidence, transaction, scope } = this.deps;
    const now = options.now ?? (() => new Date());
    const cursor = await cursors.initialize(query);
    let revision = cursor.revision;
    let providerCursor = cursor.providerCursor;
    const pending = new Set(cursor.pendingEnrichmentIds);
    const result: ScanResult = {
      status: 'complete',
      windowComplete: false,
      pagesCommitted: 0,
      observationsStored: 0,
      ready: [],
      pending: [],
      held: [],
    };

    const observe = async (event: RaindropEvent): Promise<EvidenceObservation> => {
      const traces = options.fetchTraces ? await client.getTraces(event.id) : undefined;
      return observeEvent(query.projectId, event, traces, now());
    };
    const commit = async (observations: EvidenceObservation[], nextCursor: string | null) => {
      await options.hooks?.beforeCommit?.();
      let stored = 0;
      await transaction(async (session) => {
        stored = 0; // a retried transaction recounts
        for (const observation of observations)
          if ((await evidence.put(observation, scope, session)).stored) stored++;
        await cursors.checkpoint(query, revision, nextCursor, [...pending], session);
      });
      revision += 1;
      providerCursor = nextCursor;
      result.observationsStored += stored;
      result.pagesCommitted += 1;
      await options.hooks?.afterCommit?.();
    };
    const settle = (event: RaindropEvent, observation: EvidenceObservation) => {
      if (missingFields(options.requiredFields, observation.presentFields).length === 0) {
        pending.delete(event.id);
        result.ready.push(event.id);
      } else pending.add(event.id);
    };

    try {
      // 1. Known events whose enrichment had not arrived: reread by ID, independent of the listing watermark.
      const rereads = [...pending].slice(0, options.maxPendingRereads ?? 100);
      if (rereads.length) {
        const observations: EvidenceObservation[] = [];
        for (const id of rereads) {
          const event = await client.getEvent(id);
          if (!event) continue; // not visible yet; stays pending
          const observation = await observe(event);
          observations.push(observation);
          settle(event, observation);
        }
        await commit(observations, providerCursor);
      }

      // 2. Pages of the fixed window, resumed from the committed provider cursor.
      if (providerCursor === WINDOW_COMPLETE) result.windowComplete = true;
      else {
        for (let pages = 0; pages < (options.maxPages ?? 20); pages++) {
          const page = await client.listEvents(paramsFor(query, providerCursor, options.pageSize ?? 100));
          const seen = new Set<string>();
          const observations: EvidenceObservation[] = [];
          for (const event of page.data) {
            if (seen.has(event.id)) continue; // dedupe within the page
            seen.add(event.id);
            const observation = await observe(event);
            observations.push(observation);
            settle(event, observation);
          }
          const done = !page.hasMore || !page.cursor;
          await commit(observations, done ? WINDOW_COMPLETE : page.cursor);
          if (done) {
            result.windowComplete = true;
            break;
          }
        }
        if (!result.windowComplete) result.status = 'incomplete';
      }
    } catch (error) {
      if (error instanceof RaindropQueryError) {
        result.reason = error.kind;
        result.status = error.kind === 'auth' || error.kind === 'forbidden' ? 'blocked' : 'error';
      } else throw error;
    }

    // Report what is still pending and what has been pending too long (HELD), from stored first-observation times.
    const holdAfterMs = options.holdAfterMs ?? 15 * 60_000;
    for (const id of pending) {
      result.pending.push(id);
      const stored = await evidence.latest(query.projectId, id, scope);
      if (stored && now().getTime() - stored.firstObservedAt.getTime() > holdAfterMs) result.held.push(id);
    }
    return result;
  }
}
