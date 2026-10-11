import type { CreateIndexesOptions, Document, IndexSpecification } from 'mongodb';
import type { NativeSourceRegistration } from '@expunge/contracts';
import { ENVIRONMENTS, nativeSourceRegistrationSchema } from '@expunge/contracts';
import type { AtlasAction, AtlasRoleManifest } from './roles.js';

const str = { bsonType: 'string', minLength: 1, maxLength: 256 };
const hash = { bsonType: 'string', pattern: '^[a-f0-9]{64}$' };
const integer = {
  bsonType: ['int', 'long', 'double'],
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
};
const date = { bsonType: 'date' };
const en = (values: readonly string[]) => ({ bsonType: 'string', enum: [...values] });
const object = (properties: Record<string, Document>, required = Object.keys(properties)): Document => ({
  bsonType: 'object',
  properties,
  required,
  additionalProperties: false,
});
const array = (items: Document, maxItems: number) => ({ bsonType: 'array', items, maxItems });
const scalar = {
  oneOf: [
    object({ bsonType: en(['string']), value: { bsonType: 'string', maxLength: 4096 } }),
    object({ bsonType: en(['objectId']), value: { bsonType: 'string', pattern: '^[a-fA-F0-9]{24}$' } }),
    object({ bsonType: en(['int']), value: { ...integer, minimum: -2147483648, maximum: 2147483647 } }),
    object({
      bsonType: en(['long']),
      value: { bsonType: 'string', maxLength: 20, pattern: '^-?(0|[1-9][0-9]*)$' },
    }),
    object({ bsonType: en(['double']), value: { bsonType: ['int', 'long', 'double'] } }),
    object({ bsonType: en(['decimal', 'date']), value: { bsonType: 'string', maxLength: 128 } }),
    object({ bsonType: en(['bool']), value: { bsonType: 'bool' } }),
    object({ bsonType: en(['null']), value: { bsonType: 'null' } }),
  ],
};
const path = { ...array({ bsonType: 'string', minLength: 1, maxLength: 128 }, 16), minItems: 1 };
const scope = { tenantId: str, env: en(['staging', 'production']), scopeId: str };
const namespace = object({ namespaceId: str, database: str, collection: str });
const registration = object(
  {
    contractVersion: { bsonType: ['int', 'double'], enum: [2] },
    sourceId: str,
    deploymentId: str,
    scope: object(scope),
    revision: { ...integer, minimum: 1 },
    policyRevision: { ...integer, minimum: 1 },
    authorizationRevision: { ...integer, minimum: 1 },
    sourceKind: en(['original', 'isolated_replay']),
    namespaces: { ...array(namespace, 64), minItems: 1 },
    fields: {
      ...array(
        object({
          fieldId: str,
          namespaceId: str,
          path,
          bsonTypes: {
            ...array(
              en([
                'string',
                'objectId',
                'int',
                'long',
                'double',
                'decimal',
                'date',
                'bool',
                'null',
                'array',
                'object',
                'binData',
              ]),
              12,
            ),
            minItems: 1,
          },
          identity: { bsonType: 'bool' },
          protected: { bsonType: 'bool' },
        }),
        1024,
      ),
      minItems: 1,
    },
    tenantBoundaries: {
      ...array(object({ namespaceId: str, fieldId: str, equals: scalar }), 64),
      minItems: 1,
    },
    subjectIdentityFieldIds: { ...array(str, 32), minItems: 1 },
    references: array(
      object({
        referenceId: str,
        fromFieldId: str,
        toFieldId: str,
        owner: en(['from', 'to', 'none']),
        identityRule: en(['same_bson_type', 'string_to_objectId', 'objectId_to_string']),
      }),
      256,
    ),
    rules: {
      ...array(
        object(
          {
            ruleId: str,
            namespaceId: str,
            all: { ...array(object({ fieldId: str, equals: scalar }), 32), minItems: 1 },
            effect: en(['delete', 'redact', 'restrict', 'tombstone']),
            fieldIds: array(str, 64),
            replacement: scalar,
          },
          ['ruleId', 'namespaceId', 'all', 'effect', 'fieldIds'],
        ),
        128,
      ),
      minItems: 1,
    },
    retainedFieldIds: array(str, 1024),
    consistency: {
      oneOf: [
        object({
          kind: en(['native_revision']),
          changeStreamRequired: { enum: [true] },
          bindings: { ...array(object({ namespaceId: str, revisionFieldId: str }), 64), minItems: 1 },
        }),
        object({ kind: en(['conditional_preimage']), changeStreamRequired: { enum: [true] } }),
      ],
    },
    limits: object({
      maxScanned: { ...integer, minimum: 1, maximum: 100000 },
      maxChanged: { ...integer, minimum: 1, maximum: 100000 },
      maxBatch: { ...integer, minimum: 1, maximum: 100 },
      maxHops: { ...integer, maximum: 16 },
      maxTotalScanned: { ...integer, minimum: 1, maximum: 1000000 },
      maxTotalChanged: { ...integer, minimum: 1, maximum: 100000 },
      maxOperations: { ...integer, minimum: 1, maximum: 10000 },
    }),
    ownerReview: object({
      reviewId: str,
      actorId: str,
      reviewedAt: str,
      provenanceDigest: hash,
      writeScopeDigest: hash,
    }),
    effectJournal: object({ database: str, collection: str }),
  },
  [
    'contractVersion',
    'sourceId',
    'deploymentId',
    'scope',
    'revision',
    'policyRevision',
    'authorizationRevision',
    'sourceKind',
    'namespaces',
    'fields',
    'tenantBoundaries',
    'subjectIdentityFieldIds',
    'references',
    'rules',
    'retainedFieldIds',
    'consistency',
    'limits',
    'ownerReview',
  ],
);
const target = object({
  namespaceId: str,
  identity: scalar,
  ruleId: str,
  preimageDigest: hash,
  postimageDigest: { oneOf: [hash, { bsonType: 'null' }] },
  concretePaths: array(path, 4096),
});
const request = {
  _id: str,
  ...scope,
  sourceId: str,
  registrationHash: hash,
  ownerActorId: str,
  authorizationRevision: integer,
  subjectFieldId: str,
  subject: scalar,
  expiresAt: date,
  createdAt: date,
};
const effect = {
  _id: str,
  ...scope,
  effectKey: hash,
  jobId: str,
  sourceId: str,
  registrationHash: hash,
  previewHash: hash,
  argsDigest: hash,
  targetCount: integer,
  createdAt: date,
};
const resourceLimits = object(
  Object.fromEntries(
    [
      'modelCalls',
      'toolCalls',
      'scannedDocuments',
      'changedDocuments',
      'traversalDepth',
      'graphNodes',
      'graphEdges',
      'wallTimeMs',
      'totalTokens',
      'maxCostMicrousd',
    ].map((name) => [name, integer]),
  ),
);

