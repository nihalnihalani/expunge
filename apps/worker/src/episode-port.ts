import {
  contentHash,
  type ActorContext,
  type CompletionReceipt,
  type CostSummary,
  type HarnessBundle,
  type Job,
  type ResourceLimits,
  type RunBinding,
  type WorldSpec,
} from '@expunge/contracts';
import type { ToolProvider } from '@expunge/runtime';
import type { JobRunResult } from './dispatch.js';
import type { WakeCommand } from './wake.js';

/**
 * Worker side of the worker-backed EpisodePort for the gate's fixed-world campaigns (the gate-side port is `kind: 'worker'` and
 * delegates `run` here). A run is a REAL cleanup job pinned to the candidate bundle, executed by the real Dispatcher with
 * the real domain tools, in a world instance of its own. What the grader receives is read back from COMMITTED state at
 * read concern majority: the job row, the completion receipt, the effects and the world. The model's narrative is never
 * read. The model itself is whatever the injected worker was built with (a FAKE model in tests: protocol evidence only).
 */

export type RunOutcome = 'completed' | 'incomplete' | 'refused' | 'failed' | 'cancelled' | 'timed_out';

export type EpisodeRequest = {
  campaignId: string;
  runId: string;
  instanceId: string;
  bundle: HarnessBundle;
  bundleHash: string;
  profile: { profileId: string; modelId: string; modelKind: 'fake' | 'provider'; params: unknown };
  limits: ResourceLimits;
  /**
   * The fault plan the TRIAL declares. The worker does not read it: faults are injected only by the domain gateway, from
   * the plan stored for the world (`world_faults`), attested in the fenced step log. Kept so callers can compare it.
   */
  faults: WorldSpec['faults'];
  signal: AbortSignal;
};

export type TrustedReceiptEvidence = {
  receipt: CompletionReceipt;
  binding: RunBinding;
  currentWorldRevision: number;
  committedReceiptHash: string;
};

export type EpisodeResult = {
  outcome: RunOutcome;
  failureCode?: string;
  jobId?: string;
  terminal: { status: 'complete' | 'incomplete' | 'refused'; claim: 'all_targets' | 'registered_scope' };
  runtimeHash?: string;
  receipt?: TrustedReceiptEvidence;
  retryFailures: number;
  cost: CostSummary;
};

/** A world instance the host created and the job-creating identity for it. */
export type SeededInstance = {
  actor: ActorContext;
  worldId: string;
  collectionIds: string[];
  scopeRevision: number;
  subjectHandle: string;
};

/**
 * The privileged half: everything that needs more rights than the worker has (installing authority, writing a world,
 * creating a job, reading the world back). Mongo implementation: `MongoEpisodeJobHost` (episode-host.ts).
 */
export interface EpisodeJobHost {
  /** Stores the bundle as a permitted artifact of the instance's scope. Throws if it does not hash to `bundleHash`. */
  pinBundle(instance: SeededInstance, bundle: HarnessBundle, bundleHash: string): Promise<void>;
  /** Creates the queued cleanup job (and its subject) bound to the pinned bundle and this run id. */
  createJob(
    instance: SeededInstance,
    job: { jobId: string; binding: Omit<RunBinding, 'jobId'> },
    subjectHandle: string,
  ): Promise<void>;
}

/** What committed state says about one job. Majority reads; nothing the model said. */
export type CommittedEpisode = {
  job: Job;
  receipt: CompletionReceipt | null;
  worldRevision: number;
  /** Batches of the job's latest plan, and how many of them have a committed effect. */
  plannedBatches: number;
  committedBatches: number;
};
export interface EpisodeEvidence {
  read(instance: SeededInstance, jobId: string, runId: string): Promise<CommittedEpisode | null>;
}

