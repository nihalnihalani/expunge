import { createHash } from 'node:crypto';
import canonicalizeModule from 'canonicalize';
const canonicalize = canonicalizeModule as unknown as (value: unknown) => string | undefined;
import { z } from 'zod';
import type { ProjectionEventKind } from './projection.js';

export * from './projection.js';

export const CONTRACT_VERSION = 1 as const;
export const GUARDRAIL_MAX_DEPTH = 8;
export const GUARDRAIL_MAX_NODES = 2048;
export type Environment = 'dev' | 'evaluation' | 'demo';
export type TargetKind = 'worker' | 'improver' | 'hider';
export type EffectKind = 'delete' | 'redact' | 'restrict' | 'tombstone';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ActorContext = {
  actorId: string;
  tenantId: string;
  env: Environment;
  scopeId: string;
  authorizationRevision: number;
};
export type ScopeKey = Pick<ActorContext, 'tenantId' | 'env' | 'scopeId'>;
export type DeploymentKey = ScopeKey & { target: TargetKind };
export type RunBinding = {
  jobId: string;
  runId: string;
  worldId: string;
  harnessHash: string;
  scopeRevision: number;
  workerProfileHash: string;
};
export type DomainAddress = {
  collectionId: string;
  recordId: string | number;
  recordIdBsonType: 'string' | 'objectId' | 'int' | 'long';
};
export type FieldDescriptor = {
  fieldId: string;
  collectionId: string;
  path: string[];
  bsonTypes: string[];
  isArray: boolean;
  sanitized: boolean;
};
export type ReferenceDeclaration = {
  edgeId: string;
  fromCollectionId: string;
  fromFieldId: string;
  toCollectionId: string;
  toFieldId: string;
  identityRule: 'same_bson_type' | 'string_to_objectId' | 'objectId_to_string';
};
export type ScopeRegistry = ScopeKey & {
  revision: number;
  collectionIds: string[];
  fields: FieldDescriptor[];
  referenceEdges: ReferenceDeclaration[];
  allowedEffectKinds: EffectKind[];
  eligibilityPolicyId: string;
  eligibilityPolicyHash: string;
  documentLimits: { maxScanned: number; maxChanged: number };
  discoveryCompleteness: { kind: 'declared' | 'observed' | 'partial'; limitations: string[] };
};
export type WorldRevision = ScopeKey & {
  worldId: string;
  revision: number;
  scopeRevision: number;
  maintenanceMode: boolean;
  updatedAt: Date;
};
/**
 * The trusted binding of a world to a scope revision, stored apart from the revision counter so the worker
 * principal can advance the counter without being able to rewrite the binding or toggle maintenance.
 */
export type WorldScopeBinding = ScopeKey & {
  worldId: string;
  scopeRevision: number;
  maintenanceMode: boolean;
  updatedAt: Date;
};
export type WorldSpec = {
  contractVersion: 1;
  seedCommitment: string;
  family: string;
  identityRecipe: { subjectOrdinal: number; aliasCount: number };
  collectionLayouts: Array<{
    collectionId: 'customers' | 'accounts' | 'messages' | 'events' | 'notes' | 'archives';
    identityPath: string[];
    referencePath: string[];
    layout: 'direct' | 'nested' | 'array' | 'reference' | 'mixed';
  }>;
  referenceTopology: { maxHops: number; includeCycles: boolean; duplicateReferences: boolean };
  unrelatedRecipes: { documentsPerCollection: number; namesakeCount: number };
  eligibilityPolicy: { id: string; hash: string; effects: EffectKind[] };
  faults: {
    partialAcknowledgements: number;
    interruptAfterEffects: number | null;
    transientFailures: number;
  };
  resourceBounds: { maxDocuments: number; maxReferenceHops: number };
};
export type ContextPolicy = {
  schemaMode: 'selected_fields' | 'all_registered_fields' | 'inspect_then_select';
  includeNestedArrays: boolean;
  referenceDepth: number;
  lessonRecall: { mode: 'exact' | 'hybrid'; topK: number; moduleIds: string[] };
  sourceEligibilityPolicyHash: string;
  maxContextTokens: number;
  evidenceFormat: 'score_only' | 'trace_and_score' | 'contrastive_traces';
};
export type WorkflowGraph = {
  entryNodeId: string;
  nodes: Array<{ id: string; toolId: string; inputBindings: Record<string, string>; maxVisits: number }>;
  edges: Array<{
    from: string;
    to: string;
    when: 'success' | 'more_references' | 'needs_approval' | 'retryable_error' | 'verification_failed';
  }>;
  terminalNodeIds: string[];
};
export type ToolPolicy = {
  grants: string[];
  prerequisites: Array<{
    toolId: string;
    requiredArtifact: 'preview_plan' | 'action_receipt' | 'completion_receipt' | 'approval_grant';
    binding: 'same_job_same_plan_current_revision';
  }>;
};
export type ResourceLimits = {
  modelCalls: number;
  toolCalls: number;
  scannedDocuments: number;
  changedDocuments: number;
  traversalDepth: number;
  graphNodes: number;
  graphEdges: number;
  wallTimeMs: number;
  totalTokens: number;
  maxCostMicrousd: number;
};
export type FactOperand =
  | { kind: 'fact'; factId: string }
  | { kind: 'binding'; bindingId: string }
  | {
      kind: 'constant';
      value:
        | number
        | boolean
        | 'valid'
        | 'invalid'
        | 'running'
        | 'retained'
        | 'eligible'
        | 'delete'
        | 'redact'
        | 'restrict'
        | 'tombstone';
    };