export const NATIVE_SOURCE_VALIDATORS: Record<string, Document> = {
  provenance_scope_barriers: {
    $jsonSchema: object({ _id: hash, ...scope, env: en(ENVIRONMENTS), touches: integer, updatedAt: date }),
  },
  native_source_gap_barriers: {
    $jsonSchema: object(
      {
        _id: hash,
        ...scope,
        sourceId: str,
        ownerActorId: str,
        namespaceId: str,
        registrationHash: hash,
        registrationRevision: integer,
        blocked: { bsonType: 'bool' },
        rebaselineHash: hash,
        updatedAt: date,
      },
      [
        '_id',
        ...Object.keys(scope),
        'sourceId',
        'ownerActorId',
        'namespaceId',
        'registrationHash',
        'registrationRevision',
        'blocked',
        'updatedAt',
      ],
    ),
  },
  native_source_registrations: {
    $jsonSchema: object({ _id: hash, registrationHash: hash, registration, createdAt: date }),
  },
  native_source_heads: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      sourceId: str,
      ownerActorId: str,
      registrationHash: hash,
      revision: integer,
      authorizationRevision: integer,
      eligible: { bsonType: 'bool' },
      touches: integer,
      updatedAt: date,
    }),
  },
  native_source_owner_grants: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      sourceId: str,
      ownerActorId: str,
      registrationHash: hash,
      previousRevision: integer,
      authorizationRevision: integer,
      reviewId: str,
      expiresAt: date,
      createdAt: date,
    }),
  },
  native_source_grant_consumptions: {
    $jsonSchema: object({ _id: str, ...scope, sourceId: str, registrationHash: hash, createdAt: date }),
  },
  native_source_cleanup_requests: { $jsonSchema: object(request) },
  native_source_preview_approvals: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      jobId: str,
      sourceId: str,
      registrationHash: hash,
      previewHash: hash,
      targetsDigest: hash,
      ownerActorId: str,
      authorizationRevision: integer,
      expiresAt: date,
      createdAt: date,
    }),
  },
  native_source_preview_consumptions: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      approvalId: str,
      effectKey: hash,
      jobId: str,
      registrationHash: hash,
      previewHash: hash,
      batchOrdinal: integer,
      createdAt: date,
    }),
  },
  native_source_job_bindings: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      jobId: str,
      sourceId: str,
      registrationHash: hash,
      revision: integer,
      authorizationRevision: integer,
      ownerActorId: str,
      cleanupRequestId: str,
      subjectFieldId: str,
      subject: scalar,
      createdAt: date,
    }),
  },
  native_source_previews: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      jobId: str,
      sourceId: str,
      registrationHash: hash,
      subjectKey: hash,
      previewHash: hash,
      targets: array(target, 1000),
      snapshotDigest: hash,
      scanned: integer,
      sourceKind: en(['original', 'isolated_replay']),
      snapshotRows: array(object({ namespaceId: str, identity: scalar, digest: hash }), 100000),
      observedAt: date,
      limitations: array(str, 32),
    }),
  },
  native_source_preimage_rows: {
    $jsonSchema: object({
      _id: str,
      previewId: str,
      ordinal: integer,
      target,
      preimage: { bsonType: 'object' },
      postimage: { bsonType: ['object', 'null'] },
    }),
  },
  native_source_effects: { $jsonSchema: object({ ...effect, batchOrdinal: integer }) },
  native_source_receipts: {
    $jsonSchema: object({
      ...effect,
      sourceKind: en(['original', 'isolated_replay']),
      leaseFence: integer,
      status: en(['source_effect_committed', 'held_cross_deployment']),
      atomicity: en(['same_deployment_transaction', 'control_intent_only']),
      limitations: array(str, 32),
    }),
  },
  native_source_readbacks: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      receiptId: str,
      effectKey: hash,
      status: en(['verified', 'diverged']),
      inspected: integer,
      observedAt: date,
    }),
  },
  native_source_consistency: {
    $jsonSchema: object(
      {
        _id: hash,
        ...scope,
        jobId: str,
        sourceId: str,
        registrationHash: hash,
        namespaceId: str,
        resumeToken: { bsonType: 'object' },
        status: en(['observing', 'changed', 'gap']),
        changed: integer,
        gapReason: str,
        coverage: en(['watermark_unproven']),
        updatedAt: date,
      },
      [
        '_id',
        ...Object.keys(scope),
        'jobId',
        'sourceId',
        'registrationHash',
        'namespaceId',
        'status',
        'coverage',
        'updatedAt',
      ],
    ),
  },
  native_source_consistency_events: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      jobId: str,
      sourceId: str,
      registrationHash: hash,
      namespaceId: str,
      kind: en(['gap', 'rebaseline']),
      reason: str,
      recovery: str,
      createdAt: date,
    }),
  },
  native_source_runtime_profiles: {
    $jsonSchema: object({
      _id: hash,
      spec: str,
      pricing: object({ inputMicrousdPerMillion: integer, outputMicrousdPerMillion: integer }),
      limits: resourceLimits,
      runtimeHash: hash,
      profileDigest: hash,
      createdAt: date,
    }),
  },
  native_source_budgets: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      jobId: str,
      sourceId: str,
      registrationHash: hash,
      harnessHash: hash,
      workerProfileHash: hash,
      profileDigest: hash,
      caps: object({
        scanned: integer,
        changed: integer,
        operations: integer,
        hops: integer,
        nodes: integer,
        edges: integer,
      }),
      scannedReserved: integer,
      changed: integer,
      operations: integer,
      revision: integer,
      updatedAt: date,
    }),
  },
};
export const NATIVE_SOURCE_COLLECTIONS = Object.keys(NATIVE_SOURCE_VALIDATORS);
const identity = { tenantId: 1, env: 1, scopeId: 1 } as const;
export const NATIVE_SOURCE_INDEXES: Array<{
  collection: string;
  key: IndexSpecification;
  options?: CreateIndexesOptions;
}> = [
  { collection: 'provenance_scope_barriers', key: identity, options: { unique: true } },
  { collection: 'native_source_gap_barriers', key: { ...identity, sourceId: 1 }, options: { unique: true } },
  { collection: 'native_source_heads', key: { ...identity, sourceId: 1 }, options: { unique: true } },
  { collection: 'native_source_owner_grants', key: { ...identity, sourceId: 1, expiresAt: 1 } },
  { collection: 'native_source_cleanup_requests', key: { ...identity, sourceId: 1, expiresAt: 1 } },
  {
    collection: 'native_source_preview_approvals',
    key: { ...identity, jobId: 1, previewHash: 1, expiresAt: 1 },
  },
  { collection: 'native_source_preview_consumptions', key: { effectKey: 1 }, options: { unique: true } },
  { collection: 'native_source_job_bindings', key: { ...identity, jobId: 1 }, options: { unique: true } },
  { collection: 'native_source_previews', key: { ...identity, jobId: 1, previewHash: 1 } },
  { collection: 'native_source_preimage_rows', key: { previewId: 1, ordinal: 1 }, options: { unique: true } },
  {
    collection: 'native_source_effects',
    key: { ...identity, jobId: 1, previewHash: 1, batchOrdinal: 1 },
    options: { unique: true },
  },
  {
    collection: 'native_source_receipts',
    key: { ...identity, jobId: 1, effectKey: 1 },
    options: { unique: true },
  },
  { collection: 'native_source_readbacks', key: { effectKey: 1, observedAt: 1 } },
  {
    collection: 'native_source_consistency',
    key: { ...identity, jobId: 1, namespaceId: 1 },
    options: { unique: true },
  },
  { collection: 'native_source_consistency_events', key: { ...identity, jobId: 1, createdAt: 1 } },
  { collection: 'native_source_budgets', key: { ...identity, jobId: 1 }, options: { unique: true } },
];

