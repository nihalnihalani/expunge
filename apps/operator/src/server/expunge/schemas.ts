import { z } from 'zod';
import {
  ARTIFACT_KINDS,
  CANDIDATE_STATES,
  EFFECT_KINDS,
  ENVIRONMENTS,
  EXTERNAL_ERASURE_STATUSES,
  JOB_FAILURE_CODES,
  JOB_KINDS,
  JOB_PHASES,
  JOB_STATUSES,
  MUTATION_CLASSES,
  OUTBOX_STATES,
  POLICY_RESULTS,
  PROJECTION_KINDS,
  PROVIDER_ERASURE_STATUSES,
  SOURCE_ORIGINS,
  TARGET_KINDS,
  TOOL_IDS,
  type ApprovalDescriptorView,
  type ArtifactEnvelope,
  type CampaignView,
  type CandidateView,
  type CleanupPreview,
  type CompletionReceiptView,
  type DeploymentView,
  type EvidenceBundleView,
  type ExpungeJobList,
  type ExpungeJobSnapshotV2,
  type ExternalErasureView,
  type ForwardedProjectionEvent,
  type GateReportView,
  type GraphPage,
  type ModelNarrativeView,
  type PrivacyView,
  type ProjectionKind,
  type RecordDetail,
  type SourceBindingView,
  type SourceReadinessView,
  type WorldSummary,
} from '../../shared/expunge.js';

/**
 * Every response from the domain service passes through these schemas before it is
 * forwarded to the browser (DA-1 K9). Object schemas strip unknown fields, every
 * string and array is bounded, and a failure rejects the whole response. Failures
 * carry only issue paths and codes, never the offending values.
 */
export class ProjectionRejected extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super('Projection payload rejected.');
    this.name = 'ProjectionRejected';
    this.issues = issues;
  }
}

const text = (max: number) => z.string().max(max);
// Same bounds as packages/contracts/src/projection.ts so a payload the backend may write is never
// refused here; path parameters are validated separately and more strictly (routes.ts).
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime();
const int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bson = z.enum(['objectId', 'string', 'int', 'long']);
export const environmentSchema = z.enum(ENVIRONMENTS);
const env = environmentSchema;
const idList = (max: number) => z.array(id).max(max);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sourceKind = z.enum(['original', 'isolated_replay']);
const sourceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export const sourceBindingSchema: z.ZodType<SourceBindingView> = z.object({
  sourceId,
  sourceKind,
  registrationHash: hash,
  registrationRevision: revision,
  policyRevision: revision,
  authorizationRevision: revision,
});

export const sourceReadinessSchema: z.ZodType<SourceReadinessView> = z
  .object({
    registration: z.enum(['missing', 'active', 'revoked', 'unsupported']),
    permission: z.enum(['not_checked', 'authorized', 'denied', 'revoked']),
    sourceId: sourceId.nullable(),
    sourceKind: sourceKind.nullable(),
    sourceRegistrationHash: hash.nullable(),
    registrationRevision: revision.nullable(),
    policyRevision: revision.nullable(),
    authorizationRevision: revision.nullable(),
  })
  .superRefine((source, context) => {
    if (
      source.registration === 'active' &&
      [
        source.sourceId,
        source.sourceKind,
        source.sourceRegistrationHash,
        source.registrationRevision,
        source.policyRevision,
        source.authorizationRevision,
      ].some((value) => value === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['registration'],
        message: 'Active source requires a complete binding.',
      });
    if (source.permission === 'authorized' && source.registration !== 'active')
      context.addIssue({
        code: 'custom',
        path: ['permission'],
        message: 'Cleanup permission requires an active registration.',
      });
  });

// ---- Readiness body from the domain ----
export const domainReadinessSchema = z.object({
  backend: z.object({
    kind: z.enum(['live', 'fixture']),
    version: text(64).nullable(),
  }),
  scope: z.object({ bound: z.boolean() }),
  source: sourceReadinessSchema.nullable().optional(),
  evidence: z.object({
    configured: z.boolean(),
    writeProvenAt: iso.nullable(),
    readBackProvenAt: iso.nullable(),
    deadLetters: int,
  }),
});
export type DomainReadiness = z.infer<typeof domainReadinessSchema>;

