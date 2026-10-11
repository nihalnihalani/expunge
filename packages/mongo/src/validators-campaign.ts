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
const anyObject: Schema = { bsonType: 'object' };
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

/**
 * Control collections of the campaign results: the immutable summary and rows a meta or Hider campaign commits, the
 * adversary's campaign and trial rows, the meta draw commitment, and the per-world split assignments. All insert-only;
 * nothing is updated or removed by any runtime principal.
 */
export const CAMPAIGN_RESULT_COLLECTIONS = [
  'campaign_artifacts',
  'campaign_artifact_rows',
  'meta_draw_commitments',
  'adversary_trials',
  'world_splits',
] as const;

export const CAMPAIGN_RESULT_VALIDATORS: Record<string, Document> = {
  campaign_artifacts: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      artifactId: str,
      kind: en(['meta', 'hider']),
      campaignId: str,
      manifestHash: hash,
      rowIds: arr(str, 4096),
      payload: {},
      payloadDigest: hash,
      committedAt: date,
    }),
  },
  campaign_artifact_rows: {
    $jsonSchema: object(
      {
        _id: str,
        ...scope,
        campaignId: str,
        rowId: str,
        kind: en(['meta', 'hider']),
        manifestHash: hash,
        result: en(['measured', 'null', 'invalid']),
        admitted: bool,
        w0ResetProof: str,
        budgetHash: hash,
        payload: {},
        payloadDigest: hash,
        committedAt: date,
      },
      [
        '_id',
        ...Object.keys(scope),
        'campaignId',
        'rowId',
        'kind',
        'manifestHash',
        'result',
        'payload',
        'payloadDigest',
        'committedAt',
      ],
    ),
  },
  // `_id` is assigned by the server (forceServerObjectId), so the commit time is the server's and is read from it.
  // Four kinds per campaign, each once, in order: the draw commitment, the I1 creation record, the freeze, the drawn set.
  meta_draw_commitments: {
    $jsonSchema: {
      bsonType: 'object',
      anyOf: [
        object({
          _id: { bsonType: 'objectId' },
          campaignId: str,
          kind: en(['commitment']),
          commitment: object({ seedCommitment: hash, incidentPoolHash: hash, worldPoolHash: hash }),
          i0Hash: hash,
        }),
        object({ _id: { bsonType: 'objectId' }, campaignId: str, kind: en(['i1']), i1Hash: hash }),
        object({ _id: { bsonType: 'objectId' }, campaignId: str, kind: en(['draw']), setHash: hash }),
        object({ _id: { bsonType: 'objectId' }, campaignId: str, kind: en(['freeze']), freezeHash: hash }, [
          '_id',
          'campaignId',
          'kind',
        ]),
      ],
    },
  },
  adversary_campaigns: {
    $jsonSchema: object({
      _id: str,
      campaignId: str,
      campaignHash: str,
      frozen: {},
      seedCommitment: str,
      hider: object({ id: str, kind: en(['enumerator', 'fake', 'provider']) }),
      workerBundleHash: hash,
      parentBundleHash: hash,
      rounds: integer,
      perRound: integer,
      targetAdmitted: integer,
      summary: {},
      digest: str,
      createdAt: date,
    }),
  },
  adversary_trials: {
    $jsonSchema: object(
      {
        _id: str,
        adversaryTrialId: str,
        specHash: hash,
        referenceSolverHash: hash,
        admitted: bool,
        reasonCodes: arr(str, 64),
        noveltyFamily: str,
        resourceBounds: anyObject,
        workerRunId: nullable(str),
        metrics: nullable(anyObject),
        campaignId: str,
        round: integer,
        ordinal: integer,
        hiderId: str,
        hiderKind: en(['enumerator', 'fake', 'provider']),
        hypothesis: nullable(str),
        category: nullable(str),
        family: nullable(str),
        structuralHash: nullable(str),
        noveltyShape: nullable(str),
        referenceResultHash: nullable(str),
        plan: nullable(anyObject),
        limitation: nullable(anyObject),
        reward: { bsonType: ['int', 'long', 'double'] },
      },
      [
        '_id',
        'adversaryTrialId',
        'specHash',
        'referenceSolverHash',
        'admitted',
        'reasonCodes',
        'noveltyFamily',
        'resourceBounds',
        'workerRunId',
        'metrics',
        'campaignId',
        'round',
        'ordinal',
        'hiderId',
        'hiderKind',
        'reward',
      ],
    ),
  },
  // Which split a world belongs to, written once when the world is seeded.
  world_splits: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      worldId: str,
      split: en(['train', 'protected', 'validation', 'final']),
      planCommitment: hash,
      createdAt: date,
    }),
  },
};

export const CAMPAIGN_RESULT_INDEXES: IndexEntry[] = [
  {
    collection: 'campaign_artifact_rows',
    key: { ...identity, campaignId: 1, rowId: 1 },
    options: { unique: true },
  },
  { collection: 'meta_draw_commitments', key: { campaignId: 1, kind: 1 }, options: { unique: true } },
  { collection: 'adversary_trials', key: { campaignId: 1, ordinal: 1 } },
  { collection: 'adversary_trials', key: { adversaryTrialId: 1 }, options: { unique: true } },
  { collection: 'world_splits', key: { ...identity, worldId: 1 }, options: { unique: true } },
];