/** The slice of Dispatcher a session uses. A fresh one is built per session so a restart is a real restart. */
export interface EpisodeWorker {
  wake(command: WakeCommand): boolean;
  idle(): Promise<void>;
  stop(): Promise<void>;
}
export type EpisodeWorkerFactory = (deps: {
  tools: (base: ToolProvider) => ToolProvider;
  onResult: (result: JobRunResult) => void;
  session: number;
}) => EpisodeWorker;

export type WorkerEpisodeRunnerOptions = {
  host: EpisodeJobHost;
  evidence: EpisodeEvidence;
  /** Builds the worker; `tools(base)` receives the real tool provider and must return it unwrapped (no fault layer here). */
  workerFactory: EpisodeWorkerFactory;
  /** The domain tool provider the worker uses (not wrapped). */
  baseTools: ToolProvider;
  /** Worker sessions per run (a restart after the gateway's stored-plan interruption is one more). */
  maxSessions?: number;
};

const zeroCost = (): CostSummary => ({
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicrousd: 0,
  unpricedCalls: 0,
  mongoOperations: 0,
  wallTimeMs: 0,
});

const failed = (code: string, jobId?: string, over: Partial<EpisodeResult> = {}): EpisodeResult => ({
  outcome: 'failed',
  failureCode: code,
  ...(jobId ? { jobId } : {}),
  terminal: { status: 'incomplete', claim: 'registered_scope' },
  retryFailures: 0,
  cost: zeroCost(),
  ...over,
});

const sameLimits = (a: ResourceLimits, b: ResourceLimits) =>
  contentHash(a as never, 'resource-limits') === contentHash(b as never, 'resource-limits');

/** The cumulative cost of a job from its durable checkpoint: the meter (all sessions) plus the tool-call count. */
export function costOf(job: Job, committedBatches: number): CostSummary {
  const checkpoint = (job.checkpoint ?? {}) as {
    meter?: Partial<Record<string, number>>;
    toolCalls?: number;
    terminal?: { toolCalls?: number };
  };
  const meter = checkpoint.meter ?? {};
  const n = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    modelCalls: n(meter.modelCalls),
    toolCalls: Math.max(n(checkpoint.terminal?.toolCalls), n(checkpoint.toolCalls)),
    inputTokens: n(meter.inputTokens),
    outputTokens: n(meter.outputTokens),
    costMicrousd: n(meter.costMicrousd),
    unpricedCalls: n(meter.unpricedCalls),
    // One committed batch is one transactional effect write; that is the Mongo work the grader can attribute.
    mongoOperations: committedBatches,
    wallTimeMs: n(meter.wallTimeMs),
  };
}

export class WorkerEpisodeRunner {
  constructor(private readonly options: WorkerEpisodeRunnerOptions) {}

  /**
   * The worker-side half of an EpisodePort `run`: submit the cleanup job against an already seeded instance and await
   * its committed outcome. The gate-side port seeds and resets the world (fixture_builder) and reads it back for
   * grading; none of that is in the worker.
   */
  async run(request: EpisodeRequest, instance: SeededInstance): Promise<EpisodeResult> {
    // Limits come only from the pinned bundle; a request that disagrees with it is refused, not silently re-limited.
    if (!sameLimits(request.limits, request.bundle.limits)) return failed('LimitsMismatch');
    const { host, evidence } = this.options;
    const jobId = `ep_${contentHash({ runId: request.runId, instanceId: request.instanceId }, 'episode-job').slice(0, 40)}`;
    try {
      await host.pinBundle(instance, request.bundle, request.bundleHash);
      await host.createJob(
        instance,
        {
          jobId,
          binding: {
            runId: request.runId,
            worldId: instance.worldId,
            harnessHash: request.bundleHash,
            scopeRevision: instance.scopeRevision,
            workerProfileHash: contentHash(request.profile as never, 'worker-profile'),
          },
        },
        instance.subjectHandle,
      );
    } catch (error) {
      return failed(error instanceof Error ? error.name : 'SetupFailed', jobId);
    }

    const sessions = await this.sessions(jobId, request, instance);
    const committed = await evidence.read(instance, jobId, request.runId).catch(() => null);
    if (!committed) return failed('CommittedStateUnreadable', jobId);
    return this.resultFrom(request, committed, sessions);
  }

