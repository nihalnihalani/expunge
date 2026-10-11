import type { ActorContext, CompletionReceipt } from '@expunge/contracts';
import type { MongoService } from '@expunge/mongo';
import type { CompletionReceiptReader } from '@expunge/runtime';

/**
 * Reads committed completion receipts with the worker's own principal (domain_executor has FIND on
 * `completion_receipts`). The row is bound by job, run and harness; the actor scope is checked against
 * the stored receipt actor. The model's text never reaches this reader.
 */
export class MongoCompletionReceiptReader implements CompletionReceiptReader {
  constructor(private readonly service: MongoService) {}
  async find(
    actor: ActorContext,
    binding: { jobId: string; runId: string; harnessHash: string },
  ): Promise<CompletionReceipt | null> {
    const saved = await this.service.control
      .collection<CompletionReceipt & { _id: string; actor: ActorContext; createdAt: Date }>(
        'completion_receipts',
      )
      .findOne({
        jobId: binding.jobId,
        runId: binding.runId,
        harnessHash: binding.harnessHash,
        'actor.tenantId': actor.tenantId,
        'actor.env': actor.env,
        'actor.scopeId': actor.scopeId,
      });
    if (!saved) return null;
    const { _id: _unusedId, actor: _unusedActor, createdAt: _unusedCreatedAt, ...receipt } = saved;
    return receipt;
  }
}
