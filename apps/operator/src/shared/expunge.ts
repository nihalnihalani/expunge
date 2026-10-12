import { z } from 'zod';

/**
 * Sanitized read projection shapes for the Expunge workflow (owned by ui-ux-improver).
 * Standalone: the operator has its own lock and cannot import @expunge/contracts.
 * Names and unions mirror docs/expunge/CONTRACTS.md and packages/contracts/src/index.ts.
 * Everything here is a sanitized read projection. No raw subject literal, no hidden manifest,
 * no credential, no model text that could be mistaken for committed state.
 */

// ---- Mirrored vocabulary (runtime arrays; a parity test compares them with packages/contracts) ----
export const ENVIRONMENTS = [
  'dev',
  'evaluation',
  'demo',
  'staging',
  'production',
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
/** Real source registrations require an explicit release environment. */
export const SOURCE_ENVIRONMENTS = ['staging', 'production'] as const;
export type SourceEnvironment = (typeof SOURCE_ENVIRONMENTS)[number];
/**
 * An isolated replay is a copy the owner created, so it may also live in the synthetic demo environment. Cleaning it
 * never erases the original; original sources stay limited to SOURCE_ENVIRONMENTS.
 */
export const ISOLATED_REPLAY_ENVIRONMENTS = [
  ...SOURCE_ENVIRONMENTS,
  'demo',
] as const;

/** Whether a world's environment may host cleanup for its bound source kind. No binding never qualifies. */
export function sourceEnvironmentAllowed(
  env: Environment,
  binding: Pick<SourceBindingView, 'sourceKind'> | undefined,
): boolean {
  if (!binding) return false;
  const allowed: readonly Environment[] =
    binding.sourceKind === 'isolated_replay'
      ? ISOLATED_REPLAY_ENVIRONMENTS
      : SOURCE_ENVIRONMENTS;
  return allowed.includes(env);
}

export const JOB_KINDS = [
  'cleanup',
  'observe',
  'propose',
  'evaluate',
  'promote',
  'rollback',
  'redact',
  'external_delete',
  'adversarial_generate',
  'meta_evaluate',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATUSES = [
  'queued',
  'running',
  'waiting_evidence',
  'waiting_approval',
  'waiting_external',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const EFFECT_KINDS = [
  'delete',
  'redact',
  'restrict',
  'tombstone',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];
export const MUTATION_CLASSES = [
  'tightening',
  'behavioral',
  'authority_expansion',
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];
export const SOURCE_ORIGINS = [
  'agent_self_report',
  'verifier_feedback',
  'human_feedback',
  'raindrop_classifier',
  'experiment_result',
  'admission_service',
] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];
export const OUTBOX_STATES = [
  'pending',
  'leased',
  'sdk_enqueued',
  'ingest_accepted',
  'query_visible',
  'evidence_ready',
  'retrying',
  'dead_letter',
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];
export const EXTERNAL_ERASURE_STATUSES = [
  'not_required',
  'pending',
  'confirmed',
  'failed',
] as const;
export type ExternalErasureStatus = (typeof EXTERNAL_ERASURE_STATUSES)[number];
export const PROVIDER_ERASURE_STATUSES = [
  'unsubmitted',
  'submitting',
  'submission_ambiguous',
  'pending',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
] as const;
export type ProviderErasureStatus = (typeof PROVIDER_ERASURE_STATUSES)[number];
export const CANDIDATE_STATES = [
  'proposed',
  'schema_rejected',
  'replay_rejected',
  'evaluating',
  'behavior_rejected',
  'waiting_approval',
  'eligible',
  'promoted',
  'stale',
  'revoked',
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];
export const POLICY_RESULTS = ['allow', 'ask', 'deny'] as const;
export type PolicyResult = (typeof POLICY_RESULTS)[number];
export const TARGET_KINDS = ['worker', 'improver', 'hider'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const JOB_PHASES = [
  'inspect',
  'resolve',
  'discover',
  'preview',
  'apply',
  'verify',
  'complete',
] as const;
export type JobPhase = (typeof JOB_PHASES)[number];
export type PhaseState =
  'pending' | 'active' | 'committed' | 'skipped' | 'failed';
export const TOOL_IDS = [
  'inspect_scope',
  'resolve_subject',
  'discover_references',
  'preview_cleanup',
  'apply_cleanup_batch',
  'verify_registered_scope',
  'complete_cleanup',
  'inspect_harness',
  'report_diagnostic',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];
/** Projection event kinds: the 11 in CONTRACTS.md plus the six additive kinds frozen on 2026-10-11. */
export const PROJECTION_KINDS = [
  'job_started',
  'tool_decided',
  'effect_committed',
  'evidence_ready',
  'candidate_proposed',
  'trial_completed',
  'approval_required',
  'harness_promoted',
  'receipt_committed',
  'external_erasure_updated',
  'job_failed',
  'job_status_changed',
  'cancel_requested',
  'approval_resolved',
  'harness_rolled_back',
  'retraction_progress',
  'campaign_row_committed',
] as const;

// ---- Readiness: GET /api/expunge/readiness ----
export type ReadinessReason =
  | 'env_missing'
  | 'env_malformed' // configured
  | 'connect_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_5xx'
  | 'bad_response' // reachable
  | 'unauthorized'
  | 'forbidden'
  | 'scope_unbound' // authorized
  | 'source_registration_unreported'
  | 'source_missing'
  | 'source_revoked'
  | 'source_unsupported'
  | 'legacy_backend'
  | 'cleanup_permission_not_checked'
  | 'cleanup_permission_denied'
  | 'cleanup_permission_revoked'
  | 'evidence_unconfigured'
  | 'evidence_never_proven'
  | 'evidence_stale'
  | 'evidence_dead_letter'; // evidence-ready

export interface ReadinessCheck {
  /** unknown = not evaluated because an earlier check failed (never rendered as pass). */
  status: 'pass' | 'fail' | 'unknown';
  reason: ReadinessReason | null;
  /** Server-side configuration NAMES that are missing or malformed. Never values. */
  missing: string[];
  /** Fixed-vocabulary sentence chosen by the operator, not echoed from upstream bodies. */
  detail: string;
  /** Time the operator or backend actually observed this result. */
  observedAt: string | null;
}

/** Sanitized source identity derived from the owner's stored registration, never browser authority. */
export interface SourceBindingView {
  sourceId: string;
  sourceKind: 'original' | 'isolated_replay';
  registrationHash: string;
  registrationRevision: number;
  policyRevision: number;
  authorizationRevision: number;
}

/** Actual registry and permission state reported by the domain service. Null fields stay unbound. */
export interface SourceReadinessView {
  registration: 'missing' | 'active' | 'revoked' | 'unsupported';
  permission: 'not_checked' | 'authorized' | 'denied' | 'revoked';
  sourceId: string | null;
  sourceKind: 'original' | 'isolated_replay' | null;
  sourceRegistrationHash: string | null;
  registrationRevision: number | null;
  policyRevision: number | null;
  authorizationRevision: number | null;
}

export interface ExpungeReadiness {
  checkedAt: string;
  /** 'fixture' = deterministic test backend; the UI shows a persistent banner. */
  backend: { kind: 'live' | 'fixture' | 'none'; version: string | null };
  configured: ReadinessCheck; // operator env present and well formed; no network
  reachable: ReadinessCheck; // backend answered the readiness route within the bound
  authorized: ReadinessCheck; // backend accepted the service principal and bound the owner to a scope
  /** Optional only for historical projections; an absent check always blocks cleanup. */
  sourceRegistered?: ReadinessCheck;
  cleanupAuthorized?: ReadinessCheck;
  /** Null/absent means no server-reported source binding. */
  source?: SourceReadinessView | null;
  evidenceReady: ReadinessCheck; // observability write and read-back proven by the backend, not by the operator
  /** true only when all six pass against the live backend. Derived server-side. */
  ready: boolean;
  /** Which write actions have a configured server-side principal. Names only, never values. */
  writes: {
    submit: boolean;
    cancel: boolean;
    approve: boolean;
    missing: string[];
  };
  /** Operator telemetry state, from the server environment. */
  telemetry: 'disabled' | 'enabled';
}

/** Operational cleanup prerequisites. Remote evidence is a separate improvement/admission prerequisite. */
export function cleanupReadinessPassed(
  readiness:
    | Pick<
        ExpungeReadiness,
        | 'backend'
        | 'configured'
        | 'reachable'
        | 'authorized'
        | 'sourceRegistered'
        | 'cleanupAuthorized'
      >
    | undefined,
): boolean {
  return (
    readiness?.backend.kind === 'live' &&
    [
      readiness.configured,
      readiness.reachable,
      readiness.authorized,
      readiness.sourceRegistered,
      readiness.cleanupAuthorized,
    ].every((item) => item?.status === 'pass')
  );
}

/** Exact immutable source binding comparison; missing bindings never match one another. */
export function sourceBindingsEqual(
  left: SourceBindingView | undefined,
  right: SourceBindingView | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.sourceId === right.sourceId &&
    left.sourceKind === right.sourceKind &&
    left.registrationHash === right.registrationHash &&
    left.registrationRevision === right.registrationRevision &&
    left.policyRevision === right.policyRevision &&
    left.authorizationRevision === right.authorizationRevision,
  );
}

/** A projected source must match every live registration binding reported by the backend. */
export function sourceBindingMatchesReadiness(
  binding: SourceBindingView | undefined,
  source: SourceReadinessView | null | undefined,
): boolean {
  return Boolean(
    binding &&
    source &&
    source.registration === 'active' &&
    binding.sourceId === source.sourceId &&
    binding.sourceKind === source.sourceKind &&
    binding.registrationHash === source.sourceRegistrationHash &&
    binding.registrationRevision === source.registrationRevision &&
    binding.policyRevision === source.policyRevision &&
    binding.authorizationRevision === source.authorizationRevision,
  );
}

/**
 * The selected world may start cleanup only when its environment admits its source kind and its binding matches the
 * live registration the backend reports. Shared by the server's transport gate and the New cleanup view.
 */
export function sourceScopeReady(
  world: { env: Environment; source?: SourceBindingView } | undefined,
  source: SourceReadinessView | null | undefined,
): boolean {
  return Boolean(
    world &&
    sourceEnvironmentAllowed(world.env, world.source) &&
    sourceBindingMatchesReadiness(world.source, source),
  );
}

// ---- Worlds and previews: GET /api/expunge/worlds, POST /api/expunge/previews ----
export interface WorldSummary {
  worldId: string;
  label: string;
  env: Environment;
  /** Absent historical worlds are displayed as unbound and cannot start native cleanup. */
  source?: SourceBindingView;
  scopeId: string;
  scopeRevision: number;
  worldRevision: number;
  maintenanceMode: boolean;
  collectionIds: string[];
  fieldCount: number;
  referenceEdgeCount: number;
  allowedEffectKinds: EffectKind[];
  eligibilityPolicyId: string;
  eligibilityPolicyHash: string;
  documentLimits: { maxScanned: number; maxChanged: number };
  discoveryCompleteness: {
    kind: 'declared' | 'observed' | 'partial';
    limitations: string[];
  };
}

export type SubjectIdType = 'objectId' | 'string' | 'int' | 'long';
export interface CleanupSubjectInput {
  idType: SubjectIdType;
  value: string;
}

export interface CleanupPreview {
  previewId: string;
  /** Executed model-free by the gateway under the expert-static discovery policy; never authorizes an effect. */
  basis: 'expert_static_discovery';
  worldId: string;
  /** Exact source identity/policy/permission binding from the domain's persisted preview. */
  source?: SourceBindingView;
  worldRevision: number;
  scopeRevision: number;
  /** Masked display and a hash. The literal subject is not echoed back. */
  subject: { display: string; identityHash: string; idType: SubjectIdType };
  perCollection: Array<{
    collectionId: string;
    exactIdentityMatches: number;
    eligibleEffects: Partial<Record<EffectKind, number>>;
    retained: number;
    notInspected: boolean;
  }>;
  limitations: string[];
  expiresAt: string;
}

export interface SubmitCleanupRequest {
  requestKey: string; // client UUID; server dedupes
  worldId: string;
  previewId: string; // preview must match current world/scope revision
  subject: CleanupSubjectInput;
} // strict: no tenant, actor, role, authorization revision fields

// ---- Snapshot v2: GET /api/expunge/jobs/:jobId (additive over today's snapshot) ----
export interface Counter {
  used: number;
  cap: number;
}
export const GRAPH_NODE_STATES = [
  'residual',
  'applied',
  'previewed',
  'inspected',
  'discovered',
  'retained',
  'excluded',
  'not_inspected',
] as const;
export type GraphNodeState = (typeof GRAPH_NODE_STATES)[number];

export interface ExpungeJobSnapshotV2 {
  schemaVersion: 2;
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  /** Highest committed event sequence reflected in this snapshot (contiguous per job stream). */
  sequence: number;
  /** Identifies one backend history of this job's stream; a change means restore or replacement. */
  streamEpoch?: string;
  runId?: string;
  harness?: { hash: string; parentHash: string | null; activeRevision: number };
  scope: {
    scopeId: string;
    scopeRevision: number;
    env: Environment;
  };
  world?: { worldId: string; revision: number; maintenanceMode: boolean };
  subject?: { display: string; identityHash: string; idType: SubjectIdType };
  phase: JobPhase | null;
  phaseStates: Record<JobPhase, PhaseState>;
  cancellation: { requested: boolean; requestedAt: string | null };
  coverage: {
    registeredCollectionIds: string[];
    inspectedCollectionIds: string[];
    discoveredFieldIds: string[];
    completeness: 'declared' | 'observed' | 'partial';
    limitations: string[];
  };
  limits: {
    modelCalls: Counter;
    toolCalls: Counter;
    scannedDocuments: Counter;
    changedDocuments: Counter;
    traversalDepth: Counter;
    graphNodes: Counter;
    graphEdges: Counter;
    wallTimeMs: Counter;
    totalTokens: Counter;
    costMicrousd: Counter;
    /** Calls without a provider price. Shown as a count, never folded into cost as zero. */
    unpricedCalls: number;
  };
  graph: {
    artifactId: string | null;
    nodeCount: number;
    edgeCount: number;
    truncated: boolean;
    byState: Record<GraphNodeState, number>;
  };
  evidence: {
    outboxState: OutboxState | null;
    evidenceReady: boolean;
    truncated: boolean;
  };
  approval: {
    state:
      | 'none'
      | 'pending'
      | 'approved'
      | 'declined'
      | 'expired'
      | 'consumed'
      | 'stale';
    proposalId: string | null;
    expiresAt: string | null;
  };
  receipt: { receiptId: string; sequence: number } | null;
  /** Index of committed artifacts for this job (bounded to 200), read by id through the artifact route. */
  artifacts: ArtifactRef[];
  externalErasure: {
    status: ExternalErasureStatus;
    providerStatus: ProviderErasureStatus | null;
    dueBy: string | null;
  } | null;
  cost: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
    unpricedCalls: number;
    mongoOperations: number;
    wallTimeMs: number;
  };
  updatedAt: string;
}

export interface ExpungeJobListItem {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  sequence: number;
  subjectDisplay?: string;
  worldId?: string;
  harnessHash?: string;
  receiptDomainStatus?: 'complete_in_registered_scope' | 'incomplete';
  /** Present with receiptDomainStatus: the committed receipt that carries the verdict. */
  receiptId?: string;
  receiptSequence?: number;
  verifiedWorldRevision?: number;
  /**
   * Present only on a failed job with no committed receipt: the worker's short terminal reason code (for example
   * `ModelAttestationFailed`, `NoCompletionReceipt`). A code-shaped token, never free text or subject data.
   */
  terminalReason?: string;
  updatedAt: string;
}
export interface ExpungeJobList {
  items: ExpungeJobListItem[];
  nextCursor: string | null;
}

// ---- ProjectionEvent payloads (sanitized, bounded). Kind -> payload. ----
export interface JobStartedPayload {
  jobKind: JobKind;
  harnessHash: string;
  worldId?: string;
  scopeRevision: number;
  attempt: number;
}
export interface ToolDecidedPayload {
  stepId: string;
  phase: JobPhase;
  toolId: ToolId;
  decision: PolicyResult;
  ruleIds: string[];
  /** fixed-vocabulary summary, at most 200 chars, no subject literals */
  summary: string;
  targetCount?: number;
}
export interface EffectCommittedPayload {
  receiptId: string;
  stepId: string;
  batchOrdinal: number;
  effectKind: EffectKind;
  collectionId: string;
  appliedCount: number;
  resultingWorldRevision: number;
  /** graph node ids touched, at most 100; full set in the graph artifact */
  nodeIds: string[];
}
export interface EvidenceReadyPayload {
  evidenceId: string;
  provider: string;
  externalEventId?: string;
  externalTraceId?: string;
  externalSignalIds: string[];
  origin: SourceOrigin;
  outboxState: OutboxState;
  truncated: boolean;
  missing: string[];
  contentHash: string;
  permittedUse: 'training' | 'gate_only' | 'display_only' | 'revoked';
}
export interface CandidateProposedPayload {
  candidateId: string;
  target: TargetKind;
  parentHash: string;
  childHash: string;
  claimedClass: MutationClass;
  computedClass: MutationClass;
  surfaces: string[];
  hypothesis: string;
  state: CandidateState;
}
export interface TrialCompletedPayload {
  reportId: string | null;
  candidateId: string;
  pairId: string;
  family: string;
  /** Split and per-arm outcomes stay in authorized report detail, never this worker-readable event. */
  verdict: 'admit' | 'reject' | 'hold' | null;
}
export interface ApprovalRequiredPayload {
  proposalId: string;
  candidateId: string;
  computedClass: MutationClass;
  flipSetDigest: string;
  expiresAt: string;
}
export interface HarnessPromotedPayload {
  promotionId: string;
  target: TargetKind;
  fromHash: string;
  toHash: string;
  fromRevision: number;
  toRevision: number;
  gateReportId: string;
  consumedGrantId: string | null;
}
export interface ReceiptCommittedPayload {
  receiptId: string;
  domainStatus: 'complete_in_registered_scope' | 'incomplete';
  externalErasureStatus: ExternalErasureStatus;
  verifiedWorldRevision: number;
}
export interface ExternalErasureUpdatedPayload {
  requestKey: string;
  providerStatus: ProviderErasureStatus;
  dueBy: string | null;
  completedAt: string | null;
  subjectCount: number;
  snapshotHash: string;
}
export const JOB_FAILURE_CODES = [
  'budget_exhausted',
  'lease_lost',
  'policy_denied',
  'verification_failed',
  'provider_error',
  'world_conflict',
  'internal_error',
] as const;
export type JobFailureCode = (typeof JOB_FAILURE_CODES)[number];
export interface JobFailedPayload {
  code: JobFailureCode;
  retryable: boolean;
  phase: JobPhase | null;
  message: string;
}

// Additive kinds the UI needs because today's list has no committed signal for these states.
export interface JobStatusChangedPayload {
  from: JobStatus;
  to: JobStatus;
  reason: string;
}
export interface CancelRequestedPayload {
  requestedAt: string;
  by: 'owner' | 'system';
}
export interface ApprovalResolvedPayload {
  proposalId: string;
  decision: 'approved' | 'declined' | 'expired' | 'stale';
  grantId: string | null;
}
export interface HarnessRolledBackPayload {
  promotionId: string;
  target: TargetKind;
  fromHash: string;
  toHash: string;
  testedParentHash: string;
  reason: string;
}
export interface RetractionProgressPayload {
  retractionId: string;
  sourceId: string;
  frontierSize: number;
  visited: number;
  closureComplete: boolean;
  revoked: number;
  regenerated: number;
  runsCancelled: number;
  failClosed: boolean;
}
export interface CampaignRowPayload {
  campaignId: string;
  manifestHash: string;
  kind: 'hider' | 'meta';
  rowId: string;
  w0ResetProof?: string;
  budgetHash?: string;
  result: 'measured' | 'null' | 'invalid';
}

/** Reader-authorized campaign artifact detail. Admission is not a projection-event field. */
export interface CampaignDetailRowView extends CampaignRowPayload {
  admitted?: boolean;
}

export interface ProjectionPayloadByKind {
  job_started: JobStartedPayload;
  tool_decided: ToolDecidedPayload;
  effect_committed: EffectCommittedPayload;
  evidence_ready: EvidenceReadyPayload;
  candidate_proposed: CandidateProposedPayload;
  trial_completed: TrialCompletedPayload;
  approval_required: ApprovalRequiredPayload;
  harness_promoted: HarnessPromotedPayload;
  receipt_committed: ReceiptCommittedPayload;
  external_erasure_updated: ExternalErasureUpdatedPayload;
  job_failed: JobFailedPayload;
  job_status_changed: JobStatusChangedPayload;
  cancel_requested: CancelRequestedPayload;
  approval_resolved: ApprovalResolvedPayload;
  harness_rolled_back: HarnessRolledBackPayload;
  retraction_progress: RetractionProgressPayload;
  campaign_row_committed: CampaignRowPayload;
}
export type ProjectionKind = keyof ProjectionPayloadByKind;
/** A newer backend kind this operator does not know: counted and shown generically, payload dropped. */
export interface UnknownKindEvent {
  eventId: string;
  sequence: number;
  jobId: string;
  runId?: string;
  kind: 'unknown_kind';
  originalKind: string;
  artifactIds: string[];
  payload: Record<string, never>;
}
export type TypedProjectionEvent = {
  [K in ProjectionKind]: {
    eventId: string;
    sequence: number;
    jobId: string;
    runId?: string;
    kind: K;
    artifactIds: string[];
    payload: ProjectionPayloadByKind[K];
  };
}[ProjectionKind];
export type ForwardedProjectionEvent = TypedProjectionEvent | UnknownKindEvent;

// ---- Artifacts by id: GET /api/expunge/artifacts/:artifactId ----
export interface ArtifactEnvelope<T = unknown> {
  artifactId: string;
  kind: ArtifactKind;
  jobId: string | null;
  /** event sequence at which this artifact became visible; used to order against the log */
  committedAtSequence: number;
  /** content hash for immutable artifacts, null for mutable lifecycle records */
  contentHash: string | null;
  payload: T;
}

// ---- Proposal review and decision ----
export interface ApprovalDescriptorView {
  proposalId: string;
  grantId: string | null;
  state: 'pending' | 'approved' | 'declined' | 'expired' | 'consumed' | 'stale';
  target: TargetKind;
  parentHash: string;
  childHash: string;
  expectedParentRevision: number;
  computedClass: MutationClass;
  flipSet: Array<{
    capability: string;
    change: 'added' | 'widened' | 'removed' | 'tightened';
  }>;
  flipSetDigest: string;
  scope: {
    scopeId: string;
    scopeRevision: number;
    authorizationRevision: number;
  };
  gateReportId: string;
  gateReportDigest: string;
  approver: { actorId: string; display: string };
  expiresAt: string;
  consequences: string[];
  /** digest the client must echo; the server re-derives and compares */
  descriptorDigest: string;
}
export interface ApprovalDecisionRequest {
  decision: 'approve' | 'decline';
  descriptorDigest: string;
  toolCallId?: string; // when the review was opened from the chat card
} // strict: never carries executable arguments
export interface ApprovalDecisionResult {
  accepted: boolean;
  /** committed state after the call, re-read from the domain, not echoed from the request */
  state: ApprovalDescriptorView['state'];
  committedEventSequence: number | null;
  /** Minted by the database when an approval is committed; absent or null for a decline. */
  grantId?: string | null;
}

export interface CancelJobRequest {
  reason?: string;
}

// ---- Artifact index and UI views of artifacts (additive to the plan; proposed for CONTRACTS.md) ----
export const ARTIFACT_KINDS = [
  'completion_receipt',
  'action_receipt',
  'graph_page',
  'record_detail',
  'model_narrative',
  'candidate',
  'gate_report',
  'trial_pair',
  'harness_bundle',
  'evidence_bundle',
  'approval_descriptor',
  'promotion_receipt',
  'external_erasure',
  'provenance_page',
  'retraction',
  'deployment',
  'campaign',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export interface ArtifactRef {
  artifactId: string;
  kind: ArtifactKind;
  committedAtSequence: number;
}

export interface DomainAddressView {
  collectionId: string;
  recordId: string;
  recordIdBsonType: SubjectIdType;
}
export interface GraphNode {
  id: string;
  collectionId: string;
  recordId: string;
  recordIdBsonType: SubjectIdType;
  /** Reference distance from the subject; the controlled world has at most five hops. */
  hop: number;
  state: GraphNodeState;
  effect: EffectKind | null;
  /** Sanitized display label, for example "accounts / 7f3a (objectId)". */
  label: string;
  fieldIds: string[];
  /** True when the exact-identity rule was not met (a namesake). */
  noExactIdentity: boolean;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  edgeId: string;
  fieldId: string;
}
export interface GraphPage {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextCursor: string | null;
}
export interface RecordElementView {
  index: number;
  outcome: 'removed' | 'preserved' | 'redacted' | 'tombstoned' | 'restricted';
  display: string | null;
}
export interface RecordFieldView {
  path: string;
  kind: 'scalar' | 'array' | 'unchanged_group';
  changed: boolean;
  count?: number;
  elements?: RecordElementView[];
  display?: string | null;
}
export interface RecordDetail {
  nodeId: string;
  address: DomainAddressView;
  preHash: string;
  postHash: string | null;
  effect: EffectKind | null;
  fields: RecordFieldView[];
}
export interface CompletionReceiptView {
  receiptId: string;
  jobId: string;
  /** Historical receipts without this binding cannot establish original-source erasure. */
  source?: SourceBindingView;
  runId: string;
  harnessHash: string;
  scopeId: string;
  scopeRevision: number;
  verifiedWorldRevision: number;
  verificationPlanHash: string;
  inspectedCollectionIds: string[];
  discoveredFieldIds: string[];
  operationalResiduals: number;
  excludedOrRetainedRecords: number;
  limitations: string[];
  domainStatus: 'complete_in_registered_scope' | 'incomplete';
  externalErasureStatus: ExternalErasureStatus;
  registeredCollectionIds: string[];
  effectCounts: Partial<Record<EffectKind, number>>;
  actionReceiptIds: string[];
  committedAt: string;
  /** Present in evaluation views only, labeled with the fixed evaluator hash. */
  independentGrader?: {
    evaluatorHash: string;
    verdict: 'pass' | 'fail';
    reasonCodes: string[];
  } | null;
}
export interface ModelNarrativeView {
  jobId: string;
  text: string;
  /** True when this narrative was replayed from a recorded run rather than produced live. */
  replayed: boolean;
  producedAt: string;
}
export interface EvidenceReferenceView {
  provider: string;
  externalEventId?: string;
  externalTraceId?: string;
  externalSignalIds: string[];
  localSourceIds: string[];
  origin: SourceOrigin;
  redactionPolicy: string;
  retrievedAt: string;
  contentHash: string;
  permittedUse: 'training' | 'gate_only' | 'display_only' | 'revoked';
}
export interface EvidenceBundleView {
  evidenceId: string;
  split: 'train' | 'protected' | 'validation' | 'final';
  sources: EvidenceReferenceView[];
  tools: Array<{ toolId: ToolId; decision: PolicyResult; summary: string }>;
  diagnostics: string[];
  confidence: number;
  outbox: Array<{ state: OutboxState; at: string | null }>;
  truncated: boolean;
  missing: string[];
  retryAttempts: number;
}
export interface TypedPatchView {
  surface: 'context' | 'workflow' | 'guardrails' | 'tool_policy' | 'plugin';
  path: string;
  before: string;
  after: string;
  sourceEvidenceIds: string[];
  hypothesis: string;
}
export interface CandidateView {
  candidateId: string;
  target: TargetKind;
  parentHash: string;
  childHash: string;
  state: CandidateState;
  hypothesis: string;
  claimedClass: MutationClass;
  computedClass: MutationClass;
  flipSet: Array<{
    capability: string;
    change: 'added' | 'widened' | 'removed' | 'tightened';
  }>;
  patches: TypedPatchView[];
  sourceEvidence: EvidenceReferenceView[];
  reasonCodes: string[];
  compiler: { ok: boolean; messages: string[] };
  replay: {
    ran: boolean;
    label: 'decision_replay_diagnostic';
    summary: string;
  } | null;
  activeParentHash: string | null;
}
export interface TrialMetricsView {
  usefulCompletion: boolean;
  targetedResiduals: number;
  unrelatedRecordChanges: number;
  retentionViolations: number;
  truthfulTerminal: boolean;
  refused: boolean;
  timedOut: boolean;
  failed: boolean;
  retryFailures: number;
  tokens: number;
  costMicrousd: number;
  unpricedCalls: number;
  wallTimeMs: number;
}
export interface TrialPairView {
  pairId: string;
  split: 'train' | 'protected' | 'validation' | 'final';
  family: string;
  seedCommitment: string;
  parent: TrialMetricsView;
  candidate: TrialMetricsView;
}
export interface ControlRowView {
  controlId:
    'score_only' | 'wrong_incident' | 'expert_static' | 'initial' | 'evolved';
  label: string;
  successes: number;
  episodes: number;
  costMicrousd: number;
}
/** The gate's own stored decision summary (packages/gate AdmissionSummary, the figures it decided on). */
export interface GateDecisionSummaryView {
  /** Candidate minus parent successes on the training split only; may be negative. */
  triggerGain: number;
  triggerRequiredGain: number;
  splits: Partial<
    Record<
      'train' | 'protected' | 'validation' | 'final',
      { trials: number; parentSuccesses: number; candidateSuccesses: number }
    >
  >;
  protectedRegressedWorlds: number;
}
export interface GateReportView {
  reportId: string;
  candidateId: string;
  parentHash: string;
  childHash: string;
  evaluatorHash: string;
  fixtureGeneratorHash: string;
  runtimeHash: string;
  workerProfileHash: string;
  splitManifestCommitment: string;
  pairs: TrialPairView[];
  plannedPairs: number;
  trialRowsDigest: string;
  controls: ControlRowView[];
  knownAuthorityFlips: string[];
  totalCostMicrousd: number;
  unpricedCalls: number;
  verdict: 'admit' | 'reject' | 'hold';
  reasonCodes: string[];
  /** Absent when the backend does not project the gate's summary. */
  decisionSummary?: GateDecisionSummaryView;
}
export interface DeploymentVersionView {
  hash: string;
  parentHash: string | null;
  testedParentHash: string | null;
  authorityClass: MutationClass | null;
  state: 'active' | 'previous' | 'rolled_back';
  promotion: {
    promotionId: string;
    gateReportId: string;
    consumedGrantId: string | null;
    at: string;
  } | null;
  rollback: {
    promotionId: string;
    toHash: string;
    reason: string;
    at: string;
  } | null;
}
export interface DeploymentView {
  target: TargetKind;
  activeHash: string;
  revision: number;
  scopeRevision: number;
  authorizationRevision: number;
  initialBundleHash: string;
  versions: DeploymentVersionView[];
  rejected: Array<{
    candidateId: string;
    childHash: string;
    reasonCodes: string[];
  }>;
  /**
   * Rollbacks the deployment service refused (for example RollbackNeedsGrant), read from the
   * insert-only refusal rows, bounded, newest first. Absent when the backend does not report them.
   */
  refusedRollbacks?: RefusedRollbackView[];
}
export interface RefusedRollbackView {
  toHash: string;
  code: string;
  at: string;
}
/**
 * The preregistered meta verdict exactly as the backend stored it (summarizeMeta, PREREGISTRATION.md).
 * The operator displays it and never recomputes it. `net` and `noDataNet` may be negative.
 */
export interface MetaVerdictView {
  verdict: 'gain' | 'tie' | 'loss';
  incidents: number;
  wins: number;
  losses: number;
  ties: number;
  /** Two-sided exact sign test on wins versus losses, 0 to 1. */
  p: number;
  net: number;
  /** Wins minus losses of I0 against I0 over the same incidents; signed. */
  noiseNet: number;
  noDataNet: number;
}
export interface CampaignView {
  campaignId: string;
  kind: 'hider' | 'meta';
  manifestHash: string;
  plannedRows: number;
  w0ResetProof: string | null;
  budgetHash: string | null;
  rows: CampaignDetailRowView[];
  quarantined: Array<{ rowId: string; reasonCodes: string[] }>;
  noiseControl: { present: boolean; rowId: string | null };
  noDataControl: { present: boolean; rowId: string | null };
  /** Present only for a finished meta campaign whose backend stored the preregistered verdict. */
  metaVerdict?: MetaVerdictView;
}
export interface ProvenanceEdgeView {
  edgeKey: string;
  fromId: string;
  toId: string;
  kind: 'derived_from' | 'source_deleted';
}
export interface ArtifactEligibilityView {
  artifactHash: string;
  state: 'permitted' | 'revoked' | 'source_deleted';
  reasonCode: string;
  sourceIds: string[];
}
export interface ExternalErasureView {
  requestKey: string;
  providerStatus: ProviderErasureStatus;
  regulation: 'gdpr' | 'ccpa' | 'other';
  subjectCount: number;
  receivedAt: string;
  dueBy: string | null;
  completedAt: string | null;
  localExportSuppression: 'active' | 'released';
  history: Array<{ at: string; status: string; snapshotHash: string }>;
  revokedPendingEntries: number;
}
export interface PrivacyView {
  retractionId: string;
  sourceId: string;
  progress: RetractionProgressPayload;
  edges: ProvenanceEdgeView[];
  eligibility: ArtifactEligibilityView[];
  erasure: ExternalErasureView | null;
  retainedBytesCheck: { state: 'checked' | 'not_checked'; violations: number };
}

// ---- Legacy minimal shapes (kept source compatible) ----
export interface ExpungeJobSnapshot {
  jobId: string;
  status: JobStatus;
  sequence: number;
  runId?: string;
  harnessHash?: string;
  updatedAt: string;
}
export interface ExpungeProjectionEvent {
  eventId: string;
  sequence: number;
  jobId: string;
  runId?: string;
  kind: string;
  artifactIds: string[];
  payload: Record<string, unknown>;
}
export interface ExpungeCommittedEvents {
  events: ExpungeProjectionEvent[];
  nextSequence: number;
  streamEpoch?: string;
}
export interface ExpungeFoundationStatus {
  /** `ready` only when the domain service address and read credential are present and well formed. */
  operator: 'ready' | 'setup_only';
  domain: 'configured' | 'unconfigured';
  /** `mongodb` only when a domain service is configured; otherwise there is no authority to name. */
  authority: 'mongodb' | 'unconfigured';
  telemetry: 'disabled' | 'enabled';
  /** Whether writes and reads of job data are possible: needs OWNER_TOKEN on the operator. */
  ownerAuth: 'configured' | 'missing';
  /** Build identity from dist/build-id.json (a hash of the source the build was made from), or null if unbuilt. */
  build: string | null;
}

// ---- Review tool: registered through the client hook and the projection agent allowlist ----
export const expungeReviewSchema = z
  .object({ proposalId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) })
  .strict();
export type ExpungeReviewArgs = z.infer<typeof expungeReviewSchema>;
export const expungeReviewTool = {
  name: 'review_expunge_proposal',
  description:
    'Open the stored human review for an Expunge harness proposal. Pass only the proposal ID. The decision is recorded by the approval issuer; this tool never carries executable arguments.',
  parameters: z.toJSONSchema(expungeReviewSchema),
};