export type GuardrailPredicate =
  | { op: 'all' | 'any'; predicates: GuardrailPredicate[] }
  | { op: 'not'; predicate: GuardrailPredicate }
  | {
      op: 'compare';
      comparator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      left: FactOperand;
      right: FactOperand;
    }
  | { op: 'receipt_valid'; bindingId: string }
  | {
      op: 'prior_effect_count';
      toolId: string;
      comparator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
      count: number;
    };
export type GuardrailAst = {
  ruleId: string;
  predicate: GuardrailPredicate;
  result: 'allow' | 'ask' | 'deny';
  sourceEvidenceIds: string[];
  /**
   * Worker tool ids this rule applies to. Absent or empty means every tool call. Ids are validated against the
   * compiler vocabulary by the compiler, not here.
   */
  appliesTo?: string[];
};
export type PluginBinding = {
  slot: 'discovery' | 'context' | 'critic';
  sourceHash: string;
  compiledHash: string;
  abiHash: string;
  sandboxProfileHash: string;
  exportName: string;
  inputSchemaHash: string;
  outputSchemaHash: string;
};
export type SourceOrigin =
  | 'agent_self_report'
  | 'verifier_feedback'
  | 'human_feedback'
  | 'raindrop_classifier'
  | 'experiment_result'
  | 'admission_service';
export type EvidenceReference = {
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
};
export type HarnessBundle = {
  contractVersion: 1;
  target: TargetKind;
  parentHash: string | null;
  contextPolicy: ContextPolicy;
  workflow: WorkflowGraph;
  guardrails: GuardrailAst[];
  toolPolicy: ToolPolicy;
  completionPolicy: 'model_narrative' | 'verified_receipt';
  pluginArtifacts: PluginBinding[];
  limits: ResourceLimits;
  evidence: EvidenceReference[];
  runtimeAdapterHash: string;
  compilerHash: string;
  vocabularyHash: string;
  authorityFloorHash: string;
  eligibilityPolicyHash: string;
};
export type ArtifactEnvelope<T = HarnessBundle> = {
  _id: string;
  payload: T;
  createdAt: Date;
  sourceBlobIds: string[];
};
export type JobKind =
  | 'cleanup'
  | 'observe'
  | 'propose'
  | 'evaluate'
  | 'promote'
  | 'rollback'
  | 'redact'
  | 'external_delete'
  | 'adversarial_generate'
  | 'meta_evaluate';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_evidence'
  | 'waiting_approval'
  | 'waiting_external'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type Lease = { ownerId: string; fence: number; until: Date; heartbeatAt: Date };
