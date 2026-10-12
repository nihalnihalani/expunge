import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildW0Bundle, type InfrastructureHashes } from '@expunge/baselines';
import { contentHash, type ActorContext, type Environment, type ScopeKey } from '@expunge/contracts';
import {
  COLLECTION_IDS,
  ELIGIBILITY_POLICY_HASH,
  FAMILIES,
  createWorldSpec,
  type FixtureFamily,
} from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import {
  ArtifactRepository,
  AuthorityPolicyRepository,
  AuthorityRepository,
  DeploymentRepository,
  ScopeRepository,
  WorldRepository,
  createPrincipalService,
  mongoConfigFromEnv,
  seedOptionsFromEnv,
} from '@expunge/mongo';
import { runtimeHash } from '@expunge/runtime';

/**
 * Seeds one synthetic company world into the configured scope (EXPUNGE_TENANT_ID / EXPUNGE_ENV / EXPUNGE_SCOPE_ID) and
 * deploys the W0 baseline as the scope's starting worker harness, so the operator can preview and submit a cleanup.
 *
 *   npm run seed:world -- --family direct_nested --seed demo-1
 *
 * The visible world goes to Atlas: registry and world binding through the fixture_builder principal, records and the
 * harness through setup (as the domain test rig does). The sealed manifest (the grader's hidden truth) never goes to a
 * worker-readable place: it is written to .expunge/worlds/<worldId>.private.json, which Git ignores. The W0 bundle is
 * stamped with this checkout's runtimeHash(), the value the worker attests and the gate compares, so re-seed a fresh
 * scope after the runtime code changes. Idempotent: the same family and seed in the same scope changes nothing; a
 * different world in a scope that already holds one is refused (one registry per scope revision).
 */
const { values } = parseArgs({
  options: { family: { type: 'string', default: 'direct_nested' }, seed: { type: 'string' } },
});
const family = values.family as FixtureFamily;
if (!(FAMILIES as readonly string[]).includes(family)) {
  console.log(JSON.stringify({ code: 'UnknownFamily', family, families: FAMILIES }));
  process.exit(2);
}
const seed = values.seed ?? `${family}-1`;

const text = (name: string) => process.env[name]?.trim() ?? '';
const binding: ScopeKey = {
  tenantId: text('EXPUNGE_TENANT_ID'),
  env: text('EXPUNGE_ENV') as Environment,
  scopeId: text('EXPUNGE_SCOPE_ID'),
};
const missing = Object.entries(binding).filter(([, value]) => !value);
if (missing.length) {
  console.log(JSON.stringify({ code: 'MissingConfiguration', missing: missing.map(([key]) => key) }));
  process.exit(2);
}

const config = mongoConfigFromEnv();
const setup = createPrincipalService(config, 'setup');
const builder = createPrincipalService(config, 'fixture_builder');
await Promise.all([setup.client.connect(), builder.client.connect()]);
try {
  const spec = createWorldSpec({ family, seed });
  const fixture = generateSealedFixture(spec, seed, binding);
  const { world } = fixture;
  const scopes = new ScopeRepository(builder);
  const worlds = new WorldRepository(builder);

  // A new scope gets the same authority row and approval policies `npm run setup:mongo` seeds (both idempotent
  // installs, data only: no collections, validators, indexes or roles are touched here).
  const authorities = new AuthorityRepository(setup);
  let authority = await authorities.read(binding).catch(() => null);
  let authoritySeeded = false;
  if (!authority) {
    const seeds = seedOptionsFromEnv(process.env);
    if (!seeds.authorities?.length) {
      console.log(JSON.stringify({ code: 'AuthorityNotSeeded', missing: ['EXPUNGE_AUTHORITY_FLOOR_HASH'] }));
      process.exit(2);
    }
    const policies = new AuthorityPolicyRepository(setup);
    for (const policy of seeds.authorityPolicies ?? [])
      await policies.install(policy.key, policy.behavioralRequiresApproval);
    for (const row of seeds.authorities) await authorities.install(row.key, row.floorHash);
    authority = await authorities.read(binding);
    authoritySeeded = true;
  }

  const registry = await scopes.read(binding, world.scope.revision).catch(() => null);
  let worldAction: string;
  if (registry) {
    const existingWorld = await builder.world
      .collection('world_scope_bindings')
      .findOne({ tenantId: binding.tenantId, env: binding.env, scopeId: binding.scopeId });
    if (contentHash(registry) !== contentHash(world.scope) || existingWorld?.worldId !== world.worldId) {
      console.log(
        JSON.stringify({
          code: 'ScopeHoldsAnotherWorld',
          scope: binding,
          existingWorldId: existingWorld?.worldId ?? null,
          hint: 'set EXPUNGE_SCOPE_ID to a new id and seed again (or reuse the same --family and --seed)',
        }),
      );
      process.exit(2);
    }
    worldAction = 'already seeded';
  } else {
    await scopes.insert(world.scope);
    await worlds.create(binding, world.worldId, world.scope.revision);
    for (const id of COLLECTION_IDS)
      if (world.collections[id].length)
        await setup.world.collection(id).insertMany(structuredClone(world.collections[id]) as never[]);
    worldAction = 'created';
  }

  // The starting worker harness: the W0 baseline, permitted for this scope and deployed as the active pointer.
  const hashes: InfrastructureHashes = {
    runtimeAdapterHash: runtimeHash(),
    compilerHash: COMPILER_HASH,
    vocabularyHash: VOCABULARY_HASH,
    authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
    eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
    sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  };
  const bundle = buildW0Bundle(hashes);
  const artifacts = new ArtifactRepository(setup);
  const harnessHash = contentHash(bundle);
  const stored = await artifacts.read(harnessHash).catch(() => null);
  if (!stored) await artifacts.insert(bundle);
  await setup.control.collection('artifact_eligibility').updateOne(
    { ...binding, artifactHash: harnessHash },
    {
      $setOnInsert: {
        ...binding,
        artifactHash: harnessHash,
        state: 'permitted',
        policyHash: ELIGIBILITY_POLICY_HASH,
        reasonCode: 'baseline_seeded',
        sourceIds: [],
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
  const deployments = new DeploymentRepository(setup);
  const current = await deployments.read({ ...binding, target: 'worker' });
  let deployment: string;
  if (!current) {
    const actor: ActorContext = {
      ...binding,
      actorId: 'setup',
      authorizationRevision: authority.authorizationRevision,
    };
    await deployments.initialize(actor, 'worker', harnessHash, world.scope.revision);
    deployment = 'W0 baseline deployed';
  } else if (current.activeHash === harnessHash) deployment = 'W0 baseline already active';
  else
    deployment = `kept existing active harness ${current.activeHash.slice(0, 12)} (revision ${current.revision})`;

  mkdirSync(new URL('../.expunge/worlds/', import.meta.url), { recursive: true });
  const manifestPath = `.expunge/worlds/${world.worldId}.private.json`;
  writeFileSync(
    new URL(`../${manifestPath}`, import.meta.url),
    JSON.stringify(
      { expungePrivate: true, family, seed, scope: binding, manifest: fixture.manifest },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        scope: binding,
        authority: authoritySeeded ? 'seeded for this scope' : 'already present',
        family,
        seed,
        worldId: world.worldId,
        world: worldAction,
        subjectHandle: world.subjectHandle,
        records: Object.fromEntries(COLLECTION_IDS.map((id) => [id, world.collections[id].length])),
        harness: { hash: harnessHash, runtimeAdapterHash: hashes.runtimeAdapterHash, deployment },
        sealedManifest: manifestPath,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([setup.close(), builder.close()]);
}
