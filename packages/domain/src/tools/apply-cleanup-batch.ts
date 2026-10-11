import { z } from 'zod';
import { contentHash, type ActionIntent, type AppliedEffect, type PolicyDecision } from '@expunge/contracts';
import {
  ProtocolError,
  deriveArgsDigest,
  deriveEffectKey,
  deriveTargetHash,
  type ScopeRepository,
} from '@expunge/mongo';
import { eligibilityOf, liveFloorValidator } from '@expunge/governance';
import { batchesOf } from '../plan.js';
import { nodeKey } from '../keys.js';
import { recordEffectFor } from '../record-effects.js';
import type { PlanBatch } from '../rows.js';
import type { PlanRow } from '../store.js';
import type { ToolRuntime } from '../runtime.js';
import { ToolRefusal } from '../runtime.js';

/** The step name that, with the plan and the batch ordinal, names one logical effect. */
export const APPLY_STEP_ID = 'apply';

export const applyCleanupBatchInput = z
  .object({
    /** The batch to apply. Absent means the next one that has not committed. */
    batch: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type ApplyCleanupBatchInput = z.infer<typeof applyCleanupBatchInput>;

export type PreparedApply = {
  plan: PlanRow;
  batches: PlanBatch[];
  committedPrefix: number;
  ordinal: number;
  batch: PlanBatch | null;
  /** What the decision sees about the batch; null when there is no such batch to decide. */
  facts: {
    documentCount: number;
    effectKind: PlanBatch['effect'];
    policyStatus: 'retained' | 'eligible';
  } | null;
  /** Identity of the logical effect, fixed by the plan and the ordinal; also names the ledger row. */
  identity: { stepId: string; batchOrdinal: number; argsDigest: string } | null;
  intent: Omit<ActionIntent, 'policyDecision' | 'decisionId' | 'intentId'> | null;
};

/**
 * Everything the decision needs about the batch about to be applied, from committed state only: which batch,
 * how many documents, which effect, whether every record is still eligible for it, and the identity of the effect.
 * The caller decides first; nothing here writes.
 */
export async function prepareApply(
  rt: ToolRuntime,
  input: ApplyCleanupBatchInput,
): Promise<PreparedApply | null> {
  const plan = await rt.store.latestPlan(rt.actor, rt.job._id, rt.run.runId);
  if (!plan) return null;
  const registry = await rt.registry();
  const batches = batchesOf(registry, plan.targets);
  const committedPrefix = await rt.store.committedBatchCount(
    rt.actor,
    { jobId: rt.job._id, approvedPlanHash: plan.planHash, stepId: APPLY_STEP_ID },
    batches.length,
  );
  const ordinal = input.batch ?? committedPrefix;
  const batch = batches[ordinal] ?? null;
  if (!batch)
    return {
      plan,
      batches,
      committedPrefix,
      ordinal,
      batch: null,
      facts: null,
      identity: null,
      intent: null,
    };

  // A batch that already committed replays its saved receipt; its records have legitimately moved on.
  let policyStatus: 'retained' | 'eligible' = 'eligible';
  if (ordinal >= committedPrefix) {
    const registryNow = registry;
    for (const target of batch.targets) {
      const document = await rt.env.scopes.readRecord(rt.world, registryNow, target.address);
      const verdict = document ? eligibilityOf(registryNow, document as never) : null;
      if (verdict && (!verdict.eligible || verdict.effect !== target.effect)) {
        policyStatus = 'retained';
        break;
      }
    }
  }
  const worldRevision = await rt.worldRevision();
  const base = {
    jobId: rt.job._id,
    runId: rt.run.runId,
    harnessHash: rt.run.harnessHash,
    stepId: APPLY_STEP_ID,
    approvedPlanHash: plan.planHash,
    batchOrdinal: ordinal,
    targetAddresses: batch.targets.map((target) => target.address),
    effectKind: batch.effect,
  };
  const targetHash = deriveTargetHash(base.targetAddresses);
  const expectedDocumentVersions = batch.targets.map((target) => ({
    address: target.address,
    version: target.expectedRev,
  }));
  const intent = {
    ...base,
    targetHash,
    expectedDocumentVersions,
    worldRevision,
    effectKey: deriveEffectKey(base),
    // The digest binds the record versions the plan saw, so a replay at other versions is a different action.
    argsDigest: deriveArgsDigest({ ...base, expectedDocumentVersions }),
  };
  return {
    plan,
    batches,
    committedPrefix,
    ordinal,
    batch,
    facts: { documentCount: batch.targets.length, effectKind: batch.effect, policyStatus },
    identity: { stepId: APPLY_STEP_ID, batchOrdinal: ordinal, argsDigest: intent.argsDigest },
    intent,
  };
}

/**
 * Commits one batch of the bound plan as one logical effect: a single transaction that fences the lease, the
 * authorization revision, the decision ledger row and the owner floor, advances the world counter once, applies each
 * record's effect as one conditional update and writes the intent, the effect key and the receipt. A retry of the
 * same batch, by any tool-call id or after a takeover, returns the saved receipt without writing again.
 */
export async function applyCleanupBatch(
  rt: ToolRuntime,
  prepared: PreparedApply,
  decision: { policy: PolicyDecision; decisionId: string },
) {
  const { plan, batch, intent: base, ordinal } = prepared;
  if (prepared.batches.length === 0) {
    // Everything in the plan was retained or unclassified: there is nothing to commit. No effect, receipt or counter
    // move; the run goes on to verification, which judges the outcome honestly.
    if (ordinal !== 0) throw new ToolRefusal('UnknownBatch');
    return {
      batchOrdinal: 0,
      effect: null,
      documents: 0,
      appliedEffects: 0,
      committed: false as const,
      emptyPlan: true as const,
      replayed: false,
      receiptId: null,
      resultingWorldRevision: await rt.worldRevision(),
      batchesRemaining: 0,
    };
  }
  if (!batch || !base)
    throw new ToolRefusal(
      prepared.committedPrefix >= prepared.batches.length ? 'NoBatchRemaining' : 'UnknownBatch',
    );
  if (ordinal > prepared.committedPrefix) throw new ToolRefusal('BatchOutOfOrder');

  const registry = await rt.registry();
  const ownerPolicy = await rt.ownerPolicy();
  const roles = await rt.fieldRoles();
  const bindings = new Set(plan.bindings);
  const intent: ActionIntent = {
    ...base,
    intentId: contentHash({ effectKey: base.effectKey, decisionId: decision.decisionId }, 'intent-id'),
    policyDecision: decision.policy,
    decisionId: decision.decisionId,
  };
  const scopes: ScopeRepository = rt.env.scopes;
  const receipt = await rt.env.effects.commitEffect({
    actor: rt.actor,
    lease: rt.lease,
    intent,
    validate: liveFloorValidator(rt.env, rt.actor, rt.job._id),
    apply: async (session) => {
      const applied: AppliedEffect[] = [];
      for (const target of batch.targets) {
        // Read the record inside the transaction: what is written is computed from what this snapshot holds.
        const document = await scopes.readRecord(rt.world, registry, target.address, session);
        if (!document || document._rev !== target.expectedRev) throw new ProtocolError('StaleTarget');
        const verdict = eligibilityOf(registry, document as never);
        // The owner policy can change a record's standing after the plan was made; a record it no longer lets
        // this effect touch is left exactly as it is, and the whole batch stops.
        if (!verdict.eligible || verdict.effect !== target.effect) throw new ProtocolError('PolicyChanged');
        const preHash = await scopes.preimageHash(rt.world, registry, target.address, session);
        const effect = recordEffectFor({
          registry,
          policy: ownerPolicy,
          roles,
          collectionId: target.address.collectionId,
          document,
          effect: target.effect,
          expectedRev: target.expectedRev,
          bindings,
        });
        await scopes.applyEffect(rt.world, registry, target.address, effect, session);
        const removed = target.effect === 'delete';
        applied.push({
          address: target.address,
          kind: target.effect,
          preHash,
          postHash: removed ? null : await scopes.preimageHash(rt.world, registry, target.address, session),
          preVersion: target.expectedRev,
          postVersion: removed ? null : target.expectedRev + 1,
        });
      }
      return applied;
    },
  });
  const replayed = ordinal < prepared.committedPrefix;
  // Events describe committed state; the receipt id is stable across a replay, so a repeat appends nothing new.
  const byCollection = new Map<string, string[]>();
  for (const effect of receipt.appliedEffects) {
    const list = byCollection.get(effect.address.collectionId) ?? [];
    list.push(nodeKey(effect.address));
    byCollection.set(effect.address.collectionId, list);
  }
  for (const [collectionId, nodeIds] of byCollection)
    await rt.emit(
      'effect_committed',
      `effect:${receipt.receiptId}:${collectionId}`,
      {
        receiptId: receipt.receiptId,
        stepId: APPLY_STEP_ID,
        batchOrdinal: ordinal,
        effectKind: batch.effect,
        collectionId,
        appliedCount: nodeIds.length,
        resultingWorldRevision: receipt.resultingWorldRevision,
        nodeIds: nodeIds.slice(0, 100),
      },
      [receipt.receiptId],
    );
  return {
    batchOrdinal: ordinal,
    effect: batch.effect,
    documents: receipt.appliedEffects.length,
    appliedEffects: receipt.appliedEffects.length,
    committed: true as const,
    emptyPlan: false as const,
    replayed,
    receiptId: receipt.receiptId,
    resultingWorldRevision: receipt.resultingWorldRevision,
    batchesRemaining: Math.max(0, prepared.batches.length - Math.max(prepared.committedPrefix, ordinal + 1)),
  };
}
