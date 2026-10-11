import { z } from 'zod';
import type { AuthorityRevision } from '@expunge/contracts';
import { PolicyEvaluator, toolArgsDigest, type Verdict } from '@expunge/governance';
import { ProtocolError } from '@expunge/mongo';
import { JobWaitSignal, isFenceLoss, type ToolContext } from '@expunge/runtime';
import type { WorkerToolId } from '@expunge/baselines';
import { phaseOf, RunContext } from './context.js';
import {
  createGatewayControls,
  type CallAdmission,
  type CallOutcome,
  type GatewayControls,
} from './controls.js';
import type { DomainEnv } from './env.js';
import { ToolRefusal, type ToolRuntime } from './runtime.js';
import { buildSnapshot, type BatchFacts } from './snapshot.js';
import {
  applyCleanupBatch,
  applyCleanupBatchInput,
  prepareApply,
  type PreparedApply,
} from './tools/apply-cleanup-batch.js';
import { completeCleanup, completeCleanupInput } from './tools/complete-cleanup.js';
import { discoverReferences, discoverReferencesInput } from './tools/discover-references.js';
import { inspectHarness, inspectHarnessInput } from './tools/inspect-harness.js';
import { inspectScope, inspectScopeInput } from './tools/inspect-scope.js';
import { previewCleanup, previewCleanupInput } from './tools/preview-cleanup.js';
import { reportDiagnostic, reportDiagnosticInput } from './tools/report-diagnostic.js';
import { resolveSubject, resolveSubjectInput } from './tools/resolve-subject.js';
import { verifyRegisteredScope, verifyRegisteredScopeInput } from './tools/verify-registered-scope.js';

/** Ledger identity of one decided call that is not an effect: the tool, its ordinal in this run and its arguments. */
type CallIdentity = { stepId: string; batchOrdinal: number; argsDigest: string };
type Prepared = { facts: BatchFacts | null; identity: CallIdentity | null; apply?: PreparedApply | null };
type Decided = { verdict: Verdict; decisionId: string; admission: CallAdmission };

type ToolSpec = {
  toolId: WorkerToolId;
  description: string;
  parameters: z.ZodType;
  prepare?(rt: ToolRuntime, args: never): Promise<Prepared>;
  run(rt: ToolRuntime, args: never, prepared: Prepared, decided: Decided): Promise<unknown>;
};

const noPrepare = async (): Promise<Prepared> => ({ facts: null, identity: null });

/** Types one tool's arguments from its schema, then stores it in the untyped table the gateway dispatches from. */
function tool<Schema extends z.ZodType>(definition: {
  toolId: WorkerToolId;
  description: string;
  parameters: Schema;
  prepare?(rt: ToolRuntime, args: z.infer<Schema>): Promise<Prepared>;
  run(rt: ToolRuntime, args: z.infer<Schema>, prepared: Prepared, decided: Decided): Promise<unknown>;
}): ToolSpec {
  return definition as unknown as ToolSpec;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  tool({
    toolId: 'inspect_scope',
    description:
      'List the registered collections, fields and reference edges this run may see, and the owner scope limits. Read only.',
    parameters: inspectScopeInput,
    run: (rt, args) => inspectScope(rt, args),
  }),
  tool({
    toolId: 'resolve_subject',
    description:
      'Resolve the authorized subject of this job from exact registered identity values. Takes no arguments; the subject is the one the owner submitted. Read only.',
    parameters: resolveSubjectInput,
    run: (rt) => resolveSubject(rt),
  }),
  tool({
    toolId: 'discover_references',
    description:
      'Find the records connected to the resolved subject through exact identity values and declared reference edges, within the bundle depth and the scan budget. Read only.',
    parameters: discoverReferencesInput,
    run: (rt, args) => discoverReferences(rt, args),
  }),
  tool({
    toolId: 'preview_cleanup',
    description:
      'Turn the discovered records into an immutable preview plan under the owner policy: the effect for each record, in batches. Changes nothing in the world.',
    parameters: previewCleanupInput,
    run: (rt) => previewCleanup(rt),
  }),
  tool({
    toolId: 'apply_cleanup_batch',
    description:
      'Apply one batch of the preview plan (the next uncommitted one unless `batch` is given). One transaction per batch; a repeated call for the same batch returns the saved receipt.',
    parameters: applyCleanupBatchInput,
    prepare: async (rt, args): Promise<Prepared> => {
      const apply = await prepareApply(rt, args);
      return { facts: apply?.facts ?? null, identity: apply?.identity ?? null, apply };
    },
    run: async (rt, args, prepared, decided) => {
      void args;
      if (!prepared.apply) throw new ToolRefusal('NoPreviewPlan');
      return applyCleanupBatch(rt, prepared.apply, {
        policy: decided.verdict.decision,
        decisionId: decided.decisionId,
      });
    },
  }),
  tool({
    toolId: 'verify_registered_scope',
    description:
      "Read every registered collection and field at a stable world revision and report whether any record still holds the subject's exact identity. Read only.",
    parameters: verifyRegisteredScopeInput,
    run: (rt) => verifyRegisteredScope(rt),
  }),
  tool({
    toolId: 'complete_cleanup',
    description:
      'Finish the job from committed state: the completion receipt is built from a verification of the registered scope, not from this call.',
    parameters: completeCleanupInput,
    run: (rt) => completeCleanup(rt),
  }),
  tool({
    toolId: 'inspect_harness',
    description:
      "Describe this run's own pinned harness: policies, limits, granted tools and guardrail rule ids. Read only.",
    parameters: inspectHarnessInput,
    run: (rt) => inspectHarness(rt),
  }),
  tool({
    toolId: 'report_diagnostic',
    description:
      'Record a short diagnostic about a problem you hit. It is stored as your own report, never as evidence, and changes nothing.',
    parameters: reportDiagnosticInput,
    run: (rt, args) => reportDiagnostic(rt, args),
  }),
];

