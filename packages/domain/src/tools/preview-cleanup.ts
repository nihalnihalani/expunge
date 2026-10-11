import { z } from 'zod';
import { eligibilityOf } from '@expunge/governance';
import type { DomainAddress } from '@expunge/contracts';
import { batchesOf, planHashOf, sortTargets } from '../plan.js';
import type { PlanTarget, RetainedRecord } from '../rows.js';
import type { ToolRuntime } from '../runtime.js';
import { ToolRefusal } from '../runtime.js';

/** No arguments: the targets are the records discovery selected, never anything a caller names. */
export const previewCleanupInput = z.object({}).strict();

/** The typed key under which other records refer to this record: its `_id`, with its BSON type. */
export function idBinding(address: DomainAddress): string | null {
  switch (address.recordIdBsonType) {
    case 'string':
      return `s:${address.recordId}`;
    case 'objectId':
      return `o:${address.recordId}`;
    case 'int':
      return `n:${address.recordId}`;
    case 'long':
      return `l:${address.recordId}`;
    default:
      return null;
  }
}

/**
 * Turns what discovery selected into an immutable, hashed plan: for each selected record that still exists, the
 * effect the owner policy assigns it at the version it has now, or a retained marker when the policy keeps it.
 * Nothing is written to the world.
 */
export async function previewCleanup(rt: ToolRuntime) {
  const registry = await rt.registry();
  const policy = await rt.ownerPolicy();
  const discovery = await rt.store.latestStep(rt.actor, rt.job._id, 'discovery');
  const resolution = await rt.store.latestStep(rt.actor, rt.job._id, 'subject_resolution');
  if (!resolution) throw new ToolRefusal('SubjectNotResolved');
  if (!discovery) throw new ToolRefusal('DiscoveryRequired');

  const worldRevision = await rt.worldRevision();
  const targets: PlanTarget[] = [];
  const retained: RetainedRecord[] = [];
  for (const selected of discovery.payload.selected) {
    const document = await rt.env.scopes.readRecord(rt.world, registry, selected.address);
    if (!document) continue; // already gone: nothing to plan
    const verdict = eligibilityOf(registry, document as never);
    if (!verdict.eligible) {
      retained.push({ address: selected.address, reason: verdict.reason });
      continue;
    }
    targets.push({
      address: selected.address,
      effect: verdict.effect,
      expectedRev: document._rev,
      hop: selected.hop,
      via: selected.via,
    });
  }
  const limits = rt.bundle.limits;
  const changeCap = Math.min(limits.changedDocuments, registry.documentLimits.maxChanged);
  if (targets.length > changeCap) throw new ToolRefusal('PlanExceedsDocumentLimit');

  const ordered = sortTargets(registry, targets);
  const bindings = new Set(resolution.payload.bindings);
  for (const target of ordered) {
    const id = idBinding(target.address);
    if (id !== null) bindings.add(id);
  }
  const planHash = planHashOf({
    jobId: rt.job._id,
    runId: rt.run.runId,
    harnessHash: rt.run.harnessHash,
    worldId: rt.run.worldId,
    scopeRevision: rt.run.scopeRevision,
    worldRevision,
    ownerPolicyHash: policy.hash,
    targets: ordered,
    bindings: [...bindings],
  });
  const plan = await rt.store.putPlan({
    tenantId: rt.actor.tenantId,
    env: rt.actor.env,
    scopeId: rt.actor.scopeId,
    planHash,
    jobId: rt.job._id,
    runId: rt.run.runId,
    harnessHash: rt.run.harnessHash,
    worldId: rt.run.worldId,
    scopeRevision: rt.run.scopeRevision,
    worldRevision,
    ownerPolicyHash: policy.hash,
    targets: ordered,
    bindings: [...bindings].sort(),
    retained,
  });
  const batches = batchesOf(registry, plan.targets);
  const byEffect = new Map<string, number>();
  for (const target of plan.targets) byEffect.set(target.effect, (byEffect.get(target.effect) ?? 0) + 1);
  return {
    planId: plan.planHash,
    worldRevision,
    targetCount: plan.targets.length,
    byEffect: Object.fromEntries([...byEffect.entries()].sort()),
    retainedCount: retained.length,
    retainedReasons: [...new Set(retained.map((entry) => entry.reason))].sort(),
    batches: batches.map((batch) => ({
      ordinal: batch.ordinal,
      effect: batch.effect,
      documents: batch.targets.length,
    })),
    changesWorld: false as const,
  };
}
