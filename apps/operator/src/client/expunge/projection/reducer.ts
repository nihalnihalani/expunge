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
  /** Stream epoch the window belongs to; null until the backend names one. */
  epoch: string | null;
  /** Consecutive snapshots ignored because they were older than the one shown. */
  staleStreak: number;
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

/** After this many consecutive older snapshots with no epoch, the backend is treated as restored. */
export const MAX_STALE_SNAPSHOTS = 3;

export function initialState(jobId: string): JobProjectionState {
  return {
    jobId,
    connection: 'bootstrapping',
    snapshot: null,
    events: [],
    dropped: 0,
    lastSequence: 0,
    epoch: null,
    staleStreak: 0,
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
      /** Stream epoch of the page, when the backend names one. */
      epoch?: string | null;
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

/** Index of the retained event with this sequence, or -1 (the window is sorted by sequence). */
function indexOfSequence(events: ForwardedProjectionEvent[], sequence: number) {
  let low = 0;
  let high = events.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const found = events[mid].sequence;
    if (found === sequence) return mid;
    if (found < sequence) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/**
 * Applies one action. Rules:
 * - Snapshot order is judged against the snapshot already shown, never against the event cursor
 *   (a snapshot read can lag an events read in the same poll). An older snapshot in the same
 *   stream epoch is ignored and the newer one stays; it is not a reset.
 * - A different stream epoch (snapshot or events page) means the backend history was replaced,
 *   including a restore that has since moved past the old cursor: drop the window, label it a
 *   reset, adopt the new snapshot and re-page from 0. Where the backend names no epoch,
 *   MAX_STALE_SNAPSHOTS consecutive older snapshots are treated the same way.
 * - Events are applied in order and deduplicated by sequence (also within one page and against
 *   the retained window). A known sequence that arrives with a different eventId is a conflict.
 *   The first new event must be lastSequence + 1 and the rest consecutive; otherwise the page is
 *   ignored and a re-bootstrap is requested, so a gap can never be silently skipped.
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
  const clearWindow = {
    events: [] as ForwardedProjectionEvent[],
    dropped: 0,
    lastSequence: 0,
  };
  switch (action.type) {
    case 'snapshot': {
      const incoming = action.snapshot;
      const epoch = incoming.streamEpoch ?? null;
      const shown = state.snapshot;
      const epochChanged =
        epoch !== null && state.epoch !== null && epoch !== state.epoch;
      const older = shown !== null && incoming.sequence < shown.sequence;
      if (older && !epochChanged) {
        const streak = state.staleStreak + 1;
        if (epoch === null && streak >= MAX_STALE_SNAPSHOTS)
          return {
            state: bump({
              snapshot: incoming,
              ...clearWindow,
              notice: 'reset',
              staleStreak: 0,
              connection: 'live',
              updatedAt: action.now,
              attempt: 0,
              nextRetryMs: null,
              failure: null,
            }),
            needsRebootstrap: true,
          };
        return {
          state: bump({
            staleStreak: streak,
            connection: 'live',
            updatedAt: action.now,
            attempt: 0,
            nextRetryMs: null,
            failure: null,
          }),
          needsRebootstrap: false,
        };
      }
      return {
        state: bump({
          snapshot: incoming,
          ...(epochChanged ? { ...clearWindow, notice: 'reset' as const } : {}),
          epoch: epoch ?? state.epoch,
          staleStreak: 0,
          connection: 'live',
          updatedAt: action.now,
          attempt: 0,
          nextRetryMs: null,
          failure: null,
        }),
        needsRebootstrap: epochChanged,
      };
    }
    case 'events': {
      const epoch = action.epoch ?? null;
      if (epoch !== null && state.epoch !== null && epoch !== state.epoch)
        return {
          state: bump({ ...clearWindow, epoch: null, notice: 'reset' }),
          needsRebootstrap: true,
        };
      // Deduplicate by sequence, inside the page as well as against what is retained. The same
      // event repeated is harmless; a different event claiming the same sequence is a conflict.
      const seen = new Map<number, string>();
      const fresh: ForwardedProjectionEvent[] = [];
      let conflict = false;
      for (const event of action.events) {
        if (event.sequence <= state.lastSequence) {
          const at = indexOfSequence(state.events, event.sequence);
          if (at >= 0 && state.events[at].eventId !== event.eventId)
            conflict = true;
          continue;
        }
        const prior = seen.get(event.sequence);
        if (prior !== undefined) {
          if (prior !== event.eventId) conflict = true;
          continue;
        }
        seen.set(event.sequence, event.eventId);
        fresh.push(event);
      }
      if (fresh.length === 0 && !conflict)
        return { state, needsRebootstrap: false };
      const gap = () => ({
        state: bump({ ...clearWindow, notice: 'gap' as const }),
        needsRebootstrap: true,
      });
      if (conflict || fresh[0].sequence !== state.lastSequence + 1)
        return gap();
      for (let index = 1; index < fresh.length; index++)
        if (fresh[index].sequence !== fresh[index - 1].sequence + 1)
          return gap();
      const merged = trim([...state.events, ...fresh], state.dropped);
      return {
        state: bump({
          events: merged.events,
          dropped: merged.dropped,
          lastSequence: fresh[fresh.length - 1].sequence,
          epoch: epoch ?? state.epoch,
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
