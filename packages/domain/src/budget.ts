import type { ClientSession, Filter } from 'mongodb';
import type { ScopeKey } from '@expunge/contracts';
import type { CallPayload, DiscoveryPayload, WorkflowPayload } from './rows.js';
import type { StepRow } from './store.js';
import type { ToolRuntime } from './runtime.js';
import { WORKFLOW_START, type WorkflowPosition } from './workflow.js';

export const TOOL_CALL_BUDGET_EXCEEDED = 'gateway:tool_call_budget_exceeded';
export const SCANNED_DOCUMENTS_BUDGET_EXCEEDED = 'gateway:scanned_documents_budget_exceeded';
export const CHANGED_DOCUMENTS_BUDGET_EXCEEDED = 'gateway:changed_documents_budget_exceeded';
export const CALL_REPLAY_DIGEST_MISMATCH = 'gateway:call_replay_digest_mismatch';

/** What a call row holds beyond the shared `CallPayload`: its logical identity and what it was admitted as. */
export type CallRecord = CallPayload & {
  /** The logical effect key of an effectful call (null for a read): a retry names the same key, whoever makes it. */
  logicalKey: string | null;
  /** Digest of the call's inputs. A replay of the same logical call must present the same one. */
  inputsDigest: string;
  /** The workflow node this call visits when it ends in an advancing outcome; null for exempt tools and denied calls. */
  nodeId: string | null;
  /** The controls found no violation, so the call went on to the decision. */
  admitted: boolean;
  /** The lease fence of the session that began the call: an unended row of an older fence was interrupted. */
  fence: number;
};
/** What a workflow row holds beyond `WorkflowPayload`: how the call itself ended (the settled outcome is `outcome`). */
export type WorkflowRecord = WorkflowPayload & {
  callOutcome: string;
  /** The call took an edge: the position moved and a visit was used. Denied, waiting and failed calls did not. */
  advanced: boolean;
};

type CallStep = StepRow<'call'> & { payload: CallRecord };
type WorkflowStep = StepRow<'workflow'> & { payload: WorkflowRecord };

/**
 * Reads the job's durable control state: the call rows, workflow rows, discovery steps and committed receipts. Reads
 * only; every write goes through `rt.store`, which fences it on the run's lease. Nothing is held in memory between
 * calls, so a new session or a takeover sees exactly what the last holder left. Given the transaction's `session`,
 * every read sees the snapshot the step is then appended in, so a count and the insert that spends it are one unit.
 */
export class ControlState {
  private readonly scope: ScopeKey;
  private readonly jobId: string;

  constructor(
    private readonly rt: ToolRuntime,
    private readonly session?: ClientSession,
  ) {
    this.scope = { tenantId: rt.actor.tenantId, env: rt.actor.env, scopeId: rt.actor.scopeId };
    this.jobId = rt.job._id;
  }

  private steps() {
    return this.rt.env.service.control.collection<StepRow>('domain_steps');
  }
  private match(kind: string, extra: Record<string, unknown> = {}): Filter<StepRow> {
    return { ...this.scope, jobId: this.jobId, kind, ...extra } as Filter<StepRow>;
  }

  /**
   * The job has ended (finished by `complete_cleanup`, failed or cancelled). Its lease is gone, so no row can be
   * added and nothing can be changed: the controls have nothing left to guard, and a call on it either answers from
   * committed state or fails in the tool's own fenced write.
   */
  async jobFinished(): Promise<boolean> {
    const job = await this.rt.env.jobs.readAuthorized(this.rt.actor, this.jobId);
    return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
  }

  callCount(toolId?: string): Promise<number> {
    return this.steps().countDocuments(this.match('call', toolId ? { 'payload.toolId': toolId } : {}), {
      session: this.session,
    });
  }

  async latestCall(): Promise<CallStep | null> {
    return (await this.steps().findOne(this.match('call'), {
      sort: { ordinal: -1 },
      session: this.session,
    })) as CallStep | null;
  }

  async callByNumber(callNumber: number): Promise<CallStep | null> {
    return (await this.steps().findOne(this.match('call', { ordinal: callNumber }), {
      session: this.session,
    })) as CallStep | null;
  }

  /** The newest call row of this logical effect, whichever session or attempt wrote it. */
  async latestCallFor(logicalKey: string): Promise<CallStep | null> {
    return (await this.steps().findOne(this.match('call', { 'payload.logicalKey': logicalKey }), {
      sort: { ordinal: -1 },
      session: this.session,
    })) as CallStep | null;
  }

  /** How many call rows name this logical effect: the attempts made at it so far. */
  attemptsAt(logicalKey: string): Promise<number> {
    return this.steps().countDocuments(this.match('call', { 'payload.logicalKey': logicalKey }), {
      session: this.session,
    });
  }

  /** The workflow row that settled this call, if the call has ended. */
  async settledRow(callNumber: number): Promise<WorkflowStep | null> {
    return (await this.steps().findOne(this.match('workflow', { 'payload.callNumber': callNumber }), {
      session: this.session,
    })) as WorkflowStep | null;
  }

