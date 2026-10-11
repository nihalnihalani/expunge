import { contentHash, type CostSummary, type ScopeKey, type TrialMetrics } from '@expunge/contracts';
import { gradeWorld, type GradeEvidence, type GradeReport } from '@expunge/grader';
import type { Derivation, GatePlanEntry, SealedFixture } from '@expunge/fixtures/sealed';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { faultPlanHash } from '@expunge/domain';
import type { Labeler } from './labels.js';
import {
  INFRA_FAILURE_CODES,
  NON_RESULT_OUTCOMES,
  ZERO_COST,
  type ArmName,
  type EpisodePort,
  type EpisodeRequest,
  type EpisodeResult,
  type HarnessDefect,
  type TrialArm,
  type WorkerProfile,
} from './types.js';
import type { HarnessBundle, ResourceLimits } from '@expunge/contracts';

export type ArmTask = {
  campaignId: string;
  resume: number;
  pairLabel: string;
  repeat: number;
  arm: ArmName;
  entry: GatePlanEntry;
  bundle: HarnessBundle;
  bundleHash: string;
  budget: ResourceLimits;
  profile: WorkerProfile;
  /** Extra seconds beyond the bundle's own wall-time limit before the gate cuts a run off as timed out. */
  graceMs: number;
};
export type ArmContext = {
  port: EpisodePort;
  derivation: Derivation;
  label: Labeler;
  signal: AbortSignal;
  baseScope: Pick<ScopeKey, 'tenantId' | 'env'>;
};

const safeCode = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_:]{0,63}$/.test(value) ? value : 'Error';
const nonNegative = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
function cleanCost(cost: Partial<CostSummary> | undefined): CostSummary {
  const out = { ...ZERO_COST };
  for (const key of Object.keys(out) as Array<keyof CostSummary>) out[key] = nonNegative(cost?.[key]);
  return out;
}

/** The labels of one arm: nothing in them names a split, fixture, repeat or arm. */
export function armLabels(
  label: Labeler,
  task: Pick<ArmTask, 'campaignId' | 'resume' | 'pairLabel' | 'arm'>,
) {
  const base = { campaignId: task.campaignId, resume: task.resume, pair: task.pairLabel, arm: task.arm };
  return {
    runId: label('run', base, 40),
    instanceId: label('instance', base, 24),
    scopeId: `i_${label('scope', base, 24)}`,
  };
}

/** The grading outcome of one pair of fixtures for one arm. */
export type ArmOutcome = { arm: TrialArm; grade: GradeReport | null };

/**
 * Runs one arm in a world instance of its own and grades what the port read back. Hard rules, independent of what the
 * port says:
 * - a failed, cancelled or timed-out run is never a success, whatever world it left (D8-7);
 * - a run the gate had to cut off, or that threw, is a row with no result and stays in the denominator;
 * - the grader joins hidden truth only here, through `gradeWorld`.
 */
