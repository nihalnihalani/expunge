import { EventType } from '@ag-ui/core';
import type { ActorContext, Job, JobKind, JsonValue, ScopeKey } from '@expunge/contracts';
import type { ProjectionEventInput } from '@expunge/mongo';
import {
  ExpungeExecutionAgent,
  errorCode,
  type ArtifactReader,
  type CompletionReceiptReader,
  type ExecutionHooks,
  type JobPort,
  type LeaseBinding,
  type ModelResolver,
  type RunStats,
  type ToolProvider,
} from '@expunge/runtime';
import type { ProviderEnv } from '@expunge/vendor-openmuse';
import type { Subscription } from 'rxjs';
import type { WorkerConfig } from './config.js';
import { decideTerminal, projectionFailureCode, terminalCheckpoint, type ReceiptFact } from './terminal.js';
import type { WakeCommand, WakeTarget } from './wake.js';

/** `JobRepository` (packages/mongo/src/jobs.ts) satisfies this structurally; wiring.ts checks it at compile time. */
export interface DispatchJobs extends JobPort {
  claim(actor: ActorContext, jobId: string, ownerId: string, durationMs?: number): Promise<Job | null>;
  renew(actor: ActorContext, lease: LeaseBinding, durationMs?: number): Promise<Job>;
  /** Fenced, permission-checked record of the hashes a run puts in model context (Job.contextInputs). */
  recordContextInputs(actor: ActorContext, lease: LeaseBinding, hashes: string[]): Promise<string[]>;
  /** Graceful release by the lease owner: running -> queued, lease ended, no fence bump. */
  release(actor: ActorContext, lease: LeaseBinding): Promise<void>;
  /** Job ids this principal could claim now (queued, or running with an expired lease). Used to recover from crashed workers. */
  listClaimable(
    key: ScopeKey,
    limit?: number,
  ): Promise<Array<{ jobId: string; kind: JobKind; priority: number }>>;
}

/**
 * Trusted dispatcher read of a job by ID, before any actor is known (a wake carries only jobId and commandId).
 * Backed by `JobRepository.resolveForDispatch`. Returns null when the job does not exist.
 */
export interface JobResolver {
  resolve(jobId: string): Promise<Job | null>;
}

/**
 * Persists sanitized projection events (`ProjectionRepository.append`). These are committed-state facts the operator
 * UI replays, not the model's AG-UI stream. Appends are best-effort after the job transition they describe (not in
 * the same transaction); a failed append is logged and the UI recovers from the authoritative job snapshot.
 */
export interface ProjectionSink {
  append(key: ScopeKey, event: ProjectionEventInput): Promise<unknown>;
}

export type LogEntry = { level: 'info' | 'warn' | 'error'; message: string; jobId?: string; code?: string };

export type JobOutcome =
  | 'unknown_job'
  | 'unsupported_kind'
  | 'out_of_scope'
  | 'terminal'
  | 'not_claimable'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'yielded'
  | 'lost_lease'
  | 'aborted'
  | 'released'
  | 'unfinalized';

export type JobRunResult = { jobId: string; outcome: JobOutcome; stats?: RunStats; reason?: string };

export type DispatcherDeps = {
  jobs: DispatchJobs;
  resolver: JobResolver;
  artifacts: ArtifactReader;
  tools: ToolProvider;
  models: ModelResolver;
  receipts: CompletionReceiptReader;
  config: WorkerConfig;
  env?: ProviderEnv;
  projection?: ProjectionSink;
  log?: (entry: LogEntry) => void;
  onResult?: (result: JobRunResult) => void;
};

const BEGIN = (jobId: string) => `Begin cleanup job ${jobId}.`;

type WaitState = 'waiting_evidence' | 'waiting_approval' | 'waiting_external';
type FinalizeInput = {
  jobId: string;
  actor: ActorContext;
  lease: LeaseBinding;
  claimed: Job;
  stats: RunStats;
  writer: CheckpointWriter;
  renewalFailed: boolean;
};

/** Serializes checkpoint writes for one lease and merges state so every write is a complete snapshot. */
class CheckpointWriter {
  private state: Record<string, JsonValue> = { v: 1 };
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly jobs: DispatchJobs,
    private readonly actor: ActorContext,
    private readonly lease: LeaseBinding,
  ) {}
  update(patch: Record<string, JsonValue>): Promise<void> {
    this.state = { ...this.state, ...patch };
    const snapshot = this.state;
    const write = this.chain.then(() => this.jobs.checkpoint(this.actor, this.lease, snapshot));
    this.chain = write.catch(() => undefined);
    return write;
  }
  replace(value: JsonValue): Promise<void> {
    const write = this.chain.then(() => this.jobs.checkpoint(this.actor, this.lease, value));
    this.chain = write.catch(() => undefined);
    return write;
  }
}