  /**
   * Runs worker sessions until the job is no longer handed back. Returns the number of sessions used. The worker injects
   * NO faults: a stored plan's interruption is spent by the domain gateway, which releases the lease, so the dispatcher
   * reports the session as `lost_lease`; that, and only that, starts a new session (a real restart: the job is claimed
   * again under a new fence). Anything else, including exhausting `maxSessions`, ends the loop and is read from
   * committed state (`SessionsExhausted` when the job is still not terminal).
   */
  private async sessions(jobId: string, request: EpisodeRequest, _seeded: SeededInstance): Promise<number> {
    const max = this.options.maxSessions ?? 3;
    let current: EpisodeWorker | undefined;
    const onAbort = () => void current?.stop();
    request.signal.addEventListener('abort', onAbort, { once: true });
    let used = 0;
    try {
      for (let session = 1; session <= max; session++) {
        if (request.signal.aborted) break;
        let result: JobRunResult | undefined;
        current = this.options.workerFactory({
          tools: (base) => base,
          onResult: (r) => void (result = r),
          session,
        });
        used = session;
        current.wake({ jobId, commandId: `episode-${jobId}-${session}-0000` } as WakeCommand);
        await current.idle();
        if (result?.outcome !== 'lost_lease') break;
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
    }
    return used;
  }

  private resultFrom(request: EpisodeRequest, committed: CommittedEpisode, sessions: number): EpisodeResult {
    const { job, receipt } = committed;
    const retryFailures = Math.max(0, committed.plannedBatches - committed.committedBatches);
    const attestedValue = (job.checkpoint as { attestedRuntimeHash?: unknown } | null)?.attestedRuntimeHash;
    const attested =
      typeof attestedValue === 'string' && /^[0-9a-f]{64}$/.test(attestedValue) ? attestedValue : null;
    const base = {
      jobId: job._id,
      retryFailures,
      cost: costOf(job, committed.committedBatches),
      // OBSERVED, not supplied: the worker wrote its own loaded-bytes hash into the run's checkpoint when it claimed it.
      ...(attested ? { runtimeHash: attested } : {}),
    };
    const reason = (job.checkpoint as { terminal?: { decision?: { reason?: unknown } } } | null)?.terminal
      ?.decision?.reason;
    const decided = typeof reason === 'string' ? reason : null;
    if (job.status === 'cancelled')
      return { ...base, outcome: 'cancelled', failureCode: 'RunCancelled', terminal: incomplete() };
    if (job.status === 'succeeded' && receipt) {
      const evidence: TrustedReceiptEvidence = {
        receipt,
        binding: { ...job.binding },
        currentWorldRevision: committed.worldRevision,
        committedReceiptHash: contentHash(receipt as never, 'completion-receipt'),
      };
      return {
        ...base,
        outcome: 'completed',
        terminal: { status: 'complete', claim: 'registered_scope' },
        receipt: evidence,
      };
    }
    if (job.status === 'failed' && receipt)
      // The worker committed a receipt that does not claim completion: an honest incomplete terminal.
      return {
        ...base,
        outcome: 'incomplete',
        failureCode: decided ?? 'incomplete_receipt',
        terminal: incomplete(),
      };
    if (job.status === 'failed')
      return { ...base, outcome: 'failed', failureCode: decided ?? 'JobFailed', terminal: incomplete() };
    // Still queued, running or waiting after all sessions: not a result.
    return {
      ...base,
      outcome: 'failed',
      failureCode: sessions >= (this.options.maxSessions ?? 3) ? 'SessionsExhausted' : 'NotTerminal',
      terminal: incomplete(),
    };
  }
}

const incomplete = (): EpisodeResult['terminal'] => ({ status: 'incomplete', claim: 'registered_scope' });