// ---- Worlds and previews ----
export const worldSchema: z.ZodType<WorldSummary> = z.object({
  worldId: id,
  label: text(120),
  env,
  source: sourceBindingSchema.optional(),
  scopeId: id,
  scopeRevision: int,
  worldRevision: int,
  maintenanceMode: z.boolean(),
  collectionIds: idList(64),
  fieldCount: int,
  referenceEdgeCount: int,
  allowedEffectKinds: z.array(z.enum(EFFECT_KINDS)).max(4),
  eligibilityPolicyId: id,
  eligibilityPolicyHash: hash,
  documentLimits: z.object({ maxScanned: int, maxChanged: int }),
  discoveryCompleteness: z.object({
    kind: z.enum(['declared', 'observed', 'partial']),
    limitations: z.array(text(300)).max(20),
  }),
});
export const worldsSchema = z.object({ worlds: z.array(worldSchema).max(50) });

export const previewSchema: z.ZodType<CleanupPreview> = z.object({
  previewId: id,
  basis: z.literal('expert_static_discovery'),
  worldId: id,
  source: sourceBindingSchema.optional(),
  worldRevision: int,
  scopeRevision: int,
  subject: z.object({
    display: text(80),
    identityHash: hash,
    idType: bson,
  }),
  perCollection: z
    .array(
      z.object({
        collectionId: id,
        exactIdentityMatches: int,
        eligibleEffects: z.partialRecord(z.enum(EFFECT_KINDS), int),
        retained: int,
        notInspected: z.boolean(),
      }),
    )
    .max(64),
  limitations: z.array(text(300)).max(20),
  expiresAt: iso,
});

// ---- Snapshot V2 ----
const counter = z.object({ used: int, cap: int });
const nodeStates = [
  'discovered',
  'inspected',
  'previewed',
  'applied',
  'retained',
  'excluded',
  'residual',
  'not_inspected',
] as const;
const artifactRef = z.object({
  artifactId: id,
  kind: z.enum(ARTIFACT_KINDS),
  committedAtSequence: int,
});
const phaseStates = z.record(
  z.enum(JOB_PHASES),
  z.enum(['pending', 'active', 'committed', 'skipped', 'failed']),
);
export const snapshotSchema: z.ZodType<ExpungeJobSnapshotV2> = z.object({
  schemaVersion: z.literal(2),
  jobId: id,
  kind: z.enum(JOB_KINDS),
  status: z.enum(JOB_STATUSES),
  sequence: int,
  streamEpoch: id.optional(),
  runId: id.optional(),
  harness: z
    .object({
      hash,
      parentHash: hash.nullable(),
      activeRevision: int,
    })
    .optional(),
  scope: z.object({ scopeId: id, scopeRevision: int, env }),
  world: z
    .object({ worldId: id, revision: int, maintenanceMode: z.boolean() })
    .optional(),
  subject: z
    .object({ display: text(80), identityHash: hash, idType: bson })
    .optional(),
  phase: z.enum(JOB_PHASES).nullable(),
  phaseStates,
  cancellation: z.object({
    requested: z.boolean(),
    requestedAt: iso.nullable(),
  }),
  coverage: z.object({
    registeredCollectionIds: idList(64),
    inspectedCollectionIds: idList(64),
    discoveredFieldIds: idList(256),
    completeness: z.enum(['declared', 'observed', 'partial']),
    limitations: z.array(text(300)).max(20),
  }),
  limits: z.object({
    modelCalls: counter,
    toolCalls: counter,
    scannedDocuments: counter,
    changedDocuments: counter,
    traversalDepth: counter,
    graphNodes: counter,
    graphEdges: counter,
    wallTimeMs: counter,
    totalTokens: counter,
    costMicrousd: counter,
    unpricedCalls: int,
  }),
  graph: z.object({
    artifactId: id.nullable(),
    nodeCount: int,
    edgeCount: int,
    truncated: z.boolean(),
    byState: z.record(z.enum(nodeStates), int),
  }),
  evidence: z.object({
    outboxState: z.enum(OUTBOX_STATES).nullable(),
    evidenceReady: z.boolean(),
    truncated: z.boolean(),
  }),
  approval: z.object({
    state: z.enum([
      'none',
      'pending',
      'approved',
      'declined',
      'expired',
      'consumed',
      'stale',
    ]),
    proposalId: id.nullable(),
    expiresAt: iso.nullable(),
  }),
  receipt: z.object({ receiptId: id, sequence: int }).nullable(),
  artifacts: z.array(artifactRef).max(200),
  externalErasure: z
    .object({
      status: z.enum(EXTERNAL_ERASURE_STATUSES),
      providerStatus: z.enum(PROVIDER_ERASURE_STATUSES).nullable(),
      dueBy: iso.nullable(),
    })
    .nullable(),
  cost: z.object({
    modelCalls: int,
    toolCalls: int,
    inputTokens: int,
    outputTokens: int,
    costMicrousd: int,
    unpricedCalls: int,
    mongoOperations: int,
    wallTimeMs: int,
  }),
  updatedAt: iso,
});

