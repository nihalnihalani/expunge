/**
 * DEMO STEP 2a: a REAL fresh paired admission of the operator-authored child against W0, through the gate's own `runGate`
 * (packages/gate), with the REAL provider model, the REAL worker composition (Dispatcher, domain gateway as domain_executor,
 * insert-only run_attestations) and a LOCAL replica set. Not a pilot and not a test fixture: the frozen rule (38 pairs =
 * 76 episodes over train/protected/validation) decides, and the gate stores its own report. If, and only if, the verdict is
 * `admit`, the stored report is promoted through packages/deployment (loadAdmittedReport via renderDescriptor, answerApproval,
 * promoteAdmitted) into a fresh owner scope whose pointer is W0, and a pinned job is created to show the new pin.
 *
 *   node --import tsx --env-file-if-exists=.env scripts/demo/admission.ts [--candidate FILE.bundle.json] [--concurrency 4]
 *        [--out DIR] [--uri URI]
 *
 * Reads, by NAME only (values are never printed): EXPUNGE_MODEL_PROVIDER, EXPUNGE_MODEL_ID, OPENAI_API_KEY or
 * ANTHROPIC_API_KEY, EXPUNGE_MODEL_PRICE_*_MICROUSD_PER_MILLION. The Mongo URI must be a loopback replica set; every
 * database is a fresh throwaway (expunge_adm_*). The Atlas URIs in .env are never used.
 *
 * DEMO SETUP (stated, not hidden): (1) the instance authority row is installed by `setup`, because no restricted campaign
 * installer exists yet (MA-F2); (2) operator-written eligibility rows permit both harnesses and their cited sources in every
 * instance scope and in the promotion scope (the proposer and observer pipelines write these in a real deployment); (3) the
 * campaign's per-episode cost ceiling is the owner's provisional ceiling (PROVISIONAL_COST_CEILING_MICROUSD), not a
 * ceiling measured by baseline probes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { buildW0Bundle, OWNER_EPISODE_LIMITS, PROVISIONAL_COST_CEILING_MICROUSD } from '@expunge/baselines';
import { contentHash, type ActorContext, type HarnessBundle, type ScopeKey } from '@expunge/contracts';
import {
  answerApproval,
  createPinnedCleanupJob,
  promoteAdmitted,
  renderDescriptor,
} from '@expunge/deployment';
import { createDomainEnv } from '@expunge/domain';
import {
  ELIGIBILITY_POLICY_HASH,
  FIXTURE_GENERATOR_HASH,
  createWorldSpec,
  deriveWorldScopeKey,
} from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture, sealPlanForGate } from '@expunge/fixtures/sealed';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { EVALUATOR_HASH } from '@expunge/grader';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import {
  ArtifactRepository,
  AttestationRepository,
  AuthorityPolicyRepository,
  AuthorityRepository,
  DeploymentRepository,
  JobRepository,
  ProjectionRepository,
  ScopeRepository,
  WorldRepository,
  createPrincipalService,
  setupMongo,
  type MongoService,
  type Principal,
} from '@expunge/mongo';
import { EnvModelResolver, runtimeHash } from '@expunge/runtime';
import {
  ADMISSION_RULE,
  ADMISSION_RULE_HASH,
  CampaignKeyStore,
  FreezeStore,
  GATE_HASH,
  GraderEpisodeHost,
  MongoEpisodePort,
  PLANNED_PAIRS,
  budgetHashOf,
  profileHashOf,
  runGate,
  type EpisodePort,
  type TrialRow,
  type WorkerProfile,
} from '@expunge/gate';
import {
  Dispatcher,
  FencedProjectionSink,
  MongoCommittedReader,
  MongoCompletionReceiptReader,
  MongoEpisodeEvidence,
  MongoJobResolver,
  WorkerEpisodeRunner,
  asArtifactReader,
  asDispatchJobs,
  createDomainToolWiring,
  workerConfigFromEnv,
} from '../../apps/worker/src/index.js';

const LABEL = 'REAL ADMISSION (runGate, provider model, real worker)';
const { values } = parseArgs({
  options: {
    candidate: { type: 'string', default: '.expunge/demo/candidate.bundle.json' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string', default: '.expunge/demo/admission' },
    uri: {
      type: 'string',
      default:
        process.env.MONGODB_ADMISSION_URI ??
        'mongodb://127.0.0.1:27318/?replicaSet=expunge-local&directConnection=true',
    },
  },
});
const fail = (message: string): never => {
  console.error(`${LABEL}: ${message}`);
  process.exit(2);
};
const say = (step: string, data: Record<string, unknown>) => console.error(JSON.stringify({ step, ...data }));

const uri = values.uri!;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(uri).hostname))
  fail('the admission runs only against a loopback replica set');
const concurrency = Math.max(1, Math.min(8, Number(values.concurrency)));
const provider = process.env.EXPUNGE_MODEL_PROVIDER?.trim();
const modelId = process.env.EXPUNGE_MODEL_ID?.trim();
const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
if (!provider || !modelId) fail('EXPUNGE_MODEL_PROVIDER and EXPUNGE_MODEL_ID must be set');
if (!process.env[keyName]?.trim()) fail(`${keyName} is not set (a provider model is required)`);
for (const name of [
  'EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION',
  'EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION',
])
  if (!process.env[name]?.trim()) fail(`${name} is not set (unpriced calls make the gate hold)`);

const RT = runtimeHash();
const infra = {
  runtimeAdapterHash: RT,
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
const BASE_SCOPE = { tenantId: 'admission', env: 'evaluation' } as const;
const BUDGET = OWNER_EPISODE_LIMITS;

const prefix = `expunge_adm_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const names = {
  worldDatabase: `${prefix}_world`,
  controlDatabase: `${prefix}_control`,
  privateDatabase: `${prefix}_private`,
};
const opened: MongoService[] = [];
async function as(principal: Principal): Promise<MongoService> {
  const service = createPrincipalService(
    { uris: { [principal]: uri }, ...names, appName: 'expunge-admission' },
    principal,
  );
  await service.client.connect();
  opened.push(service);
  return service;
}

/** Writes the operator's eligibility rows (demo setup) for `hashes` in `scope`. */
async function permit(setup: MongoService, scope: ScopeKey, hashes: Iterable<string>): Promise<void> {
  for (const hash of hashes)
    await setup.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash: hash,
      state: 'permitted',
      policyHash: ELIGIBILITY_POLICY_HASH,
      reasonCode: 'source_retracted',
      sourceIds: [],
      updatedAt: new Date(),
    } as never);
}

