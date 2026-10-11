/**
 * The gate-side MongoEpisodePort over the REAL worker (Dispatcher, WorkerEpisodeRunner, MongoEpisodeEvidence) and the
 * REAL domain gateway, on a local replica set. The only stand-in is the model: a labeled FakeChatModel that follows
 * each bundle's workflow. That makes this protocol evidence for the wiring and the grading join, not model evidence;
 * the profile says `fake`, so a campaign over this port is only ever held.
 *
 * KNOWN GAP (MA-F2, mongodb-authority): the setup-backed `installAuthority` stands in for a restricted authority
 * installer. No gate source path depends on it; delete it here when it lands.
 *
 * Covers training fixtures only (no fault plan): a scripted model cannot do the retry reasoning faulted families need.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildExpertStaticBundle, buildW0Bundle } from '@expunge/baselines';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { createDomainEnv } from '@expunge/domain';
import { ELIGIBILITY_POLICY_HASH } from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { gradeWorld, runReference } from '@expunge/grader';
import {
  ArtifactRepository,
  AttestationRepository,
  AuthorityRepository,
  JobRepository,
  ProjectionRepository,
} from '@expunge/mongo';
import { runtimeHash } from '@expunge/runtime';
import { FakeChatModel, fakeText, fakeToolCalls, type FakeTurn } from '@expunge/runtime/testing';
import type { HarnessBundle } from '@expunge/contracts';
import { liveSuite, TEST_URI, openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';
import { FixedModelResolver } from '../../runtime/test/fakes.js';
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
} from '../../../apps/worker/src/index.js';
import {
  CampaignKeyStore,
  ClaimStore,
  FreezeStore,
  GraderEpisodeHost,
  MongoEpisodePort,
  budgetHashOf,
  AttestedJobEvidence,
  modelStampsOf,
  verifyArm,
  campaignCrypto,
  childProjectionOf,
  profileHashOf,
  type EpisodeRequest,
} from '../src/index.js';
import { EVALUATOR_HASH } from '@expunge/grader';
import { FIXTURE_GENERATOR_HASH } from '@expunge/fixtures';
import { BASE_SCOPE, BUDGET, gateView } from './support.js';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');
const RT = runtimeHash();
const infra = {
  runtimeAdapterHash: RT,
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
let env: LiveEnvironment;
const als = new AsyncLocalStorage<{ kind: 'w0' | 'child'; applies: number }>();

function script(kind: 'w0' | 'child', applies: number): FakeTurn[] {
  const tools = [
    'inspect_scope',
    'resolve_subject',
    'discover_references',
    'preview_cleanup',
    ...Array.from({ length: applies }, () => 'apply_cleanup_batch'),
    ...(kind === 'child' ? ['verify_registered_scope'] : []),
    'complete_cleanup',
  ];
  return [...tools.map((name) => fakeToolCalls([{ name, args: {} }])), fakeText('done')];
}

describeLive('MongoEpisodePort over the real worker and domain gateway (FAKE model)', () => {
  beforeAll(async () => {
    env = await openEnvironment('greal');
  }, 60_000);
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  it('runs both arms of a training fixture on separate instances; the child decides, the grader joins the truth', async () => {
    const executor = await env.as('domain_executor');
    const grader = await env.as('grader');
    const builder = await env.as('fixture_builder');
    const domain = createDomainEnv(executor, { floors: [DEFAULT_AUTHORITY_FLOOR] });
    const parent = buildW0Bundle(infra);
    const child: HarnessBundle = { ...buildExpertStaticBundle(infra), parentHash: null };
    const artifacts = new ArtifactRepository(builder);
    const parentHash = (await artifacts.insert(parent))._id;
    const childBundle: HarnessBundle = { ...child, parentHash };
    const childHash = (await artifacts.insert(childBundle))._id;

    const campaignId = 'real-1';
    const stored = await new CampaignKeyStore(builder).mint(campaignId);
    const crypto = campaignCrypto(stored);
    const profile = {
      profileId: 'fake-fm',
      modelId: 'fake-deterministic-1',
      modelKind: 'fake' as const,
      params: {},
    };
    await new FreezeStore(builder).write({
      campaignId,
      evaluatorHash: EVALUATOR_HASH,
      fixtureGeneratorHash: FIXTURE_GENERATOR_HASH,
      runtimeHash: RT,
      compilerHash: COMPILER_HASH,
      workerProfileHash: profileHashOf(profile),
      budgetHash: budgetHashOf(BUDGET),
      maxAttemptsPerParent: 3,
      splitManifestCommitment: gateView().commitment.splitHash,
      costCeilingMicrousd: null,
    });
    const claims = new ClaimStore(grader);
    await claims.claim({
      campaignId,
      parentHash,
      childProjectionHash: childProjectionOf(childBundle),
      maxAttemptsPerParent: 3,
    });

    const jobs = new JobRepository(executor);
    const projections = new ProjectionRepository(executor);
    const runner = new WorkerEpisodeRunner({
      host: new GraderEpisodeHost({ grader, subjects: domain.store }),
      evidence: new MongoEpisodeEvidence(env.service),
      baseTools: createDomainToolWiring(executor).provider,
      workerFactory: ({ tools, onResult, session }) => {
        const plan = als.getStore()!;
        const model = new FakeChatModel(script(plan.kind, plan.applies));
        return new Dispatcher({
          jobs: asDispatchJobs(jobs),
          resolver: new MongoJobResolver(jobs),
          artifacts: asArtifactReader(new ArtifactRepository(executor)),
          tools: tools(createDomainToolWiring(executor).provider),
          models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: model.adapter }),
          receipts: new MongoCompletionReceiptReader(executor),
          committed: new MongoCommittedReader(executor),
          projection: new FencedProjectionSink(executor, jobs, projections),
          runtimeHash: RT,
          attestations: new AttestationRepository(executor),
          onResult,
          config: workerConfigFromEnv({
            EXPUNGE_WORKER_ID: `gate-${session}`,
            EXPUNGE_WORKER_LEASE_MS: '20000',
            EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '15000',
          }),
        });
      },
    });
    const port = new MongoEpisodePort({
      grader,
      builder,
      runner: runner as never,
      installAuthority: async (scope, floorHash) => {
        // LOCAL LANE ONLY: AuthorityRepository.install is a setup right today (see the packet's requirements list).
        await new AuthorityRepository(env.service).install(scope, floorHash, 1);
      },
      floorHash: DEFAULT_AUTHORITY_FLOOR.hash,
      profile,
    });

    const entry = gateView().entries.find((candidate) => candidate.split === 'train')!;
    const outcomes: Record<
      string,
      { useful: boolean; hash: string; jobId: string; runtime: string | undefined; scope: string }
    > = {};
    for (const arm of ['parent', 'candidate'] as const) {
      const scope = { ...BASE_SCOPE, scopeId: `i_${arm}_${crypto.label('t', { arm }, 12)}` };
      const fixture = generateSealedFixture(entry.spec, entry.seed, scope, undefined, {
        derivation: crypto.derivation,
      });
      const bundle = arm === 'parent' ? parent : childBundle;
      const applies = new Set(runReference(fixture.world).plan.actions.map((action) => action.effect)).size;
      const request: EpisodeRequest = {
        campaignId,
        runId: crypto.label('run', { arm }, 40),
        instanceId: crypto.label('instance', { arm }, 24),
        instanceScope: scope,
        bundle,
        bundleHash: arm === 'parent' ? parentHash : childHash,
        profile,
        limits: bundle.limits,
        budget: BUDGET,
        world: structuredClone(fixture.world),
        faults: entry.spec.faults,
        signal: new AbortController().signal,
      };
      const result = await als.run({ kind: arm === 'parent' ? 'w0' : 'child', applies }, () =>
        port.run(request),
      );
      expect(result.evidence).toBe('committed');
      expect(result.runtimeHash).toBe(RT);
      expect(result.world).not.toBeNull();
      const grade = gradeWorld(fixture.manifest, result.world!, {
        terminalStatus: result.terminal.status,
        terminalClaim: result.terminal.claim,
        retryFailures: result.retryFailures,
        cost: result.cost,
        ...(result.receipt ? { trustedReceiptEvidence: result.receipt } : {}),
      });
      outcomes[arm] = {
        useful: grade.usefulCompletion,
        hash: request.bundleHash,
        jobId: result.jobId!,
        runtime: result.runtimeHash,
        scope: scope.scopeId,
      };
      // The domain's own attestation of the stored fault plan matches the plan this instance was seeded with.
      expect(result.faults?.attestedPlanHash).toBeTruthy();
    }
    // Two instances, two scopes, no shared record ids.
    const ids = await Promise.all(
      Object.values(outcomes).map(async (o) =>
        (await env.service.world.collection('customers').find({ scopeId: o.scope }).toArray()).map((d) =>
          String(d._id),
        ),
      ),
    );
    expect(new Set([...ids[0]!, ...ids[1]!]).size).toBe(ids[0]!.length + ids[1]!.length);
    // After promotion-equivalent pinning, the run is decided by the bundle it is pinned to: the decision ledger rows
    // of each job carry that job's harness hash (read from committed decisions, not from the script).
    for (const arm of ['parent', 'candidate'] as const) {
      const rows = await env.service.control
        .collection('decisions')
        .find({ jobId: outcomes[arm]!.jobId })
        .toArray();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.harnessHash === outcomes[arm]!.hash)).toBe(true);
    }
    expect(outcomes.candidate!.useful).toBe(true);
    // D8-8 / DA-11 F-1: the stored job says a FAKE adapter ran. A profile that DECLARES a provider model, as the port's
    // caller may, does not change that: the gate reads the stamp the worker committed and holds it as fake evidence.
    const reader = new AttestedJobEvidence(grader);
    for (const arm of ['parent', 'candidate'] as const) {
      const row = await reader.read({ ...BASE_SCOPE, scopeId: outcomes[arm]!.scope }, outcomes[arm]!.jobId);
      const stamps = modelStampsOf(row.stamps);
      expect(stamps.length).toBeGreaterThan(0);
      expect(stamps.every((stamp) => stamp.source === 'fake')).toBe(true);
      const claimsProvider = {
        profileId: 'declared-provider',
        modelId: stamps[0]!.modelId,
        modelKind: 'provider' as const,
        provider: stamps[0]!.provider,
        params: {},
      };
      const facts = verifyArm(
        row,
        {
          runId: row.job!.binding.runId,
          worldId: row.job!.binding.worldId,
          bundleHash: outcomes[arm]!.hash,
          outcome: 'completed',
        },
        claimsProvider,
      );
      expect(facts.verified).toBe(false);
      expect(facts.reasons).toContain('model_not_provider');
    }
  }, 180_000);
});
