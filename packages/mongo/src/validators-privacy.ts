import type { Document } from 'mongodb';

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
const nullable = (schema: Schema): Schema => ({
  ...schema,
  bsonType: [...(Array.isArray(schema.bsonType) ? schema.bsonType : [schema.bsonType]), 'null'],
});
const arr = (items: Schema, maxItems = 256): Schema => ({ bsonType: 'array', items, maxItems });
const en = (values: string[]): Schema => ({ bsonType: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  bsonType: 'object',
  required,
  additionalProperties: false,
  properties,
});
const ENV = en(['dev', 'evaluation', 'demo']);
const scope = { tenantId: str, env: ENV, scopeId: str };
type IndexEntry = { collection: string; key: Document; options?: Document };
const identity = { tenantId: 1, env: 1, scopeId: 1 } as const;

const REASONS = [
  'source_retracted',
  'subject_erasure_request',
  'owner_withdrawal',
  'scan_SubjectLiteral',
  'scan_HeldOutLeak',
  'scan_PrivateIdLeak',
  'scan_raw_retention',
];
const SOURCE_KINDS = ['telemetry_event', 'trace', 'transcript', 'evidence_bundle', 'tool_output'];

/** Collections the privacy controller owns, plus the narrow export-suppression read. */
export const PRIVACY_COLLECTIONS = ['erasure_suppressions'] as const;

export const PRIVACY_VALIDATORS: Record<string, Document> = {
  // The narrow read export suppression needs: which provider-side users are being erased. No subject literal and no
  // erasure job detail; observer and domain_executor may read this and nothing about `external_deletions`.
  erasure_suppressions: {
    $jsonSchema: object({
      _id: str,
      tenantId: str,
      env: ENV,
      providerOrganizationId: str,
      userKey: str,
      jobId: str,
      active: bool,
      updatedAt: date,
    }),
  },
  // Raw evidence, or the tombstone that replaces it: the tombstone has no content hash, no size and no content.
  raw_artifacts: {
    $jsonSchema: {
      bsonType: 'object',
      anyOf: [
        object({
          _id: str,
          ...scope,
          sourceId: str,
          kind: en(SOURCE_KINDS),
          contentSha256: hash,
          sizeBytes: integer,
          retention: en(['raw', 'hash_only']),
          content: nullable({ bsonType: 'string', maxLength: 1_048_576 }),
          registeredAt: date,
        }),
        object({
          _id: str,
          ...scope,
          sourceId: str,
          kind: en(SOURCE_KINDS),
          deletedAt: date,
          reasonCode: en(REASONS),
          policyHash: hash,
          closureId: nullable(str),
        }),
      ],
    },
  },
  // Subject handle -> provider-side opaque identities. A subject literal lives here and nowhere the model reads.
  subject_tokens: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      subjectHandle: str,
      provider: str,
      tokenGeneration: integer,
      tokens: arr(str, 1024),
      registeredAt: date,
    }),
  },
  // Structural learning only: closed-vocabulary ids, counts, hashes. A purged lesson keeps only its tombstone.
  lessons: {
    $jsonSchema: {
      bsonType: 'object',
      anyOf: [
        object({
          _id: str,
          ...scope,
          lessonId: str,
          moduleId: str,
          family: str,
          structure: {},
          retention: en(['structural']),
          sourceIds: arr(str, 1024),
          policyHash: hash,
          registeredAt: date,
        }),
        object({
          _id: str,
          ...scope,
          lessonId: str,
          deletedAt: date,
          reasonCode: en(REASONS),
          policyHash: hash,
          closureId: nullable(str),
        }),
      ],
    },
  },
};

export const PRIVACY_INDEXES: IndexEntry[] = [
  // One row per (organization, user, erasure job): the provider erasure is organization-wide, a user may be under several
  // jobs, and clearing one job's row must not lift another's.
  {
    collection: 'erasure_suppressions',
    key: { providerOrganizationId: 1, userKey: 1, jobId: 1 },
    options: { unique: true },
  },
  { collection: 'erasure_suppressions', key: { providerOrganizationId: 1, active: 1, userKey: 1 } },
  { collection: 'erasure_suppressions', key: { jobId: 1, active: 1 } },
  { collection: 'lessons', key: { ...identity, lessonId: 1 } },
];
