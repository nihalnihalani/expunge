import type { WorkerToolId } from '@expunge/baselines';
import { contentHash } from '@expunge/contracts';
import {
  CALL_REPLAY_DIGEST_MISMATCH,
  CHANGED_DOCUMENTS_BUDGET_EXCEEDED,
  SCANNED_DOCUMENTS_BUDGET_EXCEEDED,
  TOOL_CALL_BUDGET_EXCEEDED,
  ControlState,
  type CallRecord,
  type WorkflowRecord,
} from './budget.js';
import type { ToolRuntime } from './runtime.js';
import { ADVANCING_OUTCOMES, admitTransition, advance } from './workflow.js';

/** How a call ended, in the vocabulary the bundle's workflow edges use (`when`). */
export type CallOutcome =
  | 'success'
  | 'more_references'
  | 'batches_remaining'
  | 'retryable_error'
  | 'verification_failed'
  | 'needs_approval'
  | 'denied'
  | 'failed';

export interface CallAdmission {
  /** 1-based and durable across sessions and takeovers: the Nth call this job has made. */
  callNumber: number;
  /** Calls to this tool in this job so far, INCLUDING this one. It feeds the `retry_count` fact (calls beyond the first). */
  callsToThisTool: number;
  /**
   * Gateway rule ids to add to a DENY verdict, such as `gateway:workflow_transition_denied`,
   * `gateway:workflow_visits_exceeded`, `gateway:tool_call_budget_exceeded` or
   * `gateway:changed_documents_budget_exceeded`. Empty when the call is admitted.
   */
  violations: string[];
}

/**
 * Per-job controls the gateway applies around every call, beyond the policy evaluator's facts: the bundle's workflow
 * graph (admitted transitions and per-node visit limits) and the owner's resource limits counted across sessions
 * and plans. State lives in the job's insert-only step log (`domain_steps`, kinds `call` and `workflow`), written
 * through `rt.store` so a session without the lease cannot add to it.
 *
 * `begin` runs before the decision and writes the call row; `end` runs after the action with how it ended.
 *
 * `argsDigest` and `effectKey` are optional so an older caller still works, but the gateway should pass them: the
 * digest binds the call row to its inputs, and the effect key names the logical effect, so a retry of the same effect
 * (by any tool-call id, after any takeover) is recognised instead of being counted again.
 */
export interface GatewayControls {
  begin(
    rt: ToolRuntime,
    call: {
      toolId: WorkerToolId;
      documentsToChange: number;
      /** `toolArgsDigest(toolId, args)`, or the effect's `argsDigest` for an effectful call. */
      argsDigest?: string;
      /** The logical effect key of an effectful call; absent for a read. */
      effectKey?: string | null;
    },
  ): Promise<CallAdmission>;
  end(
    rt: ToolRuntime,
    call: { toolId: WorkerToolId; callNumber: number; outcome: CallOutcome },
  ): Promise<void>;
}

/**
 * The gateway's durable controls. Every decision comes from the job's own rows and the bundle's graph and limits, so
 * nothing resets when a session ends, a plan is replaced or another worker takes the lease.
 *
 * - Tool calls: every call row counts, denied ones included, so a model cannot probe for free. A call over the limit
 *   writes no row (the log is bounded by the limit) and is denied.
 * - Workflow: the call must follow an admitted edge from where the last advancing call left the run, to a node with
 *   visits left. `inspect_harness` and `report_diagnostic` are outside the graph.
 * - Scanned documents: discovery only, summed over the job's discovery steps; a discovery is refused once the limit
 *   has been used.
 * - Changed documents: the committed receipts' applied effects, plus the batch this call would add unless that
 *   effect already committed (then the call only replays its saved receipt).
 * - A finished job (its last call, `complete_cleanup`, ended the lease) is admitted without a row and ends without
 *   one: it can write nothing, so only answers from committed state are left.
 * - Atomicity: a call's reads and its row are one fenced transaction, so overlapping calls of one holder serialise.
 *   A call reserves its node's visit when it begins, so overlapping calls cannot pass a node's `maxVisits`; visits are
 *   counted from the log (calls that took an edge), never read back from a running total. Overlapping calls are judged
 *   from the same settled position: each must follow an admitted edge from where the last ended call left the run.
 *   DISCLOSED: because overlapping calls are judged from the same settled position, a node can repeat without a
 *   self edge for that outcome (two `preview->apply` in flight). The repeat is bounded by the visits reserved at
 *   `begin`, by `limits.toolCalls`, and by the tool's own guards (one commit per effect key, batches in order).
 * - Replay: a call naming a logical effect that already has a row must present the same inputs digest. An effect that
 *   already committed is replayed for free, and a call that began but never ended (a crashed session) resumes under
 *   its own number instead of taking a new one.
 */
