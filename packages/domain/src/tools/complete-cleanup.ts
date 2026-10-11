import { z } from 'zod';
import { contentHash, type CompletionReceipt } from '@expunge/contracts';
import { liveFloorValidator } from '@expunge/governance';
import type { ToolRuntime } from '../runtime.js';
import { ToolRefusal } from '../runtime.js';
import { sweepAndRecord } from './verify-registered-scope.js';

export const completeCleanupInput = z.object({}).strict();

/**
 * Ends the job from committed state. The receipt is built from a verification sweep of the registered scope, never
 * from anything the model says:
 * - `verified_receipt`: needs the latest sweep to be valid for the current world revision with no residuals;
 *   otherwise the call is refused and the job stays open.
 * - `model_narrative`: the model's claim is not evidence, so the gateway sweeps now and commits what it finds,
 *   a complete receipt when the scope is clean and a truthful `incomplete` one (job failed) when it is not.
 */
export async function completeCleanup(rt: ToolRuntime) {
  const registry = await rt.registry();
  const existing = await rt.store.completionReceipt(rt.actor, rt.job._id, rt.run.runId);
  if (existing)
    return {
      completed: existing.domainStatus === 'complete_in_registered_scope',
      domainStatus: existing.domainStatus,
      operationalResiduals: existing.operationalResiduals,
      receiptId: existing.receiptId,
      alreadyCommitted: true as const,
    };

  // The yardstick for "nothing left" is the subject's reach as fixed at resolution. A reach that was cut by a limit is
  // only a lower bound, so no receipt, complete or incomplete, may claim to have measured against all of it.
  const resolution = await rt.store.latestStep(rt.actor, rt.job._id, 'subject_resolution');
  if (!resolution) throw new ToolRefusal('SubjectNotResolved');
  if (resolution.payload.closureTruncated) throw new ToolRefusal('ClosureIncomplete');

  let sweepId: string;
  let residuals: number;
  let retainedOrExcluded: number;
  let verifiedWorldRevision: number;
  let verificationPlanHash: string | null;
  if (rt.bundle.completionPolicy === 'verified_receipt') {
    const sweep = await rt.store.latestSweep(rt.actor, rt.job._id, rt.run.runId);
    if (!sweep || sweep.status !== 'valid') throw new ToolRefusal('VerificationRequired');
    if (sweep.worldRevisionAfter !== (await rt.worldRevision())) throw new ToolRefusal('VerificationStale');
    if (sweep.residuals !== 0) throw new ToolRefusal('ResidualsRemain');
    ({ _id: sweepId, residuals, retainedOrExcluded } = sweep);
    verifiedWorldRevision = sweep.worldRevisionAfter;
    verificationPlanHash = sweep.planHash;
  } else {
    const { outcome, row } = await sweepAndRecord(rt, registry);
    if (!outcome.valid) throw new ToolRefusal(outcome.reason);
    sweepId = row._id;
    residuals = outcome.residuals;
    retainedOrExcluded = outcome.retainedOrExcluded;
    verifiedWorldRevision = outcome.worldRevisionAfter;
    verificationPlanHash = row.planHash;
  }

  const complete = residuals === 0;
  const receipt: CompletionReceipt = {
    receiptId: contentHash(
      { jobId: rt.job._id, runId: rt.run.runId, sweepId, domainStatus: complete ? 'complete' : 'incomplete' },
      'completion-receipt-id',
    ),
    jobId: rt.job._id,
    runId: rt.run.runId,
    harnessHash: rt.run.harnessHash,
    scopeId: rt.actor.scopeId,
    scopeRevision: rt.run.scopeRevision,
    verifiedWorldRevision,
    verificationPlanHash: verificationPlanHash ?? contentHash({ jobId: rt.job._id, plan: null }, 'no-plan'),
    inspectedCollectionIds: registry.collectionIds,
    discoveredFieldIds: registry.fields.map((field) => field.fieldId),
    operationalResiduals: residuals,
    excludedOrRetainedRecords: retainedOrExcluded,
    limitations: [...new Set([...registry.discoveryCompleteness.limitations, 'registered scope only'])],
    domainStatus: complete ? 'complete_in_registered_scope' : 'incomplete',
    externalErasureStatus: 'not_required',
  };
  const validate = liveFloorValidator(rt.env, rt.actor, rt.job._id);
  if (complete) await rt.env.effects.complete(rt.actor, rt.lease, receipt, validate);
  else await rt.env.effects.completeIncomplete(rt.actor, rt.lease, receipt, validate);

  await rt.emit(
    'receipt_committed',
    `receipt:${receipt.receiptId}`,
    {
      receiptId: receipt.receiptId,
      domainStatus: receipt.domainStatus,
      externalErasureStatus: receipt.externalErasureStatus,
      verifiedWorldRevision: receipt.verifiedWorldRevision,
    },
    [receipt.receiptId],
  );
  if (complete)
    await rt.emit('job_status_changed', `${rt.job._id}:gw:status:${rt.job.attempt}:succeeded`, {
      from: 'running',
      to: 'succeeded',
      reason: 'completion receipt committed',
    });
  else
    await rt.emit('job_failed', `${rt.job._id}:gw:failed:${rt.job.attempt}`, {
      code: 'verification_failed',
      retryable: false,
      phase: 'complete',
      message: 'incomplete receipt',
    });
  return {
    completed: complete,
    domainStatus: receipt.domainStatus,
    operationalResiduals: residuals,
    excludedOrRetainedRecords: retainedOrExcluded,
    receiptId: receipt.receiptId,
    alreadyCommitted: false as const,
  };
}