/** Source access is a separate exact manifest. Mongo collection RBAC does not enforce the tenant predicate. */
export function nativeSourceAtlasActions(input: NativeSourceRegistration): AtlasAction[] {
  const source = nativeSourceRegistrationSchema.parse(input);
  const resources = (namespaceIds: Set<string>) =>
    source.namespaces
      .filter((value) => namespaceIds.has(value.namespaceId))
      .map((value) => ({ db: value.database, collection: value.collection }));
  const all = new Set(source.namespaces.map((value) => value.namespaceId));
  const actions: AtlasAction[] = [
    { action: 'FIND', resources: resources(all) },
    { action: 'CHANGE_STREAM', resources: resources(all) },
  ];
  const updates = new Set(
    source.rules.filter((value) => value.effect !== 'delete').map((value) => value.namespaceId),
  );
  const deletes = new Set(
    source.rules.filter((value) => value.effect === 'delete').map((value) => value.namespaceId),
  );
  if (updates.size) actions.push({ action: 'UPDATE', resources: resources(updates) });
  if (deletes.size) actions.push({ action: 'REMOVE', resources: resources(deletes) });
  // Journal writes are insert-only. No generic source INSERT or metadata UPDATE privilege is granted.
  if (source.effectJournal)
    actions.push(
      ...['FIND', 'INSERT'].map((action) => ({
        action,
        resources: [{ db: source.effectJournal!.database, collection: source.effectJournal!.collection }],
      })),
    );
  return actions;
}
export const NATIVE_SOURCE_EXECUTOR_READS = [
  'native_source_registrations',
  'native_source_heads',
  'native_source_cleanup_requests',
  'native_source_job_bindings',
  'native_source_previews',
  'native_source_preimage_rows',
  'native_source_effects',
  'native_source_receipts',
  'native_source_readbacks',
  'native_source_consistency',
  'native_source_consistency_events',
  'native_source_runtime_profiles',
  'native_source_budgets',
  'native_source_preview_approvals',
  'native_source_preview_consumptions',
  'native_source_gap_barriers',
  'provenance_scope_barriers',
] as const;
export const NATIVE_SOURCE_EXECUTOR_INSERTS = [
  'native_source_job_bindings',
  'native_source_previews',
  'native_source_preimage_rows',
  'native_source_effects',
  'native_source_receipts',
  'native_source_readbacks',
  'native_source_consistency',
  'native_source_consistency_events',
  'native_source_budgets',
  'native_source_preview_consumptions',
  'native_source_gap_barriers',
  'provenance_scope_barriers',
] as const;
export function withNativeSourceAccess(
  role: AtlasRoleManifest,
  input: NativeSourceRegistration,
): AtlasRoleManifest {
  return { ...role, actions: [...role.actions, ...nativeSourceAtlasActions(input)] };
}

