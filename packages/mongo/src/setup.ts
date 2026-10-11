import type { Document, IndexSpecification, CreateIndexesOptions } from 'mongodb';
import type { DeploymentKey, Environment, ScopeKey, TargetKind } from '@expunge/contracts';
import { requirePrincipal, type MongoService } from './client.js';
import { AuthorityRepository } from './authority.js';
import { AuthorityPolicyRepository } from './policy.js';
import {
  CONTROL_VALIDATORS,
  PRIVATE_VALIDATORS,
  WORLD_VALIDATORS,
  assertSupportedMongoSchema,
} from './validators.js';

export const WORLD_COLLECTIONS = [
  'customers',
  'accounts',
  'messages',
  'events',
  'notes',
  'archives',
  'schema_registry',
  'identity_edges',
  'world_revisions',
  'world_scope_bindings',
  'retained_invoices',
] as const;
export const CONTROL_COLLECTIONS = [
  'jobs',
  'runs',
  'action_intents',
  'effects',
  'action_receipts',
  'completion_receipts',
  'artifacts',
  'candidates',
  'gate_reports',
  'deployments',
  'promotions',
  'approvals',
  'public_trial_rows',
  'evidence',
  'provenance_edges',
  'lessons',
  'raw_artifacts',
  'subject_tokens',
  'artifact_eligibility',
  'telemetry_outbox',
  'telemetry_receipts',
  'observer_cursors',
  'projection_events',
  'external_deletions',
  'meta_campaigns',
  'adversary_campaigns',
  'stream_offsets',
  'projection_sequences',
  'deployment_outbox',
  'provenance_closures',
  'authority_policies',
  'grant_consumptions',
  'authority_revisions',
  'authority_touches',
  'decisions',
  'wake_commands',
  'job_subjects',
  'domain_steps',
  'preview_plans',
  'verification_sweeps',
  'diagnostics',
] as const;
export const PRIVATE_COLLECTIONS = [
  'fixture_specs',
  'oracle_manifests',
  'expected_poststates',
  'preservation_hashes',
  'heldout_assignments',
  'grader_results',
  'campaign_keys',
] as const;
type IndexEntry = { collection: string; key: IndexSpecification; options?: CreateIndexesOptions };
const identity = { tenantId: 1, env: 1, scopeId: 1 } as const;
const jobActorIdentity = { 'actor.tenantId': 1, 'actor.env': 1, 'actor.scopeId': 1 } as const;
export const CONTROL_INDEXES: IndexEntry[] = [
  { collection: 'jobs', key: { kind: 1, status: 1, priority: -1, createdAt: 1 } },
  { collection: 'jobs', key: { status: 1, 'lease.until': 1 } },
  // Scope-bound claimable listing: scope, then status/kind, ordered by priority and age.
  {
    collection: 'jobs',
    key: { ...jobActorIdentity, status: 1, kind: 1, priority: -1, createdAt: 1 },
  },
  // Revocation finds live jobs by pinned harness or by any recorded context input.
  { collection: 'jobs', key: { ...jobActorIdentity, 'binding.harnessHash': 1 } },
  { collection: 'jobs', key: { ...jobActorIdentity, contextInputs: 1 } },
  { collection: 'effects', key: { effectKey: 1 }, options: { unique: true } },
  { collection: 'action_intents', key: { effectKey: 1 }, options: { unique: true } },
  { collection: 'action_receipts', key: { effectKey: 1 }, options: { unique: true } },
  { collection: 'completion_receipts', key: { jobId: 1, verifiedWorldRevision: 1 } },
  { collection: 'artifacts', key: { 'payload.parentHash': 1 } },
  { collection: 'artifacts', key: { 'payload.target': 1, createdAt: 1 } },
  { collection: 'deployments', key: { ...identity, target: 1 }, options: { unique: true } },
  { collection: 'promotions', key: { ...identity, target: 1, toRevision: 1 }, options: { unique: true } },
  {
    collection: 'promotions',
    key: { consumedGrantId: 1 },
    options: { unique: true, partialFilterExpression: { consumedGrantId: { $type: 'string' } } },
  },
  { collection: 'approvals', key: { nonce: 1 }, options: { unique: true } },
  { collection: 'approvals', key: { expiresAt: 1 } },
  { collection: 'gate_reports', key: { candidateId: 1 } },
  { collection: 'candidates', key: { candidateId: 1 }, options: { unique: true } },
  {
    collection: 'candidates',
    key: { 'actor.tenantId': 1, 'actor.env': 1, 'actor.scopeId': 1, target: 1, parentHash: 1, state: 1 },
  },
  {
    collection: 'public_trial_rows',
    key: { campaignId: 1, pairId: 1, arm: 1, repeat: 1 },
    options: { unique: true },
  },
  {
    collection: 'evidence',
    key: { provider: 1, projectId: 1, externalEventId: 1, evidenceRevision: 1 },
    options: { unique: true },
  },
  { collection: 'provenance_edges', key: { edgeKey: 1 }, options: { unique: true } },
  { collection: 'provenance_edges', key: { ...identity, fromId: 1, edgeKey: 1 } },
  { collection: 'provenance_edges', key: { ...identity, createdAt: 1, edgeKey: 1 } },
  { collection: 'provenance_closures', key: { ...identity, sourceId: 1 }, options: { unique: true } },
  { collection: 'authority_policies', key: { ...identity, target: 1 }, options: { unique: true } },
  { collection: 'grant_consumptions', key: { ...identity, target: 1, candidateId: 1 } },
  { collection: 'authority_revisions', key: { ...identity }, options: { unique: true } },
  { collection: 'authority_touches', key: { ...identity }, options: { unique: true } },
  { collection: 'decisions', key: { ...identity, jobId: 1, stepId: 1, batchOrdinal: 1 } },
  { collection: 'job_subjects', key: { ...identity, jobId: 1 }, options: { unique: true } },
  {
    collection: 'domain_steps',
    key: { ...identity, jobId: 1, kind: 1, ordinal: 1 },
    options: { unique: true },
  },
  { collection: 'preview_plans', key: { ...identity, jobId: 1, createdAt: 1 } },
  { collection: 'verification_sweeps', key: { ...identity, jobId: 1, createdAt: 1 } },
  { collection: 'diagnostics', key: { ...identity, jobId: 1, createdAt: 1 } },
  // TTL is housekeeping for deduplication ids only; it never decides whether a command is allowed.
  { collection: 'wake_commands', key: { acceptedAt: 1 }, options: { expireAfterSeconds: 7 * 24 * 3600 } },
  { collection: 'wake_commands', key: { jobId: 1, acceptedAt: 1 } },
  { collection: 'provenance_edges', key: { ...identity, toId: 1 } },
  { collection: 'lessons', key: { ...identity, moduleId: 1, family: 1 } },
  { collection: 'raw_artifacts', key: { tenantId: 1, env: 1, sourceId: 1 } },
  {
    collection: 'subject_tokens',
    key: { tenantId: 1, env: 1, subjectHandle: 1, provider: 1, tokenGeneration: 1 },
    options: { unique: true },
  },
  { collection: 'artifact_eligibility', key: { ...identity, artifactHash: 1 }, options: { unique: true } },
  { collection: 'telemetry_outbox', key: { operationId: 1 }, options: { unique: true } },
  { collection: 'telemetry_outbox', key: { status: 1, nextAttemptAt: 1, 'lease.until': 1 } },
  { collection: 'telemetry_receipts', key: { operationId: 1 }, options: { unique: true } },
  { collection: 'observer_cursors', key: { projectId: 1, observerVersion: 1 }, options: { unique: true } },
  // Sequences are per job stream; uniqueness is per (scope, job, sequence).
  { collection: 'projection_events', key: { ...identity, jobId: 1, sequence: 1 }, options: { unique: true } },
  { collection: 'external_deletions', key: { ...identity, requestKey: 1 }, options: { unique: true } },
  { collection: 'external_deletions', key: { providerStatus: 1, dueBy: 1 } },
  { collection: 'deployment_outbox', key: { dedupeKey: 1 }, options: { unique: true } },
];
export const WORLD_INDEXES: IndexEntry[] = [
  ...WORLD_COLLECTIONS.filter((n) =>
    ['customers', 'accounts', 'messages', 'events', 'notes', 'archives', 'retained_invoices'].includes(n),
  ).map((collection) => ({ collection, key: { tenantId: 1, env: 1, worldId: 1, _id: 1 } }) as IndexEntry),
  { collection: 'schema_registry', key: { ...identity, revision: 1 }, options: { unique: true } },
  { collection: 'world_scope_bindings', key: { ...identity, worldId: 1 }, options: { unique: true } },
  { collection: 'world_revisions', key: { ...identity, worldId: 1 }, options: { unique: true } },
  { collection: 'identity_edges', key: { edgeKey: 1 }, options: { unique: true } },
  // Edges are versioned by the world revision they were derived at; traversal reads one revision only.
  { collection: 'identity_edges', key: { ...identity, worldId: 1, worldRevision: 1, fromNode: 1 } },
  { collection: 'identity_edges', key: { ...identity, worldId: 1, worldRevision: 1, toNode: 1 } },
];
/**
 * Indexes replaced by a redesign. Dropping them keeps setup idempotent across versions: the legacy unique
 * `(scope, sequence)` index would otherwise reject the second job's first event now that sequences are per job.
 */
