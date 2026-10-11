import { z } from 'zod';
import type {
  EffectKind,
  ExternalErasureJob,
  JobKind,
  JobStatus,
  MutationClass,
  OutboxState,
  SourceOrigin,
  TargetKind,
} from './index.js';

/**
 * Projection events: sanitized, bounded, backend-written facts the operator UI replays. Each kind has a strict
 * payload schema so raw subject content, grader fields or free model text cannot ride through a `JsonValue`.
 * Shapes mirror docs/ui/B3-PLAN.md section 9 and are frozen in docs/expunge/CONTRACTS.md.
 */
export const PROJECTION_EVENT_KINDS = [
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
export type ProjectionEventKind = (typeof PROJECTION_EVENT_KINDS)[number];

export type JobPhase = 'inspect' | 'resolve' | 'discover' | 'preview' | 'apply' | 'verify' | 'complete';
export type PolicyResult = 'allow' | 'ask' | 'deny';
export type ToolId =
  | 'inspect_scope'
  | 'resolve_subject'
  | 'discover_references'
  | 'preview_cleanup'
  | 'apply_cleanup_batch'
  | 'verify_registered_scope'
  | 'complete_cleanup'
  | 'inspect_harness'
  | 'report_diagnostic';
export type ProviderErasureStatus = ExternalErasureJob['providerStatus'];
export type CandidateState =
  | 'proposed'
  | 'schema_rejected'
  | 'replay_rejected'
  | 'evaluating'
  | 'behavior_rejected'
  | 'waiting_approval'
  | 'eligible'
  | 'promoted'
  | 'stale'
  | 'revoked';
export type JobFailureCode =
  | 'budget_exhausted'
  | 'lease_lost'
  | 'policy_denied'
  | 'verification_failed'
  | 'provider_error'
  | 'world_conflict'
  | 'internal_error';

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
  /** Fixed-vocabulary summary, at most 200 characters, never a subject literal. */
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
  /** Graph node ids touched, at most 100. */
  nodeIds: string[];
}
/**
 * How each delivery proof of an evidence row was obtained, so a consumer never reads an attested or inferred step as
 * an observed one. `worker_attested`: the worker's own SDK queued it in another process and this service could not see
 * it. `inferred`: a later proof implies it (e.g. the signal is visible in the Query API, so ingestion accepted it) but
 * no acceptance was seen. `resend_unverified`: a crash left it unknown whether the first send landed, so it was sent
 * again without proof that the first had not; a vendor-side double count is possible.
 */
