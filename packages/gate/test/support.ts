import {
  buildSealedSplitPlan,
  sealPlanForGate,
  type GatePlanView,
  type SealedSplitEntry,
} from '@expunge/fixtures/sealed';
import { buildW0Bundle } from '@expunge/baselines';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import { contentHash, type HarnessBundle, type ResourceLimits } from '@expunge/contracts';
import { ELIGIBILITY_POLICY_HASH, FIXTURE_GENERATOR_HASH } from '@expunge/fixtures';
import { EVALUATOR_HASH } from '@expunge/grader';
import { ArtifactRepository, type MongoService } from '@expunge/mongo';
import { OWNER_EPISODE_LIMITS } from '@expunge/baselines';
import { openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';
import {
  CampaignKeyStore,
  FreezeStore,
  budgetHashOf,
  childProjectionOf,
  profileHashOf,
  runGate,
  type GateConfig,
  type GateOutcome,
} from '../src/index.js';
import { jobRecorder } from './job-rows.js';
import { ScriptedEpisodePort, type Behavior, type ScriptedOptions } from '../src/testing/index.js';

export const RUNTIME_HASH = 'c'.repeat(64);
export const FLOOR_HASH = 'd'.repeat(64);
export const MASTER_SEED = contentHash({ label: 'gate-tests' }, 'test-master-seed');
export const BUDGET: ResourceLimits = OWNER_EPISODE_LIMITS;
export const BASE_SCOPE = { tenantId: 'gate-campaign', env: 'evaluation' } as const;

let cachedPlan: SealedSplitEntry[] | undefined;
export const fullPlan = () => (cachedPlan ??= buildSealedSplitPlan(MASTER_SEED));
export const gateView = (): GatePlanView => sealPlanForGate(fullPlan());

export const infra = {
  runtimeAdapterHash: RUNTIME_HASH,
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: FLOOR_HASH,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
export const w0 = (): HarnessBundle => buildW0Bundle(infra);
/** A behavioural child of W0 (a deeper reference walk): same authority, different executable projection. */
export const childOf = (parent: HarnessBundle, parentHash: string, depth = 5): HarnessBundle => ({
  ...structuredClone(parent),
  parentHash,
  limits: { ...parent.limits, traversalDepth: depth },
});

export type Gate = {
  env: LiveEnvironment;
  grader: MongoService;
  builder: MongoService;
  parentHash: string;
  parent: HarnessBundle;
  insertBundle(bundle: HarnessBundle): Promise<string>;
  /** Freezes a campaign (key + freeze row) and returns its id. */
  freezeCampaign(
    campaignId: string,
    over?: Partial<Parameters<FreezeStore['write']>[0]>,
    port?: ScriptedEpisodePort,
  ): Promise<void>;
  run(
    childHash: string,
    campaignId: string,
    port: ScriptedEpisodePort,
    over?: Partial<GateConfig>,
  ): Promise<GateOutcome>;
};

export async function openGate(label: string): Promise<Gate> {
  const env = await openEnvironment(label);
  const grader = await env.as('grader');
  const builder = await env.as('fixture_builder');
  const parent = w0();
  const parentHash = (await new ArtifactRepository(builder).insert(parent))._id;
  const view = gateView();
  const defaultProfile = new ScriptedEpisodePort({
    behavior: () => 'solve',
    declare: { kind: 'worker', modelKind: 'provider', evidence: 'committed' },
  }).profile;
  return {
    env,
    grader,
    builder,
    parentHash,
    parent,
    insertBundle: async (bundle) => (await new ArtifactRepository(builder).insert(bundle))._id,
    async freezeCampaign(campaignId, over = {}, port) {
      await new CampaignKeyStore(builder).mint(campaignId);
      await new FreezeStore(builder).write({
        campaignId,
        evaluatorHash: EVALUATOR_HASH,
        fixtureGeneratorHash: FIXTURE_GENERATOR_HASH,
        runtimeHash: RUNTIME_HASH,
        compilerHash: COMPILER_HASH,
        workerProfileHash: profileHashOf(port?.profile ?? defaultProfile),
        budgetHash: budgetHashOf(BUDGET),
        maxAttemptsPerParent: 50,
        splitManifestCommitment: view.commitment.splitHash,
        costCeilingMicrousd: 100_000,
        ...over,
      });
    },
    run(childHash, campaignId, port, over = {}) {
      return runGate({
        grader,
        campaignId,
        candidateId: `cand-${childHash.slice(0, 8)}`,
        parentHash,
        childHash,
        view,
        port,
        budget: BUDGET,
        baseScope: BASE_SCOPE,
        sourceScope: { tenantId: 'owner-tenant', env: 'dev', scopeId: 'owner-scope' },
        concurrency: 4,
        ...over,
      });
    },
  };
}

/** A port that declares committed evidence (rule tests only) and behaves per bundle: parent vs child. */
export function rulePort(
  gate: Pick<Gate, 'parentHash' | 'env'>,
  parentBehavior: Behavior | ((r: Parameters<ScriptedOptions['behavior']>[0]) => Behavior),
  childBehavior: Behavior | ((r: Parameters<ScriptedOptions['behavior']>[0]) => Behavior),
  extra: Partial<ScriptedOptions> = {},
): ScriptedEpisodePort {
  const pick = (value: Behavior | ((r: never) => Behavior), request: never) =>
    typeof value === 'function' ? value(request) : value;
  return new ScriptedEpisodePort({
    behavior: (request) =>
      request.bundleHash === gate.parentHash
        ? pick(parentBehavior, request as never)
        : pick(childBehavior, request as never),
    declare: { kind: 'worker', modelKind: 'provider', evidence: 'committed' },
    runtimeHash: RUNTIME_HASH,
    recordJob: jobRecorder(gate.env.service),
    ...extra,
  });
}
export { childProjectionOf };

let uniq = 0;
/** A behavioural child of W0 with its own executable projection (the scanned-documents limit differs). */
export const uniqueChild = (
  parent: HarnessBundle,
  parentHash: string,
  wallTimeMs?: number,
): HarnessBundle => ({
  ...structuredClone(parent),
  parentHash,
  limits: {
    ...parent.limits,
    scannedDocuments: 100 + ++uniq,
    ...(wallTimeMs ? { wallTimeMs } : {}),
  },
});