async function main(): Promise<void> {
  const setup = await as('setup');
  await setupMongo(setup);
  const [executor, grader, builder, promoter, issuer] = await Promise.all(
    (['domain_executor', 'grader', 'fixture_builder', 'promoter', 'approval_issuer'] as const).map(as),
  );
  say('databases', { prefix });

  // --- the exact parent and the exact compiled child ------------------------------------------------------------
  const parent = buildW0Bundle(infra);
  const child = JSON.parse(readFileSync(values.candidate!, 'utf8')) as HarnessBundle;
  const artifacts = new ArtifactRepository(builder);
  const parentHash = (await artifacts.insert(parent))._id;
  if (child.parentHash !== parentHash)
    fail(
      `the candidate was compiled for another W0 (${child.parentHash} vs ${parentHash}); re-run scripts/demo/candidate.ts`,
    );
  const childHash = (await artifacts.insert(child))._id;
  if (childHash !== contentHash(child)) fail('stored child hash differs from its content hash');
  const eligible = new Set<string>([parentHash, childHash]);
  for (const bundle of [parent, child])
    for (const reference of bundle.evidence) eligible.add(reference.contentHash);
  say('harnesses', { parentHash, childHash, runtimeHash: RT });

  // --- the campaign: key, sealed split plan and freeze, written by the fixture builder before any episode ---------
  const profile: WorkerProfile = {
    profileId: `gate-${provider}`,
    modelId: modelId!,
    modelKind: 'provider',
    provider: provider!,
    params: {},
  };
  const campaignId = `adm-${randomUUID().slice(0, 8)}`;
  await new CampaignKeyStore(builder).mint(campaignId);
  const masterSeed = contentHash(
    { label: 'admission', campaignId, nonce: randomUUID() },
    'admission-master-seed',
  );
  const view = sealPlanForGate(buildSealedSplitPlan(masterSeed));
  const freeze = await new FreezeStore(builder).write({
    campaignId,
    evaluatorHash: EVALUATOR_HASH,
    fixtureGeneratorHash: FIXTURE_GENERATOR_HASH,
    runtimeHash: RT,
    compilerHash: COMPILER_HASH,
    workerProfileHash: profileHashOf(profile),
    budgetHash: budgetHashOf(BUDGET),
    maxAttemptsPerParent: 3,
    splitManifestCommitment: view.commitment.splitHash,
    costCeilingMicrousd: PROVISIONAL_COST_CEILING_MICROUSD,
  });
  say('freeze', {
    campaignId,
    freezeHash: freeze.freezeHash,
    splitManifestCommitment: freeze.splitManifestCommitment,
    plannedPairs: PLANNED_PAIRS,
    costCeilingMicrousd: freeze.costCeilingMicrousd,
  });

  // --- the real worker composition behind the gate's MongoEpisodePort ---------------------------------------------
  const domain = createDomainEnv(executor, { floors: [DEFAULT_AUTHORITY_FLOOR] });
  // Domain tool failures are surfaced by code (never message or values): a tool fault is infrastructure, not behaviour.
  const toolFaults: Record<string, number> = {};
  const wiring = () =>
    createDomainToolWiring(executor, {
      log: (entry) => {
        const key = `${entry.message}:${String(entry.code ?? 'none')}`;
        toolFaults[key] = (toolFaults[key] ?? 0) + 1;
        if (toolFaults[key] === 1)
          say('domain_warning', { message: entry.message, code: entry.code ?? null });
      },
    }).provider;
  const jobs = new JobRepository(executor);
  const projections = new ProjectionRepository(executor);
  const runner = new WorkerEpisodeRunner({
    host: new GraderEpisodeHost({ grader, subjects: domain.store }),
    evidence: new MongoEpisodeEvidence(setup),
    baseTools: wiring(),
    workerFactory: ({ tools, onResult, session }) =>
      new Dispatcher({
        jobs: asDispatchJobs(jobs),
        resolver: new MongoJobResolver(jobs),
        artifacts: asArtifactReader(new ArtifactRepository(executor)),
        tools: tools(wiring()),
        models: new EnvModelResolver(process.env),
        receipts: new MongoCompletionReceiptReader(executor),
        committed: new MongoCommittedReader(executor),
        projection: new FencedProjectionSink(executor, jobs, projections),
        runtimeHash: RT,
        attestations: new AttestationRepository(executor),
        env: process.env,
        onResult,
        config: workerConfigFromEnv({
          EXPUNGE_WORKER_ID: `adm-${session}-${randomUUID().slice(0, 6)}`,
          EXPUNGE_WORKER_LEASE_MS: '60000',
          EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '120000',
        }),
      }),
  });
  const real = new MongoEpisodePort({
    grader,
    builder,
    runner: runner as never,
    installAuthority: async (scope, floorHash) => {
      // DEMO SETUP (1) and (2): see the header.
      await new AuthorityRepository(setup).install(scope, floorHash, 1);
      await permit(setup, scope, eligible);
    },
    floorHash: DEFAULT_AUTHORITY_FLOOR.hash,
    profile,
    label: `REAL worker/domain path with the provider model ${provider}/${modelId}`,
  });
  // Progress only: the gate reads every arm's evidence from the stored job and attestation rows, never from the port.
  let done = 0;
  const port: EpisodePort = {
    kind: real.kind,
    label: real.label,
    profile: real.profile,
    run: async (request) => {
      const result = await real.run(request);
      done += 1;
      say('episode', {
        done,
        of: PLANNED_PAIRS * 2,
        outcome: result.outcome,
        failureCode: result.failureCode ?? null,
        costMicrousd: result.cost.costMicrousd,
      });
      return result;
    },
  };

  // The owner scope the child would be promoted into. Its stored eligibility is what the gate's source check reads.
  const spec = createWorldSpec({ family: 'direct_nested', seed: `adm-owner-${campaignId}` });
  const ownerScope = deriveWorldScopeKey(spec, `adm-owner-${campaignId}`, {
    tenantId: 'admission-owner',
    env: 'evaluation',
    scopeId: 'base',
  });

  const started = Date.now();
  const outcome = await runGate({
    grader,
    campaignId,
    candidateId: 'demo-operator-authored',
    parentHash,
    childHash,
    view,
    port,
    budget: BUDGET,
    baseScope: BASE_SCOPE,
    concurrency,
    sourceScope: ownerScope,
  });
  const wallMs = Date.now() - started;
  const rows: TrialRow[] = outcome.rows;
  const armCost = (arm: 'parent' | 'candidate') =>
    rows.reduce(
      (sum, row) => ({
        costMicrousd: sum.costMicrousd + row[arm].metrics.cost.costMicrousd,
        modelCalls: sum.modelCalls + row[arm].metrics.cost.modelCalls,
        tokens: sum.tokens + row[arm].metrics.cost.inputTokens + row[arm].metrics.cost.outputTokens,
        unpricedCalls: sum.unpricedCalls + row[arm].metrics.cost.unpricedCalls,
      }),
      { costMicrousd: 0, modelCalls: 0, tokens: 0, unpricedCalls: 0 },
    );
  const trainByFamily: Record<string, { pairs: number; parent: number; candidate: number }> = {};
  for (const row of rows.filter((item) => item.split === 'train')) {
    const tally = (trainByFamily[row.family] ??= { pairs: 0, parent: 0, candidate: 0 });
    tally.pairs += 1;
    tally.parent += row.parent.metrics.usefulCompletion ? 1 : 0;
    tally.candidate += row.candidate.metrics.usefulCompletion ? 1 : 0;
  }
  const failureCodes = (arm: 'parent' | 'candidate') => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const key = `${row[arm].outcome}${row[arm].failureCode ? `:${row[arm].failureCode}` : ''}`;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };
  const limitBreaches = rows
    .map((row) => row.candidate)
    .filter(
      (arm) =>
        arm.hadResult &&
        arm.metrics.cost.inputTokens + arm.metrics.cost.outputTokens > child.limits.totalTokens,
    ).length;
  const result = {
    label: LABEL,
    finishedAt: new Date().toISOString(),
    wallMs,
    model: { provider, modelId, keyVariable: keyName },
    databases: prefix,
    campaignId,
    freezeHash: freeze.freezeHash,
    ruleHash: ADMISSION_RULE_HASH,
    rule: ADMISSION_RULE,
    gateHash: GATE_HASH,
    runtimeHash: RT,
    parentHash,
    childHash,
    concurrency,
    verdict: outcome.verdict,
    reasonCodes: outcome.reasonCodes,
    summary: outcome.decision.summary,
    attestedRuntimeHash: outcome.decision.attestedRuntimeHash,
    reportId: outcome.reportId,
    digest: outcome.digest,
    publicRows: outcome.publicRows ?? null,
    episodes: rows.length * 2,
    evidence: {
      committed: rows
        .flatMap((row) => [row.parent, row.candidate])
        .filter((arm) => arm.evidence === 'committed').length,
      fakeReasons: [
        ...new Set(
          rows.flatMap((row) =>
            [row.parent, row.candidate].flatMap((arm) =>
              arm.evidence === 'fake' ? arm.evidenceReasons : [],
            ),
          ),
        ),
      ],
    },
    infraArms: rows.flatMap((row) => [row.parent, row.candidate]).filter((arm) => arm.infra).length,
    harnessDefectPairs: rows.filter((row) => row.parent.harnessDefect || row.candidate.harnessDefect).length,
    candidateTokenLimitBreaches: limitBreaches,
    cost: { parent: armCost('parent'), candidate: armCost('candidate'), total: outcome.report?.cost ?? null },
    trainByFamily,
    outcomes: { parent: failureCodes('parent'), candidate: failureCodes('candidate') },
    promotion: null as Record<string, unknown> | null,
  };
  say('verdict', {
    verdict: result.verdict,
    reasonCodes: result.reasonCodes,
    summary: result.summary,
    reportId: result.reportId,
    digest: result.digest,
  });

  // --- promotion from the stored report, only on admit ------------------------------------------------------------
  if (outcome.verdict === 'admit' && outcome.digest) {
    const fixture = generateSealedFixture(spec, `adm-owner-${campaignId}`, ownerScope);
    const world = fixture.world;
    const actor: ActorContext = { ...ownerScope, actorId: 'owner', authorizationRevision: 1 };
    await new AuthorityRepository(setup).install(ownerScope, DEFAULT_AUTHORITY_FLOOR.hash, 1);
    await new ScopeRepository(builder).insert(world.scope);
    await new WorldRepository(builder).create(ownerScope, world.worldId, world.scope.revision);
    await permit(setup, ownerScope, eligible);
    await new DeploymentRepository(setup).initialize(actor, 'worker', parentHash, world.scope.revision);
    await new AuthorityPolicyRepository(setup).install({ ...ownerScope, target: 'worker' }, true);
    const request = { actor, target: 'worker' as const, reportId: outcome.reportId, parentHash, childHash };
    const { descriptor } = await renderDescriptor(issuer, request);
    const approval = await answerApproval(issuer, {
      ...request,
      answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'approve' },
    });
    if (approval.state !== 'approved') throw new Error('ApprovalNotGranted');
    const promotion = await promoteAdmitted(promoter, {
      ...request,
      grantId: approval.grantId,
      reason: 'real admission promotion',
      expectedDigest: outcome.digest,
    });
    const pinned = await createPinnedCleanupJob(executor, {
      actor,
      jobId: `adm-pinned-${campaignId}`,
      binding: {
        runId: `adm-pinned-run-${campaignId}`,
        worldId: world.worldId,
        scopeRevision: world.scope.revision,
        workerProfileHash: profileHashOf(profile),
      },
    });
    result.promotion = {
      descriptorDigest: descriptor.descriptorDigest,
      computedClass: descriptor.computedClass,
      changes: descriptor.changes.map((change) => ({
        unit: change.unit,
        before: change.before,
        after: change.after,
      })),
      grantId: approval.grantId,
      promotionId: promotion.promotionId,
      from: promotion.fromHash,
      to: promotion.toHash,
      revision: `${promotion.fromRevision} -> ${promotion.toRevision}`,
      pinnedJob: pinned._id,
      pinnedHarness: pinned.binding.harnessHash,
      pinnedIsChild: pinned.binding.harnessHash === childHash,
    };
    say('promotion', result.promotion);
  } else say('promotion', { skipped: true, reason: `verdict ${outcome.verdict}` });

  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, 'admission.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (outcome.report)
    writeFileSync(
      join(values.out!, 'gate-report.json'),
      `${JSON.stringify({ digest: outcome.digest, report: outcome.report }, null, 2)}\n`,
    );
  // Every arm of every split, held-out included: local and git-ignored (the stored report keeps held-out splits as totals).
  writeFileSync(join(values.out!, 'rows.private.json'), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        label: LABEL,
        error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : 'unknown',
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const service of opened) await service.close().catch(() => undefined);
  });