export const jobListSchema: z.ZodType<ExpungeJobList> = z.object({
  items: z
    .array(
      z.object({
        jobId: id,
        kind: z.enum(JOB_KINDS),
        status: z.enum(JOB_STATUSES),
        sequence: int,
        subjectDisplay: text(80).optional(),
        worldId: id.optional(),
        harnessHash: hash.optional(),
        receiptDomainStatus: z
          .enum(['complete_in_registered_scope', 'incomplete'])
          .optional(),
        receiptId: id.optional(),
        receiptSequence: int.optional(),
        verifiedWorldRevision: int.optional(),
        updatedAt: iso,
      }),
    )
    .max(200),
  nextCursor: text(256).nullable(),
});

// ---- Event payloads, one strict-bounded schema per kind ----
const phase = z.enum(JOB_PHASES);
const payloadSchemas = {
  job_started: z.object({
    jobKind: z.enum(JOB_KINDS),
    harnessHash: hash,
    worldId: id.optional(),
    scopeRevision: int,
    attempt: int,
  }),
  tool_decided: z.object({
    stepId: id,
    phase,
    toolId: z.enum(TOOL_IDS),
    decision: z.enum(POLICY_RESULTS),
    ruleIds: idList(64),
    summary: text(200),
    targetCount: int.optional(),
  }),
  effect_committed: z.object({
    receiptId: id,
    stepId: id,
    batchOrdinal: int,
    effectKind: z.enum(EFFECT_KINDS),
    collectionId: id,
    appliedCount: int,
    resultingWorldRevision: int,
    nodeIds: idList(100),
  }),
  evidence_ready: z.object({
    evidenceId: id,
    provider: id,
    externalEventId: id.optional(),
    externalTraceId: id.optional(),
    externalSignalIds: idList(256),
    origin: z.enum(SOURCE_ORIGINS),
    outboxState: z.enum(OUTBOX_STATES),
    truncated: z.boolean(),
    missing: idList(64),
    contentHash: hash,
    permittedUse: z.enum(['training', 'gate_only', 'display_only', 'revoked']),
  }),
  candidate_proposed: z.object({
    candidateId: id,
    target: z.enum(TARGET_KINDS),
    parentHash: hash,
    childHash: hash,
    claimedClass: z.enum(MUTATION_CLASSES),
    computedClass: z.enum(MUTATION_CLASSES),
    surfaces: idList(16),
    hypothesis: text(1000),
    state: z.enum(CANDIDATE_STATES),
  }),
  trial_completed: z.object({
    reportId: id.nullable(),
    candidateId: id,
    pairId: id,
    family: id,
    split: z.enum(['train', 'protected', 'validation', 'final']),
    parentUseful: z.boolean(),
    candidateUseful: z.boolean(),
    verdict: z.enum(['admit', 'reject', 'hold']).nullable(),
  }),
  approval_required: z.object({
    proposalId: id,
    candidateId: id,
    computedClass: z.enum(MUTATION_CLASSES),
    flipSetDigest: hash,
    expiresAt: iso,
  }),
  harness_promoted: z.object({
    promotionId: id,
    target: z.enum(TARGET_KINDS),
    fromHash: hash,
    toHash: hash,
    fromRevision: int,
    toRevision: int,
    gateReportId: id,
    consumedGrantId: id.nullable(),
  }),
  receipt_committed: z.object({
    receiptId: id,
    domainStatus: z.enum(['complete_in_registered_scope', 'incomplete']),
    externalErasureStatus: z.enum(EXTERNAL_ERASURE_STATUSES),
    verifiedWorldRevision: int,
  }),
  external_erasure_updated: z.object({
    requestKey: id,
    providerStatus: z.enum(PROVIDER_ERASURE_STATUSES),
    dueBy: iso.nullable(),
    completedAt: iso.nullable(),
    subjectCount: int,
    snapshotHash: hash,
  }),
  job_failed: z.object({
    code: z.enum(JOB_FAILURE_CODES),
    retryable: z.boolean(),
    phase: phase.nullable(),
    message: text(500),
  }),
  job_status_changed: z.object({
    from: z.enum(JOB_STATUSES),
    to: z.enum(JOB_STATUSES),
    reason: text(200),
  }),
  cancel_requested: z.object({
    requestedAt: iso,
    by: z.enum(['owner', 'system']),
  }),
  approval_resolved: z.object({
    proposalId: id,
    decision: z.enum(['approved', 'declined', 'expired', 'stale']),
    grantId: id.nullable(),
  }),
  harness_rolled_back: z.object({
    promotionId: id,
    target: z.enum(TARGET_KINDS),
    fromHash: hash,
    toHash: hash,
    testedParentHash: hash,
    reason: text(300),
  }),
  retraction_progress: z.object({
    retractionId: id,
    sourceId: id,
    frontierSize: int,
    visited: int,
    closureComplete: z.boolean(),
    revoked: int,
    regenerated: int,
    runsCancelled: int,
    failClosed: z.boolean(),
  }),
  campaign_row_committed: z.object({
    campaignId: id,
    manifestHash: hash,
    kind: z.enum(['hider', 'meta']),
    rowId: id,
    admitted: z.boolean().optional(),
    w0ResetProof: text(256).optional(),
    budgetHash: hash.optional(),
    result: z.enum(['measured', 'null', 'invalid']),
  }),
} satisfies Record<ProjectionKind, z.ZodType>;