export async function runArm(context: ArmContext, task: ArmTask): Promise<ArmOutcome> {
  const labels = armLabels(context.label, task);
  const instanceScope: ScopeKey = {
    tenantId: context.baseScope.tenantId,
    env: context.baseScope.env,
    scopeId: labels.scopeId,
  };
  // A fresh sealed fixture for this instance: record ids derive from (seed, collection, role, instance) under the
  // campaign key, so two arms of one pair never share a collection-wide _id.
  const fixture: SealedFixture = generateSealedFixture(
    task.entry.spec,
    task.entry.seed,
    instanceScope,
    undefined,
    { derivation: context.derivation },
  );
  const faults = structuredClone(task.entry.spec.faults);
  const request: EpisodeRequest = {
    campaignId: task.campaignId,
    runId: labels.runId,
    instanceId: labels.instanceId,
    instanceScope,
    bundle: structuredClone(task.bundle),
    bundleHash: task.bundleHash,
    profile: structuredClone(task.profile),
    limits: structuredClone(task.bundle.limits),
    budget: structuredClone(task.budget),
    world: structuredClone(fixture.world),
    faults,
    signal: context.signal,
  };
  const controller = new AbortController();
  const relay = () => controller.abort();
  context.signal.addEventListener('abort', relay, { once: true });
  request.signal = controller.signal;
  const cutoffMs = Math.max(1, task.bundle.limits.wallTimeMs + task.graceMs);
  let result: EpisodeResult | null = null;
  let outcome: TrialArm['outcome'] = 'failed';
  let failureCode: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    // A campaign cancelled before this arm started records the arm as cancelled: it stays in the denominator.
    if (context.signal.aborted) throw new Error('Aborted');
    const cutoff = new Promise<'cutoff'>((resolve) => {
      timer = setTimeout(() => resolve('cutoff'), cutoffMs);
    });
    const pending = Promise.resolve().then(() => context.port.run(request));
    // A run the gate cut off may still settle later; its late failure must not surface as an unhandled rejection.
    pending.catch(() => undefined);
    const raced = await Promise.race([pending, cutoff]);
    if (raced === 'cutoff') {
      controller.abort();
      outcome = 'timed_out';
      failureCode = 'RunTimedOut';
    } else {
      result = raced;
      outcome = raced.outcome;
      failureCode = raced.failureCode === undefined ? null : safeCode(raced.failureCode);
    }
  } catch (error) {
    outcome = context.signal.aborted ? 'cancelled' : 'failed';
    failureCode = context.signal.aborted
      ? 'RunCancelled'
      : safeCode(error instanceof Error ? error.name : '');
  } finally {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener('abort', relay);
  }
  if (result && !isKnownOutcome(result.outcome)) {
    outcome = 'failed';
    failureCode = 'InvalidOutcome';
    result = null;
  }

  const readback = result?.world ?? null;
  const graded: TrialArm['graded'] = readback ? 'readback' : 'initial';
  const actual = readback ?? fixture.world;
  const nonResult = NON_RESULT_OUTCOMES.includes(outcome);
  const evidence: GradeEvidence = {
    terminalStatus: nonResult || !result ? 'incomplete' : result.terminal.status,
    terminalClaim: result?.terminal.claim ?? 'registered_scope',
    retryFailures: nonNegative(result?.retryFailures),
    cost: cleanCost(result?.cost),
    ...(result?.receipt && !nonResult ? { trustedReceiptEvidence: result.receipt } : {}),
  };
  let report: GradeReport | null = null;
  let bindingFailure = false;
  try {
    report = gradeWorld(fixture.manifest, actual, evidence);
  } catch {
    // The world the port gave back does not match the sealed commitments (a forged, swapped or foreign world). It is a
    // failed row graded on the initial world, never a success and never an exception that drops the pair.
    bindingFailure = true;
    outcome = 'failed';
    failureCode = 'GraderBinding';
    report = gradeWorld(fixture.manifest, fixture.world, { ...evidence, terminalStatus: 'incomplete' });
  }
  const metrics: TrialMetrics = {
    usefulCompletion: report.usefulCompletion && !nonResult && !bindingFailure && outcome === 'completed',
    targetedResiduals: report.targetedResiduals,
    unrelatedRecordChanges: report.unrelatedRecordChanges,
    retentionViolations: report.retentionViolations,
    truthfulTerminal: report.truthfulTerminal,
    refused: report.refused,
    retryFailures: report.retryFailures,
    cost: report.cost,
  };
  const attested =
    result && typeof result.runtimeHash === 'string' && /^[a-f0-9]{64}$/.test(result.runtimeHash)
      ? result.runtimeHash
      : null;
  const infra = failureCode !== null && INFRA_FAILURE_CODES.includes(failureCode);
  const arm: TrialArm = {
    arm: task.arm,
    runId: labels.runId,
    outcome,
    failureCode,
    metrics,
    preservationViolations: report.preservationViolations,
    falseCompletion: report.falseCompletion,
    hadResult: result !== null,
    attestedRuntimeHash: attested,
    evidence: result?.evidence === 'committed' ? 'committed' : 'fake',
    infra,
    harnessDefect: result ? defectOf(result, faults, instanceScope, fixture.world.worldId) : null,
    worldUnread: readback === null,
    graderBindingFailure: bindingFailure,
    graded,
  };
  return { arm, grade: report };
}

function isKnownOutcome(value: unknown): value is TrialArm['outcome'] {
  return ['completed', 'incomplete', 'refused', 'failed', 'cancelled', 'timed_out'].includes(value as string);
}

/**
 * A fault-plan attestation that differs from the plan the trial committed, or a planned fault that was never injected,
 * is a defect in the harness, not behaviour of either arm (PREREGISTRATION R9). A port that attests nothing for a
 * world with no planned faults is fine; one that attests nothing for a world with faults is a defect.
 */
function defectOf(
  result: EpisodeResult,
  faults: {
    partialAcknowledgements: number;
    interruptAfterEffects: number | null;
    transientFailures: number;
  },
  scope: ScopeKey,
  worldId: string,
): HarnessDefect | null {
  const planned =
    faults.partialAcknowledgements +
    faults.transientFailures +
    (faults.interruptAfterEffects === null ? 0 : 1);
  if (!result.faults) return planned > 0 && result.evidence === 'committed' ? 'FaultPlanMismatch' : null;
  const expected = faultPlanHash(scope, worldId, faults);
  if (result.faults.attestedPlanHash !== expected) return 'FaultPlanMismatch';
  // A run that did not reach its effects (failed before) cannot be blamed for an uninjected fault.
  if (result.outcome === 'completed' || result.outcome === 'incomplete') {
    const injected = result.faults.injected;
    if (
      injected.transient < faults.transientFailures ||
      injected.lostAck < faults.partialAcknowledgements ||
      (faults.interruptAfterEffects !== null && injected.interrupted < 1)
    )
      return 'FaultPlanNotInjected';
  }
  return null;
}

export const faultPlanKey = (faults: unknown): string => contentHash(faults as never, 'fault-plan');