/** Tools whose action is a committed change guarded by its own transaction fence; all others re-check afterwards. */
const CHANGES_WORLD: ReadonlySet<string> = new Set(['apply_cleanup_batch', 'complete_cleanup']);
/** Codes of `ProtocolError` that mean the run's authority is gone: the job is cancelled and the call refused. */
const AUTHORITY_CODES = new Set(['AuthorityRevisionStale', 'AuthorityFloorMismatch', 'AuthorityMissing']);
/** Failures a retry of the same tool can recover from (the workflow's `retryable_error` edge). */
const RETRYABLE_CODES = new Set([
  'StaleDocumentVersion',
  'StaleTarget',
  'StaleWorldRevision',
  'PartialEffect',
  // Injected by the campaign fault layer (before commit; after commit with the acknowledgement lost).
  'TransientFault',
  'AcknowledgementLost',
]);
const isRetryable = (error: unknown): boolean =>
  (error instanceof ProtocolError && RETRYABLE_CODES.has(error.code)) ||
  (error instanceof ToolRefusal && RETRYABLE_CODES.has(error.code));

/** How a successful call ended, as the workflow's edge conditions name it. */
function outcomeOf(toolId: WorkerToolId, output: unknown): CallOutcome {
  const result = (output ?? {}) as Record<string, unknown>;
  if (toolId === 'discover_references' && result.moreAvailable === true) return 'more_references';
  // A plan is applied one batch per call: the run stays on `apply` until the last batch commits.
  if (
    toolId === 'apply_cleanup_batch' &&
    typeof result.batchesRemaining === 'number' &&
    result.batchesRemaining > 0
  )
    return 'batches_remaining';
  if (toolId === 'verify_registered_scope' && result.verified === false) return 'verification_failed';
  return 'success';
}
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * The trusted path from a tool call to the world: validate the arguments, read the committed state the decision
 * needs, decide (owner floor, grants, prerequisites, compiled guardrails), write the decision to the ledger, and only
 * then act. A denied call never reaches the action; a call that needs approval stops the run with a wait. Nothing the
 * model sends is used for the decision except the arguments' digest.
 */
export class JobGateway {
  private constructor(
    readonly env: DomainEnv,
    readonly rt: RunContext,
    private readonly evaluator: PolicyEvaluator,
    private readonly controls: GatewayControls,
  ) {}

  /**
   * Opens the gateway for one run. The floor is the one the run's pinned bundle names, taken from the floors this
   * process knows; a bundle naming an unknown floor cannot run (`AuthorityFloorUnknown`), and there is no default.
   */
  static async open(
    env: DomainEnv,
    context: ToolContext,
    controls: GatewayControls = createGatewayControls(),
  ): Promise<JobGateway> {
    const floor = env.floorFor(context.bundle.authorityFloorHash);
    const rt = await RunContext.open(env, context);
    return new JobGateway(env, rt, new PolicyEvaluator(context.bundle, floor), controls);
  }