export type Job = {
  _id: string;
  kind: JobKind;
  actor: ActorContext;
  binding: RunBinding;
  parentJobId: string | null;
  checkpoint: JsonValue;
  status: JobStatus;
  cancellationRequested: boolean;
  lease: Lease;
  commitSeq: number;
  eventSeq: number;
  attempt: number;
  priority: number;
  inputRefs: string[];
  outputRefs: string[];
  /**
   * Every artifact, evidence and lesson hash the run actually placed in model context. The trusted runtime
   * fills it; revocation matches on it in addition to `binding.harnessHash`. Absent means none recorded.
   */
  contextInputs?: string[];
  createdAt: Date;
  updatedAt: Date;
};
export type PolicyDecision = {
  result: 'allow' | 'ask' | 'deny';
  ruleIds: string[];
  authorizationRevision: number;
};
export type ActionIntent = {
  intentId: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  stepId: string;
  approvedPlanHash: string;
  batchOrdinal: number;
  targetAddresses: DomainAddress[];
  targetHash: string;
  effectKind: EffectKind;
  expectedDocumentVersions: Array<{ address: DomainAddress; version: number }>;
  worldRevision: number;
  policyDecision: PolicyDecision;
  effectKey: string;
  argsDigest: string;
  /**
   * Id of the policy decision ledger row that authorizes this intent. It is a digest over the intent's own
   * identity fields and its `policyDecision`, so a decision cannot be fabricated, edited or reused for another
   * action: the row must already exist in the same scope.
   */
  decisionId: string;
};
/** What the gateway knew when it decided one call; replay reads exactly this, never later state. */
export type DecisionInputsRecord = {
  facts: Record<string, JsonValue>;
  bindings: Record<string, JsonValue>;
  prior: Record<string, JsonValue>;
  /** ISO time each fact, binding or prior-effect value was observed; later values are future for replay. */
  observedAt?: Record<string, string>;
};
/** One row of the per-scope decision ledger written by the trusted gateway before an effect may commit. */
export type DecisionRecord = ScopeKey & {
  decisionId: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  stepId: string;
  batchOrdinal: number;
  argsDigest: string;
  decision: PolicyDecision;
  decidedAt: Date;
  /** Worker tool the decision governs (read-only tools are recorded too). */
  toolId?: string;
  inputs?: DecisionInputsRecord;
  /** contentHash of `inputs`, so a replay can prove it read the inputs the gateway used. */
  inputsDigest?: string;
};
/** Authoritative owner authorization state for one scope. Only setup and the approval issuer write it. */
export type AuthorityRevision = ScopeKey & {
  authorizationRevision: number;
  floorHash: string;
  updatedAt: Date;
};
export type AppliedEffect = {
  address: DomainAddress;
  kind: EffectKind;
  preHash: string;
  postHash: string | null;
  preVersion: number;
  postVersion: number | null;
};
export type ActionReceipt = {
  receiptId: string;
  effectKey: string;
  intentHash: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  appliedEffects: AppliedEffect[];
  resultingWorldRevision: number;
  leaseFence: number;
  status: 'committed';
  evidenceRefs: string[];
};
export type CompletionReceipt = {
  receiptId: string;
  jobId: string;
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
  externalErasureStatus: 'not_required' | 'pending' | 'confirmed' | 'failed';
};
export type CostSummary = {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  unpricedCalls: number;
  mongoOperations: number;
  wallTimeMs: number;
};
export type EvidenceBundle = {
  evidenceId: string;
  actor: ScopeKey;
  binding: RunBinding;
  tools: Array<{ toolId: string; input: JsonValue; output: JsonValue; decision: PolicyDecision }>;
  failureWitnesses: JsonValue[];
  diagnostics: JsonValue[];
  modelOutput: string;
  sources: EvidenceReference[];
  cost: CostSummary;
  confidence: number;
  split: 'train' | 'protected' | 'validation' | 'final';
};
export type OutboxState =
  | 'pending'
  | 'leased'
  | 'sdk_enqueued'
  | 'ingest_accepted'
  | 'query_visible'
  | 'evidence_ready'
  | 'retrying'
  | 'dead_letter';
