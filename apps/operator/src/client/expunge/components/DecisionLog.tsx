import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ForwardedProjectionEvent,
  ProjectionKind,
} from '../../../shared/expunge';
import { describeEvent, EVENT_LABELS } from '../projection/selectors';
import { EffectChip } from './NodeChips';
import { StatusChip } from './StatusChip';

export type LogCategory =
  | 'decisions'
  | 'effects'
  | 'evidence'
  | 'improvement'
  | 'completion'
  | 'lifecycle';

export const CATEGORY_LABELS: Record<LogCategory, string> = {
  decisions: 'Tool decisions',
  effects: 'Effects',
  evidence: 'Evidence',
  improvement: 'Improvement and approval',
  completion: 'Completion and erasure',
  lifecycle: 'Lifecycle',
};

const CATEGORY: Record<ProjectionKind | 'unknown_kind', LogCategory> = {
  tool_decided: 'decisions',
  effect_committed: 'effects',
  evidence_ready: 'evidence',
  candidate_proposed: 'improvement',
  trial_completed: 'improvement',
  approval_required: 'improvement',
  approval_resolved: 'improvement',
  harness_promoted: 'improvement',
  harness_rolled_back: 'improvement',
  receipt_committed: 'completion',
  external_erasure_updated: 'completion',
  retraction_progress: 'completion',
  campaign_row_committed: 'completion',
  job_started: 'lifecycle',
  job_status_changed: 'lifecycle',
  cancel_requested: 'lifecycle',
  job_failed: 'lifecycle',
  unknown_kind: 'lifecycle',
};

export const categoryOf = (event: ForwardedProjectionEvent): LogCategory =>
  CATEGORY[event.kind];

const PAGE = 200;
const MAX_PAYLOAD = 2000;

export function payloadText(event: ForwardedProjectionEvent) {
  let text: string;
  try {
    text = JSON.stringify(event.payload, null, 2);
  } catch {
    return '(payload could not be shown)';
  }
  return text.length > MAX_PAYLOAD
    ? `${text.slice(0, MAX_PAYLOAD)}\n(truncated)`
    : text;
}

function Row({ event }: { event: ForwardedProjectionEvent }) {
  return (
    <li className="ex-log-row">
      <div className="ex-log-head">
        <span className="ex-log-seq ex-num">#{event.sequence}</span>
        <span className="ex-log-kind">
          {EVENT_LABELS[event.kind] ?? event.kind}
        </span>
        {event.kind === 'tool_decided' && (
          <>
            {event.payload.decision === 'deny' ? (
              <StatusChip state="rejected" label="Denied" />
            ) : event.payload.decision === 'ask' ? (
              <StatusChip state="waiting_approval" label="Asked for approval" />
            ) : (
              <span className="ex-chip">Allowed</span>
            )}
          </>
        )}
        {event.kind === 'effect_committed' && (
          <EffectChip effect={event.payload.effectKind} />
        )}
      </div>
      <p className="ex-log-text">{describeEvent(event)}</p>
      <details className="ex-log-detail">
        <summary>Sanitized payload</summary>
        <pre className="ex-code-block">{payloadText(event)}</pre>
      </details>
    </li>
  );
}

/**
 * The committed event stream, newest first, filterable by category. Each row is one committed
 * fact with a fixed-vocabulary summary; the raw (already validated and bounded) payload is one
 * disclosure away. Long logs show 200 rows at a time.
 */
export function DecisionLog({
  events,
  dropped,
  withheld = false,
}: {
  events: ForwardedProjectionEvent[];
  dropped: number;
  /** The stream could not be read contiguously, so no events are shown rather than a partial list. */
  withheld?: boolean;
}) {
  const [filter, setFilter] = useState<LogCategory | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [follow, setFollow] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const present = useMemo(() => {
    const counts = new Map<LogCategory, number>();
    for (const event of events)
      counts.set(categoryOf(event), (counts.get(categoryOf(event)) ?? 0) + 1);
    return counts;
  }, [events]);
  const rows = useMemo(
    () =>
      events
        .filter((event) => filter === null || categoryOf(event) === filter)
        .reverse(),
    [events, filter],
  );
  // "Follow latest" keeps the newest event in view; it never moves the page on its own otherwise.
  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = 0;
  }, [follow, rows.length]);
  if (events.length === 0 && withheld)
    return (
      <p className="ex-note">
        Events are withheld because the committed stream is not contiguous. Use
        Retry above; nothing is shown that could hide a missing event.
      </p>
    );
  if (events.length === 0)
    return (
      <p className="ex-note">
        No committed events yet. Events appear here only after the database
        commits them.
      </p>
    );
  return (
    <div className="ex-log">
      <div className="ex-tools">
        <div
          className="ex-filters"
          role="group"
          aria-label="Filter events by category"
        >
          <button
            type="button"
            className="ex-btn ex-filter"
            aria-pressed={filter === null}
            onClick={() => setFilter(null)}
          >
            All ({events.length})
          </button>
          {[...present.entries()].map(([category, count]) => (
            <button
              key={category}
              type="button"
              className="ex-btn ex-filter"
              aria-pressed={filter === category}
              onClick={() => {
                setFilter(filter === category ? null : category);
                setShown(PAGE);
              }}
            >
              {CATEGORY_LABELS[category]} ({count})
            </button>
          ))}
          <button
            type="button"
            className="ex-btn"
            aria-pressed={follow}
            onClick={() => setFollow((value) => !value)}
          >
            Follow latest
          </button>
        </div>
      </div>
      <div
        ref={list}
        className="ex-log-list"
        role="region"
        aria-label="Committed events, newest first"
        tabIndex={0}
      >
        <ol className="ex-loglist">
          {rows.slice(0, shown).map((event) => (
            <Row key={event.eventId} event={event} />
          ))}
        </ol>
      </div>
      <p className="ex-note">
        Showing {Math.min(shown, rows.length).toLocaleString()} of{' '}
        {rows.length.toLocaleString()} events
        {filter ? ` in ${CATEGORY_LABELS[filter].toLowerCase()}` : ''}
        {dropped > 0
          ? `; ${dropped.toLocaleString()} older events are kept on the server, not in this window`
          : ''}
        .
      </p>
      {rows.length > shown && (
        <button
          type="button"
          className="ex-btn"
          onClick={() => setShown((count) => count + PAGE)}
        >
          Show {Math.min(PAGE, rows.length - shown)} more
        </button>
      )}
    </div>
  );
}