export const MAX_EVENT_PAYLOAD_BYTES = 16_384;
export const MAX_EVENTS_PER_PAGE = 500;
const kinds: ReadonlySet<string> = new Set(PROJECTION_KINDS);
const eventEnvelope = z.object({
  eventId: id,
  sequence: int,
  jobId: id,
  runId: id.optional(),
  kind: z.string().max(64),
  artifactIds: z.array(text(256)).max(100),
  payload: z.unknown(),
});

function issuesOf(error: z.ZodError, prefix = ''): string[] {
  return error.issues
    .slice(0, 12)
    .map(
      (issue) => `${prefix}${issue.path.join('.') || '(root)'}:${issue.code}`,
    );
}

function parseEvent(value: unknown, index: number): ForwardedProjectionEvent {
  const base = eventEnvelope.safeParse(value);
  if (!base.success)
    throw new ProjectionRejected(issuesOf(base.error, `events.${index}.`));
  const { kind, payload, ...rest } = base.data;
  let size: number;
  try {
    size = JSON.stringify(payload ?? null).length;
  } catch {
    throw new ProjectionRejected([`events.${index}.payload:unserializable`]);
  }
  if (size > MAX_EVENT_PAYLOAD_BYTES)
    throw new ProjectionRejected([`events.${index}.payload:too_large`]);
  if (!kinds.has(kind))
    return {
      ...rest,
      kind: 'unknown_kind',
      originalKind: /^[a-z0-9_]{1,64}$/.test(kind) ? kind : 'invalid',
      payload: {},
    };
  const schema = payloadSchemas[kind as ProjectionKind];
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new ProjectionRejected(
      issuesOf(parsed.error, `events.${index}.payload.`),
    );
  return { ...rest, kind, payload: parsed.data } as ForwardedProjectionEvent;
}

