import type { ActorContext } from '@expunge/contracts';
import { errorCode } from './errors.js';
import type { JobPort, LeaseBinding, WaitStatus } from './ports.js';

export type ReleaseOutcome = 'none' | 'yielded' | 'cancelled' | 'lost';

/**
 * Releases a lease the run was holding, using only the repository's own transitions:
 *  - a requested wait   -> `yield` (waiting_evidence | waiting_approval | waiting_external);
 *  - a cancellation the stored job has requested -> `finish(..., 'cancelled')`.
 * Anything else (worker shutdown, a model failure) is not released here: the dispatcher decides, or the
 * lease simply expires and the job is reclaimed with a new fence. A lost fence is reported, not retried.
 */
export async function releaseLease(
  jobs: JobPort,
  actor: ActorContext,
  lease: LeaseBinding,
  request: { wait?: WaitStatus },
): Promise<ReleaseOutcome> {
  try {
    if (request.wait) {
      await jobs.yield(actor, lease, request.wait);
      return 'yielded';
    }
    const job = await jobs.readAuthorized(actor, lease.jobId);
    if (job.cancellationRequested && job.status === 'running' && job.lease.fence === lease.fence) {
      await jobs.finish(actor, lease, 'cancelled', []);
      return 'cancelled';
    }
    return 'none';
  } catch (error) {
    if (['LostLease', 'JobNotFound'].includes(errorCode(error))) return 'lost';
    throw error;
  }
}
