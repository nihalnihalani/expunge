import { TriangleAlert } from 'lucide-react';
import type { ExpungeJobSnapshotV2 } from '../../../shared/expunge';
import { notInspected } from '../projection/selectors';

/**
 * A finished job can still leave registered collections uninspected. Say so next to the
 * status so a finished job is never read as a complete cleanup.
 */
export function GapBanner({ snapshot }: { snapshot: ExpungeJobSnapshotV2 }) {
  if (snapshot.status !== 'succeeded') return null;
  const missing = notInspected(snapshot);
  if (missing.length === 0) return null;
  return (
    <div className="ex-banner ex-banner--warn" role="note">
      <TriangleAlert size={16} aria-hidden />
      <strong>
        The job finished, but not every registered collection was inspected.
      </strong>
      <span>
        Completion in the registered scope is incomplete until{' '}
        {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} inspected.
        Only a committed receipt states the verdict.
      </span>
    </div>
  );
}
