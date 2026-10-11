import type { Document } from 'mongodb';
import { ENVIRONMENTS } from '@expunge/contracts';

/**
 * Strict validators, indexes and role grants for the control collections the gate, the adversary, the fault layer, the
 * privacy controller and the deployment rollback write. They are merged into `CONTROL_VALIDATORS`, `CONTROL_INDEXES`
 * and the role manifests, so the manifests and the setup read from one place each.
 *
 * What a collection-level grant cannot do (limit WHICH fields or transitions a writer changes) is said next to the
 * collection and enforced by the owning repository with a compare-and-set; docs/MONGO.md lists each.
 */
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
const anyObject: Schema = { bsonType: 'object' };
const nullable = (schema: Schema): Schema => ({
  ...schema,
  bsonType: [...(Array.isArray(schema.bsonType) ? schema.bsonType : [schema.bsonType]), 'null'],
});
const arr = (items: Schema, maxItems = 256): Schema => ({ bsonType: 'array', items, maxItems });
const en = (values: readonly string[]): Schema => ({ bsonType: 'string', enum: [...values] });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  bsonType: 'object',
  required,
  additionalProperties: false,
  properties,
});
const scope = { tenantId: str, env: en(ENVIRONMENTS), scopeId: str };

export const GATE_CONTROL_COLLECTIONS = [
  'campaign_freezes',
  'gate_claims',
  'gate_attempts',
  'gate_held_runs',
  'world_faults',
  'rollback_refusals',
  'campaign_artifact_permits',
] as const;

export const GATE_CONTROL_VALIDATORS: Record<string, Document> = {
  // Written once by the fixture builder before a campaign runs; the gate only reads it (hash-checked on read).
  campaign_freezes: {
    $jsonSchema: object({
      _id: str,
      campaignId: str,
      evaluatorHash: hash,
      fixtureGeneratorHash: hash,
      runtimeHash: hash,
      compilerHash: hash,
      workerProfileHash: hash,
      budgetHash: hash,
      maxAttemptsPerParent: integer,
      splitManifestCommitment: hash,
      costCeilingMicrousd: nullable(integer),
      freezeHash: hash,
    }),
  },
  // One claim per (parent, executable child). The grader moves `state` open -> held | failed | decided and
  // held -> open for the same campaign; a collection grant cannot limit that, so the gate's repository does it by
  // compare-and-set on (_id, campaignId, state).
  gate_claims: {
    $jsonSchema: object(
      {
        _id: hash,
        parentHash: hash,
        childProjectionHash: hash,
        campaignId: str,
        state: en(['open', 'held', 'decided', 'failed', 'invalid']),
        ordinal: integer,
      },
      ['_id', 'parentHash', 'childProjectionHash', 'campaignId', 'state'],
    ),
  },
  // The atomic per-parent attempt counter: one row per parent, `findOneAndUpdate` with upsert and `$inc`.
  gate_attempts: { $jsonSchema: object({ _id: str, attempts: integer }) },
  // Trials of a campaign that ended HELD, kept and excluded from the resumed decision. Insert-only.
  gate_held_runs: {
    $jsonSchema: object({
      _id: str,
      claimKey: hash,
      campaignId: str,
      attempt: integer,
      freezeHash: hash,
      reasonCodes: arr(str, 64),
      excluded: en(['superseded_by_resume']),
      trials: arr(anyObject, 4096),
    }),
  },
  // The fault plan of one campaign world: trusted, hash-checked on read, never visible to the model.
  world_faults: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      worldId: str,
      plan: object({
        partialAcknowledgements: integer,
        interruptAfterEffects: nullable(integer),
        transientFailures: integer,
      }),
      planHash: hash,
      createdAt: date,
    }),
  },
  // Every refused rollback, insert-only: the audit the deployment projection serves as `refusedRollbacks`.
  rollback_refusals: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      target: en(['worker', 'improver', 'hider']),
      toHash: hash,
      code: en([
        'RollbackNeedsGrant',
        'StaleParent',
        'StaleScopeRevision',
        'RollbackTargetIsActive',
        'ApprovalInvalidOrConsumed',
      ]),
      at: date,
      actor: object({ actorId: str, authorizationRevision: integer }),
    }),
  },
  // Where the grader records that an artifact may run in a campaign's scope. It is NOT `artifact_eligibility`: the grader
  // has no write on that collection, so a campaign permit can never make an artifact eligible for production context
  // loading. Only campaign scopes (evaluation env, no production deployment) are consulted (see ArtifactRepository).
  campaign_artifact_permits: {
    $jsonSchema: object({
      _id: str,
      ...scope,
      campaignId: str,
      artifactHash: hash,
      freezeHash: hash,
      createdAt: date,
    }),
  },
};

type IndexEntry = { collection: string; key: Document; options?: Document };
const identity = { tenantId: 1, env: 1, scopeId: 1 } as const;
export const GATE_CONTROL_INDEXES: IndexEntry[] = [
  { collection: 'gate_claims', key: { parentHash: 1 } },
  { collection: 'gate_claims', key: { campaignId: 1, state: 1 } },
  { collection: 'gate_held_runs', key: { claimKey: 1, campaignId: 1, attempt: 1 } },
  { collection: 'world_faults', key: { ...identity, worldId: 1 }, options: { unique: true } },
  { collection: 'rollback_refusals', key: { ...identity, target: 1, at: -1 } },
];