export interface EventsPage {
  events: ForwardedProjectionEvent[];
  nextSequence: number;
  streamEpoch?: string;
}
export function parseEventsPage(
  value: unknown,
  jobId: string,
  afterSequence: number,
): EventsPage {
  const page = z
    .object({
      events: z.array(z.unknown()).max(MAX_EVENTS_PER_PAGE),
      nextSequence: int,
      streamEpoch: id.optional(),
    })
    .safeParse(value);
  if (!page.success) throw new ProjectionRejected(issuesOf(page.error));
  const events = page.data.events.map(parseEvent);
  let sequence = afterSequence;
  for (const event of events) {
    if (event.jobId !== jobId)
      throw new ProjectionRejected(['events:job_binding_mismatch']);
    if (event.sequence <= sequence)
      throw new ProjectionRejected(['events:sequence_not_increasing']);
    sequence = event.sequence;
  }
  if (page.data.nextSequence !== sequence)
    throw new ProjectionRejected(['nextSequence:cursor_mismatch']);
  return page.data.streamEpoch === undefined
    ? { events, nextSequence: sequence }
    : { events, nextSequence: sequence, streamEpoch: page.data.streamEpoch };
}

// ---- Artifact payloads ----
const effectsRecord = z.partialRecord(z.enum(EFFECT_KINDS), int);
const evidenceRef = z.object({
  provider: text(64),
  externalEventId: text(128).optional(),
  externalTraceId: text(128).optional(),
  externalSignalIds: z.array(text(128)).max(50),
  localSourceIds: idList(50),
  origin: z.enum(SOURCE_ORIGINS),
  redactionPolicy: text(64),
  retrievedAt: iso,
  contentHash: hash,
  permittedUse: z.enum(['training', 'gate_only', 'display_only', 'revoked']),
});
const trialMetrics = z.object({
  usefulCompletion: z.boolean(),
  targetedResiduals: int,
  unrelatedRecordChanges: int,
  retentionViolations: int,
  truthfulTerminal: z.boolean(),
  refused: z.boolean(),
  timedOut: z.boolean(),
  failed: z.boolean(),
  retryFailures: int,
  tokens: int,
  costMicrousd: int,
  unpricedCalls: int,
  wallTimeMs: int,
});
const flip = z.object({
  capability: text(120),
  change: z.enum(['added', 'widened', 'removed', 'tightened']),
});
const split = z.enum(['train', 'protected', 'validation', 'final']);

