import type { JobSnapshot } from '@expunge/governance';
import { batchesOf } from './plan.js';
import type { ToolRuntime } from './runtime.js';
import { APPLY_STEP_ID } from './tools/apply-cleanup-batch.js';

export type BatchFacts = NonNullable<JobSnapshot['batch']>;

/**
 * The committed state one decision is made from. Every field is read from the stores now; the model supplies none of
 * it. `priorCalls` includes the call being decided, so the first call of a tool has `priorCalls === 1`.
 */
export async function buildSnapshot(
  rt: ToolRuntime,
  toolId: string,
  batch: BatchFacts | null,
  priorCalls: number,
): Promise<JobSnapshot> {
  const registry = await rt.registry();
  const store = rt.env.store;
  const [plan, discovery, sweep, receipt, effects, worldRevision] = await Promise.all([
    store.latestPlan(rt.actor, rt.job._id, rt.run.runId),
    store.latestStep(rt.actor, rt.job._id, 'discovery'),
    store.latestSweep(rt.actor, rt.job._id, rt.run.runId),
    store.completionReceipt(rt.actor, rt.job._id, rt.run.runId),
    store.committedEffectCount(rt.actor, rt.job._id),
    rt.worldRevision(),
  ]);
  let planFacts: JobSnapshot['plan'] = null;
  if (plan) {
    const batchCount = batchesOf(registry, plan.targets).length;
    planFacts = {
      targetCount: plan.targets.length,
      worldRevision: plan.worldRevision,
      batchCount,
      committedBatches: await store.committedBatchCount(
        rt.actor,
        { jobId: rt.job._id, approvedPlanHash: plan.planHash, stepId: APPLY_STEP_ID },
        batchCount,
      ),
    };
  }
  const arrayFields = registry.fields.filter((field) => field.isArray);
  return {
    toolId,
    worldRevision,
    plan: planFacts,
    batch,
    discovery: discovery
      ? { frontierOpen: discovery.payload.frontierOpen, depth: discovery.payload.depth }
      : null,
    arrayFieldsRegistered: arrayFields.length,
    arrayFieldsInspected: discovery ? discovery.payload.inspectedArrayFieldIds.length : null,
    verification:
      sweep && sweep.status === 'valid'
        ? { residuals: sweep.residuals, worldRevision: sweep.worldRevisionAfter }
        : null,
    completionReceiptCommitted: receipt !== null,
    priorEffects: effects > 0 ? { apply_cleanup_batch: effects } : {},
    priorCalls,
  };
}
