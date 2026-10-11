import { PlugZap, TriangleAlert } from 'lucide-react';
import type { ExpungeApiError } from '../api';

export function Skeleton({ label }: { label: string }) {
  return (
    <div className="ex-skeleton" aria-busy="true">
      <span className="ex-sr">{`Loading ${label}`}</span>
      <div className="ex-skeleton-row" aria-hidden />
      <div className="ex-skeleton-row" aria-hidden />
      <div className="ex-skeleton-row" aria-hidden />
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="ex-state">
      <p className="ex-state-title">{title}</p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  what,
  error,
  stale,
  onRetry,
}: {
  what: string;
  error?: ExpungeApiError;
  /** True when older data is still shown beside this message. */
  stale?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="ex-state" role="alert">
      <p className="ex-state-title">
        <TriangleAlert size={14} aria-hidden /> {`Could not load ${what}.`}
      </p>
      <p>
        {error?.message ?? 'The request failed.'}{' '}
        {stale ? 'The data shown may be older than this failure.' : ''}
      </p>
      {onRetry && (
        <button type="button" className="ex-btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** A feature the backend or configuration does not provide. Never a fake empty state. */
export function UnavailableState({
  what,
  reason,
  missing,
  onRecheck,
}: {
  what: string;
  reason: string;
  /** Configuration NAMES only. */
  missing?: string[];
  onRecheck?: () => void;
}) {
  return (
    <div className="ex-state">
      <p className="ex-state-title">
        <PlugZap size={14} aria-hidden /> {`${what} is unavailable.`}
      </p>
      <p>{reason}</p>
      {missing && missing.length > 0 && (
        <p>
          Set{' '}
          {missing.map((name, index) => (
            <span key={name}>
              {index > 0 && ', '}
              <code className="ex-code">{name}</code>
            </span>
          ))}{' '}
          in the server environment, then restart the operator.
        </p>
      )}
      {onRecheck && (
        <button type="button" className="ex-btn" onClick={onRecheck}>
          Check again
        </button>
      )}
    </div>
  );
}