export type TelemetryOutbox = ScopeKey & {
  operationId: string;
  kind: string;
  dedupeKey: string;
  jobId: string;
  payload: JsonValue;
  status: OutboxState;
  attempts: number;
  nextAttemptAt: Date;
  lease: Lease;
  evidenceRequired: string[];
  attained: Partial<Record<OutboxState, { at: Date; contentHash: string; externalReceiptId?: string }>>;
  lastErrorCode?: string;
  createdAt: Date;
  updatedAt: Date;
};
export type ObserverQueryIdentity = {
  projectId: string;
  observerVersion: string;
  filterSnapshot: JsonValue;
  filterHash: string;
  windowStart: string;
  windowEnd: string;
  overlapMs: number;
  backfillPolicy: 'pending_ids_and_overlap' | 'fixed_window';
};
export type ObserverCursor = ObserverQueryIdentity & {
  _id: string;
  revision: number;
  providerCursor: string | null;
  pendingEnrichmentIds: string[];
  lastCommittedProcessingAt: Date;
};
export type ExternalErasureJob = ScopeKey & {
  requestKey: string;
  providerOrganizationId: string;
  requester: string;
  regulation: 'gdpr' | 'ccpa' | 'other';
  namespacedUserIds: string[];
  localExportSuppression: 'active' | 'released';
  remoteJobId: string | null;
  receivedAt: Date;
  dueBy: Date | null;
  completedAt: Date | null;
  providerStatus: 'unsubmitted' | 'pending' | 'in_progress' | 'completed' | 'rejected' | 'cancelled';
  subjectEntries: Array<{ user_id: string; requested_on: string; revoked_at: string | null }>;
  providerSnapshot: JsonValue | null;
  history: Array<{ at: Date; status: string; snapshotHash: string }>;
};
export type ExternalDeletion = ExternalErasureJob;
export type MutationClass = 'tightening' | 'behavioral' | 'authority_expansion';
export type TypedPatch = {
  surface: 'context' | 'workflow' | 'guardrails' | 'tool_policy' | 'plugin';
  path: string;
  before: JsonValue;
  after: JsonValue;
  sourceEvidenceIds: string[];
  hypothesis: string;
};
export type Candidate = {
  candidateId: string;
  actor: ScopeKey;
  target: TargetKind;
  parentHash: string;
  childHash: string;
  patches: TypedPatch[];
  hypothesis: string;
  sourceEvidence: EvidenceReference[];
  claimedClass: MutationClass;
  computedClass: MutationClass;
  artifactHashes: string[];
  state:
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
};
export type TrialMetrics = {
  usefulCompletion: boolean;
  targetedResiduals: number;
  unrelatedRecordChanges: number;
  retentionViolations: number;
  truthfulTerminal: boolean;
  refused: boolean;
  retryFailures: number;
  cost: CostSummary;
};
export type TrialPair = {
  pairId: string;
  family: string;
  seedCommitment: string;
  parentRunId: string;
  candidateRunId: string;
  workerProfileHash: string;
  budgetHash: string;
  faultPlanHash: string;
  parent: TrialMetrics;
  candidate: TrialMetrics;
};
export type GateReport = {
  reportId: string;
  candidateId: string;
  parentHash: string;
  childHash: string;
  evaluatorHash: string;
  fixtureGeneratorHash: string;
  runtimeHash: string;
  workerProfileHash: string;
  splitManifestCommitment: string;
  pairedTrials: TrialPair[];
  trialRowsDigest: string;
  causalControls: JsonValue;
  knownAuthorityFlips: string[];
  cost: CostSummary;
  verdict: 'admit' | 'reject' | 'hold';
  reasonCodes: string[];
  /**
   * The gate's trusted classification of the child against its parent. Only the grader principal can write a
   * gate report, so this is the sole source `promote` uses to decide whether a grant is required. Absent on
   * reports written before the field existed; promotion fails closed without it.
   */
  computedClass?: MutationClass;
};
export type ApprovalGrant = DeploymentKey & {
  grantId: string;
  proposalId: string;
  parentHash: string;
  childHash: string;
  parentRevision: number;
  approvedDescriptor: JsonValue;
  authorizationRevision: number;
  scopeRevision: number;
  flipSetDigest: string;
  gateReportId: string;
  gateReportDigest: string;
  approverId: string;
  expiresAt: Date;
  nonce: string;
  consumedAt?: Date;
  consumedBy?: string;
  createdAt: Date;
};
export type Deployment = DeploymentKey & {
  _id: string;
  activeHash: string;
  revision: number;
  scopeRevision: number;
  authorizationRevision: number;
  updatedAt: Date;
};
export type PromotionReceipt = DeploymentKey & {
  promotionId: string;
  fromHash: string;
  toHash: string;
  fromRevision: number;
  toRevision: number;
  gateReportId: string;
  gateReportDigest: string;
  consumedGrantId?: string;
  runtimeHash: string;
  evaluatorHash: string;
  reason: string;
  createdAt: Date;
};
export type MetaTrial = {
  metaTrialId: string;
  incidentId: string;
  workerBaseHash: string;
  improver0Hash: string;
  improver1Hash: string;
  resultingWorker0Hash: string;
  resultingWorker1Hash: string;
  improvementBudgetHash: string;
  futureTrials: TrialPair[];
  noiseControl: boolean;
};
export type AdversaryTrial = {
  adversaryTrialId: string;
  specHash: string;
  referenceSolverHash: string;
  admitted: boolean;
  reasonCodes: string[];
  noveltyFamily: string;
  resourceBounds: WorldSpec['resourceBounds'];
  workerRunId: string | null;
  metrics: TrialMetrics | null;
};
export type ProjectionEvent = ScopeKey & {
  sequence: number;
  eventId: string;
  jobId: string;
  runId: string;
  artifactIds: string[];
  kind: ProjectionEventKind;
  payload: JsonValue;
  createdAt: Date;
};
export type ProvenanceEdge = ScopeKey & {
  edgeKey: string;
  fromId: string;
  toId: string;
  kind: 'derived_from' | 'source_deleted';
  createdAt: Date;
};
export type ArtifactEligibility = ScopeKey & {
  artifactHash: string;
  state: 'permitted' | 'revoked' | 'source_deleted';
  policyHash: string;
  reasonCode: string;
  sourceIds: string[];
  updatedAt: Date;
};

