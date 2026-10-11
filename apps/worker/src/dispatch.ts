import { EventType } from '@ag-ui/core';
import type { ActorContext, Job, JobKind, JobStatus, JsonValue, ScopeKey } from '@expunge/contracts';
import type { ProjectionEventInput } from '@expunge/mongo';
import type { CarrierHeaders } from '@expunge/observability';
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
import type { ClientSession } from 'mongodb';
import type { Subscription } from 'rxjs';
import type { WorkerConfig } from './config.js';
import { decideTerminal, projectionFailureCode, terminalCheckpoint, type ReceiptFact } from './terminal.js';
import type { CommittedReader } from './committed.js';
import type { EpisodeHandle, OutcomeFacts, Telemetry } from './telemetry.js';
import type { WakeCommand, WakeTarget } from './wake.js';

/** `JobRepository` (packages/mongo/src/jobs.ts) satisfies this structurally; wiring.ts checks it at compile time. */
export interface DispatchJobs extends JobPort {
  claim(actor: ActorContext, jobId: string, ownerId: string, durationMs?: number): Promise<Job | null>;
  renew(actor: ActorContext, lease: LeaseBinding, durationMs?: number): Promise<Job>;
  /** Fenced, permission-checked record of the hashes a run puts in model context (Job.contextInputs). */
  recordContextInputs(actor: ActorContext, lease: LeaseBinding, hashes: string[]): Promise<string[]>;
  /** Graceful release by the lease owner: running -> queued, lease ended, no fence bump. */
  release(actor: ActorContext, lease: LeaseBinding): Promise<void>;
  /**
   * Throws `HarnessNotDeployed` unless the scope's deployment pointer names the job's pinned harness now (cleanup jobs
   * only; the repository itself skips campaign worlds and other kinds). Called after the claim and before any model or tool
   * call, so a rollback or promotion between creating and claiming a job stops it before it acts.
   */
  assertHarnessDeployed(actor: ActorContext, jobId: string): Promise<void>;
  /** `JobRepository.finish` also accepts the caller's transaction, which lets a telemetry intent commit with the state. */
  finish(
    actor: ActorContext,
    lease: LeaseBinding,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outputRefs: string[],
    session?: ClientSession,
  ): Promise<void>;
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
  /**
   * Append that commits only while `holder` still owns the job (same owner and fence), checked in the same
   * transaction as the insert. A resumed zombie worker is refused with a `StaleFence` error. Absent: unfenced appends.
   */
  appendFenced?(
    key: ScopeKey,
    event: ProjectionEventInput,
    holder: { actor: ActorContext; lease: LeaseBinding },
  ): Promise<unknown>;
  /** True when the job's stream already holds a terminal event (job_failed or a status change to a terminal state). */
  hasTerminal?(key: ScopeKey, jobId: string): Promise<boolean>;
}

/** Recently finished jobs of the worker's scope, for repairing terminal projections lost to a crash. */
export interface TerminalSweep {
  listRecentTerminal(key: ScopeKey, limit: number): Promise<Job[]>;
}

export type LogEntry = {
  level: 'info' | 'warn' | 'error';
  message: string;
  jobId?: string;
  code?: string;
  /** Usage totals that could not be committed (the job was already terminal). Numbers only. */
  meter?: JsonValue;
};

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

export type JobRunResult = {
  jobId: string;
  outcome: JobOutcome;
  stats?: RunStats;
  reason?: string;
  /** The committed completion receipt this run's ending was decided on, when one exists. */
  receiptId?: string;
};

/**
 * The insert-only per-fence attestation store (`AttestationRepository` in @expunge/mongo, domain_executor INSERT only).
 * Structural so tests can fake it; the real repository satisfies it.
 */
export interface AttestationPort {
  record(
    actor: ActorContext,
    lease: LeaseBinding,
    attestation: {
      fence: number;
      source: string;
      provider: string;
      modelId: string;
      spec: string;
      /** Hash of the runtime this session loaded (`runtimeHash()`), part of the stamp: a differing value for the same fence conflicts. */
      runtimeHash: string;
      endpoint?: string;
      endpointHostHash?: string;
      at: Date;
    },
  ): Promise<unknown>;
}