  async call(toolId: WorkerToolId, rawArgs: unknown): Promise<unknown> {
    const spec = TOOL_SPECS.find((candidate) => candidate.toolId === toolId);
    if (!spec) throw new ToolRefusal('UnknownTool');
    if (this.rt.signal.aborted) throw new ToolRefusal('Aborted');
    const parsed = spec.parameters.safeParse(rawArgs ?? {});
    if (!parsed.success) throw new ToolRefusal('InvalidArguments');
    const args = parsed.data as never;
    try {
      const prepared = spec.prepare ? await spec.prepare(this.rt, args) : await noPrepare();
      const decided = await this.decide(toolId, parsed.data, prepared);
      const { result, ruleIds } = decided.verdict.decision;
      const finish = (outcome: CallOutcome) =>
        this.controls.end(this.rt, { toolId, callNumber: decided.admission.callNumber, outcome });
      await this.rt.emit(
        'tool_decided',
        `decision:${decided.decisionId}`,
        {
          stepId: prepared.identity?.stepId ?? toolId,
          phase: phaseOf(toolId),
          toolId,
          decision: result,
          ruleIds: ruleIds.slice(0, 64),
          summary: `${toolId}: ${result}`,
          ...(prepared.facts ? { targetCount: prepared.facts.documentCount } : {}),
        },
        [decided.decisionId],
      );
      if (result === 'deny') {
        await finish('denied');
        throw new ToolRefusal('PolicyDenied');
      }
      if (result === 'ask') {
        await finish('needs_approval');
        throw new JobWaitSignal('waiting_approval');
      }
      let output: unknown;
      try {
        output = await spec.run(this.rt, args, prepared, decided);
      } catch (error) {
        await finish(isRetryable(error) ? 'retryable_error' : 'failed');
        throw error;
      }
      // A read returns nothing computed under an authorization that was revoked while it ran.
      if (!CHANGES_WORLD.has(toolId)) await this.assertAuthorityCurrent();
      await finish(outcomeOf(toolId, output));
      return output;
    } catch (error) {
      throw await this.refusal(toolId, error);
    }
  }

  /** The stored authorization revision must still be the one this run holds. Throws `AuthorityRevisionStale`. */
  private async assertAuthorityCurrent(): Promise<AuthorityRevision> {
    const stored = await this.env.authority.read(this.rt.actor);
    if (stored.authorizationRevision !== this.rt.actor.authorizationRevision)
      throw new ProtocolError('AuthorityRevisionStale');
    return stored;
  }

  private async decide(toolId: WorkerToolId, args: unknown, prepared: Prepared): Promise<Decided> {
    // Every call, reads included, starts from the live authority: a revoked run is stopped before it sees anything.
    const stored = await this.assertAuthorityCurrent();
    // What the call is, before it is admitted: an effect is named by its derived digest and effect key (so a retry of
    // the same logical effect is recognised), every other call by the digest of its arguments.
    const argsDigest = prepared.identity?.argsDigest ?? toolArgsDigest(toolId, args);
    const admission = await this.controls.begin(this.rt, {
      toolId,
      documentsToChange: prepared.facts?.documentCount ?? 0,
      argsDigest,
      effectKey: prepared.apply?.intent?.effectKey ?? null,
    });
    const snapshot = await buildSnapshot(this.rt, toolId, prepared.facts, admission.callsToThisTool);
    const evaluated = this.evaluator.decide(snapshot, this.rt.actor.authorizationRevision, stored.floorHash);
    // A control violation (workflow transition, visit or budget limit) turns the verdict into a deny.
    const verdict: Verdict =
      admission.violations.length === 0
        ? evaluated
        : {
            ...evaluated,
            decision: {
              result: 'deny',
              ruleIds: [...new Set([...evaluated.decision.ruleIds, ...admission.violations])],
              authorizationRevision: evaluated.decision.authorizationRevision,
            },
          };
    const identity: CallIdentity = prepared.identity ?? {
      stepId: toolId,
      batchOrdinal: admission.callNumber,
      argsDigest,
    };
    const record = await this.env.ledger.record(
      this.rt.actor,
      {
        jobId: this.rt.run.jobId,
        runId: this.rt.run.runId,
        harnessHash: this.rt.run.harnessHash,
        toolId,
        ...identity,
      },
      verdict,
    );
    return { verdict, decisionId: record.decisionId, admission };
  }

  /** Maps a failure to the closed vocabulary a model may see. Authority loss also stops the job. */
  private async refusal(toolId: string, error: unknown): Promise<unknown> {
    if (error instanceof ToolRefusal || error instanceof JobWaitSignal) return error;
    if (isFenceLoss(error)) return error;
    if (error instanceof ProtocolError) {
      if (AUTHORITY_CODES.has(error.code)) {
        try {
          await this.env.jobs.cancel(this.rt.actor, this.rt.job._id);
        } catch (cancelError) {
          this.env.report?.({ kind: 'tool_failed', toolId, error: cancelError });
        }
        this.env.report?.({
          kind: 'job_cancelled_for_authority',
          jobId: this.rt.job._id,
          code: error.code,
        });
        return new ToolRefusal('AuthorityRevoked');
      }
      return new ToolRefusal(SAFE_CODE.test(error.code) ? error.code : 'ToolFailed');
    }
    this.env.report?.({ kind: 'tool_failed', toolId, error });
    return new ToolRefusal('ToolFailed');
  }
}
