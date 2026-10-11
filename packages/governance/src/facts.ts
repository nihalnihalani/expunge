import type { EffectKind } from '@expunge/contracts';
import type { DecisionInput } from '@expunge/harness-compiler';

/**
 * Committed job state the gateway reads before it decides one call. Every field is a fact about the stored job,
 * never something the model said. `null` means "not known at decision time" and reaches the guardrail evaluator as
 * unknown, which a restrictive rule treats as fired.
 */
export interface JobSnapshot {
  toolId: string;
  /** Current world revision, read now. */
  worldRevision: number;
  plan: {
    targetCount: number;
    /** World revision the plan was made at. */
    worldRevision: number;
    batchCount: number;
    committedBatches: number;
  } | null;
  /** The batch being decided; only apply decisions carry one. */
  batch: { documentCount: number; effectKind: EffectKind; policyStatus: 'retained' | 'eligible' } | null;
  discovery: { frontierOpen: number; depth: number } | null;
  arrayFieldsRegistered: number | null;
  arrayFieldsInspected: number | null;
  /** The latest verification sweep, if any, with the world revision it verified. */
  verification: { residuals: number; worldRevision: number } | null;
  completionReceiptCommitted: boolean;
  /** Committed effects per worker tool so far. */
  priorEffects: Readonly<Record<string, number>>;
  /** Calls already decided for this tool in this run. */
  priorCalls: number;
}

/** Facts, binding statuses and prior-effect counts exactly as `decide` evaluates them. */
export function buildDecisionInput(snapshot: JobSnapshot): DecisionInput {
  const { plan, verification } = snapshot;
  // Each committed batch of the plan advanced the world revision by one; anything else is a foreign write.
  const planCurrent = plan !== null && plan.worldRevision + plan.committedBatches === snapshot.worldRevision;
  const verificationCurrent = verification !== null && verification.worldRevision === snapshot.worldRevision;
  const verified = verificationCurrent && verification.residuals === 0;
  const facts: Record<string, unknown> = {
    plan_target_count: plan?.targetCount ?? null,
    batch_document_count: snapshot.batch?.documentCount ?? null,
    batch_effect_kind: snapshot.batch?.effectKind ?? null,
    batch_policy_status: snapshot.batch?.policyStatus ?? null,
    frontier_open_count: snapshot.discovery?.frontierOpen ?? null,
    discovery_depth: snapshot.discovery?.depth ?? null,
    array_fields_registered: snapshot.arrayFieldsRegistered,
    array_fields_inspected: snapshot.arrayFieldsInspected,
    verification_residuals: verificationCurrent ? verification.residuals : null,
    verification_status: verification === null ? null : verified ? 'valid' : 'invalid',
    world_revision_fresh: plan === null ? null : planCurrent,
    retry_count: Math.max(0, snapshot.priorCalls - 1),
  };
  const allBatchesCommitted = plan !== null && plan.committedBatches >= plan.batchCount;
  const bindings: Record<string, unknown> = {
    preview_plan: plan === null ? null : planCurrent ? 'valid' : 'invalid',
    // A plan with nothing to apply has nothing to commit: it is valid while current, so verification can still follow.
    action_receipt:
      plan === null || (plan.committedBatches === 0 && plan.batchCount > 0)
        ? null
        : allBatchesCommitted && planCurrent
          ? 'valid'
          : 'invalid',
    completion_receipt: snapshot.completionReceiptCommitted
      ? 'valid'
      : verification === null
        ? null
        : verified
          ? 'valid'
          : 'invalid',
    approval_grant: null,
  };
  return { toolId: snapshot.toolId, facts, bindings, prior: { ...snapshot.priorEffects } };
}
