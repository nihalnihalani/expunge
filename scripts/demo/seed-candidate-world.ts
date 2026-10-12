import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildW0Bundle, type InfrastructureHashes } from '@expunge/baselines';
import {
  contentHash,
  type ActorContext,
  type Environment,
  type EvidenceBundle,
  type HarnessBundle,
  type ScopeKey,
  type TypedPatch,
} from '@expunge/contracts';
import {
  COLLECTION_IDS,
  ELIGIBILITY_POLICY_HASH,
  FAMILIES,
  createWorldSpec,
  type FixtureFamily,
} from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import {
  COMPILER_HASH,
  VOCABULARY_HASH,
  applyPatches,
  buildEvidenceCatalog,
  compileHarness,
} from '@expunge/harness-compiler';
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
 * deploys the IMPROVED child of W0 as the scope's starting worker harness, so the operator's cleanup runs the harness
 * that finds the nested copies.
 *
 *   EXPUNGE_SCOPE_ID=<new scope> npm run seed:candidate -- --family direct_nested --seed demo-1
 *
 * Same world, authority and sealed-manifest handling as scripts/seed-world.ts (the sealed manifest goes to
 * .expunge/worlds/<worldId>.private.json, which is ignored). The child is the OPERATOR-AUTHORED three-patch child of
 * scripts/demo/candidate.ts (not an evolver proposal), compiled here by the real harness-compiler against this world's
 * registry; a rejection exits 1 and deploys nothing. W0, the child and their evidence references are stored and marked
 * permitted for this scope; the child becomes the active worker pointer only when the scope has none yet (an existing
 * pointer is kept and reported). Both bundles carry this checkout's runtimeHash(), so re-seed a fresh scope after the
 * runtime code changes.
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
  const w0Hash = contentHash(bundle);

  // The improved child of W0: exactly three edits, compiled by the real harness-compiler (as scripts/demo/candidate.ts).
  const EVIDENCE_IDS = ['job_eea9d347', 'receipt_a685d993', 'effect_5d0815f2'];
  const hyp = (what: string) =>
    `OPERATOR-AUTHORED: ${what}. W0 deleted the customer record only and left the nested copies of the subject's data.`;
  const patches: TypedPatch[] = [
    {
      surface: 'context',
      path: 'contextPolicy.includeNestedArrays',
      before: false,
      after: true,
      sourceEvidenceIds: [...EVIDENCE_IDS],
      hypothesis: hyp('Read arrays nested inside documents'),
    },
    {
      surface: 'context',
      path: 'contextPolicy.schemaMode',
      before: 'selected_fields',
      after: 'all_registered_fields',
      sourceEvidenceIds: [...EVIDENCE_IDS],
      hypothesis: hyp('Show every registered field so identity fields are visible'),
    },
    {
      surface: 'tool_policy',
      path: 'limits.traversalDepth',
      before: 1,
      after: 5,
      sourceEvidenceIds: [...EVIDENCE_IDS],
      hypothesis: hyp('Raise the traversal bound to five hops, inside the owner floor'),
    },
  ];
  const child: HarnessBundle = applyPatches(bundle, patches);
  child.parentHash = w0Hash;
  const transcription: EvidenceBundle = {
    evidenceId: 'evb_baseline_transcribed',
    actor: { tenantId: 'baseline', env: 'evaluation', scopeId: 'baseline' },
    binding: {
      jobId: EVIDENCE_IDS[0]!,
      runId: 'unknown',
      worldId: 'unknown',
      harnessHash: w0Hash,
      scopeRevision: 1,
      workerProfileHash: '0'.repeat(64),
    },
    tools: [],
    failureWitnesses: [],
    diagnostics: [],
    modelOutput: '(not transcribed)',
    sources: [
      {
        provider: 'operator-transcription',
        externalEventId: EVIDENCE_IDS[0]!,
        externalSignalIds: EVIDENCE_IDS.slice(1),
        localSourceIds: [],
        origin: 'verifier_feedback',
        redactionPolicy: 'ids-only',
        retrievedAt: '2026-10-11T00:00:00.000Z',
        contentHash: contentHash({ ids: EVIDENCE_IDS }, 'baseline-evidence-ids'),
        permittedUse: 'training',
      },
    ],
    cost: {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicrousd: 0,
      unpricedCalls: 0,
      mongoOperations: 0,
      wallTimeMs: 0,
    },
    confidence: 0.5,
    split: 'train',
    withheld: { freeText: true, values: true },
    truncated: true,
  } as EvidenceBundle;
  child.evidence = [...bundle.evidence, ...transcription.sources];
  const compiled = compileHarness(
    { candidate: child, parent: bundle, patches, claimedClass: 'behavioral' },
    {
      expected: {
        runtimeAdapterHash: hashes.runtimeAdapterHash,
        eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
        sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
      },
      floor: DEFAULT_AUTHORITY_FLOOR as never,
      registry: {
        collectionIds: world.scope.collectionIds,
        fieldIds: world.scope.fields.map((f) => f.fieldId),
      },
      forbidden: { subject: [], task: [] },
      evidence: buildEvidenceCatalog([transcription]),
    },
  );
  if (!compiled.ok) {
    console.log(JSON.stringify({ code: 'ChildRejected', rejection: compiled.rejection }, null, 2));
    process.exit(1);
  }
  const harnessHash = contentHash(child);

  const eligible = new Set<string>();
  for (const b of [bundle, child]) {
    const h = contentHash(b);
    const stored = await artifacts.read(h).catch(() => null);
    if (!stored) await artifacts.insert(b);
    eligible.add(h);
    for (const reference of b.evidence) eligible.add(reference.contentHash);
  }
  for (const hash of eligible)
    await setup.control.collection('artifact_eligibility').updateOne(
      { ...binding, artifactHash: hash },
      {
        $setOnInsert: {
          ...binding,
          artifactHash: hash,
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
    deployment = 'improved child deployed';
  } else if (current.activeHash === harnessHash) deployment = 'improved child already active';
  else
    deployment = `kept existing active harness ${current.activeHash.slice(0, 12)} (revision ${current.revision})`;

  mkdirSync(new URL('../../.expunge/worlds/', import.meta.url), { recursive: true });
  const manifestPath = `.expunge/worlds/${world.worldId}.private.json`;
  writeFileSync(
    new URL(`../../${manifestPath}`, import.meta.url),
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
        harness: {
          hash: harnessHash,
          parentHash: w0Hash,
          compiledBundleHash: compiled.artifact.bundleHash,
          mutationClass: compiled.artifact.mutationClass,
          runtimeAdapterHash: hashes.runtimeAdapterHash,
          deployment,
        },
        sealedManifest: manifestPath,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([setup.close(), builder.close()]);
}