export type DispatcherDeps = {
  jobs: DispatchJobs;
  resolver: JobResolver;
  artifacts: ArtifactReader;
  tools: ToolProvider;
  models: ModelResolver;
  receipts: CompletionReceiptReader;
  /** Authoritative per-fence model attestations. When set, a failed insert fails the session closed (the checkpoint copy is a convenience). */
  attestations?: AttestationPort;
  config: WorkerConfig;
  env?: ProviderEnv;
  projection?: ProjectionSink;
  /** Hash of the runtime bytes this process loaded (`runtimeHash()` from @expunge/runtime), written into each claimed run's checkpoint. */
  runtimeHash?: string;
  /** Enables the startup repair of terminal projections lost on a crash (needs `projection`). */
  terminalSweep?: TerminalSweep;
  /** Raindrop episodes. Optional and best effort: it never changes how a job runs or ends. */
  telemetry?: Telemetry;
  /** Confirms a success at read concern majority before it is reported to Raindrop; absent means unconfirmed reports. */
  committed?: CommittedReader;
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
  episode?: EpisodeHandle;
  /** Set when the telemetry intent already committed together with the job's terminal state. */
  telemetryRecorded: { value: boolean };
};

/** An error from the telemetry half of an atomic finish, so it can be told apart from the job layer's own. */
class TelemetryFailure extends Error {
  constructor(readonly original: unknown) {
    super('TelemetryFailure');
    this.name = 'TelemetryFailure';
  }
}

const statusEvent = (
  jobId: string,
  runId: string,
  attempt: number,
  to: 'succeeded' | 'cancelled' | 'queued' | WaitState,
  reason: string,
  from: 'running' | 'queued' = 'running',
): ProjectionEventInput => ({
  eventId: `${jobId}:status:${attempt}:${to}`,
  jobId,
  runId,
  artifactIds: [],
  kind: 'job_status_changed',
  payload: { from, to, reason },
});

const failedEvent = (jobId: string, runId: string, attempt: number, reason: string): ProjectionEventInput => {
  const code = projectionFailureCode(reason);
  return {
    eventId: `${jobId}:failed:${attempt}`,
    jobId,
    runId,
    artifactIds: [],
    kind: 'job_failed',
    payload: {
      code,
      retryable: code === 'provider_error' || code === 'lease_lost' || reason === 'ModelAttestationFailed',
      phase: null,
      message: reason.slice(0, 200),
    },
  };
};

/**
 * The terminal event a finished job should have in its stream, rebuilt from committed state only. The reason of a
 * failure comes from the terminal checkpoint the worker wrote before finishing, so a rebuilt event is byte-identical
 * to the original and a duplicate append is a no-op.
 */
export function terminalEventFor(job: Job): ProjectionEventInput | null {
  const { _id: jobId, attempt } = job;
  const runId = job.binding.runId;
  // The prior status is a committed fact only as far as the row shows it: a job that was ever claimed had been running;
  // one that never was (attempt 0, cancelled while queued) had been queued.
  const from = attempt > 0 ? 'running' : 'queued';
  switch (job.status) {
    case 'succeeded':
      return statusEvent(jobId, runId, attempt, 'succeeded', 'completion receipt committed', from);
    case 'cancelled':
      return statusEvent(jobId, runId, attempt, 'cancelled', 'cancellation requested', from);
    case 'failed': {
      const decision = (job.checkpoint as { terminal?: { decision?: { reason?: unknown } } } | null)?.terminal
        ?.decision;
      // No recorded reason is said so; the closed failure vocabulary maps it to internal_error, the message does not pretend.
      const reason = typeof decision?.reason === 'string' ? decision.reason : 'reason_unrecorded';
      return failedEvent(jobId, runId, attempt, reason);
    }
    default:
      return null;
  }
}

const scopeOf = (actor: ActorContext): ScopeKey => ({
  tenantId: actor.tenantId,
  env: actor.env,
  scopeId: actor.scopeId,
});
const MAX_CARRIERS = 256;
/** Telemetry faults are named by their class (never by message): `errorCode` would flatten them to a generic code. */
const faultName = (error: unknown): string => (error instanceof Error ? error.name : 'UnknownError');

