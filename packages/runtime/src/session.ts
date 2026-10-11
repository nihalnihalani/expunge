import { createHash, randomUUID } from 'node:crypto';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import type { HarnessBundle, Job, ScopeKey } from '@expunge/contracts';
import { tanstackAgent, type TanStackAgent, type ToolDefinition } from '@expunge/vendor-openmuse';
import type { Subscriber, Subscription } from 'rxjs';
import { filterModelStateEvent, stripProtectedKeys } from './authority.js';
import { RuntimeError, JobWaitSignal, errorCode, isFenceLoss, type RuntimeErrorCode } from './errors.js';
import { releaseLease } from './lease-release.js';
import { defaultWorkerPrompt } from './prompt.js';
import type {
  ExecutionBinding,
  ExecutionDependencies,
  PhaseInfo,
  RunEnd,
  RunStats,
  WaitStatus,
} from './ports.js';

export const STEP_LIMIT_NOTE =
  'The step limit for this run was reached before the job finished. The job has not been completed.';
const DEFAULT_PHASE_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_DRAIN_MS = 5_000;
const PAUSED = (reason: string) => ({
  status: 'paused',
  reason,
  note: 'The job is paused, waiting or over budget; do not perform more actions.',
});

/**
 * One execution of `ExpungeExecutionAgent.run`. Everything here derives authority from the STORED job
 * (read through the trusted `JobPort` with the dispatcher's actor and lease) and the pinned bundle it
 * names. Nothing from the AG-UI input (state, context, forwardedProps, system messages, client tools)
 * selects the harness, actor, scope or tools.
 */
export class RunSession {
  readonly controller = new AbortController();
  settled: Promise<RunStats> = Promise.resolve({
    endedBy: 'aborted',
    toolCalls: 0,
    phases: 0,
    elapsedMs: 0,
    release: 'none',
  });