const LEGACY_INDEXES: Array<{ collection: string; name: string }> = [
  { collection: 'projection_events', name: 'tenantId_1_env_1_scopeId_1_sequence_1' },
];
async function dropLegacyIndexes(service: MongoService): Promise<void> {
  for (const { collection, name } of LEGACY_INDEXES) {
    try {
      await service.control.collection(collection).dropIndex(name);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      // 26 NamespaceNotFound, 27 IndexNotFound: nothing to migrate.
      if (code !== 26 && code !== 27) throw error;
    }
  }
}
export type AuthorityPolicySeed = { key: DeploymentKey; behavioralRequiresApproval: boolean };
export type AuthoritySeed = { key: ScopeKey; floorHash: string };
export type SetupOptions = {
  /** Stored approval policies to install idempotently. A missing policy makes promotion fail closed. */
  authorityPolicies?: AuthorityPolicySeed[];
  /** Per-scope authority rows (authorization revision 1) to install idempotently. Missing: effects fail closed. */
  authorities?: AuthoritySeed[];
};
const TARGETS: TargetKind[] = ['worker', 'improver', 'hider'];
const ENVIRONMENTS: Environment[] = ['dev', 'evaluation', 'demo'];
/**
 * Setup seeds from the environment, never from a request: the scope named by EXPUNGE_TENANT_ID, EXPUNGE_ENV and
 * EXPUNGE_SCOPE_ID gets an authority row with floor hash EXPUNGE_AUTHORITY_FLOOR_HASH and an approval policy for
 * each target. Behavioral changes require approval unless EXPUNGE_BEHAVIORAL_REQUIRES_APPROVAL is exactly "0".
 * Without a floor hash nothing is seeded; the system then fails closed instead of guessing.
 */