/**
 * Stored approval policy for one DeploymentKey. Only the `behavioral` class is policy-selectable; an
 * authority expansion always needs a grant and a tightening never does.
 */
export type AuthorityPolicy = DeploymentKey & {
  behavioralRequiresApproval: boolean;
  createdAt: Date;
};

/** Refuses implicit Date/BSON/toJSON conversion, sparse arrays, undefined and non-I-JSON values. */
export function assertCanonicalJson(value: unknown, path = '$'): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
      throw new Error(`InvalidUnicode:${path}`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`InvalidNumber:${path}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new Error(`SparseArray:${path}`);
      assertCanonicalJson(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      assertCanonicalJson(key, `${path}:key`);
      assertCanonicalJson(child, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`NonCanonicalJson:${path}`);
}
export function canonicalJson(value: unknown): string {
  assertCanonicalJson(value);
  const result = canonicalize(value);
  if (typeof result !== 'string') throw new Error('CanonicalizationFailed');
  return result;
}
export function contentHash(value: unknown, domain = 'artifact'): string {
  if (!/^[a-z0-9_-]+$/.test(domain)) throw new Error('InvalidHashDomain');
  return createHash('sha256')
    .update(`expunge:contract:1:${domain}\n`)
    .update(canonicalJson(value))
    .digest('hex');
}
export function scopeIdentity(key: ScopeKey): string {
  return contentHash({ tenantId: key.tenantId, env: key.env, scopeId: key.scopeId }, 'scope');
}
export function deploymentIdentity(key: DeploymentKey): string {
  return contentHash(
    { tenantId: key.tenantId, env: key.env, scopeId: key.scopeId, target: key.target },
    'deployment',
  );
}
export function sameScope(a: ScopeKey, b: ScopeKey): boolean {
  return a.tenantId === b.tenantId && a.env === b.env && a.scopeId === b.scopeId;
}
export function assertJobAccess(actor: ActorContext, job: Job): void {
  if (
    !sameScope(actor, job.actor) ||
    actor.actorId !== job.actor.actorId ||
    actor.authorizationRevision !== job.actor.authorizationRevision
  )
    throw new Error('UnauthorizedJob');
  if (job.binding.jobId !== job._id) throw new Error('InvalidJobBinding');
}
export function observerQueryHash(query: Omit<ObserverQueryIdentity, 'filterHash'>): string {
  return contentHash(query, 'observer-query');
}

/** Field path grammar (OWNERSHIP.md frozen interface 2), shared by fixtures, mongo scope compile and discovery. */
export const FIELD_PATH_WILDCARD = '*';
export const FIELD_PATH_MAX_SEGMENTS = 16;
const FIELD_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/**
 * The only path that may name the MongoDB record key. It is readable as a registered field but is not a
 * member of the frozen field path grammar, so `isFieldPath(['_id'])` stays false.
 */
export const RECORD_KEY_PATH: readonly ['_id'] = ['_id'];

/**
 * True when `path` is a non-sparse array of 1..16 segments where each segment is an identifier matching
 * `/^[A-Za-z][A-Za-z0-9_]{0,31}$/` or the literal `*`, the first segment is not `*`, and `*` occurs at most once.
 * `*` means every element of the array at that position.
 */
export function isFieldPath(path: unknown): path is string[] {
  if (!Array.isArray(path) || path.length < 1 || path.length > FIELD_PATH_MAX_SEGMENTS) return false;
  let wildcards = 0;
  for (let index = 0; index < path.length; index++) {
    if (!(index in path)) return false;
    const segment: unknown = path[index];
    if (typeof segment !== 'string') return false;
    if (segment === FIELD_PATH_WILDCARD) {
      if (index === 0 || ++wildcards > 1) return false;
    } else if (!FIELD_PATH_SEGMENT.test(segment)) return false;
  }
  return true;
}
/**
 * Envelope fields written by trusted code only: the tenant/env/world binding, record version and owner policy
 * metadata. A registered field may never address them, so a write plan can never re-tenant or re-policy a record.
 */
export const RESERVED_ENVELOPE_FIELDS: readonly string[] = [
  '_id',
  '_rev',
  'tenantId',
  'env',
  'worldId',
  'scopeId',
  'eligibility',
  'access',
  'lifecycle',
];
/** Registered business fields live below this subtree of a domain document. */
export const REGISTRY_DATA_ROOT = 'data';

/** The record key descriptor: readable so reference edges can name it, never writable. */
export function isRecordKeyPath(path: unknown): path is string[] {
  return Array.isArray(path) && path.length === 1 && path[0] === RECORD_KEY_PATH[0];
}
/**
 * Paths a ScopeRegistry field descriptor may carry: the read-only record key `['_id']`, or a path inside the
 * `data` subtree that satisfies `isFieldPath` (at least one segment below `data`). Envelope fields such as
 * `tenantId` or `_rev` are rejected even though `isFieldPath` alone would accept most of them.
 */
export function isRegistryFieldPath(path: unknown): path is string[] {
  if (isRecordKeyPath(path)) return true;
  return (
    isFieldPath(path) &&
    path.length >= 2 &&
    path[0] === REGISTRY_DATA_ROOT &&
    !RESERVED_ENVELOPE_FIELDS.includes(path[0])
  );
}
/** Validates and decomposes a field path; throws `InvalidFieldPath` for anything outside the grammar. */
export function parseFieldPath(path: string[]): { segments: string[]; wildcardIndex: number | null } {
  if (!isFieldPath(path)) throw new Error('InvalidFieldPath');
  const index = path.indexOf(FIELD_PATH_WILDCARD);
  return { segments: [...path], wildcardIndex: index === -1 ? null : index };
}

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const operand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fact'), factId: id }).strict(),
  z.object({ kind: z.literal('binding'), bindingId: id }).strict(),
  z
    .object({
      kind: z.literal('constant'),
      value: z.union([
        z.number().finite().min(-1e9).max(1e9),
        z.boolean(),
        z.enum([
          'valid',
          'invalid',
          'running',
          'retained',
          'eligible',
          'delete',
          'redact',
          'restrict',
          'tombstone',
        ]),
      ]),
    })
    .strict(),
]);
const predicate: z.ZodType<GuardrailPredicate> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['all', 'any']), predicates: z.array(predicate).min(1).max(32) }).strict(),
    z.object({ op: z.literal('not'), predicate }).strict(),
    z
      .object({
        op: z.literal('compare'),
        comparator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
        left: operand,
        right: operand,
      })
      .strict(),
    z.object({ op: z.literal('receipt_valid'), bindingId: id }).strict(),
    z
      .object({
        op: z.literal('prior_effect_count'),
        toolId: id,
        comparator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']),
        count: integer,
      })
      .strict(),
  ]),
);
export const harnessBundleSchema: z.ZodType<HarnessBundle> = z
  .object({
    contractVersion: z.literal(1),
    target: z.enum(['worker', 'improver', 'hider']),
    parentHash: hash.nullable(),
    contextPolicy: z
      .object({
        schemaMode: z.enum(['selected_fields', 'all_registered_fields', 'inspect_then_select']),
        includeNestedArrays: z.boolean(),
        referenceDepth: integer.max(16),
        lessonRecall: z
          .object({
            mode: z.enum(['exact', 'hybrid']),
            topK: integer.max(100),
            moduleIds: z.array(id).max(100),
          })
          .strict(),
        sourceEligibilityPolicyHash: hash,
        maxContextTokens: integer,
        evidenceFormat: z.enum(['score_only', 'trace_and_score', 'contrastive_traces']),
      })
      .strict(),
    workflow: z
      .object({
        entryNodeId: id,
        nodes: z
          .array(
            z
              .object({ id, toolId: id, inputBindings: z.record(id), maxVisits: integer.min(1).max(100) })
              .strict(),
          )
          .min(1)
          .max(128),
        edges: z
          .array(
            z
              .object({
                from: id,
                to: id,
                when: z.enum([
                  'success',
                  'more_references',
                  'needs_approval',
                  'retryable_error',
                  'verification_failed',
                ]),
              })
              .strict(),
          )
          .max(256),
        terminalNodeIds: z.array(id).min(1).max(128),
      })
      .strict(),
    guardrails: z
      .array(
        z
          .object({
            ruleId: id,
            predicate,
            result: z.enum(['allow', 'ask', 'deny']),
            sourceEvidenceIds: z.array(id).max(64),
            appliesTo: z.array(id).max(16).optional(),
          })
          .strict(),
      )
      .max(128),
    toolPolicy: z
      .object({
        grants: z.array(id).max(128),
        prerequisites: z
          .array(
            z
              .object({
                toolId: id,
                requiredArtifact: z.enum([
                  'preview_plan',
                  'action_receipt',
                  'completion_receipt',
                  'approval_grant',
                ]),
                binding: z.literal('same_job_same_plan_current_revision'),
              })
              .strict(),
          )
          .max(128),
      })
      .strict(),
    completionPolicy: z.enum(['model_narrative', 'verified_receipt']),
    pluginArtifacts: z
      .array(
        z
          .object({
            slot: z.enum(['discovery', 'context', 'critic']),
            sourceHash: hash,
            compiledHash: hash,
            abiHash: hash,
            sandboxProfileHash: hash,
            exportName: id,
            inputSchemaHash: hash,
            outputSchemaHash: hash,
          })
          .strict(),
      )
      .max(3),
    limits: z
      .object({
        modelCalls: integer,
        toolCalls: integer,
        scannedDocuments: integer,
        changedDocuments: integer,
        traversalDepth: integer.max(16),
        graphNodes: integer,
        graphEdges: integer,
        wallTimeMs: integer,
        totalTokens: integer,
        maxCostMicrousd: integer,
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            provider: id,
            externalEventId: id.optional(),
            externalTraceId: id.optional(),
            externalSignalIds: z.array(id).max(256),
            localSourceIds: z.array(id).max(256),
            origin: z.enum([
              'agent_self_report',
              'verifier_feedback',
              'human_feedback',
              'raindrop_classifier',
              'experiment_result',
              'admission_service',
            ]),
            redactionPolicy: id,
            retrievedAt: z.string().datetime(),
            contentHash: hash,
            permittedUse: z.enum(['training', 'gate_only', 'display_only', 'revoked']),
          })
          .strict(),
      )
      .max(128),
    runtimeAdapterHash: hash,
    compilerHash: hash,
    vocabularyHash: hash,
    authorityFloorHash: hash,
    eligibilityPolicyHash: hash,
  })
  .strict();
export function validateHarnessBundle(value: unknown): HarnessBundle {
  assertCanonicalJson(value);
  const bundle = harnessBundleSchema.parse(value);
  let count = 0;
  const walk = (p: GuardrailPredicate, depth: number) => {
    if (++count > GUARDRAIL_MAX_NODES || depth > GUARDRAIL_MAX_DEPTH) throw new Error('GuardrailBounds');
    if (p.op === 'all' || p.op === 'any') p.predicates.forEach((c) => walk(c, depth + 1));
    else if (p.op === 'not') walk(p.predicate, depth + 1);
  };
  bundle.guardrails.forEach((g) => walk(g.predicate, 0));
  const ids = new Set(bundle.workflow.nodes.map((n) => n.id));
  if (
    ids.size !== bundle.workflow.nodes.length ||
    !ids.has(bundle.workflow.entryNodeId) ||
    bundle.workflow.terminalNodeIds.some((t) => !ids.has(t)) ||
    bundle.workflow.edges.some((e) => !ids.has(e.from) || !ids.has(e.to))
  )
    throw new Error('InvalidWorkflowReferences');
  return bundle;
}
