import type {
  CompletionReceipt,
  CostSummary,
  HarnessBundle,
  ResourceLimits,
  RunBinding,
  ScopeKey,
  TrialMetrics,
  WorldSpec,
} from '@expunge/contracts';
import type { VisibleWorld } from '@expunge/fixtures';

export type ArmName = 'parent' | 'candidate';
/** The splits a gate runs. The untouched final split is not among them. */
export type GateSplit = 'train' | 'protected' | 'validation';
export const GATE_SPLITS: readonly GateSplit[] = ['train', 'protected', 'validation'];

/**
 * How a run ended, as the port observed it. Only `completed` can be a success, and then only if the grader agrees; a
 * failed, cancelled or timed-out run is a row with no success that stays in the denominator.
 */
export type EpisodeOutcome = 'completed' | 'incomplete' | 'refused' | 'failed' | 'cancelled' | 'timed_out';
export const NON_RESULT_OUTCOMES: readonly EpisodeOutcome[] = ['failed', 'cancelled', 'timed_out'];

/** The frozen worker profile. Equal for both arms; its hash is pinned in the campaign freeze. */
export type WorkerProfile = {
  profileId: string;
  modelId: string;
  /** `fake` is a labeled stand-in for protocol tests. A campaign on a fake model can only be held, never decided. */
  modelKind: 'fake' | 'provider';
  /** The provider the worker must resolve (e.g. `openai`). Required for a provider profile: the stamp must equal it. */
  provider?: string;
  params: unknown;
};

export type TrustedReceiptEvidence = {
  receipt: CompletionReceipt;
  binding: RunBinding;
  currentWorldRevision: number;
  committedReceiptHash: string;
};

/** What a port is asked to do for one arm of one pair, in a world instance of its own. */
export type EpisodeRequest = {
  campaignId: string;
  /** An HMAC label under the campaign key: it names no pair, split, fixture or arm. */
  runId: string;
  instanceId: string;
  /** The instance's own scope; its world's record ids are scoped to it. */
  instanceScope: ScopeKey;
  bundle: HarnessBundle;
  bundleHash: string;
  profile: WorkerProfile;
  /** The bundle's own limits, which the worker enforces. */
  limits: ResourceLimits;
  /** The frozen owner ceiling both arms run under. */
  budget: ResourceLimits;
  /** The visible world to seed. A copy: the port cannot change the gate's. Never carries the manifest. */
  world: VisibleWorld;
  /** The fault plan the trial declares (equal for both arms). The port may only seed it; the domain gateway injects. */
  faults: WorldSpec['faults'];
  signal: AbortSignal;
};

/**
 * What the port reports. `world` is the world read back from committed state; `evidence` says whether that is what it
 * is. A port that cannot read the world back returns null and the run is graded as unchanged (never a success).
 */
export type EpisodeResult = {
  outcome: EpisodeOutcome;
  failureCode?: string;
  jobId?: string;
  terminal: { status: 'complete' | 'incomplete' | 'refused'; claim: 'all_targets' | 'registered_scope' };
  /** The runtime hash the worker build wrote into the run's own checkpoint. Not a value the caller supplies. */
  runtimeHash?: string;
  receipt?: TrustedReceiptEvidence;
  retryFailures: number;
  cost: CostSummary;
  world: VisibleWorld | null;
  /** `committed` only when everything above was read from committed state. */
  evidence: 'committed' | 'fake';
  /** The stored fault plan the domain gateway attested for this world, and what it injected. */
  faults?: {
    attestedPlanHash: string | null;
    injected: { transient: number; lostAck: number; interrupted: number };
  };
};

export interface EpisodePort {
  /** `worker` runs the real worker path; `fake` is a scripted stand-in. */
  readonly kind: 'worker' | 'fake';
  readonly label: string;
  readonly profile: WorkerProfile;
  run(request: EpisodeRequest): Promise<EpisodeResult>;
}

/** Codes that count as infrastructure failure for the INVALID-INFRA threshold (PREREGISTRATION R9), predeclared. */
export const INFRA_FAILURE_CODES: readonly string[] = [
  'ProviderServerError',
  'ProviderRateLimited',
  'ProviderOutage',
  'NetworkUnavailable',
  'CredentialUnavailable',
  'ModelUnavailable',
  'CommittedStateUnreadable',
  // The port could not set up the instance or the runner threw: no job ran, so nothing was learned about the arm.
  'SetupFailed',
  'RunnerFailed',
];
export const INFRA_INVALID_THRESHOLD = 0.1;

export type HarnessDefect = 'FaultPlanMismatch' | 'FaultPlanNotInjected';

/** One graded arm. The metrics are the contract's TrialMetrics; the rest feed the admission rule and the record. */
export type TrialArm = {
  arm: ArmName;
  runId: string;
  outcome: EpisodeOutcome;
  failureCode: string | null;
  metrics: TrialMetrics;
  preservationViolations: number;
  falseCompletion: boolean;
  /** The port returned a result (it did not throw and was not cut off by the gate's timeout). */
  hadResult: boolean;
  /** The runtime hash the worker attested for this run, when it did. */
  attestedRuntimeHash: string | null;
  evidence: 'committed' | 'fake';
  infra: boolean;
  harnessDefect: HarnessDefect | null;
  worldUnread: boolean;
  graderBindingFailure: boolean;
  /** The `World` the grader graded was the initial one: the port gave none back. */
  graded: 'readback' | 'initial';
  /** Why the stored job row did not verify as real evidence (empty when it did, or when no job was started). */
  evidenceReasons: string[];
};

export type TrialRow = {
  pairId: string;
  split: GateSplit;
  fixtureLabel: string;
  repeat: number;
  family: string;
  seedCommitment: string;
  faultPlanHash: string;
  parent: TrialArm;
  candidate: TrialArm;
};

export const ZERO_COST: CostSummary = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicrousd: 0,
  unpricedCalls: 0,
  mongoOperations: 0,
  wallTimeMs: 0,
};
export function addCost(left: CostSummary, right: CostSummary): CostSummary {
  const total = { ...ZERO_COST };
  for (const key of Object.keys(total) as Array<keyof CostSummary>) total[key] = left[key] + right[key];
  return total;
}