const completionReceipt: z.ZodType<CompletionReceiptView> = z.object({
  receiptId: id,
  jobId: id,
  source: sourceBindingSchema.optional(),
  runId: id,
  harnessHash: hash,
  scopeId: id,
  scopeRevision: int,
  verifiedWorldRevision: int,
  verificationPlanHash: hash,
  inspectedCollectionIds: idList(64),
  discoveredFieldIds: idList(256),
  operationalResiduals: int,
  excludedOrRetainedRecords: int,
  limitations: z.array(text(300)).max(30),
  domainStatus: z.enum(['complete_in_registered_scope', 'incomplete']),
  externalErasureStatus: z.enum(EXTERNAL_ERASURE_STATUSES),
  registeredCollectionIds: idList(64),
  effectCounts: effectsRecord,
  actionReceiptIds: idList(200),
  committedAt: iso,
  independentGrader: z
    .object({
      evaluatorHash: hash,
      verdict: z.enum(['pass', 'fail']),
      reasonCodes: z.array(text(64)).max(20),
    })
    .nullable()
    .optional(),
});
const graphPage: z.ZodType<GraphPage> = z.object({
  nodes: z
    .array(
      z.object({
        id,
        collectionId: id,
        recordId: text(64),
        recordIdBsonType: bson,
        hop: z.number().int().min(0).max(8),
        state: z.enum(nodeStates),
        effect: z.enum(EFFECT_KINDS).nullable(),
        label: text(120),
        fieldIds: idList(32),
        noExactIdentity: z.boolean(),
      }),
    )
    .max(1000),
  edges: z
    .array(z.object({ id, from: id, to: id, edgeId: id, fieldId: id }))
    .max(2000),
  nextCursor: text(256).nullable(),
});
const recordDetail: z.ZodType<RecordDetail> = z.object({
  nodeId: id,
  address: z.object({
    collectionId: id,
    recordId: text(64),
    recordIdBsonType: bson,
  }),
  preHash: hash,
  postHash: hash.nullable(),
  effect: z.enum(EFFECT_KINDS).nullable(),
  fields: z
    .array(
      z.object({
        path: text(160),
        kind: z.enum(['scalar', 'array', 'unchanged_group']),
        changed: z.boolean(),
        count: int.optional(),
        display: text(200).nullable().optional(),
        elements: z
          .array(
            z.object({
              index: int,
              outcome: z.enum([
                'removed',
                'preserved',
                'redacted',
                'tombstoned',
                'restricted',
              ]),
              display: text(200).nullable(),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .max(200),
});
const modelNarrative: z.ZodType<ModelNarrativeView> = z.object({
  jobId: id,
  text: text(4000),
  replayed: z.boolean(),
  producedAt: iso,
});
const evidenceBundle: z.ZodType<EvidenceBundleView> = z.object({
  evidenceId: id,
  split,
  sources: z.array(evidenceRef).max(50),
  tools: z
    .array(
      z.object({
        toolId: z.enum(TOOL_IDS),
        decision: z.enum(POLICY_RESULTS),
        summary: text(200),
      }),
    )
    .max(100),
  diagnostics: z.array(text(300)).max(30),
  confidence: z.number().min(0).max(1),
  outbox: z
    .array(z.object({ state: z.enum(OUTBOX_STATES), at: iso.nullable() }))
    .max(10),
  truncated: z.boolean(),
  missing: z.array(text(64)).max(20),
  retryAttempts: int,
});
const candidate: z.ZodType<CandidateView> = z.object({
  candidateId: id,
  target: z.enum(TARGET_KINDS),
  parentHash: hash,
  childHash: hash,
  state: z.enum(CANDIDATE_STATES),
  hypothesis: text(500),
  claimedClass: z.enum(MUTATION_CLASSES),
  computedClass: z.enum(MUTATION_CLASSES),
  flipSet: z.array(flip).max(50),
  patches: z
    .array(
      z.object({
        surface: z.enum([
          'context',
          'workflow',
          'guardrails',
          'tool_policy',
          'plugin',
        ]),
        path: text(200),
        before: text(2000),
        after: text(2000),
        sourceEvidenceIds: idList(20),
        hypothesis: text(500),
      }),
    )
    .max(10),
  sourceEvidence: z.array(evidenceRef).max(20),
  reasonCodes: z.array(text(64)).max(20),
  compiler: z.object({ ok: z.boolean(), messages: z.array(text(300)).max(20) }),
  replay: z
    .object({
      ran: z.boolean(),
      label: z.literal('decision_replay_diagnostic'),
      summary: text(500),
    })
    .nullable(),
  activeParentHash: hash.nullable(),
});
const gateReport: z.ZodType<GateReportView> = z.object({
  reportId: id,
  candidateId: id,
  parentHash: hash,
  childHash: hash,
  evaluatorHash: hash,
  fixtureGeneratorHash: hash,
  runtimeHash: hash,
  workerProfileHash: hash,
  splitManifestCommitment: hash,
  pairs: z
    .array(
      z.object({
        pairId: id,
        split,
        family: text(64),
        seedCommitment: hash,
        parent: trialMetrics,
        candidate: trialMetrics,
      }),
    )
    .max(200),
  plannedPairs: int,
  trialRowsDigest: hash,
  controls: z
    .array(
      z.object({
        controlId: z.enum([
          'score_only',
          'wrong_incident',
          'expert_static',
          'initial',
          'evolved',
        ]),
        label: text(80),
        successes: int,
        episodes: int,
        costMicrousd: int,
      }),
    )
    .max(10),
  knownAuthorityFlips: z.array(text(120)).max(50),
  totalCostMicrousd: int,
  unpricedCalls: int,
  verdict: z.enum(['admit', 'reject', 'hold']),
  reasonCodes: z.array(text(64)).max(20),
  // Authority-bearing: an unknown key fails the whole artifact instead of being stripped.
  decisionSummary: z
    .strictObject({
      triggerGain: z
        .number()
        .int()
        .min(-Number.MAX_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
      triggerRequiredGain: int,
      splits: z.partialRecord(
        split,
        z.strictObject({
          trials: int,
          parentSuccesses: int,
          candidateSuccesses: int,
        }),
      ),
      protectedRegressedWorlds: int,
    })
    .optional(),
});
const approvalDescriptor: z.ZodType<ApprovalDescriptorView> = z.object({
  proposalId: id,
  grantId: id.nullable(),
  state: z.enum([
    'pending',
    'approved',
    'declined',
    'expired',
    'consumed',
    'stale',
  ]),
  target: z.enum(TARGET_KINDS),
  parentHash: hash,
  childHash: hash,
  expectedParentRevision: int,
  computedClass: z.enum(MUTATION_CLASSES),
  flipSet: z.array(flip).max(50),
  flipSetDigest: hash,
  scope: z.object({
    scopeId: id,
    scopeRevision: int,
    authorizationRevision: int,
  }),
  gateReportId: id,
  gateReportDigest: hash,
  approver: z.object({ actorId: id, display: text(80) }),
  expiresAt: iso,
  consequences: z.array(text(300)).max(10),
  descriptorDigest: hash,
});
const deployment: z.ZodType<DeploymentView> = z.object({
  target: z.enum(TARGET_KINDS),
  activeHash: hash,
  revision: int,
  scopeRevision: int,
  authorizationRevision: int,
  initialBundleHash: hash,
  versions: z
    .array(
      z.object({
        hash,
        parentHash: hash.nullable(),
        testedParentHash: hash.nullable(),
        authorityClass: z.enum(MUTATION_CLASSES).nullable(),
        state: z.enum(['active', 'previous', 'rolled_back']),
        promotion: z
          .object({
            promotionId: id,
            gateReportId: id,
            consumedGrantId: id.nullable(),
            at: iso,
          })
          .nullable(),
        rollback: z
          .object({
            promotionId: id,
            toHash: hash,
            reason: text(300),
            at: iso,
          })
          .nullable(),
      }),
    )
    .max(100),
  rejected: z
    .array(
      z.object({
        candidateId: id,
        childHash: hash,
        reasonCodes: z.array(text(64)).max(20),
      }),
    )
    .max(100),
});
const campaign: z.ZodType<CampaignView> = z.object({
  campaignId: id,
  kind: z.enum(['hider', 'meta']),
  manifestHash: hash,
  plannedRows: int,
  w0ResetProof: text(128).nullable(),
  budgetHash: hash.nullable(),
  rows: z.array(payloadSchemas.campaign_row_committed).max(500),
  quarantined: z
    .array(z.object({ rowId: id, reasonCodes: z.array(text(64)).max(20) }))
    .max(100),
  noiseControl: z.object({ present: z.boolean(), rowId: id.nullable() }),
  noDataControl: z.object({ present: z.boolean(), rowId: id.nullable() }),
  // Authority-bearing: an unknown key fails the whole artifact instead of being stripped.
  metaVerdict: z
    .strictObject({
      verdict: z.enum(['gain', 'tie', 'loss']),
      incidents: int,
      wins: int,
      losses: int,
      ties: int,
      p: z.number().min(0).max(1),
      net: z
        .number()
        .int()
        .min(-Number.MAX_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
      noiseNet: z
        .number()
        .int()
        .min(-Number.MAX_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
      noDataNet: z
        .number()
        .int()
        .min(-Number.MAX_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .optional(),
});
const externalErasure: z.ZodType<ExternalErasureView> = z.object({
  requestKey: id,
  providerStatus: z.enum(PROVIDER_ERASURE_STATUSES),
  regulation: z.enum(['gdpr', 'ccpa', 'other']),
  subjectCount: int,
  receivedAt: iso,
  dueBy: iso.nullable(),
  completedAt: iso.nullable(),
  localExportSuppression: z.enum(['active', 'released']),
  history: z
    .array(z.object({ at: iso, status: text(32), snapshotHash: hash }))
    .max(100),
  revokedPendingEntries: int,
});
const privacy: z.ZodType<PrivacyView> = z.object({
  retractionId: id,
  sourceId: id,
  progress: payloadSchemas.retraction_progress,
  edges: z
    .array(
      z.object({
        edgeKey: id,
        fromId: id,
        toId: id,
        kind: z.enum(['derived_from', 'source_deleted']),
      }),
    )
    .max(500),
  eligibility: z
    .array(
      z.object({
        artifactHash: hash,
        state: z.enum(['permitted', 'revoked', 'source_deleted']),
        reasonCode: text(64),
        sourceIds: idList(50),
      }),
    )
    .max(500),
  erasure: externalErasure.nullable(),
  retainedBytesCheck: z.object({
    state: z.enum(['checked', 'not_checked']),
    violations: int,
  }),
});

/** Artifact kinds the operator can serve. Others return 501 until a schema exists. */
export const artifactPayloadSchemas: Partial<
  Record<(typeof ARTIFACT_KINDS)[number], z.ZodType>
> = {
  completion_receipt: completionReceipt,
  graph_page: graphPage,
  record_detail: recordDetail,
  model_narrative: modelNarrative,
  evidence_bundle: evidenceBundle,
  candidate,
  gate_report: gateReport,
  approval_descriptor: approvalDescriptor,
  deployment,
  campaign,
  retraction: privacy,
  external_erasure: externalErasure,
};
export const approvalDescriptorSchema = approvalDescriptor;
export const deploymentSchema = deployment;

export function parseArtifact(value: unknown): ArtifactEnvelope {
  const envelope = z
    .object({
      artifactId: id,
      kind: z.enum(ARTIFACT_KINDS),
      jobId: id.nullable(),
      committedAtSequence: int,
      contentHash: hash.nullable(),
      payload: z.unknown(),
    })
    .safeParse(value);
  if (!envelope.success) throw new ProjectionRejected(issuesOf(envelope.error));
  const schema = artifactPayloadSchemas[envelope.data.kind];
  if (!schema) throw new ProjectionRejected(['kind:unsupported']);
  const payload = schema.safeParse(envelope.data.payload);
  if (!payload.success)
    throw new ProjectionRejected(issuesOf(payload.error, 'payload.'));
  return { ...envelope.data, payload: payload.data };
}

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProjectionRejected(issuesOf(parsed.error));
  return parsed.data;
}

/** Request bodies are strict: any extra field (tenant, actor, role, revision) is a 400. */
export const submitRequestSchema = z.strictObject({
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  worldId: id,
  previewId: id,
  subject: z.strictObject({ idType: bson, value: z.string().min(1).max(128) }),
});
export const previewRequestSchema = z.strictObject({
  worldId: id,
  subject: z.strictObject({ idType: bson, value: z.string().min(1).max(128) }),
});
export const cancelRequestSchema = z.strictObject({
  reason: text(300).optional(),
});
export const decisionRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'decline']),
  descriptorDigest: hash,
  toolCallId: z.string().min(1).max(200).optional(),
});
