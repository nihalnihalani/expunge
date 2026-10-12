import type { JobStatus } from '../../../shared/expunge';
import { useNow } from '../hooks/useNow';

/** A queued job no worker has claimed for this long gets a visible warning. */
export const UNCLAIMED_AFTER_MS = 120_000;

/**
 * Minutes a job has waited unclaimed, or null when no warning is due. A worker claim moves the
 * job to 'running' and a requeue rewrites updatedAt, so for a 'queued' job updatedAt is the moment
 * it last entered the queue. Only status and updatedAt are read: the rule needs no lease details.
 */
export function unclaimedMinutes(
  job: { status: JobStatus; updatedAt: string },
  now: number,
): number | null {
  if (job.status !== 'queued') return null;
  const since = Date.parse(job.updatedAt);
  if (!Number.isFinite(since)) return null;
  const waited = now - since;
  if (waited <= UNCLAIMED_AFTER_MS) return null;
  return Math.floor(waited / 60_000);
}

/** Pass `now` to share a parent clock (and in tests); without it the notice keeps its own. */
export function UnclaimedNotice({
  job,
  now,
}: {
  job: { status: JobStatus; updatedAt: string };
  now?: number;
}) {
  const clock = useNow();
  const minutes = unclaimedMinutes(job, now ?? clock);
  if (minutes === null) return null;
  return (
    <div className="ex-banner ex-banner--warn" role="note">
      <strong>Not picked up yet:</strong>
      <span>
        no worker has claimed this job for {minutes} min. Check that a worker
        is running for this scope.
      </span>
    </div>
  );
}
