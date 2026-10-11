import { contentHash, type EffectKind, type ScopeRegistry } from '@expunge/contracts';
import { addressKey } from './keys.js';
import type { PlanBatch, PlanTarget } from './rows.js';

/** Documents per effect batch: one transaction stays well inside the deployment's transaction lifetime. */
export const MAX_BATCH_DOCUMENTS = 25;
const EFFECT_ORDER: readonly EffectKind[] = ['delete', 'redact', 'restrict', 'tombstone'];

/** Plan targets in the order the plan is applied: collection order of the registry, then record id. */
export function sortTargets(
  registry: Pick<ScopeRegistry, 'collectionIds'>,
  targets: readonly PlanTarget[],
): PlanTarget[] {
  const order = new Map(registry.collectionIds.map((id, index) => [id, index]));
  return [...targets].sort(
    (left, right) =>
      (order.get(left.address.collectionId) ?? 99) - (order.get(right.address.collectionId) ?? 99) ||
      addressKey(left.address).localeCompare(addressKey(right.address), 'en'),
  );
}

/** Deterministic batches: one effect kind per batch, at most MAX_BATCH_DOCUMENTS records, in application order. */
export function batchesOf(
  registry: Pick<ScopeRegistry, 'collectionIds'>,
  targets: readonly PlanTarget[],
  size = MAX_BATCH_DOCUMENTS,
): PlanBatch[] {
  const sorted = sortTargets(registry, targets);
  const batches: PlanBatch[] = [];
  for (const effect of EFFECT_ORDER) {
    const group = sorted.filter((target) => target.effect === effect);
    for (let index = 0; index < group.length; index += size)
      batches.push({ ordinal: batches.length, effect, targets: group.slice(index, index + size) });
  }
  return batches;
}

/** The plan's identity: exactly what it will do, to which records at which versions, bound to the run. */
export function planHashOf(input: {
  jobId: string;
  runId: string;
  harnessHash: string;
  worldId: string;
  scopeRevision: number;
  worldRevision: number;
  ownerPolicyHash: string;
  targets: readonly PlanTarget[];
  bindings: readonly string[];
}): string {
  return contentHash(
    {
      jobId: input.jobId,
      runId: input.runId,
      harnessHash: input.harnessHash,
      worldId: input.worldId,
      scopeRevision: input.scopeRevision,
      worldRevision: input.worldRevision,
      ownerPolicyHash: input.ownerPolicyHash,
      targets: input.targets.map((target) => ({
        address: target.address,
        effect: target.effect,
        expectedRev: target.expectedRev,
      })),
      bindings: [...input.bindings].sort(),
    },
    'preview-plan',
  );
}
