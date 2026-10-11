/**
 * PILOT, NOT ADMISSION. Compares the parent W0 with a candidate bundle on FRESH seeded training worlds, with the REAL provider
 * model, through the REAL worker composition (Dispatcher, the domain gateway as domain_executor, insert-only run_attestations)
 * on a LOCAL replica set. Nothing here is a gate decision: no frozen split commitment is checked, no claim is promoted, no
 * held-out instance is used, and the candidate is re-parented onto the pilot's own W0 (see the README section in docs/demo).
 *
 *   node --import tsx --env-file-if-exists=.env scripts/demo/pilot.ts --candidate FILE.json [--pairs 6] [--concurrency 4]
 *        [--out DIR] [--mongo-uri URI]
 *
 * Reads, by NAME only (values are never printed): MONGODB_PILOT_URI (or --mongo-uri; must be a loopback replica set),
 * EXPUNGE_MODEL_PROVIDER, EXPUNGE_MODEL_ID, OPENAI_API_KEY or ANTHROPIC_API_KEY, optional EXPUNGE_MODEL_PRICE_*_MICROUSD_PER_MILLION.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildW0Bundle, OWNER_EPISODE_LIMITS } from '@expunge/baselines';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { createDomainEnv } from '@expunge/domain';
import { contentHash, type HarnessBundle } from '@expunge/contracts';
import { ELIGIBILITY_POLICY_HASH, FIXTURE_GENERATOR_HASH, createWorldSpec } from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture, sealPlanForGate } from '@expunge/fixtures/sealed';
import { EVALUATOR_HASH, gradeWorld } from '@expunge/grader';
import {
  ArtifactRepository,
  AttestationRepository,
  AuthorityRepository,
  JobRepository,
  ProjectionRepository,
  createPrincipalService,
  setupMongo,
  type MongoService,
  type Principal,
} from '@expunge/mongo';
import { EnvModelResolver, runtimeHash } from '@expunge/runtime';
import {
  AttestedJobEvidence,
  CampaignKeyStore,
  ClaimStore,
  FreezeStore,
  GraderEpisodeHost,
  MongoEpisodePort,
  budgetHashOf,
  campaignCrypto,
  childProjectionOf,
  modelStampsOf,
  profileHashOf,
  verifyArm,
  type EpisodeRequest,
  type WorkerProfile,
} from '@expunge/gate';
import {
  Dispatcher,
  MongoCommittedReader,
  MongoCompletionReceiptReader,
  MongoEpisodeEvidence,
  MongoJobResolver,
  FencedProjectionSink,
  WorkerEpisodeRunner,
  asArtifactReader,
  asDispatchJobs,
  workerConfigFromEnv,
  createDomainToolWiring,
} from '../../apps/worker/src/index.js';

const LABEL = 'PILOT, NOT ADMISSION';
const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const fail = (message: string): never => {
  console.error(`${LABEL}: ${message}`);
  process.exit(2);
};

const candidatePath =
  flag('--candidate') ?? fail('--candidate FILE.json (the compiled child HarnessBundle) is required');
const pairsWanted = Number(flag('--pairs', '6'));
const concurrency = Math.max(1, Math.min(4, Number(flag('--concurrency', '4'))));
const outDir = flag('--out') ?? join(tmpdir(), `expunge-pilot-${Date.now()}`);
const uri =
  flag('--mongo-uri') ??
  process.env.MONGODB_PILOT_URI ??
  'mongodb://127.0.0.1:27318/?replicaSet=expunge-local&directConnection=true';
const host = new URL(uri).hostname;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host))
  fail('the pilot runs only against a loopback replica set');

const provider = process.env.EXPUNGE_MODEL_PROVIDER?.trim();
const modelId = process.env.EXPUNGE_MODEL_ID?.trim();
const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
if (!provider || !modelId) fail('EXPUNGE_MODEL_PROVIDER and EXPUNGE_MODEL_ID must be set');
if (!process.env[keyName]?.trim())
  fail(`${keyName} is not set (the real provider model is required; no fake model is used)`);

const RT = runtimeHash();
const infra = {
  runtimeAdapterHash: RT,
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
const BASE_SCOPE = { tenantId: 'pilot', env: 'evaluation' } as const;
const BUDGET = OWNER_EPISODE_LIMITS;

// ---- fresh local databases, one set of principals per pilot ----------------------------------------------------------
const prefix = `expunge_pilot_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const names = {
  worldDatabase: `${prefix}_world`,
  controlDatabase: `${prefix}_control`,
  privateDatabase: `${prefix}_private`,
};
const opened: MongoService[] = [];
async function as(principal: Principal): Promise<MongoService> {
  const service = createPrincipalService(
    { uris: { [principal]: uri }, ...names, appName: 'expunge-pilot' },
    principal,
  );
  await service.client.connect();
  opened.push(service);
  return service;
}

type Row = {
  pair: number;
  arm: 'parent' | 'candidate';
  bundleHash: string;
  scopeId: string;
  jobId: string | null;
  outcome: string;
  failureCode: string | null;
  terminalStatus: string;
  usefulCompletion: boolean;
  reasonCodes: string[];
  targetedResiduals: number | null;
  unrelatedRecordChanges: number;
  verified: boolean;
  verifyReasons: string[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  unpricedCalls: number;
  wallTimeMs: number;
  attestationSource: string | null;
  attestedProvider: string | null;
  attestedModelId: string | null;
  attestedEndpoint: string | null;
  runtimeHash: string | null;
};

async function main(): Promise<void> {
  const setup = await as('setup');
  await setupMongo(setup);
  const executor = await as('domain_executor');
  const grader = await as('grader');
  const builder = await as('fixture_builder');

  const candidateRaw = JSON.parse(readFileSync(candidatePath, 'utf8')) as HarnessBundle;
  const parent = buildW0Bundle(infra);
  const artifacts = new ArtifactRepository(builder);
  const parentHash = (await artifacts.insert(parent))._id;
  const candidate: HarnessBundle = { ...candidateRaw, parentHash };
  const candidateHash = (await artifacts.insert(candidate))._id;
  const raw = candidateRaw as unknown as Record<string, unknown>;
  const lineageNote = (
    ['runtimeAdapterHash', 'compilerHash', 'vocabularyHash', 'authorityFloorHash'] as const
  )
    .filter((key) => raw[key] !== undefined && raw[key] !== (infra as Record<string, unknown>)[key])
    .map((key) => `candidate ${key} differs from this checkout's`);

  const eligibleHashes = new Set<string>([parentHash, candidateHash]);
  for (const bundle of [parent, candidate])
    for (const reference of bundle.evidence) eligibleHashes.add(reference.contentHash);

  const profile: WorkerProfile = {
    profileId: `pilot-${provider}`,
    modelId: modelId!,
    modelKind: 'provider',
    provider: provider!,
    params: {},
  };
  const campaignId = `pilot-${randomUUID().slice(0, 8)}`;
  const stored = await new CampaignKeyStore(builder).mint(campaignId);
  const crypto = campaignCrypto(stored);
  const masterSeed = contentHash({ label: 'pilot', campaignId }, 'pilot-master-seed');
  const view = sealPlanForGate(buildSealedSplitPlan(masterSeed));
  // The sealed plan has only two TRAIN entries (one per training family). The pilot needs more pairs, so it takes the same two
  // training families with FRESH seeds derived from this campaign: new worlds, never a validation, protected or test family.
  const families = ['direct_nested', 'alias_two_hop'] as const;
  const entries = Array.from({ length: pairsWanted }, (_v, i) => {
    const seed = contentHash({ masterSeed, pair: i }, 'pilot-world-seed');
    return {
      seed,
      spec: createWorldSpec({ family: families[i % families.length]!, seed, namesakeCount: 1 }),
    };
  });

  await new FreezeStore(builder).write({
    campaignId,
    evaluatorHash: EVALUATOR_HASH,
    fixtureGeneratorHash: FIXTURE_GENERATOR_HASH,
    runtimeHash: RT,
    compilerHash: COMPILER_HASH,
    workerProfileHash: profileHashOf(profile),
    budgetHash: budgetHashOf(BUDGET),
    maxAttemptsPerParent: 3,
    splitManifestCommitment: view.commitment.splitHash,
    costCeilingMicrousd: null,
  });
  await new ClaimStore(grader).claim({
    campaignId,
    parentHash,
    childProjectionHash: childProjectionOf(candidate),
    maxAttemptsPerParent: 3,
  });

  const domain = createDomainEnv(executor, { floors: [DEFAULT_AUTHORITY_FLOOR] });
  const jobs = new JobRepository(executor);
  const projections = new ProjectionRepository(executor);
  const runner = new WorkerEpisodeRunner({
    host: new GraderEpisodeHost({ grader, subjects: domain.store }),
    evidence: new MongoEpisodeEvidence(setup),
    baseTools: createDomainToolWiring(executor).provider,
    workerFactory: ({ tools, onResult, session }) =>
      new Dispatcher({
        jobs: asDispatchJobs(jobs),
        resolver: new MongoJobResolver(jobs),
        artifacts: asArtifactReader(new ArtifactRepository(executor)),
        tools: tools(createDomainToolWiring(executor).provider),
        models: new EnvModelResolver(process.env),
        receipts: new MongoCompletionReceiptReader(executor),
        committed: new MongoCommittedReader(executor),
        projection: new FencedProjectionSink(executor, jobs, projections),
        runtimeHash: RT,
        attestations: new AttestationRepository(executor),
        env: process.env,
        onResult,
        config: workerConfigFromEnv({
          EXPUNGE_WORKER_ID: `pilot-${session}-${randomUUID().slice(0, 6)}`,
          EXPUNGE_WORKER_LEASE_MS: '60000',
          EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '120000',
        }),
      }),
  });
  const port = new MongoEpisodePort({
    grader,
    builder,
    runner: runner as never,
    installAuthority: async (scope, floorHash) => {
      // LOCAL PILOT ONLY: AuthorityRepository.install is a setup right today.
      await new AuthorityRepository(setup).install(scope, floorHash, 1);
      // DEMO SETUP: eligibility rows written by the operator for this instance's scope. A real deployment writes them from the
      // proposer and observer pipelines. The worker's readPermitted / recordContextInputs need a permitted row for both harnesses
      // and for every source they cite; without them a run ends HarnessUnavailable or ContextInputRejected.
      for (const hash of eligibleHashes)
        await setup.control.collection('artifact_eligibility').insertOne({
          ...scope,
          artifactHash: hash,
          state: 'permitted',
          policyHash: ELIGIBILITY_POLICY_HASH,
          reasonCode: 'source_retracted',
          sourceIds: [],
          updatedAt: new Date(),
        } as never);
    },
    floorHash: DEFAULT_AUTHORITY_FLOOR.hash,
    profile,
    label: `${LABEL}: REAL worker/domain path with the provider model ${provider}/${modelId}`,
  });
  const evidence = new AttestedJobEvidence(grader);

  const tasks = entries.flatMap((entry, pair) =>
    (['parent', 'candidate'] as const).map((arm) => ({ entry, pair, arm })),
  );
  const rows: Row[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      const { entry, pair, arm } = task;
      const scope = { ...BASE_SCOPE, scopeId: `p${pair}_${arm}_${crypto.label('t', { pair, arm }, 10)}` };
      const fixture = generateSealedFixture(entry.spec, entry.seed, scope, undefined, {
        derivation: crypto.derivation,
      });
      const bundle = arm === 'parent' ? parent : candidate;
      const bundleHash = arm === 'parent' ? parentHash : candidateHash;
      const request: EpisodeRequest = {
        campaignId,
        runId: crypto.label('run', { pair, arm }, 40),
        instanceId: crypto.label('instance', { pair, arm }, 24),
        instanceScope: scope,
        bundle,
        bundleHash,
        profile,
        limits: bundle.limits,
        budget: BUDGET,
        world: structuredClone(fixture.world),
        faults: entry.spec.faults,
        signal: new AbortController().signal,
      };
      const started = Date.now();
      const result = await port.run(request);
      const grade = result.world
        ? gradeWorld(fixture.manifest, result.world, {
            terminalStatus: result.terminal.status,
            terminalClaim: result.terminal.claim,
            retryFailures: result.retryFailures,
            cost: result.cost,
            ...(result.receipt ? { trustedReceiptEvidence: result.receipt } : {}),
          })
        : null;
      let verified = false;
      let verifyReasons: string[] = ['no_job'];
      let stamp: ReturnType<typeof modelStampsOf>[number] | undefined;
      if (result.jobId) {
        const record = await evidence.read(scope, result.jobId).catch(() => null);
        if (record) {
          const facts = verifyArm(
            record,
            { runId: request.runId, worldId: request.world.worldId, bundleHash, outcome: result.outcome },
            profile,
          );
          verified = facts.verified;
          verifyReasons = facts.reasons;
          stamp = modelStampsOf(record.stamps).at(-1);
        } else verifyReasons = ['evidence_unreadable'];
      }
      rows.push({
        pair,
        arm,
        bundleHash,
        scopeId: scope.scopeId,
        jobId: result.jobId ?? null,
        outcome: result.outcome,
        failureCode: result.failureCode ?? null,
        terminalStatus: result.terminal.status,
        usefulCompletion: grade?.usefulCompletion ?? false,
        reasonCodes: grade?.reasonCodes ?? ['no_readback'],
        targetedResiduals: grade
          ? ((grade as unknown as { targetedResiduals?: number }).targetedResiduals ?? null)
          : null,
        unrelatedRecordChanges: grade?.unrelatedRecordChanges ?? -1,
        verified,
        verifyReasons,
        modelCalls: result.cost.modelCalls,
        inputTokens: result.cost.inputTokens,
        outputTokens: result.cost.outputTokens,
        costMicrousd: result.cost.costMicrousd,
        unpricedCalls: result.cost.unpricedCalls,
        wallTimeMs: Date.now() - started,
        attestationSource: stamp?.source ?? null,
        attestedProvider: stamp?.provider ?? null,
        attestedModelId: stamp?.modelId ?? null,
        attestedEndpoint: stamp?.endpoint ?? null,
        runtimeHash: stamp?.runtimeHash ?? result.runtimeHash ?? null,
      });
      console.error(`${LABEL}: ${rows.length}/${tasks.length} pair ${pair} ${arm} -> ${result.outcome}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  rows.sort((a, b) => a.pair - b.pair || (a.arm < b.arm ? -1 : 1));

  const armSummary = (arm: 'parent' | 'candidate') => {
    const list = rows.filter((r) => r.arm === arm);
    const total = (pick: (row: Row) => number) => list.reduce((sum, r) => sum + pick(r), 0);
    return {
      useful: list.filter((r) => r.usefulCompletion).length,
      verified: list.filter((r) => r.verified).length,
      residuals: total((r) => r.targetedResiduals ?? 0),
      unrelated: total((r) => Math.max(0, r.unrelatedRecordChanges)),
      modelCalls: total((r) => r.modelCalls),
      tokens: total((r) => r.inputTokens + r.outputTokens),
      costMicrousd: total((r) => r.costMicrousd),
    };
  };
  const summary = { parent: armSummary('parent'), candidate: armSummary('candidate') };
  const report = {
    label: LABEL,
    notAdmission:
      "No gate decision, no frozen-split check, no held-out instances, no promotion. The candidate was re-parented onto this pilot's own W0.",
    demoSetup:
      'demo setup: eligibility rows written by the operator for both harnesses and their cited sources, per instance scope',
    finishedAt: new Date().toISOString(),
    model: { provider, modelId, keyVariable: keyName },
    runtimeHash: RT,
    parentHash,
    candidateHash,
    lineageNotes: lineageNote,
    campaignId,
    databases: names,
    pairs: pairsWanted,
    concurrency,
    summary,
    rows,
  };
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'pilot.json');
  const mdPath = join(outDir, 'pilot.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;
  const md = [
    `# ${LABEL}`,
    '',
    `Model ${provider}/${modelId} through the real worker and domain gateway on a local replica set. Parent W0 \`${parentHash.slice(0, 12)}\` vs candidate \`${candidateHash.slice(0, 12)}\` (re-parented). Runtime hash \`${RT.slice(0, 12)}\`.`,
    '',
    '| pair | arm | outcome | useful | residuals | verified receipt | unrelated changes | model calls | tokens in/out | cost | attestation | runtimeHash |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.pair} | ${r.arm} | ${r.outcome}${r.failureCode ? ` (${r.failureCode})` : ''} | ${r.usefulCompletion ? 'yes' : 'no'} | ${r.targetedResiduals ?? 'n/a'} | ${r.verified ? 'verified' : `NOT verified: ${r.verifyReasons.join(',')}`} | ${r.unrelatedRecordChanges} | ${r.modelCalls} | ${r.inputTokens}/${r.outputTokens} | ${usd(r.costMicrousd)}${r.unpricedCalls ? ' (unpriced calls)' : ''} | ${r.attestationSource ?? 'none'}${r.attestedEndpoint ? `/${r.attestedEndpoint}` : ''} | ${r.runtimeHash ? r.runtimeHash.slice(0, 12) : 'none'} |`,
    ),
    '',
    `Parent: ${summary.parent.useful}/${pairsWanted} useful, ${summary.parent.residuals} residuals, ${summary.parent.verified} verified, ${summary.parent.modelCalls} calls, ${usd(summary.parent.costMicrousd)}.`,
    `Candidate: ${summary.candidate.useful}/${pairsWanted} useful, ${summary.candidate.residuals} residuals, ${summary.candidate.verified} verified, ${summary.candidate.modelCalls} calls, ${usd(summary.candidate.costMicrousd)}.`,
    '',
    `**${LABEL}.** ${report.notAdmission}`,
    'Demo setup: eligibility rows written by the operator for both harnesses and the sources they cite, in every instance scope.',
    ...(lineageNote.length ? ['', `Lineage notes: ${lineageNote.join('; ')}.`] : []),
    '',
  ].join('\n');
  writeFileSync(mdPath, md);
  console.log(md);
  console.log(JSON.stringify({ label: LABEL, json: jsonPath, markdown: mdPath }));
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        label: LABEL,
        error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown',
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const service of opened) await service.close().catch(() => undefined);
  });