export function seedOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SetupOptions {
  const floorHash = env.EXPUNGE_AUTHORITY_FLOOR_HASH;
  if (!floorHash) return {};
  const { EXPUNGE_TENANT_ID: tenantId, EXPUNGE_ENV: scopeEnv, EXPUNGE_SCOPE_ID: scopeId } = env;
  if (!/^[a-f0-9]{64}$/.test(floorHash)) throw new Error('InvalidSetupSeed:EXPUNGE_AUTHORITY_FLOOR_HASH');
  if (!tenantId || !scopeId || !ENVIRONMENTS.includes(scopeEnv as Environment))
    throw new Error('InvalidSetupSeed:scope');
  const key: ScopeKey = { tenantId, env: scopeEnv as Environment, scopeId };
  const behavioralRequiresApproval = env.EXPUNGE_BEHAVIORAL_REQUIRES_APPROVAL !== '0';
  return {
    authorities: [{ key, floorHash }],
    authorityPolicies: TARGETS.map((target) => ({ key: { ...key, target }, behavioralRequiresApproval })),
  };
}
export async function setupMongo(
  service: MongoService,
  options: SetupOptions = {},
): Promise<{ collections: number; indexes: number; authorityPolicies: number; authorities: number }> {
  requirePrincipal(service, ['setup']);
  let collections = 0,
    indexes = 0;
  for (const [db, names, validators] of [
    [service.world, WORLD_COLLECTIONS, WORLD_VALIDATORS],
    [service.control, CONTROL_COLLECTIONS, CONTROL_VALIDATORS],
    [service.privateDb!, PRIVATE_COLLECTIONS, PRIVATE_VALIDATORS],
  ] as const) {
    for (const name of names) {
      const validator = (validators as Record<string, Document>)[name];
      if (validator) assertSupportedMongoSchema(validator);
      const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
      if (!exists)
        await db.createCollection(
          name,
          validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {},
        );
      else if (validator)
        await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
      collections++;
    }
  }
  for (const entry of WORLD_INDEXES) {
    await service.world.collection(entry.collection).createIndex(entry.key, entry.options);
    indexes++;
  }
  await dropLegacyIndexes(service);
  for (const entry of CONTROL_INDEXES) {
    await service.control.collection(entry.collection).createIndex(entry.key, entry.options);
    indexes++;
  }
  const policies = new AuthorityPolicyRepository(service);
  for (const seed of options.authorityPolicies ?? [])
    await policies.install(seed.key, seed.behavioralRequiresApproval);
  const authorities = new AuthorityRepository(service);
  for (const seed of options.authorities ?? []) await authorities.install(seed.key, seed.floorHash);
  return {
    collections,
    indexes,
    authorityPolicies: options.authorityPolicies?.length ?? 0,
    authorities: options.authorities?.length ?? 0,
  };
}
