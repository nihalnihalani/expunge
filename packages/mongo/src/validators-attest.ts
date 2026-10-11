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
const en = (values: string[]): Schema => ({ bsonType: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  bsonType: 'object',
  required,
  additionalProperties: false,
  properties,
});
const scope = { tenantId: str, env: en(['dev', 'evaluation', 'demo']), scopeId: str };
type IndexEntry = { collection: string; key: Document; options?: Document };
const identity = { tenantId: 1, env: 1, scopeId: 1 } as const;

/** Per-fence model attestations and leak-guard export generations. Both are insert-only. */
export const ATTEST_COLLECTIONS = ['run_attestations', 'guard_exports', 'subject_set_generations'] as const;

export const ATTEST_VALIDATORS: Record<string, Document> = {
  // What model a lease holder says it ran under, one row per (job, fence). The worker inserts it; nobody updates or removes it,
  // so a principal that can UPDATE `jobs` cannot rewrite the stamp the gate checks.
  run_attestations: {
    $jsonSchema: object(
      {
        _id: hash,
        ...scope,
        jobId: str,
        runId: str,
        fence: integer,
        source: str,
        provider: str,
        modelId: str,
        spec: str,
        /** Hash of the runtime the lease holder ran under; the gate compares it instead of reading the job checkpoint. */
        runtimeHash: hash,
        endpoint: str,
        endpointHostHash: hash,
        at: date,
        createdAt: date,
      },
      [
        '_id',
        ...Object.keys(scope),
        'jobId',
        'runId',
        'fence',
        'source',
        'provider',
        'modelId',
        'spec',
        'runtimeHash',
        'at',
        'createdAt',
      ],
    ),
  },
  // The generation of the leak guard the privacy controller last exported for an organization, so the observer can hold on a
  // stale guard file. Generations only rise.
  guard_exports: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      providerOrganizationId: str,
      generation: integer,
      /** The subject-set generation this guard covers; the observer holds when the current one is ahead. */
      subjectSetGeneration: integer,
      count: integer,
      digest: hash,
      exportedAt: date,
      createdAt: date,
    }),
  },
  // One row per scope: bumped by SubjectTokenRepository.put in the SAME transaction that registers a subject's tokens, so a
  // subject registered after the last guard export is visible as "the guard does not cover the current subject set".
  subject_set_generations: {
    $jsonSchema: object({
      _id: hash,
      ...scope,
      generation: integer,
      updatedAt: date,
    }),
  },
};

export const ATTEST_INDEXES: IndexEntry[] = [
  { collection: 'run_attestations', key: { ...identity, jobId: 1, fence: 1 }, options: { unique: true } },
  {
    collection: 'guard_exports',
    key: { ...identity, providerOrganizationId: 1, generation: 1 },
    options: { unique: true },
  },
  { collection: 'subject_set_generations', key: { ...identity }, options: { unique: true } },
];