/** Serializes checkpoint writes for one lease and merges state so every write is a complete snapshot. */
class CheckpointWriter {
  private state: Record<string, JsonValue>;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly jobs: DispatchJobs,
    private readonly actor: ActorContext,
    private readonly lease: LeaseBinding,
    /** The cumulative meter an earlier session committed (checkpoint.meter): kept in every snapshot, never reset. */
    priorMeter?: JsonValue,
    /** This build's observed runtime hash: kept in every snapshot, terminal included. */
    attestedRuntimeHash?: string,
    /** Model stamps earlier sessions committed (checkpoint.attestedModels): append-only, one per claiming fence. */
    priorModels?: JsonValue[],
  ) {
    this.state = {
      v: 1,
      ...(priorMeter !== undefined ? { meter: priorMeter } : {}),
      ...(attestedRuntimeHash ? { attestedRuntimeHash } : {}),
      ...(priorModels && priorModels.length > 0 ? { attestedModels: priorModels } : {}),
    };
  }
  /** The stamps this writer carries, for the append in onModelSelected. */
  get models(): JsonValue[] {
    return (this.state.attestedModels as JsonValue[] | undefined) ?? [];
  }
  update(patch: Record<string, JsonValue>, options: { revertOnFailure?: boolean } = {}): Promise<void> {
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    const snapshot = this.state;
    const write = this.chain.then(() => this.jobs.checkpoint(this.actor, this.lease, snapshot));
    this.chain = write.catch(() => undefined);
    // A write that did not commit must not leave its content in later snapshots (a stamp that was never stored).
    if (options.revertOnFailure)
      write.catch(() => {
        if (this.state === snapshot) this.state = previous;
      });
    return write;
  }
  replace(value: JsonValue): Promise<void> {
    // A full replacement (the terminal checkpoint) must not drop the job's meter or the attested runtime hash.
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const key of ['meter', 'attestedRuntimeHash', 'attestedModels'] as const)
        if (!(key in value) && key in this.state) value = { ...value, [key]: this.state[key] as JsonValue };
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
  /** Authenticated trace carriers from wakes, kept only until the job's run begins. */
  private readonly carriers = new Map<string, CarrierHeaders>();

  constructor(private readonly deps: DispatcherDeps) {}

  wake(command: WakeCommand, carrier?: CarrierHeaders | null): boolean {
    const fresh = !this.queue.includes(command.jobId) && !this.running.has(command.jobId);
    const accepted = this.enqueue(command.jobId);
    if (accepted && fresh && carrier) {
      this.carriers.set(command.jobId, carrier);
      if (this.carriers.size > MAX_CARRIERS) {
        const oldest = this.carriers.keys().next().value;
        if (oldest !== undefined) this.carriers.delete(oldest);
      }
    }
    return accepted;
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
    if (['succeeded', 'failed', 'cancelled'].includes(stored.status)) {
      await this.repairTerminalProjection(stored);
      return { jobId, outcome: 'terminal' };
    }

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
    const refusal = await this.refuseIfNotDeployed(actor, lease, claimed);
    if (refusal) return refusal;
    await this.project(
      actor,
      {
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
      },
      lease,
    );

    const carrier = this.carriers.get(jobId) ?? null;
    this.carriers.delete(jobId);
    const execute = (episode?: EpisodeHandle) => this.execute({ jobId, actor, lease, claimed }, episode);
    return this.deps.telemetry ? this.deps.telemetry.episode(claimed, carrier, execute) : execute();
  }

  /**
   * After the claim and before any model or tool call: the job's pinned harness must still be the deployed one. A refusal
   * is a committed failure (terminal checkpoint with the reason, job `failed`, no effects). Any other error from the check
   * hands the job back untouched, because "could not check" is not "not deployed".
   */
  private async refuseIfNotDeployed(
    actor: ActorContext,
    lease: LeaseBinding,
    claimed: Job,
  ): Promise<JobRunResult | null> {
    const { jobs } = this.deps;
    const jobId = lease.jobId;
    try {
      await jobs.assertHarnessDeployed(actor, jobId);
      return null;
    } catch (error) {
      if (errorCode(error) !== 'HarnessNotDeployed') {
        this.log({
          level: 'warn',
          message: 'deployment check failed; job handed back',
          jobId,
          code: errorCode(error),
        });
        await jobs.release(actor, lease).catch(() => undefined);
        return { jobId, outcome: 'released', reason: 'deployment_check_failed' };
      }
    }
    const meter = (claimed.checkpoint as { meter?: JsonValue } | null)?.meter;
    try {
      await jobs.checkpoint(actor, lease, {
        v: 1,
        ...(meter !== undefined ? { meter } : {}),
        ...(this.deps.runtimeHash ? { attestedRuntimeHash: this.deps.runtimeHash } : {}),
        terminal: {
          endedBy: 'refused_at_start',
          toolCalls: 0,
          phases: 0,
          elapsedMs: 0,
          decision: { status: 'failed', reason: 'HarnessNotDeployed' },
        },
      });
      await jobs.finish(actor, lease, 'failed', []);
    } catch (error) {
      this.log({
        level: 'error',
        message: 'could not finalize a refused job',
        jobId,
        code: errorCode(error),
      });
      return { jobId, outcome: 'unfinalized', reason: errorCode(error) };
    }
    this.log({
      level: 'warn',
      message: 'job refused: pinned harness is not the deployed one',
      jobId,
      code: 'HarnessNotDeployed',
    });
    await this.project(
      actor,
      failedEvent(jobId, claimed.binding.runId, claimed.attempt, 'HarnessNotDeployed'),
      lease,
    );
    return { jobId, outcome: 'failed', reason: 'HarnessNotDeployed' };
  }

  private async execute(
    ctx: { jobId: string; actor: ActorContext; lease: LeaseBinding; claimed: Job },
    episode?: EpisodeHandle,
  ): Promise<JobRunResult> {
    const { jobs, config } = this.deps;
    const { jobId, actor, lease, claimed } = ctx;
    // Defensive: onPhaseComplete already carries the meter, but a snapshot written before the first phase (or a
    // replace()) must never drop what an earlier session committed.
    const priorMeter = (claimed.checkpoint as { meter?: JsonValue } | null)?.meter;
    const priorModelsRaw = (claimed.checkpoint as { attestedModels?: unknown } | null)?.attestedModels;
    const priorModels = Array.isArray(priorModelsRaw) ? (priorModelsRaw as JsonValue[]) : undefined;
    const writer = new CheckpointWriter(jobs, actor, lease, priorMeter, this.deps.runtimeHash, priorModels);
    // Observed, not supplied by any caller: written at claim time so the run's committed checkpoint names the build.
    if (this.deps.runtimeHash) {
      try {
        await writer.update({});
      } catch (error) {
        this.log({ level: 'warn', message: 'attestation checkpoint failed', jobId, code: errorCode(error) });
      }
    }
    const attestedAt = new Date(); // fixed per session so an identical repeat insert is idempotent
    // Set when complete_cleanup's own transaction committed the terminal state (and released the lease): from then on nothing
    // may renew or write under that lease, and the stale-lease errors that follow are expected, not faults.
    let terminalReached = false;
    let stopHeartbeat: () => void = () => undefined;
    const hooks: ExecutionHooks = {
      // Written by the worker only, from what the runtime resolved (never from the profile or a caller). APPEND-ONLY:
      // one entry per claiming session, carrying its lease fence, so a takeover with another model leaves two stamps and
      // never silently replaces the first. FAIL CLOSED: a write failure propagates and the runtime ends the session with
      // ModelAttestationFailed before any model call (retryable); the earlier sessions' stamps stay as they were.
      onModelSelected: async (attestation) => {
        const entry = { fence: lease.fence, ...attestation } as unknown as JsonValue;
        const existing = writer.models;
        const sameFence = existing.some((e) => (e as { fence?: unknown } | null)?.fence === lease.fence);
        try {
          // Authoritative, insert-only row first (a fenced-out holder cannot write it), then the checkpoint copy.
          if (this.deps.attestations) {
            // The runtime hash is part of the stamp and is written in the SAME insert as the model: without it there is no
            // truthful stamp, so the session ends before any model call (fail closed).
            const attested = this.deps.runtimeHash;
            if (!attested || !/^[0-9a-f]{64}$/.test(attested)) throw new Error('RuntimeHashUnavailable');
            await this.deps.attestations.record(actor, lease, {
              fence: lease.fence,
              ...attestation,
              runtimeHash: attested,
              at: attestedAt,
            });
          }
          await writer.update(
            { attestedModels: sameFence ? existing : [...existing, entry] },
            { revertOnFailure: true },
          );
        } catch (error) {
          this.log({
            level: 'warn',
            message: 'model attestation checkpoint failed; the session ends before any model call',
            jobId,
            code: errorCode(error),
          });
          throw error;
        }
      },
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
            ...(info.meter ? { meter: info.meter as unknown as JsonValue } : {}),
          });
        } catch (error) {
          // complete_cleanup commits the receipt AND the terminal job state in one transaction, so the
          // checkpoint after it legitimately finds no live lease. Re-read: a terminal job ends the run normally.
          if (errorCode(error) === 'LostLease') {
            const now = await jobs.readAuthorized(actor, jobId).catch(() => null);
            if (now && ['succeeded', 'failed', 'cancelled'].includes(now.status)) {
              terminalReached = true;
              stopHeartbeat(); // the lease is gone with the terminal transaction: stop renewing it
              if (info.meter)
                this.log({
                  level: 'info',
                  message: 'final meter not persisted: the terminal transaction already closed the lease',
                  jobId,
                  meter: info.meter as unknown as JsonValue,
                });
              return 'stop';
            }
          }
          throw error;
        }
        return 'continue';
      },
      // Cumulative job usage, written while the lease is still held so a takeover starts from the committed totals.
      onMeter: async (carry) => {
        if (terminalReached) {
          // Expected after complete_cleanup: a fenced write would fail LostLease. The totals are logged, not committed.
          this.log({
            level: 'info',
            message: 'final meter not persisted: the job is already terminal',
            jobId,
            meter: carry as unknown as JsonValue,
          });
          return;
        }
        await writer.update({ meter: carry as unknown as JsonValue });
      },
      onHookError: (hook, error) =>
        this.log({ level: 'warn', message: `hook ${hook} failed`, jobId, code: errorCode(error) }),
    };

    const agent = new ExpungeExecutionAgent(
      {
        jobs,
        artifacts: this.deps.artifacts,
        tools: episode ? episode.tools(this.deps.tools) : this.deps.tools,
        models: this.deps.models,
        receipts: this.deps.receipts,
        hooks,
        env: this.deps.env,
        phaseTimeoutMs: config.phaseTimeoutMs,
        requirePricing: config.requirePricing,
        toolDrainMs: config.toolDrainMs,
        ...(episode ? { chatMiddleware: episode.chatMiddleware() } : {}),
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
        .catch(async (error) => {
          if (terminalReached) return; // our own terminal transaction released the lease: expected, not a failure
          // The terminal transaction can land between two heartbeats and before the phase hook notices: a renewal refused on
          // a job that is now terminal is the same expected case.
          const now = await jobs.readAuthorized(actor, jobId).catch(() => null);
          if (now && ['succeeded', 'failed', 'cancelled'].includes(now.status)) {
            terminalReached = true;
            stopHeartbeat();
            return;
          }
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

    stopHeartbeat = () => clearInterval(heartbeat);
    let runErrorCode: string | undefined;
    const runModel = async () => {
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
    };
    // Subscribing inside the episode's context is what parents the model and tool spans to the episode.
    if (episode) await episode.run(runModel);
    else await runModel();

    try {
      const stats: RunStats = (await agent.settled()) ?? {
        endedBy: aborting ? 'aborted' : 'error',
        ...(runErrorCode ? { errorCode: runErrorCode } : {}),
        toolCalls: 0,
        phases: 0,
        elapsedMs: 0,
        release: 'none',
      };
      return await this.finalize({
        jobId,
        actor,
        lease,
        claimed,
        stats,
        writer,
        renewalFailed,
        ...(episode ? { episode } : {}),
        telemetryRecorded: { value: false },
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async finalize(input: FinalizeInput): Promise<JobRunResult> {
    const result = await this.finalizeState(input);
    await this.projectOutcome(input, result);
    await this.recordEpisode(input, result);
    return result;
  }

  /**
   * Telemetry after the job's committed outcome: the read-back intent (unless it already committed with the terminal
   * state) and then the terminal Raindrop event. Both are best effort and can never change the result.
   */
  private async recordEpisode(input: FinalizeInput, result: JobRunResult): Promise<void> {
    const { episode } = input;
    const telemetry = this.deps.telemetry;
    if (!episode || !telemetry) return;
    let outcome = result.outcome;
    if (outcome === 'succeeded' && this.deps.committed) {
      // Under-claim rather than over-claim: a success that cannot be confirmed as majority-committed is `aborted`.
      const confirmed = await this.deps.committed
        .confirmSucceeded(input.actor, input.jobId, result.receiptId)
        .catch(() => false);
      if (!confirmed) {
        outcome = 'unfinalized';
        this.log({
          level: 'warn',
          message: 'success not confirmed as majority-committed; reported as aborted',
          jobId: input.jobId,
        });
      }
    }
    const facts: OutcomeFacts = {
      outcome,
      stats: result.stats ?? input.stats,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.receiptId ? { receiptId: result.receiptId } : {}),
    };
    if (!input.telemetryRecorded.value) {
      try {
        // Not atomic with the job transition on this path (see finishJob); the operation id makes it idempotent.
        await telemetry.enqueue(scopeOf(input.actor), episode.intent(facts));
      } catch (error) {
        this.log({
          level: 'warn',
          message: 'telemetry intent not recorded',
          jobId: input.jobId,
          code: faultName(error),
        });
      }
    }
    await episode.complete(facts);
  }

  /**
   * Ends the job. When telemetry can share a transaction, the read-back intent commits or aborts together with the
   * terminal state. A telemetry failure inside that transaction never strands the job: the finish is retried plainly.
   */
  private async finishJob(
    input: FinalizeInput,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outputRefs: string[],
    facts: OutcomeFacts,
  ): Promise<void> {
    const { jobs, telemetry } = this.deps;
    const { actor, lease, episode } = input;
    if (episode && telemetry?.atomically) {
      try {
        await telemetry.atomically(async (session) => {
          await jobs.finish(actor, lease, status, outputRefs, session);
          try {
            await telemetry.enqueue(scopeOf(actor), episode.intent(facts), session);
          } catch (error) {
            throw new TelemetryFailure(error);
          }
        });
        input.telemetryRecorded.value = true;
        return;
      } catch (error) {
        if (!(error instanceof TelemetryFailure)) throw error;
        this.log({
          level: 'warn',
          message: 'telemetry intent could not commit with the job state; finishing without it',
          jobId: input.jobId,
          code: faultName(error.original),
        });
      }
    }
    await jobs.finish(actor, lease, status, outputRefs);
  }

  /**
   * Appends one sanitized event. With a `lease` the append is fenced when the sink supports it: a worker that lost
   * the job (a zombie resumed after takeover) cannot add events to its stream.
   */
  private async project(
    actor: ActorContext,
    event: ProjectionEventInput,
    lease?: LeaseBinding,
  ): Promise<void> {
    const sink = this.deps.projection;
    if (!sink) return;
    const key = scopeOf(actor);
    try {
      if (lease && sink.appendFenced) await sink.appendFenced(key, event, { actor, lease });
      else await sink.append(key, event);
    } catch (error) {
      const code = errorCode(error);
      // TerminalExists after our own terminal write (complete_cleanup's transaction already appended the terminal event) is the
      // expected duplicate, not an error.
      const expected = code === 'TerminalExists';
      this.log({
        level: expected ? 'info' : 'warn',
        message: expected
          ? 'terminal event already present (our own terminal write)'
          : code === 'StaleFence'
            ? 'projection refused: lease no longer held'
            : 'projection append failed',
        jobId: event.jobId,
        code,
      });
    }
  }

  /**
   * Re-emits the terminal projection event of a job that is already terminal, from committed state only. A crash
   * between the terminal transition and its event leaves the stream behind the job; event ids are deterministic, so
   * this is idempotent. Never fenced: it states what is committed, it does not act for a lease.
   */
  async repairTerminalProjection(job: Job): Promise<boolean> {
    const sink = this.deps.projection;
    if (!sink) return false;
    const event = terminalEventFor(job);
    if (!event) return false;
    const key = scopeOf(job.actor);
    try {
      if (sink.hasTerminal && (await sink.hasTerminal(key, job._id))) return false;
      await sink.append(key, event);
      this.log({
        level: 'info',
        message: 'terminal projection repaired from committed state',
        jobId: job._id,
      });
      return true;
    } catch (error) {
      this.log({
        level: 'warn',
        message: 'terminal projection repair failed',
        jobId: job._id,
        code: errorCode(error),
      });
      return false;
    }
  }

  /**
   * Startup sweep: repairs the terminal projection of recently finished jobs in the worker's scope. Disclosed limits: only
   * a bounded window of recent terminal jobs (pollBatch * 4, newest first) and only the configured scope; an older or
   * out-of-scope job is repaired when a wake for it arrives.
   */
  async repairTerminalProjections(): Promise<number> {
    const { terminalSweep, projection } = this.deps;
    const { scope, pollBatch } = this.deps.config;
    if (!terminalSweep || !projection || !scope) return 0;
    let repaired = 0;
    try {
      for (const job of await terminalSweep.listRecentTerminal(scope, pollBatch * 4))
        if (await this.repairTerminalProjection(job)) repaired++;
    } catch (error) {
      this.log({ level: 'warn', message: 'terminal projection sweep failed', code: errorCode(error) });
    }
    return repaired;
  }

  /** Committed-state facts only; the model's stream and narrative never become projection events here. */
  private async projectOutcome(input: FinalizeInput, result: JobRunResult): Promise<void> {
    const { jobId, actor, claimed, stats, lease } = input;
    const status = (to: 'succeeded' | 'cancelled' | 'queued' | WaitState, reason: string) =>
      this.project(actor, statusEvent(jobId, claimed.binding.runId, claimed.attempt, to, reason), lease);
    switch (result.outcome) {
      case 'failed':
        await this.project(
          actor,
          failedEvent(jobId, claimed.binding.runId, claimed.attempt, result.reason ?? 'internal_error'),
          lease,
        );
        return;
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
    const done = (result: JobRunResult): JobRunResult =>
      receipt ? { ...result, receiptId: receipt.receiptId } : result;
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
      return done({ jobId, outcome, stats, reason: action.reason });
    }
    try {
      await writer.replace(terminalCheckpoint(stats, action));
      try {
        await this.finishJob(input, action.status, action.outputRefs, {
          outcome: action.status,
          stats,
          reason: action.reason,
          ...(receipt ? { receiptId: receipt.receiptId } : {}),
        });
        this.log({ level: 'info', message: `job finished: ${action.status}`, jobId, code: action.reason });
        return done({ jobId, outcome: action.status, stats, reason: action.reason });
      } catch (error) {
        // The repository refuses `succeeded` without a verifiable receipt; downgrade rather than strand the job.
        if (action.status === 'succeeded' && errorCode(error) === 'CompletionReceiptRequired') {
          await this.finishJob(input, 'failed', action.outputRefs, {
            outcome: 'failed',
            stats,
            reason: 'CompletionReceiptRequired',
            ...(receipt ? { receiptId: receipt.receiptId } : {}),
          });
          return done({ jobId, outcome: 'failed', stats, reason: 'CompletionReceiptRequired' });
        }
        throw error;
      }
    } catch (error) {
      this.log({ level: 'error', message: 'could not finalize job', jobId, code: errorCode(error) });
      return { jobId, outcome: 'unfinalized', stats, reason: errorCode(error) };
    }
  }
}