  private inner?: TanStackAgent;
  private innerSubscription?: Subscription;
  private wallTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private phaseTimeoutMs = DEFAULT_PHASE_TIMEOUT_MS;
  private wallDeadline = Infinity;
  private activeTools = 0;
  private toolCalls = 0;
  private phases = 0;
  private readonly startedAt = Date.now();
  private stopRequested = false;
  private failure?: { code: string; end: RunEnd };
  private wait?: WaitStatus;
  private abortedByCaller = false;
  private runStartedEmitted = false;
  private innerFinished = false;
  private finalized = false;
  private torn = false;
  private maxSteps = 1;
  private bundle?: HarnessBundle;
  private job?: Job;
  private usage: unknown;
  private stepLimitReached = false;
  private stepLimitNoteExpected = false;
  /** In-flight tool executions (the tool's own promise, not the bounded wrapper). R2: awaited before the lease is released. */
  private readonly executions = new Set<Promise<unknown>>();
  private readonly narrative = createHash('sha256');
  private narrativeLength = 0;
  private readonly recorded = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: ExecutionDependencies,
    private readonly binding: ExecutionBinding,
    private readonly input: RunAgentInput,
    private readonly subscriber: Subscriber<BaseEvent>,
  ) {}

  /** Starts the run. Never throws: every failure becomes a sanitized RUN_ERROR. */
  async start(): Promise<void> {
    try {
      const job = await this.deps.jobs.readAuthorized(this.binding.actor, this.binding.lease.jobId);
      this.assertHoldsLease(job);
      this.job = job;
      const bundle = await this.loadBundle(job);
      this.bundle = bundle;
      this.maxSteps = Math.max(1, bundle.limits.modelCalls);
      this.phaseTimeoutMs = Math.max(
        1,
        Math.min(this.deps.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS, bundle.limits.wallTimeMs),
      );
      this.wallDeadline = this.startedAt + bundle.limits.wallTimeMs;
      this.wallTimer = setTimeout(
        () => this.fail('WallTimeExceeded', 'wall_time'),
        Math.max(1, bundle.limits.wallTimeMs),
      );
      await this.recordContextInputs(this.bundleContextHashes(job, bundle));
      if (this.stopping) return this.finish();

      const granted = new Set(bundle.toolPolicy.grants);
      let provided: ToolDefinition[];
      try {
        provided = await this.deps.tools.create({
          job,
          bundle,
          actor: this.binding.actor,
          lease: this.binding.lease,
          signal: this.controller.signal,
          recordContextInput: (hash) => this.recordContextInputs([hash], true),
        });
      } catch (error) {
        if (isFenceLoss(error)) throw error;
        throw new RuntimeError('ToolsUnavailable', { cause: error });
      }
      const tools: ToolDefinition[] = [];
      for (const tool of provided) {
        if (granted.has(tool.name)) tools.push(this.guard(tool, bundle));
        else this.deps.hooks?.onSecurityEvent?.({ kind: 'tool_not_granted', toolId: tool.name });
      }

      let selection: ReturnType<ExecutionDependencies['models']['select']>;
      try {
        selection = this.deps.models.select(job, bundle);
      } catch (error) {
        throw new RuntimeError('ModelUnavailable', { cause: error });
      }
      this.inner = tanstackAgent({
        model: selection.spec,
        textAdapter: selection.textAdapter,
        env: this.deps.env,
        maxSteps: this.maxSteps,
        tools,
        prompt: (this.deps.prompt ?? defaultWorkerPrompt)(job, bundle),
        shouldContinue: () => !this.stopping,
        stepLimitNote: STEP_LIMIT_NOTE,
        // Out of band: fires from the vendored helper only when the step limit ended the run. Model text can't forge it.
        onStepLimit: () => {
          this.stepLimitReached = true;
          this.stepLimitNoteExpected = true;
        },
        clientToolAllowlist: this.deps.clientToolAllowlist ?? [],
        stateTools: this.deps.modelStateTools ?? true,
      });
      if (this.stopping) return this.finish();

      this.armWatchdog();
      this.innerSubscription = this.inner.run(this.scopedInput()).subscribe({
        next: (event) => this.enqueue(() => this.onInnerEvent(event)),
        error: (error) => {
          this.fail(
            error instanceof Error && error.name === 'MissingProviderCredentialError'
              ? 'ModelUnavailable'
              : 'ModelRunFailed',
            'error',
          );
          this.enqueue(() => this.finish());
        },
        complete: () => this.enqueue(() => this.finish()),
      });
    } catch (error) {
      this.failFrom(error);
      this.enqueue(() => this.finish());
    }
  }

  /** Caller-requested stop (AbstractAgent.abortRun). Completes silently like BuiltInAgent does. */
  abort(): void {
    this.abortedByCaller = true;
    this.stopRequested = true;
    this.controller.abort();
    this.inner?.abortRun();
  }

  /** Observable teardown. Synchronous and idempotent; the lease release runs in the background. */
  teardown(): void {
    if (this.torn) return;
    this.torn = true;
    clearTimeout(this.wallTimer);
    clearTimeout(this.watchdog);
    this.controller.abort();
    this.inner?.abortRun();
    this.innerSubscription?.unsubscribe();
    this.settled = this.releaseAndSummarize();
  }

  private get stopping(): boolean {
    return this.stopRequested || this.controller.signal.aborted;
  }

  private assertHoldsLease(job: Job): void {
    const { lease } = this.binding;
    if (job.binding.jobId !== lease.jobId) throw new RuntimeError('LostLease');
    if (job.cancellationRequested) throw new RuntimeError('JobCancelled');
    if (job.status !== 'running' || job.lease.ownerId !== lease.ownerId || job.lease.fence !== lease.fence)
      throw new RuntimeError('LostLease');
  }

  private async loadBundle(job: Job): Promise<HarnessBundle> {
    const key: ScopeKey = { tenantId: job.actor.tenantId, env: job.actor.env, scopeId: job.actor.scopeId };
    let bundle: HarnessBundle;
    try {
      const envelope = await this.deps.artifacts.readPermitted(key, job.binding.harnessHash);
      if (envelope._id !== job.binding.harnessHash) throw new Error('hash');
      bundle = envelope.payload;
    } catch (error) {
      if (isFenceLoss(error)) throw error;
      throw new RuntimeError('HarnessUnavailable', { cause: error });
    }
    if (bundle.target !== 'worker') throw new RuntimeError('HarnessTargetMismatch');
    return bundle;
  }

  /** Every artifact/evidence hash this run's context is built from, known before the first prompt. */
  private bundleContextHashes(job: Job, bundle: HarnessBundle): string[] {
    return [
      job.binding.harnessHash,
      ...bundle.evidence.map((evidence) => evidence.contentHash),
      ...bundle.pluginArtifacts.flatMap((plugin) => [plugin.sourceHash, plugin.compiledHash]),
    ];
  }

  private async recordContextInputs(hashes: string[], rethrow = false): Promise<void> {
    const fresh = [...new Set(hashes)].filter((hash) => !this.recorded.has(hash));
    if (fresh.length === 0) return;
    try {
      await this.deps.hooks?.onContextInputs?.(fresh);
      for (const hash of fresh) this.recorded.add(hash);
    } catch (error) {
      if (isFenceLoss(error)) {
        this.fail('LostLease', 'lost_lease');
        if (rethrow) throw error;
        return;
      }
      if (rethrow) throw error;
      this.fail('ContextInputRejected', 'error');
    }
  }

  private scopedInput(): RunAgentInput {
    const state = stripProtectedKeys(this.input.state ?? {});
    if (state.removed.length)
      this.deps.hooks?.onSecurityEvent?.({
        kind: 'protected_state_ignored',
        source: 'input_state',
        paths: state.removed,
      });
    const systemMessages = this.input.messages.filter(
      (message) => message.role === 'system' || message.role === 'developer',
    ).length;
    const allowed = new Set(this.deps.clientToolAllowlist ?? []);
    const clientTools = (this.input.tools ?? []).filter((tool) => !allowed.has(tool.name)).length;
    if (systemMessages || clientTools)
      this.deps.hooks?.onSecurityEvent?.({ kind: 'client_input_dropped', systemMessages, clientTools });
    return {
      ...this.input,
      state: state.value ?? {},
      // Authority-shaped client properties never reach the inner agent.
      forwardedProps: {},
    };
  }

  private guard(tool: ToolDefinition, bundle: HarnessBundle): ToolDefinition {
    const execute = tool.execute;
    if (!execute) throw new Error(`Server tool has no executor: ${tool.name}`);
    return {
      ...tool,
      execute: async (args) => {
        if (this.stopping) return PAUSED('stopped');
        if (this.toolCalls >= bundle.limits.toolCalls) {
          this.fail('ToolCallBudgetExceeded', 'tool_budget');
          return { error: 'ToolCallBudgetExceeded' };
        }
        this.toolCalls++;
        const phase = ++this.phases;
        const started = Date.now();
        this.activeTools++;
        clearTimeout(this.watchdog);
        let outcome: PhaseInfo['outcome'] = 'ok';
        let result: unknown;
        const execution = Promise.resolve().then(() => execute(args as never));
        this.executions.add(execution);
        const forget = () => void this.executions.delete(execution);
        execution.then(forget, forget);
        try {
          result = await this.boundedPhase(execution);
        } catch (error) {
          outcome = 'tool_error';
          if (error instanceof JobWaitSignal) {
            this.requestWait(error.status);
            outcome = 'ok';
            result = PAUSED(error.status);
          } else if (isFenceLoss(error)) {
            this.fail('LostLease', 'lost_lease');
            result = { error: 'LostLease' };
          } else if (error instanceof RuntimeError) {
            result = { error: error.code };
          } else {
            this.deps.hooks?.onHookError?.(`tool:${tool.name}`, error);
            const code = errorCode(error);
            result = { error: code === 'Error' ? 'ToolFailed' : code };
          }
        } finally {
          this.activeTools--;
        }
        try {
          const verdict = await this.deps.hooks?.onPhaseComplete?.({
            phase,
            toolId: tool.name,
            toolCalls: this.toolCalls,
            outcome,
            elapsedMs: Date.now() - started,
          });
          if (verdict === 'stop') this.stopRequested = true;
        } catch (error) {
          if (isFenceLoss(error)) this.fail('LostLease', 'lost_lease');
          else this.fail('PhaseHookFailed', 'error');
          result = { error: 'PhaseHookFailed' };
        }
        if (this.activeTools === 0) this.armWatchdog();
        return result;
      },
    };
  }

  /** Races one tool phase against the phase bound, the remaining wall time and run cancellation. */
  private boundedPhase<T>(work: Promise<T>): Promise<T> {
    const limit = Math.max(1, Math.min(this.phaseTimeoutMs, this.wallDeadline - Date.now()));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RuntimeError('PhaseTimeout')); // before fail(): fail aborts the signal, which would reject with 'Aborted' first
        this.fail('PhaseTimeout', 'phase_timeout');
      }, limit);
      const onAbort = () => reject(new RuntimeError('Aborted'));
      if (this.controller.signal.aborted) onAbort();
      else this.controller.signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener('abort', onAbort);
      });
    });
  }

  /** Model phases: if nothing happens for one phase bound while no tool runs, the run is stopped. */
  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    if (this.finalized || this.innerFinished || this.stopping) return;
    this.watchdog = setTimeout(() => {
      if (this.activeTools === 0) this.fail('PhaseTimeout', 'phase_timeout');
    }, this.phaseTimeoutMs);
  }

  private requestWait(status: WaitStatus): void {
    this.wait ??= status;
    this.stopRequested = true;
  }

  private fail(code: RuntimeErrorCode | string, end: RunEnd): void {
    if (!this.failure) this.failure = { code, end };
    this.stopRequested = true;
    clearTimeout(this.watchdog);
    this.controller.abort();
    this.inner?.abortRun();
  }

  private failFrom(error: unknown): void {
    if (error instanceof RuntimeError)
      this.fail(
        error.code,
        error.code === 'LostLease' || error.code === 'JobCancelled' ? 'lost_lease' : 'error',
      );
    else if (isFenceLoss(error)) this.fail('LostLease', 'lost_lease');
    else this.fail('ModelRunFailed', 'error');
  }

  private enqueue(work: () => Promise<void> | void): void {
    this.queue = this.queue.then(work).catch((error) => {
      this.deps.hooks?.onHookError?.('event', error);
    });
  }

  private emit(event: BaseEvent): void {
    if (this.subscriber.closed) return;
    try {
      void Promise.resolve(this.deps.hooks?.onEvent?.(event)).catch((error) =>
        this.deps.hooks?.onHookError?.('onEvent', error),
      );
    } catch (error) {
      this.deps.hooks?.onHookError?.('onEvent', error);
    }
    this.subscriber.next(event);
  }

  private async onInnerEvent(event: BaseEvent): Promise<void> {
    this.armWatchdog();
    switch (event.type) {
      case EventType.RUN_STARTED:
        this.runStartedEmitted = true;
        return this.emit(event);
      case EventType.RUN_ERROR:
        // The inner message can carry provider or prompt fragments; the sanitized code is emitted at finish().
        this.fail(this.failure?.code ?? 'ModelRunFailed', this.failure?.end ?? 'error');
        return;
      case EventType.RUN_FINISHED: {
        this.innerFinished = true;
        this.usage = (event as unknown as { usage?: unknown }).usage;
        if (this.failure) return; // finish() replaces it with RUN_ERROR
        await this.emitTerminalFromReceipt();
        return this.emit(event);
      }
      case EventType.TEXT_MESSAGE_CHUNK: {
        const delta = (event as unknown as { delta?: string }).delta ?? '';
        // The wrapper's own step-limit note follows its out-of-band signal; it is not model narrative.
        if (this.stepLimitNoteExpected && delta === STEP_LIMIT_NOTE) {
          this.stepLimitNoteExpected = false;
          return this.emit(event);
        }
        this.narrative.update(delta);
        this.narrativeLength += delta.length;
        return this.emit(event);
      }
      case EventType.STATE_SNAPSHOT:
      case EventType.STATE_DELTA: {
        const filtered = filterModelStateEvent(event);
        if (filtered.removed.length)
          this.deps.hooks?.onSecurityEvent?.({
            kind: 'protected_state_ignored',
            source: 'model_state_event',
            paths: filtered.removed,
          });
        if (filtered.event) this.emit(filtered.event);
        return;
      }
      case EventType.CUSTOM: {
        const { name } = event as unknown as { name?: string };
        // Model-visible streams cannot forge the runtime's own terminal/status events.
        if (typeof name === 'string' && name.startsWith('expunge.')) return;
        return this.emit(event);
      }
      default:
        return this.emit(event);
    }
  }

  /**
   * With completionPolicy=verified_receipt the authoritative terminal text and state are rendered from
   * the COMMITTED receipt (or its absence), never from the model's text or state.
   */
  private async emitTerminalFromReceipt(): Promise<void> {
    const { job, bundle } = this;
    if (!job || !bundle || bundle.completionPolicy !== 'verified_receipt' || !this.deps.receipts) return;
    let receipt = null;
    try {
      receipt = await this.deps.receipts.find(this.binding.actor, {
        jobId: job._id,
        runId: job.binding.runId,
        harnessHash: job.binding.harnessHash,
      });
    } catch (error) {
      this.deps.hooks?.onHookError?.('receipt-read', error);
    }
    const value = receipt
      ? {
          source: 'committed_receipt' as const,
          receiptId: receipt.receiptId,
          domainStatus: receipt.domainStatus,
          scopeId: receipt.scopeId,
          scopeRevision: receipt.scopeRevision,
          verifiedWorldRevision: receipt.verifiedWorldRevision,
          operationalResiduals: receipt.operationalResiduals,
          excludedOrRetainedRecords: receipt.excludedOrRetainedRecords,
          externalErasureStatus: receipt.externalErasureStatus,
          limitations: receipt.limitations,
          modelNarrativeAuthoritative: false as const,
        }
      : { source: 'no_committed_receipt' as const, modelNarrativeAuthoritative: false as const };
    const text = receipt
      ? [
          `Committed receipt ${receipt.receiptId}: ${receipt.domainStatus}.`,
          `Scope ${receipt.scopeId} at revision ${receipt.scopeRevision}; verified world revision ${receipt.verifiedWorldRevision}.`,
          `Operational residuals: ${receipt.operationalResiduals}. Retained or excluded records: ${receipt.excludedOrRetainedRecords}. External erasure: ${receipt.externalErasureStatus}.`,
          ...receipt.limitations.map((limitation) => `Limitation: ${limitation}`),
        ].join('\n')
      : 'No completion receipt is committed for this job. Any statement of completion above is unverified model output.';
    this.emit({ type: EventType.CUSTOM, name: 'expunge.terminal_status', value } as unknown as BaseEvent);
    this.emit({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: `expunge-terminal-${randomUUID()}`,
      role: 'assistant',
      delta: text,
    } as unknown as BaseEvent);
  }

  /** Emits the terminal failure (if any) and completes the Observable. Exactly once. */
  private finish(): void {
    if (this.finalized) return;
    this.finalized = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.wallTimer);
    if (this.subscriber.closed) return;
    if (this.failure && !this.abortedByCaller) {
      if (!this.runStartedEmitted) {
        this.runStartedEmitted = true;
        this.subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: this.input.threadId,
          runId: this.input.runId,
        } as BaseEvent);
      }
      this.emit({
        type: EventType.RUN_ERROR,
        message: this.failure.code,
        code: this.failure.code,
      } as unknown as BaseEvent);
    }
    this.subscriber.complete();
  }

  private async releaseAndSummarize(): Promise<RunStats> {
    let release: RunStats['release'] = 'none';
    // R2: a tool still executing must not outlive the lease it acts under. The run's signal is already
    // aborted, so a well-behaved tool stops promptly; wait for the stragglers, bounded. If any is still
    // running after the grace period, do NOT release: the lease expires and the job is reclaimed with a
    // new fence, and the abandoned tools are reported (their non-fenced side effects cannot be stopped).
    let abandonedTools = 0;
    if (this.executions.size > 0) {
      const grace = Math.max(0, this.deps.toolDrainMs ?? DEFAULT_TOOL_DRAIN_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        Promise.allSettled([...this.executions]).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), grace);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) {
        abandonedTools = this.executions.size;
        this.deps.hooks?.onSecurityEvent?.({ kind: 'tools_abandoned', count: abandonedTools });
      }
    }
    if (abandonedTools === 0) {
      try {
        const outcome = await releaseLease(this.deps.jobs, this.binding.actor, this.binding.lease, {
          wait: this.wait,
        });
        release = outcome === 'none' ? 'none' : outcome;
      } catch (error) {
        this.deps.hooks?.onHookError?.('release', error);
      }
    }
    let endedBy: RunEnd;
    if (release === 'yielded') endedBy = 'waiting';
    else if (release === 'cancelled') endedBy = 'cancelled';
    else if (this.failure) endedBy = this.failure.end;
    else if (this.abortedByCaller || !this.innerFinished) endedBy = 'aborted';
    else if (this.stepLimitReached) endedBy = 'step_limit';
    else endedBy = 'finished';
    return {
      endedBy,
      ...(this.failure ? { errorCode: this.failure.code } : {}),
      ...(this.wait ? { waitStatus: this.wait } : {}),
      toolCalls: this.toolCalls,
      phases: this.phases,
      elapsedMs: Date.now() - this.startedAt,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      ...(this.narrativeLength > 0
        ? { narrative: { sha256: this.narrative.digest('hex'), length: this.narrativeLength } }
        : {}),
      ...(abandonedTools > 0 ? { abandonedTools } : {}),
      release,
    };
  }
}
