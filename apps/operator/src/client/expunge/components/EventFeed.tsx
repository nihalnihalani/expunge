import type { ForwardedProjectionEvent } from '../../../shared/expunge';
import { describeEvent, EVENT_LABELS } from '../projection/selectors';

/** Latest committed events, newest first. The decision log (S4) groups and expands these. */
export function EventFeed({
  events,
  dropped,
  limit = 10,
}: {
  events: ForwardedProjectionEvent[];
  dropped: number;
  limit?: number;
}) {
  if (events.length === 0)
    return (
      <p className="ex-note">
        No committed events yet. Events appear here only after the database
        commits them.
      </p>
    );
  const latest = events.slice(-limit).reverse();
  return (
    <div>
      <ol
        className="ex-feed"
        aria-label="Latest committed events, newest first"
      >
        {latest.map((event) => (
          <li key={event.eventId} className="ex-feed-row">
            <span className="ex-feed-seq ex-num">#{event.sequence}</span>
            <span className="ex-feed-kind">
              {EVENT_LABELS[event.kind] ?? event.kind}
            </span>
            <span className="ex-feed-text">{describeEvent(event)}</span>
          </li>
        ))}
      </ol>
      <p className="ex-note">
        Showing the latest {latest.length} of {events.length + dropped}{' '}
        committed events.
      </p>
    </div>
  );
}
