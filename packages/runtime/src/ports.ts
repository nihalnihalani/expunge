import type { BaseEvent } from '@ag-ui/core';
import type {
  ActorContext,
  ArtifactEnvelope,
  CompletionReceipt,
  HarnessBundle,
  Job,
  JobStatus,
  JsonValue,
  ScopeKey,
} from '@expunge/contracts';
import type { AnyTextAdapter, ChatMiddleware, ProviderEnv, ToolDefinition } from '@expunge/vendor-openmuse';
import type { MeterCarry } from './meter.js';

export type WaitStatus = 'waiting_evidence' | 'waiting_approval' | 'waiting_external';
export type LeaseBinding = { jobId: string; ownerId: string; fence: number };

/**
 * The slice of `JobRepository` (packages/mongo/src/jobs.ts) the runtime needs. The real repository
 * satisfies it structurally; `apps/worker` checks that at compile time. The runtime never calls
 * `claim`/`renew` (the dispatcher owns the lease) and never receives a Mongo client.
 */
export interface JobPort {
  readAuthorized(actor: ActorContext, jobId: string): Promise<Job>;
  checkpoint(actor: ActorContext, lease: LeaseBinding, checkpoint: JsonValue): Promise<void>;
  yield(actor: ActorContext, lease: LeaseBinding, status: WaitStatus): Promise<void>;
  finish(
    actor: ActorContext,
    lease: LeaseBinding,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outputRefs: string[],
  ): Promise<void>;
}

/** `ArtifactRepository.readPermitted` (scoped eligibility check, hash verification). */
export interface ArtifactReader {
  readPermitted(key: ScopeKey, hash: string): Promise<ArtifactEnvelope<HarnessBundle>>;
}

/** Committed completion receipts only; the model's narrative never reaches this port. */
export interface CompletionReceiptReader {
  find(
    actor: ActorContext,
    binding: { jobId: string; runId: string; harnessHash: string },
  ): Promise<CompletionReceipt | null>;
}

export type ToolContext = {
  readonly job: Job;
  readonly bundle: HarnessBundle;
  readonly actor: ActorContext;
  readonly lease: LeaseBinding;
  /** Aborts when the run is cancelled, times out, loses its lease or its subscriber unsubscribes. */
  readonly signal: AbortSignal;
  /**
   * Declare a hash (artifact, evidence, lesson) that is about to be placed in model context. The
   * runtime records it through the hook BEFORE the material reaches a prompt. Rejects when the hash
   * is not permitted or was revoked; the tool must then rebuild its output without that material.
   */
  recordContextInput(hash: string): Promise<void>;
};

/**
 * Supplies the typed job-bound tools (inspect_scope ... report_diagnostic). The runtime offers only
 * the tools whose names the pinned bundle's toolPolicy grants; a tool that is provided but not
 * granted is never shown to the model.
 */
export interface ToolProvider {
  create(context: ToolContext): ToolDefinition[] | Promise<ToolDefinition[]>;
}

/** Prices of the frozen worker profile, in integer micro-US dollars per million tokens. Absent means unpriced. */
export type ModelPricing = {
  inputMicrousdPerMillion?: number;
  outputMicrousdPerMillion?: number;
};

export type ModelSelection = {
  /** "provider/model", e.g. "openai/gpt-5". */
  spec: string;
  /** The profile's prices. Missing prices make calls unpriced; they are never treated as free. */
  pricing?: ModelPricing;
  /** TEST ONLY: a ready adapter (the labeled fake provider under src/testing). Production selection leaves it unset. */
  textAdapter?: AnyTextAdapter;
};
export interface ModelResolver {
  select(job: Job, bundle: HarnessBundle): ModelSelection;
}

export type PhaseInfo = {
  phase: number;
  toolId: string;
  toolCalls: number;
  outcome: 'ok' | 'tool_error';
  elapsedMs: number;
  /** The adapter that actually served the run so far (provider-reported name and model), once known. */
  model?: { provider: string; model: string };
  /** Cumulative usage of the JOB (prior sessions included), to be persisted in the checkpoint. */
  meter?: MeterCarry;
};

export type SecurityEvent =
  | { kind: 'protected_state_ignored'; source: 'input_state' | 'model_state_event'; paths: string[] }
  | { kind: 'tool_not_granted'; toolId: string }
  | { kind: 'tools_abandoned'; count: number }
  | { kind: 'client_state_dropped'; keys: number }
  | { kind: 'client_input_dropped'; systemMessages: number; clientTools: number };

