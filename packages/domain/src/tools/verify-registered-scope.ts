import { z } from 'zod';
import type { ScopeRegistry } from '@expunge/contracts';
import { addressKey } from '../keys.js';
import { idBinding } from './preview-cleanup.js';
import type { ToolRuntime } from '../runtime.js';
import { ToolRefusal } from '../runtime.js';
import { sweepRegisteredScope, type SweepOutcome } from '../sweep.js';
import type { SweepRow } from '../store.js';

export const verifyRegisteredScopeInput = z.object({}).strict();

/** The subject's exact strings this run must find nowhere: its full identity plus the ids of every planned record. */
export async function verificationBindings(rt: ToolRuntime): Promise<Set<string>> {
  const resolution = await rt.store.latestStep(rt.actor, rt.job._id, 'subject_resolution');
  if (!resolution) throw new ToolRefusal('SubjectNotResolved');
  const bindings = new Set<string>([...resolution.payload.identityBindings, ...resolution.payload.bindings]);
  for (const plan of await rt.store.listPlans(rt.actor, rt.job._id, rt.run.runId))
    for (const value of plan.bindings) bindings.add(value);
  // Records in the subject's reach are named by their keys wherever another record refers to them.
  for (const member of resolution.payload.closure) {
    const id = idBinding(member.address);
    if (id !== null) bindings.add(id);
  }
  return bindings;
}

/** Runs one sweep over the whole registered scope and records it (insert-only). Shared with `complete_cleanup`. */
export async function sweepAndRecord(
  rt: ToolRuntime,
  registry: ScopeRegistry,
): Promise<{ outcome: SweepOutcome; row: SweepRow }> {
  const bindings = await verificationBindings(rt);
  const roles = await rt.fieldRoles();
  const policy = await rt.ownerPolicy();
  const resolution = (await rt.store.latestStep(rt.actor, rt.job._id, 'subject_resolution'))!;
  const plan = await rt.store.latestPlan(rt.actor, rt.job._id, rt.run.runId);
  const maxDocuments = Math.min(rt.bundle.limits.scannedDocuments, registry.documentLimits.maxScanned);
  const outcome = await sweepRegisteredScope({
    scopes: rt.env.scopes,
    world: rt.world,
    registry,
    roles,
    policy,
    bindings,
    closure: resolution.payload.closure,
    maxDocuments,
    worldRevision: () => rt.worldRevision(),
  });
  const base = {
    tenantId: rt.actor.tenantId,
    env: rt.actor.env,
    scopeId: rt.actor.scopeId,
    jobId: rt.job._id,
    runId: rt.run.runId,
    harnessHash: rt.run.harnessHash,
    worldId: rt.run.worldId,
    scopeRevision: rt.run.scopeRevision,
    worldRevisionBefore: outcome.worldRevisionBefore,
    worldRevisionAfter: outcome.worldRevisionAfter,
    planHash: plan?.planHash ?? null,
    inspectedCollectionIds: registry.collectionIds,
    discoveredFieldIds: registry.fields.map((field) => field.fieldId),
    limitations: registry.discoveryCompleteness.limitations,
  };
  const row = await rt.store.putSweep(
    outcome.valid
      ? {
          ...base,
          status: 'valid',
          residuals: outcome.residuals,
          retainedOrExcluded: outcome.retainedOrExcluded,
          residualSamples: outcome.residualSamples,
        }
      : { ...base, status: 'invalid', residuals: 0, retainedOrExcluded: 0, residualSamples: [] },
  );
  return { outcome, row };
}

/**
 * Reads every registered collection at a stable world revision and reports whether any record still carries the
 * subject's exact identity. Read only; the sweep row it records is what a later completion is built from. A scan
 * that cannot finish is reported as unavailable, never as clean.
 */
export async function verifyRegisteredScope(rt: ToolRuntime) {
  const registry = await rt.registry();
  const { outcome, row } = await sweepAndRecord(rt, registry);
  if (!outcome.valid) throw new ToolRefusal(outcome.reason);
  const visibleFieldIds = new Set((await rt.visible()).fields.map((field) => field.fieldId));
  return {
    verified: outcome.residuals === 0,
    residuals: outcome.residuals,
    retainedOrExcluded: outcome.retainedOrExcluded,
    // A field the run cannot see is not named: the residual is shown by collection and record, with its reason.
    residualRecords: outcome.residualSamples.slice(0, 25).map((residual) => ({
      collectionId: residual.address.collectionId,
      recordId: residual.address.recordId,
      ...(visibleFieldIds.has(residual.fieldId) ? { fieldId: residual.fieldId } : {}),
      reason: residual.reason,
      handle: addressKey(residual.address),
    })),
    worldRevision: outcome.worldRevisionAfter,
    closureComplete: !(await rt.store.latestStep(rt.actor, rt.job._id, 'subject_resolution'))?.payload
      .closureTruncated,
    inspectedCollections: registry.collectionIds.length,
    inspectedFields: registry.fields.length,
    sweepId: row._id,
  };
}