/** Production native executor provisioning omits every legacy generated-world and private-truth grant. */
export function nativeDomainExecutorAtlasRoleManifest(
  input: NativeSourceRegistration,
  controlDatabase: string,
): AtlasRoleManifest {
  const source = nativeSourceRegistrationSchema.parse(input);
  if (
    !controlDatabase ||
    source.namespaces.some((value) => value.database === controlDatabase) ||
    source.effectJournal?.database === controlDatabase
  )
    throw new Error('NativeSourceCollidesWithAuthorityStorage');
  const control = (action: string, collections: readonly string[]): AtlasAction => ({
    action,
    resources: collections.map((collection) => ({ db: controlDatabase, collection })),
  });
  return {
    roleName: 'expunge_native_domain_executor',
    inheritedRoles: [],
    actions: [
      ...nativeSourceAtlasActions(source),
      control('FIND', [
        ...NATIVE_SOURCE_EXECUTOR_READS,
        'jobs',
        'artifacts',
        'artifact_eligibility',
        'provenance_edges',
        'authority_revisions',
        'authority_touches',
        'deployments',
      ]),
      control('INSERT', NATIVE_SOURCE_EXECUTOR_INSERTS),
      control('UPDATE', [
        'jobs',
        'authority_touches',
        'native_source_heads',
        'native_source_budgets',
        'native_source_consistency',
        'native_source_gap_barriers',
        'provenance_scope_barriers',
      ]),
    ],
  };
}