  private async latestWorkflow(extra: Record<string, unknown> = {}): Promise<WorkflowStep | null> {
    return (await this.steps().findOne(this.match('workflow', extra), {
      sort: { ordinal: -1 },
      session: this.session,
    })) as WorkflowStep | null;
  }

  /**
   * Where the run stands: the node and outcome of the last call that took an edge, with every node's visits counted
   * from the log (the calls that took an edge), not read back from a running total.
   */
  async position(): Promise<WorkflowPosition> {
    const row = await this.latestWorkflow();
    if (!row) return WORKFLOW_START;
    return { nodeId: row.payload.nodeId, outcome: row.payload.outcome, visits: await this.visits(false) };
  }

  /**
   * Visits per node: the calls that took an edge, plus (with `reserved`) the admitted calls of THIS lease holder that
   * have not ended yet. An overlapping call has already spent its visit, so a node cannot be admitted past its limit
   * by two calls that began before either ended. A call interrupted under an older fence has not taken an edge and
   * reserves nothing.
   */
  async visits(reserved: boolean): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const bump = (nodeId: string | null) => {
      if (nodeId !== null) counts[nodeId] = (counts[nodeId] ?? 0) + 1;
    };
    const workflow = await this.steps()
      .find(this.match('workflow'), { session: this.session })
      .project<{ payload: Pick<WorkflowRecord, 'callNumber' | 'advanced' | 'nodeId'> }>({
        'payload.callNumber': 1,
        'payload.advanced': 1,
        'payload.nodeId': 1,
      })
      .toArray();
    for (const row of workflow) if (row.payload.advanced) bump(row.payload.nodeId);
    if (!reserved) return counts;
    const ended = new Set(workflow.map((row) => row.payload.callNumber));
    const open = await this.steps()
      .find(
        this.match('call', {
          'payload.admitted': true,
          'payload.nodeId': { $ne: null },
          'payload.fence': this.rt.lease.fence,
        }),
        { session: this.session },
      )
      .project<{ payload: Pick<CallRecord, 'callNumber' | 'nodeId'> }>({
        'payload.callNumber': 1,
        'payload.nodeId': 1,
      })
      .toArray();
    for (const row of open) if (!ended.has(row.payload.callNumber)) bump(row.payload.nodeId);
    return counts;
  }

  /**
   * Calls to `toolId` since the run last took an edge: the retries spent on the current step of a read. A call that
   * took an edge starts the next step, so a clean sequence of calls reads zero retries.
   */
  async callsSinceLastMove(toolId: string): Promise<number> {
    const moved = await this.latestWorkflow({ 'payload.advanced': true });
    return this.steps().countDocuments(
      this.match('call', {
        'payload.toolId': toolId,
        ...(moved ? { ordinal: { $gt: moved.payload.callNumber } } : {}),
      }),
      { session: this.session },
    );
  }

  /** Documents scanned by every discovery this job has made, across plans, sessions and takeovers. */
  async scannedDocuments(): Promise<number> {
    const rows = await this.steps()
      .find(this.match('discovery'), { session: this.session })
      .project<{ payload: Pick<DiscoveryPayload, 'scannedDocuments'> }>({ 'payload.scannedDocuments': 1 })
      .toArray();
    return rows.reduce((sum, row) => sum + (row.payload.scannedDocuments ?? 0), 0);
  }

  /** Whether the logical effect has a committed effect row for this job. */
  async effectCommitted(effectKey: string): Promise<boolean> {
    const found = await this.rt.env.effects.effects.findOne(
      { _id: effectKey, jobId: this.jobId },
      { projection: { _id: 1, actor: 1 }, session: this.session },
    );
    return (
      found !== null &&
      found.actor.tenantId === this.scope.tenantId &&
      found.actor.env === this.scope.env &&
      found.actor.scopeId === this.scope.scopeId
    );
  }

  /** Effects (batches) this job has committed. A committed effect has one row per logical effect key. */
  committedEffects(): Promise<number> {
    return this.rt.env.store.committedEffectCount(this.rt.actor, this.jobId);
  }

  /**
   * Documents changed by this job, summed over its COMMITTED action receipts. An attempt that failed or has not
   * committed has no receipt and counts for nothing, and a retried effect has one receipt, so nothing counts twice.
   */
  async committedChangedDocuments(): Promise<number> {
    const effects = await this.rt.env.effects.effects
      .find(
        {
          jobId: this.jobId,
          'actor.tenantId': this.scope.tenantId,
          'actor.env': this.scope.env,
          'actor.scopeId': this.scope.scopeId,
        },
        { session: this.session },
      )
      .project<{ receiptId: string }>({ receiptId: 1 })
      .toArray();
    if (effects.length === 0) return 0;
    const [total] = await this.rt.env.effects.receipts
      .aggregate<{ documents: number }>(
        [
          { $match: { _id: { $in: effects.map((effect) => effect.receiptId) } } },
          { $group: { _id: null, documents: { $sum: { $size: '$appliedEffects' } } } },
        ],
        { session: this.session },
      )
      .toArray();
    return total?.documents ?? 0;
  }
}
