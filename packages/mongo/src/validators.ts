import type { Document } from 'mongodb';
import { GUARDRAIL_MAX_DEPTH, PROJECTION_EVENT_KINDS } from '@expunge/contracts';
import { CAMPAIGN_RESULT_VALIDATORS } from './validators-campaign.js';
import { GATE_CONTROL_VALIDATORS } from './validators-extra.js';
import { PRIVACY_VALIDATORS } from './validators-privacy.js';

type Schema = Document;
const str: Schema = { bsonType: 'string', maxLength: 256 };
const hash: Schema = { bsonType: 'string', pattern: '^[a-f0-9]{64}$' };
const integer: Schema = {
  bsonType: ['int', 'long', 'double'],
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
};
const date: Schema = { bsonType: 'date' };
const bool: Schema = { bsonType: 'bool' };
const arr = (items: Schema, maxItems = 256): Schema => ({ bsonType: 'array', items, maxItems });
const en = (values: string[]): Schema => ({ bsonType: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  bsonType: 'object',
  required,
  additionalProperties: false,
  properties,
});
const MUTATION_CLASSES = ['tightening', 'behavioral', 'authority_expansion'];
const scope = { tenantId: str, env: en(['dev', 'evaluation', 'demo']), scopeId: str };
const actor = object({ ...scope, actorId: str, authorizationRevision: integer });
const binding = object({
  jobId: str,
  runId: str,
  worldId: str,
  harnessHash: hash,
  scopeRevision: integer,
  workerProfileHash: hash,
});
const lease = object({ ownerId: str, fence: integer, until: date, heartbeatAt: date });
const json: Schema = { bsonType: ['object', 'array', 'string', 'bool', 'int', 'long', 'double', 'null'] };
const operand: Schema = {
  oneOf: [
    object({ kind: en(['fact']), factId: str }),
    object({ kind: en(['binding']), bindingId: str }),
    object({
      kind: en(['constant']),
      value: {
        oneOf: [
          bool,
          { bsonType: ['int', 'long', 'double'], minimum: -1e9, maximum: 1e9 },
          en([
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
        ],
      },
    }),
  ],
};
// Finite unrolled schemas are supported BSON draft-4; no $ref/definitions or raw JS.
function predicateSchema(depth: number): Schema {
  const variants: Schema[] = [
    object({
      op: en(['compare']),
      comparator: en(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
      left: operand,
      right: operand,
    }),
    object({ op: en(['receipt_valid']), bindingId: str }),
    object({
      op: en(['prior_effect_count']),
      toolId: str,
      comparator: en(['eq', 'lt', 'lte', 'gt', 'gte']),
      count: integer,
    }),
  ];
  if (depth > 0) {
    const next = predicateSchema(depth - 1);
    variants.push(
      object({ op: en(['all', 'any']), predicates: { ...arr(next, 32), minItems: 1 } }),
      object({ op: en(['not']), predicate: next }),
    );
  }
  return { oneOf: variants };
}
const predicate = predicateSchema(GUARDRAIL_MAX_DEPTH);
const guardrail = object(
  {
    ruleId: str,
    predicate,
    result: en(['allow', 'ask', 'deny']),
    sourceEvidenceIds: arr(str, 64),
    appliesTo: arr(str, 16),
  },
  ['ruleId', 'predicate', 'result', 'sourceEvidenceIds'],
);
const evidenceRef = object(
  {
    provider: str,
    externalEventId: str,
    externalTraceId: str,
    externalSignalIds: arr(str),
    localSourceIds: arr(str),
    origin: en([
      'agent_self_report',
      'verifier_feedback',
      'human_feedback',
      'raindrop_classifier',
      'experiment_result',
      'admission_service',
    ]),
    redactionPolicy: str,
    retrievedAt: { bsonType: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' },
    contentHash: hash,
    permittedUse: en(['training', 'gate_only', 'display_only', 'revoked']),
  },
  [
    'provider',
    'externalSignalIds',
    'localSourceIds',
    'origin',
    'redactionPolicy',
    'retrievedAt',
    'contentHash',
    'permittedUse',
  ],
);
export const bundlePayloadSchema = object({
  contractVersion: { bsonType: ['int', 'long', 'double'], enum: [1] },
  target: en(['worker', 'improver', 'hider']),
  parentHash: { oneOf: [hash, { bsonType: 'null' }] },
  contextPolicy: object({
    schemaMode: en(['selected_fields', 'all_registered_fields', 'inspect_then_select']),
    includeNestedArrays: bool,
    referenceDepth: { ...integer, maximum: 16 },
    lessonRecall: object({
      mode: en(['exact', 'hybrid']),
      topK: { ...integer, maximum: 100 },
      moduleIds: arr(str, 100),
    }),
    sourceEligibilityPolicyHash: hash,
    maxContextTokens: integer,
    evidenceFormat: en(['score_only', 'trace_and_score', 'contrastive_traces']),
  }),
  workflow: object({
    entryNodeId: str,
    nodes: arr(
      object({
        id: str,
        toolId: str,
        inputBindings: { bsonType: 'object', additionalProperties: str },
        maxVisits: { ...integer, minimum: 1, maximum: 100 },
      }),
      128,
    ),
    edges: arr(
      object({
        from: str,
        to: str,
        when: en([
          'success',
          'more_references',
          'batches_remaining',
          'needs_approval',
          'retryable_error',
          'verification_failed',
        ]),
      }),
      256,
    ),
    terminalNodeIds: arr(str, 128),
  }),
  guardrails: arr(guardrail, 128),
  toolPolicy: object({
    grants: arr(str, 128),
    prerequisites: arr(
      object({
        toolId: str,
        requiredArtifact: en(['preview_plan', 'action_receipt', 'completion_receipt', 'approval_grant']),
        binding: en(['same_job_same_plan_current_revision']),
      }),
      128,
    ),
  }),
  completionPolicy: en(['model_narrative', 'verified_receipt']),
  pluginArtifacts: arr(
    object({
      slot: en(['discovery', 'context', 'critic']),
      sourceHash: hash,
      compiledHash: hash,
      abiHash: hash,
      sandboxProfileHash: hash,
      exportName: str,
      inputSchemaHash: hash,
      outputSchemaHash: hash,
    }),
    3,
  ),
  limits: object({
    modelCalls: integer,
    toolCalls: integer,
    scannedDocuments: integer,
    changedDocuments: integer,
    traversalDepth: { ...integer, maximum: 16 },
    graphNodes: integer,
    graphEdges: integer,
    wallTimeMs: integer,
    totalTokens: integer,
    maxCostMicrousd: integer,
  }),
  evidence: arr(evidenceRef, 128),
  runtimeAdapterHash: hash,
  compilerHash: hash,
  vocabularyHash: hash,
  authorityFloorHash: hash,
  eligibilityPolicyHash: hash,
});
const address = object({
  collectionId: str,
  recordId: { bsonType: ['string', 'int', 'long', 'double'] },
  recordIdBsonType: en(['string', 'objectId', 'int', 'long']),
});
const effect = object({
  address,
  kind: en(['delete', 'redact', 'restrict', 'tombstone']),
  preHash: hash,
  postHash: { oneOf: [hash, { bsonType: 'null' }] },
  preVersion: integer,
  postVersion: { oneOf: [integer, { bsonType: 'null' }] },
});
const cost = object({
  modelCalls: integer,
  toolCalls: integer,
  inputTokens: integer,
  outputTokens: integer,
  costMicrousd: integer,
  unpricedCalls: integer,
  mongoOperations: integer,
  wallTimeMs: integer,
});
const metrics = object({
  usefulCompletion: bool,
  targetedResiduals: integer,
  unrelatedRecordChanges: integer,
  retentionViolations: integer,
  truthfulTerminal: bool,
  refused: bool,
  retryFailures: integer,
  cost,
});
const trial = object({
  pairId: str,
  family: str,
  seedCommitment: hash,
  parentRunId: str,
  candidateRunId: str,
  workerProfileHash: hash,
  budgetHash: hash,
  faultPlanHash: hash,
  parent: metrics,
  candidate: metrics,
});
export const CONTROL_VALIDATORS: Record<string, Document> = {
  artifacts: {
    $jsonSchema: object({
      _id: hash,
      payload: bundlePayloadSchema,
      createdAt: date,
      sourceBlobIds: arr(str),
    }),
  },
  jobs: {
    $jsonSchema: object(
      {
        _id: str,
        kind: en([
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
        ]),
        actor,
        binding,
        parentJobId: { oneOf: [str, { bsonType: 'null' }] },
        checkpoint: json,
        status: en([
          'queued',
          'running',
          'waiting_evidence',
          'waiting_approval',
          'waiting_external',
          'succeeded',
          'failed',
          'cancelled',
        ]),
        cancellationRequested: bool,
        lease,
        commitSeq: integer,
        eventSeq: integer,
        attempt: integer,
        priority: { bsonType: ['int', 'long', 'double'] },
        inputRefs: arr(str),
        outputRefs: arr(str),
        contextInputs: arr(str, 4096),
        createdAt: date,
        updatedAt: date,
      },
      [
        '_id',
        'kind',
        'actor',
        'binding',
        'parentJobId',
        'checkpoint',
        'status',
        'cancellationRequested',
        'lease',
        'commitSeq',
        'eventSeq',
        'attempt',
        'priority',
        'inputRefs',
        'outputRefs',
        'createdAt',
        'updatedAt',
      ],
    ),
    // Query-operator half of the validator: a job cannot be recorded as succeeded with nothing to point at.
    // Other status protections are enforced by the repository because six principals need UPDATE on jobs.
    $nor: [{ status: 'succeeded', outputRefs: { $size: 0 } }],
  },
  provenance_closures: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      sourceId: str,
      policyHash: str,
      reasonCode: str,
      status: en(['open', 'complete']),
      frontier: arr(str, 20000),
      expanding: {
        oneOf: [
          object({ parents: arr(str, 1000), after: { oneOf: [str, { bsonType: 'null' }] } }),
          { bsonType: 'null' },
        ],
      },
      stalledReason: { oneOf: [str, { bsonType: 'null' }] },
      discovered: integer,
      rounds: integer,
      revision: integer,
      startedAt: date,
      updatedAt: date,
      completedAt: { oneOf: [date, { bsonType: 'null' }] },
    }),
  },
  authority_policies: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      target: en(['worker', 'improver', 'hider']),
      behavioralRequiresApproval: bool,
      createdAt: date,
    }),
  },
  effects: {
    $jsonSchema: object({
      _id: str,
      effectKey: str,
      argsDigest: hash,
      planHash: hash,
      jobId: str,
      actor,
      receiptId: str,
      createdAt: date,
    }),
  },
  action_receipts: {
    $jsonSchema: object({
      _id: str,
      receiptId: str,
      effectKey: str,
      intentHash: hash,
      jobId: str,
      runId: str,
      harnessHash: hash,
      appliedEffects: arr(effect, 500),
      resultingWorldRevision: integer,
      leaseFence: integer,
      status: en(['committed']),
      evidenceRefs: arr(str),
    }),
  },
  completion_receipts: {
    $jsonSchema: object({
      _id: str,
      receiptId: str,
      jobId: str,
      runId: str,
      harnessHash: hash,
      scopeId: str,
      scopeRevision: integer,
      verifiedWorldRevision: integer,
      verificationPlanHash: hash,
      inspectedCollectionIds: arr(str),
      discoveredFieldIds: arr(str),
      operationalResiduals: integer,
      excludedOrRetainedRecords: integer,
      limitations: arr(str),
      domainStatus: en(['complete_in_registered_scope', 'incomplete']),
      externalErasureStatus: en(['not_required', 'pending', 'confirmed', 'failed']),
      actor,
      createdAt: date,
    }),
  },
  deployments: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      target: en(['worker', 'improver', 'hider']),
      activeHash: hash,
      revision: integer,
      scopeRevision: integer,
      authorizationRevision: integer,
      updatedAt: date,
    }),
  },
  approvals: {
    $jsonSchema: object(
      {
        _id: str,
        ...scope,
        target: en(['worker', 'improver', 'hider']),
        grantId: str,
        proposalId: str,
        parentHash: hash,
        childHash: hash,
        parentRevision: integer,
        approvedDescriptor: json,
        authorizationRevision: integer,
        scopeRevision: integer,
        flipSetDigest: hash,
        gateReportId: str,
        gateReportDigest: hash,
        approverId: str,
        expiresAt: date,
        nonce: str,
        consumedAt: date,
        consumedBy: str,
        createdAt: date,
      },
      [
        '_id',
        ...Object.keys(scope),
        'target',
        'grantId',
        'proposalId',
        'parentHash',
        'childHash',
        'parentRevision',
        'approvedDescriptor',
        'authorizationRevision',
        'scopeRevision',
        'flipSetDigest',
        'gateReportId',
        'gateReportDigest',
        'approverId',
        'expiresAt',
        'nonce',
        'createdAt',
      ],
    ),
  },
  gate_reports: {
    $jsonSchema: object(
      {
        _id: str,
        reportId: str,
        candidateId: str,
        parentHash: hash,
        childHash: hash,
        evaluatorHash: hash,
        fixtureGeneratorHash: hash,
        runtimeHash: hash,
        workerProfileHash: hash,
        splitManifestCommitment: hash,
        pairedTrials: arr(trial, 2048),
        trialRowsDigest: hash,
        causalControls: json,
        knownAuthorityFlips: arr(str),
        cost,
        verdict: en(['admit', 'reject', 'hold']),
        reasonCodes: arr(str),
        computedClass: en(MUTATION_CLASSES),
      },
      [
        '_id',
        'reportId',
        'candidateId',
        'parentHash',
        'childHash',
        'evaluatorHash',
        'fixtureGeneratorHash',
        'runtimeHash',
        'workerProfileHash',
        'splitManifestCommitment',
        'pairedTrials',
        'trialRowsDigest',
        'causalControls',
        'knownAuthorityFlips',
        'cost',
        'verdict',
        'reasonCodes',
      ],
    ),
  },
  // Proposers insert candidates but may not set `computedClass`: the schema has no such property and rejects
  // additional ones, so the class can only come from the gate report.
  candidates: {
    $jsonSchema: object({
      _id: str,
      candidateId: str,
      actor: object(scope),
      target: en(['worker', 'improver', 'hider']),
      parentHash: hash,
      childHash: hash,
      patches: arr({ bsonType: 'object' }, 256),
      hypothesis: { bsonType: 'string', maxLength: 4096 },
      sourceEvidence: arr(evidenceRef, 128),
      claimedClass: en(MUTATION_CLASSES),
      artifactHashes: arr(str, 256),
      state: en([
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
      ]),
    }),
  },
  authority_revisions: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      authorizationRevision: integer,
      floorHash: hash,
      updatedAt: date,
    }),
  },
  authority_touches: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      authorizationRevision: integer,
      touches: integer,
      updatedAt: date,
    }),
  },
  decisions: {
    $jsonSchema: object(
      {
        _id: hash,
        ...scope,
        decisionId: hash,
        jobId: str,
        runId: str,
        harnessHash: hash,
        stepId: str,
        batchOrdinal: integer,
        argsDigest: hash,
        decision: object({
          result: en(['allow', 'ask', 'deny']),
          ruleIds: arr(str, 64),
          authorizationRevision: integer,
        }),
        decidedAt: date,
        toolId: { bsonType: 'string', maxLength: 64 },
        inputs: json,
        inputsDigest: hash,
      },
      [
        '_id',
        ...Object.keys(scope),
        'decisionId',
        'jobId',
        'runId',
        'harnessHash',
        'stepId',
        'batchOrdinal',
        'argsDigest',
        'decision',
        'decidedAt',
      ],
    ),
  },
  job_subjects: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      jobId: str,
      idType: en(['objectId', 'string', 'int', 'long']),
      value: str,
      identityHash: hash,
      createdAt: date,
    }),
  },
  domain_steps: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      jobId: str,
      runId: str,
      harnessHash: hash,
      kind: en(['scope_selection', 'subject_resolution', 'discovery', 'call', 'workflow', 'fault']),
      ordinal: integer,
      worldId: str,
      scopeRevision: integer,
      worldRevision: integer,
      payload: json,
      payloadDigest: hash,
      createdAt: date,
    }),
  },
  preview_plans: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      planHash: hash,
      jobId: str,
      runId: str,
      harnessHash: hash,
      worldId: str,
      scopeRevision: integer,
      worldRevision: integer,
      ownerPolicyHash: hash,
      targets: arr(json, 500),
      bindings: arr({ bsonType: 'string', maxLength: 512 }, 1024),
      retained: arr(json, 500),
      createdAt: date,
    }),
  },
  verification_sweeps: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      jobId: str,
      runId: str,
      harnessHash: hash,
      worldId: str,
      scopeRevision: integer,
      worldRevisionBefore: integer,
      worldRevisionAfter: integer,
      planHash: { oneOf: [hash, { bsonType: 'null' }] },
      status: en(['valid', 'invalid']),
      residuals: integer,
      retainedOrExcluded: integer,
      inspectedCollectionIds: arr(str, 16),
      discoveredFieldIds: arr(str, 256),
      residualSamples: arr(json, 50),
      limitations: arr(str, 32),
      createdAt: date,
    }),
  },
  diagnostics: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      jobId: str,
      runId: str,
      origin: en(['agent_self_report']),
      category: str,
      message: { bsonType: 'string', maxLength: 1000 },
      outboxOperationId: str,
      createdAt: date,
    }),
  },
  wake_commands: {
    $jsonSchema: object({ _id: str, commandId: str, jobId: str, acceptedAt: date }),
  },
  grant_consumptions: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      target: en(['worker', 'improver', 'hider']),
      grantId: str,
      promotionId: str,
      candidateId: str,
      consumedAt: date,
    }),
  },
  promotions: {
    $jsonSchema: object(
      {
        _id: str,
        ...scope,
        target: en(['worker', 'improver', 'hider']),
        promotionId: str,
        fromHash: hash,
        toHash: hash,
        fromRevision: integer,
        toRevision: integer,
        gateReportId: str,
        gateReportDigest: hash,
        consumedGrantId: str,
        runtimeHash: hash,
        evaluatorHash: str,
        reason: str,
        createdAt: date,
      },
      [
        '_id',
        ...Object.keys(scope),
        'target',
        'promotionId',
        'fromHash',
        'toHash',
        'fromRevision',
        'toRevision',
        'gateReportId',
        'gateReportDigest',
        'runtimeHash',
        'evaluatorHash',
        'reason',
        'createdAt',
      ],
    ),
  },
  projection_events: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      sequence: integer,
      eventId: str,
      jobId: str,
      runId: str,
      artifactIds: arr(str),
      kind: en([...PROJECTION_EVENT_KINDS]),
      payload: json,
      createdAt: date,
    }),
  },
  ...GATE_CONTROL_VALIDATORS,
  ...CAMPAIGN_RESULT_VALIDATORS,
  ...PRIVACY_VALIDATORS,
};
export const WORLD_VALIDATORS: Record<string, Document> = {
  // The revision counter only. The binding to a scope revision lives in world_scope_bindings.
  world_revisions: {
    $jsonSchema: object(
      {
        _id: str,
        ...scope,
        worldId: str,
        revision: integer,
        updatedAt: date,
        verificationSeq: integer,
      },
      ['_id', ...Object.keys(scope), 'worldId', 'revision', 'updatedAt'],
    ),
  },
  identity_edges: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      edgeKey: str,
      worldId: str,
      worldRevision: integer,
      scopeRevision: integer,
      edgeId: str,
      fieldId: str,
      fromNode: hash,
      toNode: hash,
      from: address,
      to: address,
      createdAt: date,
    }),
  },
  world_scope_bindings: {
    $jsonSchema: object(
      {
        _id: str,
        ...scope,
        worldId: str,
        scopeRevision: integer,
        maintenanceMode: bool,
        // Present only on an evaluation world built for one gate campaign.
        campaignId: str,
        updatedAt: date,
      },
      ['_id', ...Object.keys(scope), 'worldId', 'scopeRevision', 'maintenanceMode', 'updatedAt'],
    ),
  },
};
export const PRIVATE_VALIDATORS: Record<string, Document> = {
  // Per-campaign HMAC key for instance ids and tokens. Insert-only; readable by the fixture builder and grader.
  campaign_keys: {
    $jsonSchema: object({
      _id: { bsonType: 'string', minLength: 1, maxLength: 128 },
      keyId: { bsonType: 'string', minLength: 1, maxLength: 64 },
      key: { bsonType: 'binData' },
      createdAt: date,
    }),
    // JSON schema cannot bound binary length; the query-operator half pins the key to exactly 32 bytes.
    $expr: { $eq: [{ $binarySize: '$key' }, 32] },
  },
};
/** Fail setup if a future edit introduces unsupported JSON-schema keywords. */
export function assertSupportedMongoSchema(schema: unknown): void {
  const forbidden = new Set(['$schema', '$ref', 'definitions', 'format', 'default', 'type']);
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) throw new Error(`UnsupportedMongoSchemaKeyword:${key}`);
        walk(child);
      }
    }
  };
  walk(schema);
}
