/** FIXTURE cancellation: the request is committed first, the stop later. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { event, later } from '../expunge-data.js';

export default function registerCancel(state: FixtureState) {
  state.onCancel.push((current, jobId) => {
    const job = current.jobs.get(jobId);
    if (
      !job ||
      ['succeeded', 'failed', 'cancelled'].includes(job.snapshot.status)
    )
      return;
    if (job.snapshot.cancellation.requested) return;
    const requested = job.snapshot.sequence + 1;
    job.events.push(
      event(jobId, requested, 'cancel_requested', {
        requestedAt: later(500),
        by: 'owner',
      }),
    );
    job.snapshot = {
      ...job.snapshot,
      sequence: requested,
      cancellation: { requested: true, requestedAt: later(500) },
      updatedAt: later(500),
    };
    // The worker stops at its next safe point, a moment later.
    setTimeout(() => {
      const live = current.jobs.get(jobId);
      if (!live) return;
      const next = live.snapshot.sequence + 1;
      live.events.push(
        event(jobId, next, 'job_status_changed', {
          from: live.snapshot.status,
          to: 'cancelled',
          reason: 'owner requested cancellation',
        }),
      );
      live.snapshot = {
        ...live.snapshot,
        status: 'cancelled',
        sequence: next,
        updatedAt: later(520),
      };
    }, 3000);
  });
}
