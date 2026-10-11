import type { ActorContext } from '@expunge/contracts';
import type { MongoService } from '@expunge/mongo';

/**
 * Confirms that a job's success is durably committed before it is reported to Raindrop as `succeeded`. A status read
 * at the default read concern during a failover can later be rolled back; reporting it would claim a state that never
 * became real. A failed confirmation never fails the job: the episode is reported as `aborted` (an under-claim).
 */
export interface CommittedReader {
  confirmSucceeded(actor: ActorContext, jobId: string, receiptId: string | undefined): Promise<boolean>;
}

/** Reads the stored job and its completion receipt at read concern `majority` with the worker's own principal. */
export class MongoCommittedReader implements CommittedReader {
  constructor(private readonly service: MongoService) {}
  async confirmSucceeded(
    actor: ActorContext,
    jobId: string,
    receiptId: string | undefined,
  ): Promise<boolean> {
    // A cleanup job only succeeds with a committed receipt; one without it is not a success worth reporting.
    if (!receiptId) return false;
    const scope = {
      'actor.tenantId': actor.tenantId,
      'actor.env': actor.env,
      'actor.scopeId': actor.scopeId,
    };
    const job = await this.service.control
      .collection<{ _id: string; status: string }>('jobs')
      .findOne({ _id: jobId, ...scope }, { readConcern: { level: 'majority' }, projection: { status: 1 } });
    if (job?.status !== 'succeeded') return false;
    const receipt = await this.service.control
      .collection<{ _id: string; jobId: string }>('completion_receipts')
      .findOne(
        { _id: receiptId, jobId, ...scope },
        { readConcern: { level: 'majority' }, projection: { _id: 1 } },
      );
    return Boolean(receipt);
  }
}
