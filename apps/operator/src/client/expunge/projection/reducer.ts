import type {
  ExpungeJobSnapshotV2,
  ForwardedProjectionEvent,
} from '../../../shared/expunge';

/** Bounded in-memory event window (docs/ui/B3-PLAN.md section 6). Older events stay on the server. */
export const MAX_EVENTS = 2000;
export const MAX_EVENT_BYTES = 2_000_000;

export type ProjectionConnection =
  | 'bootstrapping'
  | 'live'
  | 'retrying'
  | 'disconnected'
  | 'unavailable'
  | 'not_found'
  | 'error';

export interface FailureInfo {
  /** transport = the browser could not reach the operator; http = the operator answered with an error. */
  kind: 'transport' | 'http';
  status: number;
  code: string;
  message: string;
}

export interface JobProjectionState {
  jobId: string;
  connection: ProjectionConnection;
  /** Authoritative aggregate state. Never derived from events or client actions. */
  snapshot: ExpungeJobSnapshotV2 | null;
  /** Newest-last window of committed events. */
  events: ForwardedProjectionEvent[];
  /** Number of older events dropped from the head of the window. */
  dropped: number;
  /** Highest applied event sequence. */
  lastSequence: number;
  /** Local time of the last successful read. */
  updatedAt: number | null;
  attempt: number;
  nextRetryMs: number | null;
  failure: FailureInfo | null;
  /** Set when the backend's projection moved backwards or a gap forced a re-read. */
  notice: 'reset' | 'gap' | null;
  /** Increments on every state change so views can memoize cheaply. */
  version: number;
}

export function initialState(jobId: string): JobProjectionState {
  return {
    jobId,
    connection: 'bootstrapping',
    snapshot: null,
    events: [],
    dropped: 0,
    lastSequence: 0,
    updatedAt: null,
    attempt: 0,
    nextRetryMs: null,
    failure: null,
    notice: null,
    version: 0,
  };
}

export type ProjectionAction =
  | { type: 'snapshot'; snapshot: ExpungeJobSnapshotV2; now: number }
  | {
      type: 'events';
      events: ForwardedProjectionEvent[];
      nextSequence: number;
      now: number;
    }
  | {
      type: 'failure';
      failure: FailureInfo;
      attempt: number;
      nextRetryMs: number | null;
    }
  | { type: 'clear_notice' }
  | { type: 'reset' };

/** What the controller must do after an action (the reducer itself stays pure). */
export interface ApplyResult {
  state: JobProjectionState;
  /** The page did not continue from the last applied sequence: re-read the snapshot and re-page from 0. */
  needsRebootstrap: boolean;
}

const eventBytes = (event: ForwardedProjectionEvent) => {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
};

function trim(events: ForwardedProjectionEvent[], dropped: number) {
  let total = 0;
  let start = events.length;
  // Keep the newest events within both bounds.
  for (let index = events.length - 1; index >= 0; index--) {
    total += eventBytes(events[index]);
    if (events.length - index > MAX_EVENTS || total > MAX_EVENT_BYTES) break;
    start = index;
  }
  return start === 0
    ? { events, dropped }
    : { events: events.slice(start), dropped: dropped + start };
}

/**
 * Applies one action. Rules:
 * - A snapshot whose sequence is lower than the last applied event sequence means the backend
 *   was restored or restarted: drop the window and show a reset notice. Aggregate state is
 *   always the snapshot's.
 * - Events are applied in order and deduplicated by sequence. The first new event must be
 *   lastSequence + 1; otherwise the page is ignored and a re-bootstrap is requested, so a gap
 *   can never be silently skipped.
 */
export function reduce(
  state: JobProjectionState,
  action: ProjectionAction,
): ApplyResult {
  const bump = (patch: Partial<JobProjectionState>): JobProjectionState => ({
    ...state,
    ...patch,
    version: state.version + 1,
  });
  switch (action.type) {
    case 'snapshot': {
      const regress = action.snapshot.sequence < state.lastSequence;
      return {
        state: bump({
          snapshot: action.snapshot,
          ...(regress
            ? {
                events: [],
                dropped: 0,
                lastSequence: 0,
                notice: 'reset' as const,
              }
            : {}),
          connection: 'live',
          updatedAt: action.now,
          attempt: 0,
          nextRetryMs: null,
          failure: null,
        }),
        needsRebootstrap: regress,
      };
    }
    case 'events': {
      const fresh = action.events.filter(
        (event) => event.sequence > state.lastSequence,
      );
      if (fresh.length === 0) return { state, needsRebootstrap: false };
      if (fresh[0].sequence !== state.lastSequence + 1)
        return {
          state: bump({
            events: [],
            dropped: 0,
            lastSequence: 0,
            notice: 'gap',
          }),
          needsRebootstrap: true,
        };
      for (let index = 1; index < fresh.length; index++)
        if (fresh[index].sequence !== fresh[index - 1].sequence + 1)
          return {
            state: bump({
              events: [],
              dropped: 0,
              lastSequence: 0,
              notice: 'gap',
            }),
            needsRebootstrap: true,
          };
      const merged = trim([...state.events, ...fresh], state.dropped);
      return {
        state: bump({
          events: merged.events,
          dropped: merged.dropped,
          lastSequence: fresh[fresh.length - 1].sequence,
          updatedAt: action.now,
        }),
        needsRebootstrap: false,
      };
    }
    case 'failure': {
      const f = action.failure;
      const connection: ProjectionConnection =
        f.kind === 'transport'
          ? action.attempt >= 5
            ? 'disconnected'
            : 'retrying'
          : f.status === 404
            ? 'not_found'
            : f.status === 503 || f.status === 501
              ? 'unavailable'
              : 'error';
      return {
        state: bump({
          connection,
          failure: f,
          attempt: action.attempt,
          nextRetryMs: action.nextRetryMs,
        }),
        needsRebootstrap: false,
      };
    }
    case 'clear_notice':
      return state.notice
        ? { state: bump({ notice: null }), needsRebootstrap: false }
        : { state, needsRebootstrap: false };
    case 'reset':
      return { state: initialState(state.jobId), needsRebootstrap: false };
  }
}
