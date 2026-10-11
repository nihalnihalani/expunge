import { PlugZap, RefreshCw, WifiOff } from 'lucide-react';
import { ageText, formatClock } from '../format';

export type Connection =
  'live' | 'retrying' | 'disconnected' | 'unavailable' | 'stale';

/** One banner per view. The text always says whether the job or data is affected. */
export function ConnectionBanner({
  connection,
  attempt = 0,
  nextRetryMs = null,
  updatedAt = null,
  now = Date.now(),
  onRetry,
  detail,
}: {
  connection: Connection;
  attempt?: number;
  nextRetryMs?: number | null;
  updatedAt?: number | null;
  now?: number;
  onRetry?: () => void;
  detail?: string;
}) {
  if (connection === 'live') return null;
  const updated =
    updatedAt === null
      ? 'No data has loaded yet.'
      : `Showing data from ${formatClock(updatedAt)} (${ageText(updatedAt, now)}).`;
  const Icon =
    connection === 'unavailable'
      ? PlugZap
      : connection === 'retrying'
        ? RefreshCw
        : WifiOff;
  return (
    <div
      className={`ex-banner ${connection === 'retrying' ? 'ex-banner--info' : 'ex-banner--warn'}`}
      role="status"
      data-connection={connection}
    >
      <Icon size={16} aria-hidden />
      <strong>
        {connection === 'disconnected' && 'Disconnected from the operator.'}
        {connection === 'retrying' &&
          `Retrying (attempt ${attempt}${nextRetryMs ? `, next in ${Math.max(1, Math.round(nextRetryMs / 1000))} s` : ''}).`}
        {connection === 'unavailable' &&
          'The Expunge domain service is unavailable.'}
        {connection === 'stale' && 'This view is out of date.'}
      </strong>
      <span>{detail ?? updated}</span>
      {onRetry && connection !== 'retrying' && (
        <button type="button" className="ex-btn" onClick={onRetry}>
          Retry now
        </button>
      )}
    </div>
  );
}
