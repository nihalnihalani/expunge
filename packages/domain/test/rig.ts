import { buildExpertStaticBundle, buildW0Bundle, type InfrastructureHashes } from '@expunge/baselines';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import {
  contentHash,
  type ActorContext,
  type DomainAddress,
  type EffectKind,
  type FieldDescriptor,
  type HarnessBundle,
  type Job,
  type ReferenceDeclaration,
  type ScopeRegistry,
} from '@expunge/contracts';
import {
  ArtifactRepository,
  AuthorityRepository,
  JobRepository,
  ScopeRepository,
  WorldRepository,
  type MongoService,
} from '@expunge/mongo';
import { DEFAULT_AUTHORITY_FLOOR, createAuthorityFloor, type AuthorityFloor } from '@expunge/governance';
import { OWNER_EPISODE_LIMITS, WORKER_TOOL_IDS } from '@expunge/baselines';
import type { ToolContext } from '@expunge/runtime';
import {
  COLLECTION_IDS,
  ELIGIBILITY_POLICY_HASH,
  ELIGIBILITY_POLICY_ID,
  createWorldSpec,
  deriveWorldScopeKey,
  type CollectionId,
  type FixtureFamily,
  type VisibleWorld,
} from '../../fixtures/src/index.js';
import { generateSealedFixture, type FixtureManifest } from '../../fixtures/src/sealed.js';
import { HASH, openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';
import { createDomainEnv, createDomainToolProvider, type DomainEnv } from '../src/index.js';

/**
 * SCRIPTED DRIVER (labeled fake). A deterministic stand-in for the model that follows a bundle's workflow by calling
 * the same tool definitions the runtime offers. It decides nothing: every decision, effect and receipt below comes
 * from the gateway. It is not a model and its runs are not model evidence.
 */
export const SCRIPTED_DRIVER_LABEL =
  'SCRIPTED DRIVER: deterministic stand-in for the model; follows the bundle workflow; not a model';

export const infrastructureHashes: InfrastructureHashes = {
  runtimeAdapterHash: HASH,
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
export const bundles = {
  w0: () => buildW0Bundle(infrastructureHashes),
  expert: () => buildExpertStaticBundle(infrastructureHashes),
};

export type Seeded = {
  family: FixtureFamily;
  world: VisibleWorld;
  manifest: FixtureManifest;
  binding: { tenantId: string; env: ActorContext['env']; scopeId: string };
  actor: ActorContext;
  bundleHashes: { w0: string; expert: string };
  /** The bundles the hashes name, when they are not the standard ones (a world seeded under another floor). */
  bundleObjects?: { w0: HarnessBundle; expert: HarnessBundle };
};
/** A floor whose owner depth the edge walk cannot cover (it walks five hops), to exercise a truncated reach. */
export const DEEP_FLOOR: AuthorityFloor = createAuthorityFloor({
  allowedTools: WORKER_TOOL_IDS,
  allowedEffects: ['delete', 'redact', 'restrict', 'tombstone'],
  maxLimits: { ...OWNER_EPISODE_LIMITS, traversalDepth: 8 },
});

/** One record of a hand-built world. `effect: null` leaves the eligibility metadata out. */
export type CustomDoc = {
  collection: string;
  id: string | import('mongodb').ObjectId;
  data: Record<string, unknown>;
  effect?: EffectKind | null;
  policyId?: string;
  access?: 'open' | 'restricted';
};
export type CustomWorld = {
  fields: FieldDescriptor[];
  edges: ReferenceDeclaration[];
  docs: CustomDoc[];
  floor?: AuthorityFloor;
  subject: { idType: 'string' | 'objectId'; value: string };
};

export type Rig = {
  env: LiveEnvironment;
  executor: MongoService;
  domain: DomainEnv;
  seed(family: FixtureFamily, seedValue?: string): Promise<Seeded>;
  /** A small hand-built world (shared records, free fields, typed references) bound to its own scope. */
  seedCustom(world: CustomWorld): Promise<Seeded>;
  open(
    seeded: Seeded,
    kind: 'w0' | 'expert',
    options?: {
      jobId?: string;
      bundle?: HarnessBundle;
      subject?: { idType: 'string' | 'objectId'; value: string };
    },
  ): Promise<OpenRun>;
  /** Stores a bundle as a permitted artifact for the world's scope and returns the hash a job can pin. */
  pin(seeded: Seeded, bundle: HarnessBundle): Promise<string>;
  worldNow(seeded: Seeded): Promise<VisibleWorld>;
  dispose(): Promise<void>;
};
export type OpenRun = {
  jobId: string;
  job: Job;
  context: ToolContext;
  tools: Tools;
  bundle: HarnessBundle;
};
export type Tools = Record<string, (args?: unknown) => Promise<Record<string, unknown>>>;

const clone = <T>(value: T): T => structuredClone(value);

export async function openRig(label: string): Promise<Rig> {
  const env = await openEnvironment(label);
  const executor = await env.as('domain_executor');
  const builder = await env.as('fixture_builder');
  const domain = createDomainEnv(executor, { floors: [DEFAULT_AUTHORITY_FLOOR, DEEP_FLOOR] });
  let counter = 0;

  async function seed(family: FixtureFamily, seedValue = `domain-${family}`): Promise<Seeded> {
    const spec = createWorldSpec({ family, seed: seedValue });
    const binding = deriveWorldScopeKey(spec, seedValue);
    const fixture = generateSealedFixture(spec, seedValue, binding);
    const world = fixture.world;
    await new AuthorityRepository(env.service).install(binding, DEFAULT_AUTHORITY_FLOOR.hash, 1);
    await new ScopeRepository(builder).insert(world.scope);
    await new WorldRepository(builder).create(binding, world.worldId, world.scope.revision);
    for (const id of COLLECTION_IDS)
      await env.service.world.collection(id).insertMany(clone(world.collections[id]) as never[]);
    const hashes = { w0: '', expert: '' };
    const partial = { binding } as Seeded;
    for (const kind of ['w0', 'expert'] as const) hashes[kind] = await pin(partial, bundles[kind]());
    const actor: ActorContext = { ...binding, actorId: 'owner', authorizationRevision: 1 };
    return { family, world, manifest: fixture.manifest, binding, actor, bundleHashes: hashes };
  }

  let customCounter = 0;
  async function seedCustom(spec: CustomWorld): Promise<Seeded> {
    const floor = spec.floor ?? DEFAULT_AUTHORITY_FLOOR;
    const binding = {
      tenantId: 'custom-tenant',
      env: 'evaluation' as const,
      scopeId: `custom-scope-${++customCounter}-${Date.now().toString(36)}`,
    };
    const worldId = `custom-world-${customCounter}-${Date.now().toString(36)}`;
    const collections = [...new Set(spec.fields.map((field) => field.collectionId))];
    const registry: ScopeRegistry = {
      scopeId: binding.scopeId,
      revision: 1,
      tenantId: binding.tenantId,
      env: binding.env,
      collectionIds: collections,
      fields: spec.fields,
      referenceEdges: spec.edges,
      allowedEffectKinds: ['delete', 'redact', 'restrict', 'tombstone'],
      eligibilityPolicyId: ELIGIBILITY_POLICY_ID,
      eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
      documentLimits: { maxScanned: 500, maxChanged: 500 },
      discoveryCompleteness: { kind: 'declared', limitations: ['Hand-built test world.'] },
    };
    await new AuthorityRepository(env.service).install(binding, floor.hash, 1);
    await new ScopeRepository(builder).insert(registry);
    await new WorldRepository(builder).create(binding, worldId, 1);
    for (const doc of spec.docs)
      await env.service.world.collection(doc.collection).insertOne({
        _id: doc.id as never,
        ...binding,
        worldId,
        _rev: 1,
        data: doc.data,
        ...(doc.effect === null
          ? {}
          : {
              eligibility: {
                effect: doc.effect ?? 'redact',
                policyId: doc.policyId ?? ELIGIBILITY_POLICY_ID,
              },
            }),
        access: doc.access ?? 'open',
        lifecycle: 'active',
      } as never);
    const hashes = { w0: '', expert: '' };
    const partial = { binding } as Seeded;
    const expertBundle = buildExpertStaticBundle({ ...infrastructureHashes, authorityFloorHash: floor.hash });
    hashes.expert = await pin(partial, expertBundle);
    const w0Bundle = buildW0Bundle({ ...infrastructureHashes, authorityFloorHash: floor.hash });
    hashes.w0 = await pin(partial, w0Bundle);
    const actor: ActorContext = { ...binding, actorId: 'owner', authorizationRevision: 1 };
    return {
      family: 'direct_nested',
      world: { worldId, scope: registry, subjectHandle: spec.subject.value } as unknown as VisibleWorld,
      manifest: undefined as unknown as FixtureManifest,
      binding,
      actor,
      bundleHashes: hashes,
      bundleObjects: { w0: w0Bundle, expert: expertBundle },
    };
  }

  async function pin(seeded: Seeded, bundle: HarnessBundle): Promise<string> {
    const envelope = await new ArtifactRepository(env.service).insert(bundle);
    await env.service.control.collection('artifact_eligibility').insertOne({
      ...seeded.binding,
      artifactHash: envelope._id,
      state: 'permitted',
      policyHash: HASH,
      reasonCode: 'source_retracted',
      sourceIds: [],
      updatedAt: new Date(),
    } as never);
    return envelope._id;
  }

  async function open(
    seeded: Seeded,
    kind: 'w0' | 'expert',
    options: {
      jobId?: string;
      bundle?: HarnessBundle;
      subject?: { idType: 'string' | 'objectId'; value: string };
    } = {},
  ): Promise<OpenRun> {
    const jobId = options.jobId ?? `job-${kind}-${++counter}`;
    const bundle = options.bundle ?? seeded.bundleObjects?.[kind] ?? bundles[kind]();
    const harnessHash = options.bundle ? await pin(seeded, bundle) : seeded.bundleHashes[kind];
    await new JobRepository(env.service).create(seeded.actor, {
      jobId,
      kind: 'cleanup',
      binding: {
        runId: `run-${jobId}`,
        worldId: seeded.world.worldId,
        harnessHash,
        scopeRevision: seeded.world.scope.revision,
        workerProfileHash: HASH,
      },
    });
    await domain.store.putSubject(
      seeded.actor,
      jobId,
      options.subject ?? { idType: 'string', value: seeded.world.subjectHandle },
    );
    const job = (await domain.jobs.claim(seeded.actor, jobId, 'worker-1', 120_000))!;
    const context: ToolContext = {
      job,
      bundle,
      actor: seeded.actor,
      lease: { jobId, ownerId: 'worker-1', fence: job.lease.fence },
      signal: new AbortController().signal,
      recordContextInput: async () => undefined,
    };
    return { jobId, job, context, tools: await toolsFor(domain, context), bundle };
  }

  async function worldNow(seeded: Seeded): Promise<VisibleWorld> {
    const collections = {} as Record<CollectionId, never[]>;
    for (const id of COLLECTION_IDS)
      collections[id] = (await env.service.world
        .collection(id)
        .find({ worldId: seeded.world.worldId })
        .sort({ _id: 1 })
        .toArray()) as never[];
    return { ...seeded.world, collections: collections as never };
  }

  return {
    env,
    executor,
    domain,
    seed,
    seedCustom,
    open,
    pin,
    worldNow,
    dispose: () => env.dispose(),
  };
}

export async function toolsFor(domain: DomainEnv, context: ToolContext): Promise<Tools> {
  const definitions = await createDomainToolProvider(domain).create(context);
  const table: Tools = {};
  for (const definition of definitions) {
    const execute = (
      definition as unknown as { execute: (args: unknown) => Promise<Record<string, unknown>> }
    ).execute;
    table[definition.name] = (args = {}) => execute(args);
  }
  return table;
}

/** The outcome of one scripted call: its result, or the closed refusal code the gateway answered with. */
export type Step =
  { tool: string; ok: true; result: Record<string, unknown> } | { tool: string; ok: false; code: string };
export async function attempt(tools: Tools, tool: string, args: unknown = {}): Promise<Step> {
  try {
    return { tool, ok: true, result: await tools[tool]!(args) };
  } catch (error) {
    return { tool, ok: false, code: error instanceof Error ? error.message : String(error) };
  }
}

/** W0's workflow: inspect, resolve, discover once, preview, apply every batch, complete. It never verifies. */
export async function driveW0(tools: Tools): Promise<Step[]> {
  const trace: Step[] = [];
  for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
    trace.push(await attempt(tools, tool));
  for (let guard = 0; guard < 40; guard++) {
    const step = await attempt(tools, 'apply_cleanup_batch');
    trace.push(step);
    if (!step.ok || step.result.batchesRemaining === 0) break;
  }
  trace.push(await attempt(tools, 'complete_cleanup'));
  return trace;
}

/** The expert workflow: bounded discovery loop, preview, apply, verify, and discovery again when verification fails. */
export async function driveExpert(tools: Tools): Promise<Step[]> {
  const trace: Step[] = [];
  trace.push(await attempt(tools, 'inspect_scope'));
  trace.push(await attempt(tools, 'resolve_subject'));
  for (let round = 0; round < 2; round++) {
    for (let hop = 0; hop < 3; hop++) {
      const step = await attempt(tools, 'discover_references');
      trace.push(step);
      if (!step.ok || !step.result.moreAvailable) break;
    }
    trace.push(await attempt(tools, 'preview_cleanup'));
    for (let guard = 0; guard < 40; guard++) {
      const step = await attempt(tools, 'apply_cleanup_batch');
      trace.push(step);
      if (!step.ok || step.result.batchesRemaining === 0) break;
    }
    const verify = await attempt(tools, 'verify_registered_scope');
    trace.push(verify);
    if (verify.ok && verify.result.verified === true) break;
  }
  trace.push(await attempt(tools, 'complete_cleanup'));
  return trace;
}

export const canonical = (value: unknown) => contentHash(value, 'domain-test-state');
/** Collections keyed by id and ordered by `_id`, the order a database read gives, so two worlds compare by content. */
export function byId(collections: VisibleWorld['collections']): Record<string, unknown[]> {
  return Object.fromEntries(
    COLLECTION_IDS.map((id) => [
      id,
      [...(collections[id] as Array<{ _id: string }>)].sort((l, r) => l._id.localeCompare(r._id, 'en')),
    ]),
  );
}

const field = (
  collectionId: string,
  name: string,
  path: string[],
  extra: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({
  fieldId: `${collectionId}.${name}`,
  collectionId,
  path,
  bsonTypes: ['string'],
  isArray: path.includes('*'),
  sanitized: true,
  ...extra,
});
/** The registry fields every hand-built collection has: the key, the private payload, and what the caller adds. */
export function baseFields(collectionId: string, ...more: FieldDescriptor[]): FieldDescriptor[] {
  return [
    field(collectionId, 'record_id', ['_id']),
    field(collectionId, 'private_payload', ['data', 'payload'], { bsonTypes: ['string', 'null'] }),
    ...more,
  ];
}
export { field };
export const edge = (
  fromCollection: string,
  fromFieldName: string,
  toCollection: string,
  identityRule: ReferenceDeclaration['identityRule'] = 'same_bson_type',
): ReferenceDeclaration => ({
  edgeId: `${fromCollection}.${fromFieldName}.references.${toCollection}`,
  fromCollectionId: fromCollection,
  fromFieldId: `${fromCollection}.${fromFieldName}`,
  toCollectionId: toCollection,
  toFieldId: `${toCollection}.record_id`,
  identityRule,
});
export type { DomainAddress };