export function createGatewayControls(): GatewayControls {
  return {
    async begin(rt, call) {
      const limits = rt.bundle.limits;
      const logicalKey = call.effectKey ?? null;
      const inputsDigest =
        call.argsDigest ??
        contentHash({ toolId: call.toolId, documentsToChange: call.documentsToChange }, 'gateway-call');
      const outside = new ControlState(rt);
      // The finished job has no lease to write under; it can only be asked what it already holds.
      if (await outside.jobFinished())
        return { callNumber: (await outside.callCount()) + 1, callsToThisTool: 1, violations: [] };
      const worldRevision = await rt.worldRevision();

      // Everything that decides the call is read in the same fenced transaction that appends its row. The fence's
      // commitSeq bump makes two overlapping calls of one holder conflict, and the loser plans again on the winner's
      // row. The plan only reads, one read at a time, because the transaction callback can run more than once.
      const { result } = await rt.store.appendStepAfter<'call', CallAdmission>(
        rt.actor,
        rt.run,
        'call',
        worldRevision,
        async (session) => {
          const state = new ControlState(rt, session);
          const totalCalls = await state.callCount();
          const committed = logicalKey ? await state.effectCommitted(logicalKey) : false;
          // Retries spent on the current step: attempts at this effect before this one, or, for a read, calls to the
          // tool since the run last took an edge. A clean sequence reads zero.
          let spent: number;
          if (logicalKey) {
            const prior = await state.latestCallFor(logicalKey);
            spent = await state.attemptsAt(logicalKey);
            if (prior) {
              if (prior.payload.inputsDigest !== inputsDigest)
                return {
                  payload: null,
                  result: {
                    callNumber: prior.ordinal,
                    callsToThisTool: spent,
                    violations: [CALL_REPLAY_DIGEST_MISMATCH],
                  },
                };
              // The effect already happened: this call can only return the saved receipt, which costs nothing.
              if (committed)
                return {
                  payload: null,
                  result: { callNumber: prior.ordinal, callsToThisTool: spent, violations: [] },
                };
              // A call that was admitted, began and never ended is carried on by the next holder under its number.
              // One the controls had refused is not resumed: it is judged again as a new attempt.
              const latest = await state.latestCall();
              if (
                prior.payload.admitted &&
                latest?.ordinal === prior.ordinal &&
                !(await state.settledRow(prior.ordinal))
              )
                return {
                  payload: null,
                  result: { callNumber: prior.ordinal, callsToThisTool: spent, violations: [] },
                };
            }
          } else {
            spent = await state.callsSinceLastMove(call.toolId);
          }
          const callsToThisTool = spent + 1;

          if (totalCalls >= limits.toolCalls)
            return {
              payload: null,
              result: {
                callNumber: totalCalls + 1,
                callsToThisTool,
                violations: [TOOL_CALL_BUDGET_EXCEEDED],
              },
            };

          const violations: string[] = [];
          const transition = admitTransition(
            rt.bundle.workflow,
            { ...(await state.position()), visits: await state.visits(true) },
            call.toolId,
          );
          if (transition.violation) violations.push(transition.violation);
          if (
            call.toolId === 'discover_references' &&
            (await state.scannedDocuments()) >= limits.scannedDocuments
          )
            violations.push(SCANNED_DOCUMENTS_BUDGET_EXCEEDED);
          const adding = committed ? 0 : call.documentsToChange;
          if (adding > 0 && (await state.committedChangedDocuments()) + adding > limits.changedDocuments)
            violations.push(CHANGED_DOCUMENTS_BUDGET_EXCEEDED);

          const admitted = violations.length === 0;
          const payload: CallRecord = {
            toolId: call.toolId,
            callNumber: totalCalls + 1,
            toolCallNumber: (await state.callCount(call.toolId)) + 1,
            documentsToChange: call.documentsToChange,
            logicalKey,
            inputsDigest,
            nodeId: admitted ? transition.nodeId : null,
            admitted,
            fence: rt.lease.fence,
          };
          return { payload, result: { callNumber: totalCalls + 1, callsToThisTool, violations } };
        },
      );
      return result;
    },

    async end(rt, call) {
      // `complete_cleanup` ends the job and its lease with it, so the last call of a run has no workflow row to write.
      if (await new ControlState(rt).jobFinished()) return;
      const worldRevision = await rt.worldRevision();
      await rt.store.appendStepAfter<'workflow', null>(
        rt.actor,
        rt.run,
        'workflow',
        worldRevision,
        async (session) => {
          const state = new ControlState(rt, session);
          // No row means the call was refused before it was recorded (over the call budget); a settled row is a replay.
          const row = await state.callByNumber(call.callNumber);
          if (!row || row.payload.toolId !== call.toolId) return { payload: null, result: null };
          if (await state.settledRow(call.callNumber)) return { payload: null, result: null };
          const before = await state.position();
          const moves =
            row.payload.admitted && row.payload.nodeId !== null && ADVANCING_OUTCOMES.has(call.outcome);
          const after = moves ? advance(before, row.payload.nodeId!, call.outcome) : before;
          const payload: WorkflowRecord = {
            nodeId: after.nodeId,
            callNumber: call.callNumber,
            outcome: after.outcome ?? call.outcome,
            visits: { ...after.visits },
            callOutcome: call.outcome,
            advanced: moves,
          };
          return { payload, result: null };
        },
      );
    },
  };
}