export interface EvidenceDelivery {
  sdkEnqueued: 'observed' | 'worker_attested';
  ingestAccepted: 'observed' | 'inferred' | 'resend_unverified';
  queryVisible: 'observed';
  evidenceReady: 'observed';
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
  /** Optional so rows written before delivery labels existed stay valid. */
  delivery?: EvidenceDelivery;
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
  split: 'train' | 'protected' | 'validation' | 'final';
  parentUseful: boolean;
  candidateUseful: boolean;
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
  externalErasureStatus: 'not_required' | 'pending' | 'confirmed' | 'failed';
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
export interface JobFailedPayload {
  code: JobFailureCode;
  retryable: boolean;
  phase: JobPhase | null;
  message: string;
}
/** Additive kinds (2026-10-11): committed signals the UI otherwise had to infer. */
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
  admitted?: boolean;
  w0ResetProof?: string;
  budgetHash?: string;
  result: 'measured' | 'null' | 'invalid';
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

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().max(max);
const instant = z.string().datetime();
const ids = (max: number) => z.array(id).max(max);

const JOB_KINDS = [
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
] as const satisfies readonly JobKind[];
const JOB_STATUSES = [
  'queued',
  'running',
  'waiting_evidence',
  'waiting_approval',
  'waiting_external',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly JobStatus[];
const PHASES = [
  'inspect',
  'resolve',
  'discover',
  'preview',
  'apply',
  'verify',
  'complete',
] as const satisfies readonly JobPhase[];
const TOOLS = [
  'inspect_scope',
  'resolve_subject',
  'discover_references',
  'preview_cleanup',
  'apply_cleanup_batch',
  'verify_registered_scope',
  'complete_cleanup',
  'inspect_harness',
  'report_diagnostic',
] as const satisfies readonly ToolId[];
const EFFECTS = ['delete', 'redact', 'restrict', 'tombstone'] as const satisfies readonly EffectKind[];
const CLASSES = [
  'tightening',
  'behavioral',
  'authority_expansion',
] as const satisfies readonly MutationClass[];
const TARGETS = ['worker', 'improver', 'hider'] as const satisfies readonly TargetKind[];
const ORIGINS = [
  'agent_self_report',
  'verifier_feedback',
  'human_feedback',
  'raindrop_classifier',
  'experiment_result',
  'admission_service',
] as const satisfies readonly SourceOrigin[];
const OUTBOX_STATES = [
  'pending',
  'leased',
  'sdk_enqueued',
  'ingest_accepted',
  'query_visible',
  'evidence_ready',
  'retrying',
  'dead_letter',
] as const satisfies readonly OutboxState[];
const CANDIDATE_STATES = [
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
] as const satisfies readonly CandidateState[];
const PROVIDER_STATUSES = [
  'unsubmitted',
  'pending',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
] as const satisfies readonly ProviderErasureStatus[];
const FAILURE_CODES = [
  'budget_exhausted',
  'lease_lost',
  'policy_denied',
  'verification_failed',
  'provider_error',
  'world_conflict',
  'internal_error',
] as const satisfies readonly JobFailureCode[];

const schema = <T>(shape: z.ZodType<T>): z.ZodType<T> => shape;

/** Strict per-kind payload schemas. Unknown properties, oversized strings and unbounded arrays are rejected. */
export const projectionPayloadSchemas: { [K in ProjectionEventKind]: z.ZodType<ProjectionPayloadByKind[K]> } =
  {
    job_started: schema(
      z
        .object({
          jobKind: z.enum(JOB_KINDS),
          harnessHash: hash,
          worldId: id.optional(),
          scopeRevision: count,
          attempt: count,
        })
        .strict(),
    ),
    tool_decided: schema(
      z
        .object({
          stepId: id,
          phase: z.enum(PHASES),
          toolId: z.enum(TOOLS),
          decision: z.enum(['allow', 'ask', 'deny']),
          ruleIds: ids(64),
          summary: text(200),
          targetCount: count.optional(),
        })
        .strict(),
    ),
    effect_committed: schema(
      z
        .object({
          receiptId: id,
          stepId: id,
          batchOrdinal: count,
          effectKind: z.enum(EFFECTS),
          collectionId: id,
          appliedCount: count,
          resultingWorldRevision: count,
          nodeIds: ids(100),
        })
        .strict(),
    ),
    evidence_ready: schema(
      z
        .object({
          evidenceId: id,
          provider: id,
          externalEventId: id.optional(),
          externalTraceId: id.optional(),
          externalSignalIds: ids(256),
          origin: z.enum(ORIGINS),
          outboxState: z.enum(OUTBOX_STATES),
          truncated: z.boolean(),
          missing: ids(64),
          contentHash: hash,
          permittedUse: z.enum(['training', 'gate_only', 'display_only', 'revoked']),
          delivery: z
            .object({
              sdkEnqueued: z.enum(['observed', 'worker_attested']),
              ingestAccepted: z.enum(['observed', 'inferred', 'resend_unverified']),
              queryVisible: z.literal('observed'),
              evidenceReady: z.literal('observed'),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    candidate_proposed: schema(
      z
        .object({
          candidateId: id,
          target: z.enum(TARGETS),
          parentHash: hash,
          childHash: hash,
          claimedClass: z.enum(CLASSES),
          computedClass: z.enum(CLASSES),
          surfaces: ids(16),
          hypothesis: text(1000),
          state: z.enum(CANDIDATE_STATES),
        })
        .strict(),
    ),
    trial_completed: schema(
      z
        .object({
          reportId: id.nullable(),
          candidateId: id,
          pairId: id,
          family: id,
          split: z.enum(['train', 'protected', 'validation', 'final']),
          parentUseful: z.boolean(),
          candidateUseful: z.boolean(),
          verdict: z.enum(['admit', 'reject', 'hold']).nullable(),
        })
        .strict(),
    ),
    approval_required: schema(
      z
        .object({
          proposalId: id,
          candidateId: id,
          computedClass: z.enum(CLASSES),
          flipSetDigest: hash,
          expiresAt: instant,
        })
        .strict(),
    ),
    harness_promoted: schema(
      z
        .object({
          promotionId: id,
          target: z.enum(TARGETS),
          fromHash: hash,
          toHash: hash,
          fromRevision: count,
          toRevision: count,
          gateReportId: id,
          consumedGrantId: id.nullable(),
        })
        .strict(),
    ),
    receipt_committed: schema(
      z
        .object({
          receiptId: id,
          domainStatus: z.enum(['complete_in_registered_scope', 'incomplete']),
          externalErasureStatus: z.enum(['not_required', 'pending', 'confirmed', 'failed']),
          verifiedWorldRevision: count,
        })
        .strict(),
    ),
    external_erasure_updated: schema(
      z
        .object({
          requestKey: id,
          providerStatus: z.enum(PROVIDER_STATUSES),
          dueBy: instant.nullable(),
          completedAt: instant.nullable(),
          subjectCount: count,
          snapshotHash: hash,
        })
        .strict(),
    ),
    job_failed: schema(
      z
        .object({
          code: z.enum(FAILURE_CODES),
          retryable: z.boolean(),
          phase: z.enum(PHASES).nullable(),
          message: text(500),
        })
        .strict(),
    ),
    job_status_changed: schema(
      z.object({ from: z.enum(JOB_STATUSES), to: z.enum(JOB_STATUSES), reason: text(200) }).strict(),
    ),
    cancel_requested: schema(z.object({ requestedAt: instant, by: z.enum(['owner', 'system']) }).strict()),
    approval_resolved: schema(
      z
        .object({
          proposalId: id,
          decision: z.enum(['approved', 'declined', 'expired', 'stale']),
          grantId: id.nullable(),
        })
        .strict(),
    ),
    harness_rolled_back: schema(
      z
        .object({
          promotionId: id,
          target: z.enum(TARGETS),
          fromHash: hash,
          toHash: hash,
          testedParentHash: hash,
          reason: text(300),
        })
        .strict(),
    ),
    retraction_progress: schema(
      z
        .object({
          retractionId: id,
          sourceId: id,
          frontierSize: count,
          visited: count,
          closureComplete: z.boolean(),
          revoked: count,
          regenerated: count,
          runsCancelled: count,
          failClosed: z.boolean(),
        })
        .strict(),
    ),
    campaign_row_committed: schema(
      z
        .object({
          campaignId: id,
          manifestHash: hash,
          kind: z.enum(['hider', 'meta']),
          rowId: id,
          admitted: z.boolean().optional(),
          w0ResetProof: text(256).optional(),
          budgetHash: hash.optional(),
          result: z.enum(['measured', 'null', 'invalid']),
        })
        .strict(),
    ),
  };

export function isProjectionEventKind(value: unknown): value is ProjectionEventKind {
  return typeof value === 'string' && (PROJECTION_EVENT_KINDS as readonly string[]).includes(value);
}
/** Parses `payload` against the strict schema of `kind`; throws `InvalidProjectionPayload:<kind>` otherwise. */
export function validateProjectionPayload<K extends ProjectionEventKind>(
  kind: K,
  payload: unknown,
): ProjectionPayloadByKind[K] {
  if (!isProjectionEventKind(kind)) throw new Error('InvalidProjectionKind');
  const parsed = projectionPayloadSchemas[kind].safeParse(payload);
  if (!parsed.success) throw new Error(`InvalidProjectionPayload:${kind}`);
  return parsed.data;
}