/**
 * Durable dispatcher: claims a queued (or lease-expired) cleanup job through `JobRepository.claim`, renews
 * the lease on a timer, runs `ExpungeExecutionAgent`, checkpoints between tool phases, and finalizes the job
 * from committed state. It never takes tenant, actor, harness or budget from a wake command.
 */
export class Dispatcher implements WakeTarget {
  private readonly queue: string[] = [];
  private readonly running = new Map<string, () => void>();
  private waiters: Array<() => void> = [];
  private stopping = false;
  private polling = false;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: DispatcherDeps) {}

  wake(command: WakeCommand): boolean {
    return this.enqueue(command.jobId);
  }

  /** True when a wake would be queued (not stopping, queue not full). Checked before a command id is recorded. */
  canAccept(): boolean {
    return !this.stopping && this.queue.length < this.deps.config.maxQueued;
  }

  private enqueue(jobId: string): boolean {
    if (this.stopping) return false;
    if (this.queue.includes(jobId) || this.running.has(jobId)) return true; // already pending: idempotent
    if (this.queue.length >= this.deps.config.maxQueued) return false;
    this.queue.push(jobId);
    this.pump();
    return true;
  }

  /**
   * Crashed-worker recovery: asks the repository for jobs this principal could claim now (queued, or running with an
   * expired lease) and queues them. Wake commands are an optimization; this poll makes delivery at-least-once.
   */
  async poll(): Promise<number> {
    if (this.stopping || this.polling) return 0;
    this.polling = true;
    try {
      const { scope } = this.deps.config;
      if (!scope) return 0; // polling is bound to the worker's configured scope; without one it cannot run
      const room = this.deps.config.maxQueued - this.queue.length;
      if (room <= 0) return 0;
      const candidates = await this.deps.jobs.listClaimable(
        scope,
        Math.min(room, this.deps.config.pollBatch),
      );
      let queued = 0;
      for (const candidate of candidates)
        if (
          candidate.kind === 'cleanup' &&
          !this.running.has(candidate.jobId) &&
          this.enqueue(candidate.jobId)
        )
          queued++;
      return queued;
    } catch (error) {
      this.log({ level: 'warn', message: 'claimable poll failed', code: errorCode(error) });
      return 0;
    } finally {
      this.polling = false;
    }
  }

  /** Starts the recovery poll (config.pollMs; 0 disables). Safe to call once. */
  startPolling(): void {
    const { pollMs, scope } = this.deps.config;
    if (pollMs <= 0 || !scope || this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), pollMs);
    this.pollTimer.unref?.();
  }

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Graceful stop: no new work; running jobs are aborted and then RELEASED (running -> queued, no fence bump) so
   * another worker can claim them at once, unless a tool is still running (then the lease expires instead).
   */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.queue.length = 0;
    for (const abort of this.running.values()) abort();
    await this.idle();
  }

  get inFlight(): string[] {
    return [...this.running.keys()];
  }

  private pump(): void {
    while (this.running.size < this.deps.config.maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift() as string;
      this.running.set(jobId, () => undefined);
      void this.runJob(jobId)
        .then((result) => this.deps.onResult?.(result))
        .catch((error) =>
          this.log({ level: 'error', message: 'job run failed unexpectedly', jobId, code: errorCode(error) }),
        )
        .finally(() => {
          this.running.delete(jobId);
          this.pump();
          if (this.queue.length === 0 && this.running.size === 0) {
            const waiters = this.waiters;
            this.waiters = [];
            for (const resolve of waiters) resolve();
          }
        });
    }
  }

  private log(entry: LogEntry): void {
    this.deps.log?.(entry);
  }

  async runJob(jobId: string): Promise<JobRunResult> {
    const { jobs, config } = this.deps;
    const stored = await this.deps.resolver.resolve(jobId);
    if (!stored) return { jobId, outcome: 'unknown_job' };
    const bound = config.scope;
    if (
      bound &&
      (stored.actor.tenantId !== bound.tenantId ||
        stored.actor.env !== bound.env ||
        stored.actor.scopeId !== bound.scopeId)
    )
      return { jobId, outcome: 'out_of_scope' };
    if (stored.kind !== 'cleanup') return { jobId, outcome: 'unsupported_kind' };
    if (['succeeded', 'failed', 'cancelled'].includes(stored.status)) return { jobId, outcome: 'terminal' };

    const claimed = await jobs.claim(stored.actor, jobId, config.ownerId, config.leaseMs);
    if (!claimed) return { jobId, outcome: 'not_claimable' };
    const actor = claimed.actor;
    const lease: LeaseBinding = { jobId, ownerId: config.ownerId, fence: claimed.lease.fence };
    this.log({ level: 'info', message: 'job claimed', jobId });
    if (this.stopping) {
      // stop() arrived between queueing and claiming: hand the job straight back instead of running it.
      await jobs.release(actor, lease).catch(() => undefined);
      return { jobId, outcome: 'released', reason: 'worker_stopping' };
    }
    await this.project(actor, {
      eventId: `${jobId}:started:${claimed.attempt}`,
      jobId,
      runId: claimed.binding.runId,
      artifactIds: [claimed.binding.harnessHash],
      kind: 'job_started',
      payload: {
        jobKind: claimed.kind,
        harnessHash: claimed.binding.harnessHash,
        worldId: claimed.binding.worldId,
        scopeRevision: claimed.binding.scopeRevision,
        attempt: claimed.attempt,
      },
    });

    const writer = new CheckpointWriter(jobs, actor, lease);
    const hooks: ExecutionHooks = {
      onContextInputs: async (hashes) => void (await jobs.recordContextInputs(actor, lease, hashes)),
      onPhaseComplete: async (info) => {
        try {
          await writer.update({
            phase: info.phase,
            toolCalls: info.toolCalls,
            lastTool: info.toolId,
            lastOutcome: info.outcome,
            lastPhaseMs: info.elapsedMs,
            ...(info.model ? { model: info.model } : {}),
          });
        } catch (error) {
          // complete_cleanup commits the receipt AND the terminal job state in one transaction, so the
          // checkpoint after it legitimately finds no live lease. Re-read: a terminal job ends the run normally.
          if (errorCode(error) === 'LostLease') {
            const now = await jobs.readAuthorized(actor, jobId).catch(() => null);
            if (now && ['succeeded', 'failed', 'cancelled'].includes(now.status)) return 'stop';
          }
          throw error;
        }
        return 'continue';
      },
      onHookError: (hook, error) =>
        this.log({ level: 'warn', message: `hook ${hook} failed`, jobId, code: errorCode(error) }),
    };

    const agent = new ExpungeExecutionAgent(
      {
        jobs,
        artifacts: this.deps.artifacts,
        tools: this.deps.tools,
        models: this.deps.models,
        receipts: this.deps.receipts,
        hooks,
        env: this.deps.env,
        phaseTimeoutMs: config.phaseTimeoutMs,
        requirePricing: config.requirePricing,
        toolDrainMs: config.toolDrainMs,
      },
      { actor, lease },
    );

    let subscription: Subscription | undefined;
    let finishRun: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let aborting = false;
    const abortRun = () => {
      aborting = true;
      subscription?.unsubscribe();
      finishRun();
    };
    this.running.set(jobId, abortRun);

    let renewing = false;
    let renewalFailed = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      jobs
        .renew(actor, lease, config.leaseMs)
        .catch((error) => {
          // Lost fence, or cancellation requested (renew requires cancellationRequested=false). Stop the run;
          // the agent's teardown finishes a cancelled job while the lease is still live.
          renewalFailed = true;
          this.log({
            level: 'warn',
            message: 'lease renewal failed; stopping run',
            jobId,
            code: errorCode(error),
          });
          abortRun();
        })
        .finally(() => {
          renewing = false;
        });
    }, config.renewEveryMs);

    let runErrorCode: string | undefined;
    try {
      subscription = agent
        .run({
          threadId: jobId,
          runId: claimed.binding.runId,
          state: {},
          messages: [{ id: `${claimed.binding.runId}-begin`, role: 'user', content: BEGIN(jobId) }],
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .subscribe({
          next: (event) => {
            if (event.type === EventType.RUN_ERROR)
              runErrorCode = (event as unknown as { code?: string }).code;
          },
          error: () => finishRun(),
          complete: () => finishRun(),
        });
      await done;
    } catch (error) {
      runErrorCode = errorCode(error);
    } finally {
      subscription?.unsubscribe();
    }

    try {
      const stats: RunStats = (await agent.settled()) ?? {
        endedBy: aborting ? 'aborted' : 'error',
        ...(runErrorCode ? { errorCode: runErrorCode } : {}),
        toolCalls: 0,
        phases: 0,
        elapsedMs: 0,
        release: 'none',
      };
      return await this.finalize({ jobId, actor, lease, claimed, stats, writer, renewalFailed });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async finalize(input: FinalizeInput): Promise<JobRunResult> {
    const result = await this.finalizeState(input);
    await this.projectOutcome(input, result);
    return result;
  }

  private async project(actor: ActorContext, event: ProjectionEventInput): Promise<void> {
    if (!this.deps.projection) return;
    try {
      await this.deps.projection.append(
        { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId },
        event,
      );
    } catch (error) {
      this.log({
        level: 'warn',
        message: 'projection append failed',
        jobId: event.jobId,
        code: errorCode(error),
      });
    }
  }

  /** Committed-state facts only; the model's stream and narrative never become projection events here. */
  private async projectOutcome(input: FinalizeInput, result: JobRunResult): Promise<void> {
    const { jobId, actor, claimed, stats } = input;
    const base = { jobId, runId: claimed.binding.runId, artifactIds: [] as string[] };
    const status = (to: 'succeeded' | 'cancelled' | 'queued' | WaitState, reason: string) =>
      this.project(actor, {
        ...base,
        eventId: `${jobId}:status:${claimed.attempt}:${to}`,
        kind: 'job_status_changed',
        payload: { from: 'running', to, reason },
      });
    switch (result.outcome) {
      case 'failed': {
        const code = projectionFailureCode(result.reason ?? 'internal_error');
        await this.project(actor, {
          ...base,
          eventId: `${jobId}:failed:${claimed.attempt}`,
          kind: 'job_failed',
          payload: {
            code,
            retryable: code === 'provider_error' || code === 'lease_lost',
            phase: null,
            message: (result.reason ?? 'internal_error').slice(0, 200),
          },
        });
        return;
      }
      case 'succeeded':
        if (result.reason === 'receipt_committed') await status('succeeded', 'completion receipt committed');
        return;
      case 'cancelled':
        await status('cancelled', 'cancellation requested');
        return;
      case 'yielded':
        if (stats?.waitStatus) await status(stats.waitStatus, 'a tool requested a wait');
        return;
      case 'released':
        await status('queued', 'worker stopping');
        return;
      default:
        return;
    }
  }

  private async finalizeState(input: FinalizeInput): Promise<JobRunResult> {
    const { jobs, receipts } = this.deps;
    const { jobId, actor, lease, claimed, stats, writer } = input;
    const stored = await jobs.readAuthorized(actor, jobId).catch(() => null);
    let receipt: ReceiptFact = null;
    if (!['yielded', 'cancelled'].includes(stats.release)) {
      try {
        const found = await receipts.find(actor, {
          jobId,
          runId: claimed.binding.runId,
          harnessHash: claimed.binding.harnessHash,
        });
        if (found)
          receipt = {
            receiptId: found.receiptId,
            domainStatus: found.domainStatus,
            operationalResiduals: found.operationalResiduals,
          };
      } catch (error) {
        this.log({ level: 'warn', message: 'receipt read failed', jobId, code: errorCode(error) });
      }
    }
    const action = decideTerminal({
      stats,
      stored,
      fence: lease.fence,
      receipt,
      renewalFailed: input.renewalFailed,
    });
    if (
      action.kind === 'none' &&
      this.stopping &&
      stats.endedBy === 'aborted' &&
      stats.release === 'none' &&
      !stats.abandonedTools &&
      stored?.status === 'running' &&
      stored.lease.fence === lease.fence
    ) {
      // Graceful shutdown: hand the job back (running -> queued) instead of leaving it to lease expiry.
      try {
        await jobs.release(actor, lease);
        this.log({ level: 'info', message: 'job released for shutdown', jobId });
        return { jobId, outcome: 'released', stats, reason: 'worker_stopping' };
      } catch (error) {
        this.log({ level: 'warn', message: 'release on shutdown failed', jobId, code: errorCode(error) });
        return { jobId, outcome: 'lost_lease', stats, reason: errorCode(error) };
      }
    }
    if (action.kind === 'none') {
      const outcome: JobOutcome =
        stats.release === 'yielded'
          ? 'yielded'
          : stats.release === 'cancelled'
            ? 'cancelled'
            : action.reason === 'already_terminal'
              ? stored?.status === 'succeeded'
                ? 'succeeded'
                : stored?.status === 'cancelled'
                  ? 'cancelled'
                  : 'failed'
              : action.reason === 'not_ours'
                ? 'lost_lease'
                : 'aborted';
      this.log({ level: 'info', message: `job ended: ${outcome}`, jobId });
      return { jobId, outcome, stats, reason: action.reason };
    }
    try {
      await writer.replace(terminalCheckpoint(stats, action));
      try {
        await jobs.finish(actor, lease, action.status, action.outputRefs);
        this.log({ level: 'info', message: `job finished: ${action.status}`, jobId, code: action.reason });
        return { jobId, outcome: action.status, stats, reason: action.reason };
      } catch (error) {
        // The repository refuses `succeeded` without a verifiable receipt; downgrade rather than strand the job.
        if (action.status === 'succeeded' && errorCode(error) === 'CompletionReceiptRequired') {
          await jobs.finish(actor, lease, 'failed', action.outputRefs);
          return { jobId, outcome: 'failed', stats, reason: 'CompletionReceiptRequired' };
        }
        throw error;
      }
    } catch (error) {
      this.log({ level: 'error', message: 'could not finalize job', jobId, code: errorCode(error) });
      return { jobId, outcome: 'unfinalized', stats, reason: errorCode(error) };
    }
  }
}