export interface ExecutionHooks {
  /** Persist hashes before they enter a prompt. A rejection fails the run closed. */
  onContextInputs?(hashes: string[]): Promise<void>;
  /**
   * Called after each tool phase settles and BEFORE its result reaches the model (checkpoint here). A rejection
   * with a lost-lease code aborts the run. Resolving 'stop' ends the loop after this turn as a NORMAL ending
   * (the job reached a committed terminal state, e.g. complete_cleanup finished it).
   */
  onPhaseComplete?(info: PhaseInfo): Promise<void | 'continue' | 'stop'>;
  /** Projection/tracing adapter. Errors are reported through onHookError and do not abort the run. */
  onEvent?(event: BaseEvent): void | Promise<void>;
  /**
   * Called once when the session ends, while the lease is still held and BEFORE it is released, with the job's cumulative
   * usage. Persist it (the worker writes it into the checkpoint) so a takeover starts from the committed totals.
   */
  onMeter?(carry: MeterCarry): Promise<void>;
  onSecurityEvent?(event: SecurityEvent): void;
  onHookError?(hook: string, error: unknown): void;
}

export type ExecutionDependencies = {
  readonly jobs: JobPort;
  readonly artifacts: ArtifactReader;
  readonly tools: ToolProvider;
  readonly models: ModelResolver;
  readonly receipts?: CompletionReceiptReader;
  readonly hooks?: ExecutionHooks;
  readonly env?: ProviderEnv;
  /**
   * After a run is torn down, how long to wait for tool executions that are still running before giving up on
   * releasing the lease (default 5000 ms). A tool must stop non-fenced work when ToolContext.signal aborts.
   */
  readonly toolDrainMs?: number;
  /** Per model/tool phase wall bound; the lesser of this and the remaining run wall time applies. */
  readonly phaseTimeoutMs?: number;
  /** Frontend tool names the model may be offered. Default none: a durable worker has no UI. */
  readonly clientToolAllowlist?: readonly string[];
  /**
   * Whether client-supplied AG-UI `state` may reach the model at all. Default false: client state is dropped
   * entirely (nothing about authority or the job comes from it). When true, only a denylist of authority-shaped
   * keys is stripped, which is defence in depth, not an allowlist.
   */
  readonly acceptClientState?: boolean;
  /**
   * Fail the run closed when a model call cannot be priced (no profile prices or no reported usage) and the
   * bundle sets a cost ceiling. Default false: such calls are counted as unpriced and the run is flagged.
   */
  readonly requirePricing?: boolean;
  /** Offer AGUISendStateSnapshot/Delta (protected paths are filtered). Default true. */
  readonly modelStateTools?: boolean;
  /** Trusted system prompt for the run. Defaults to `defaultWorkerPrompt`. */
  readonly prompt?: (job: Job, bundle: HarnessBundle) => string;
  /**
   * Observability middleware for the model loop (e.g. GenAI spans). Host code only: it observes the loop and cannot
   * change what the run is allowed to do. A failing middleware is the middleware's problem; the run's authority,
   * limits and lease handling do not depend on it. Default none.
   */
  readonly chatMiddleware?: readonly ChatMiddleware[];
};

export type ExecutionBinding = {
  readonly actor: ActorContext;
  readonly lease: LeaseBinding;
};

export type RunEnd =
  | 'finished'
  | 'step_limit'
  | 'tool_budget'
  | 'token_budget'
  | 'cost_budget'
  | 'wall_time'
  | 'phase_timeout'
  | 'waiting'
  | 'cancelled'
  | 'lost_lease'
  | 'aborted'
  | 'error';

/** Metered from per-call provider usage. `unpricedCalls` counts calls with no price or no reported usage. */
export type UsageSummary = {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicrousd: number;
  unpricedCalls: number;
  costCoverage: 'complete' | 'partial' | 'none';
};

/** Which provider, model and profile produced a run. `adapterInjected` is true when a caller supplied the adapter. */
export type RunProvenance = {
  spec: string;
  provider?: string;
  model?: string;
  adapterInjected: boolean;
  /** Hash of {spec, pricing}; compared with the job's workerProfileHash once a profile store exists. */
  profileHash: string;
  boundWorkerProfileHash: string;
};

export type RunStats = {
  endedBy: RunEnd;
  errorCode?: string;
  waitStatus?: WaitStatus;
  toolCalls: number;
  phases: number;
  elapsedMs: number;
  usage?: unknown;
  metered?: UsageSummary;
  /** The cumulative totals as persisted (prior sessions included). */
  meterCarry?: MeterCarry;
  provenance?: RunProvenance;
  /** sha256 and length of the model's final text; the narrative itself is not retained here. */
  narrative?: { sha256: string; length: number };
  /** HTTP attempts the provider SDK made for this run and whether the phase watchdog fired during a pending retry (numbers only). */
  providerAttempts?: { attempts: number; retriedStatuses: number[]; backoffTimeout: boolean };
  /** Tool executions still running when the drain grace expired; the lease was NOT released in that case. */
  abandonedTools?: number;
  release: 'none' | 'yielded' | 'cancelled' | 'lost';
};
