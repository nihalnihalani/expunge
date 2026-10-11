import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BSON, type Document } from 'mongodb';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import {
  type ActionIntent,
  type ActorContext,
  type ApprovalGrant,
  type DomainAddress,
  type EffectKind,
  type CompletionReceipt,
  type GateReport,
  type HarnessBundle,
  type MutationClass,
  type ScopeRegistry,
  contentHash,
} from '@expunge/contracts';
import {
  ApprovalRepository,
  ArtifactRepository,
  DeploymentRepository,
  JobRepository,
  AuthorityRepository,
  DecisionRepository,
  ScopeRepository,
  WorldRepository,
  atlasRoleManifests,
  createPrincipalService,
  deriveArgsDigest,
  deriveDecisionId,
  deriveEffectKey,
  deriveGrantBinding,
  deriveTargetHash,
  setupMongo,
  type CandidateProposal,
  type GrantBinding,
  type MongoService,
  type Principal,
  type SetupOptions,
} from '../src/index.js';

/**
 * Shared helpers for the real-MongoDB protocol suites.
 *
 * These suites prove protocol behavior (transactions, fences, validators, unique indexes) on a local replica
 * set. They are not evidence about Atlas RBAC, Atlas Search or any invited deployment.
 */
export const TEST_URI = process.env.MONGODB_TEST_URI;
/**
 * Acceptance runs set EXPUNGE_REQUIRE_LIVE_TESTS=1. Then a missing MONGODB_TEST_URI fails every live suite
 * instead of skipping it, so "41 skipped, exit 0" can never pass for a protocol run.
 */
export const REQUIRE_LIVE_TESTS = process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1';
/**
 * A suite constructor for one URI lane. With the URI set it runs; without it it skips, unless
 * EXPUNGE_REQUIRE_LIVE_TESTS=1, in which case it registers a failing test naming the missing variable.
 */
export function liveSuite(uri: string | undefined, variable: string): typeof describe {
  return ((name: string, factory: () => void) => {
    if (uri) return describe(name, factory);
    if (!REQUIRE_LIVE_TESTS) return describe.skip(name, factory);
    return describe(name, () => {
      it(`requires ${variable} (EXPUNGE_REQUIRE_LIVE_TESTS=1)`, () => {
        throw new Error(`${variable} is not set but live suites are required`);
      });
    });
  }) as typeof describe;
}
/** Replica-set protocol lane (unauthenticated local replica set). */
export const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');
/** Authenticated local RBAC lane. Local privilege evidence only; it is not evidence about Atlas. */
export const RBAC_URI = process.env.MONGODB_RBAC_TEST_URI;
export const describeRbac = liveSuite(RBAC_URI, 'MONGODB_RBAC_TEST_URI');

export const HASH = 'a'.repeat(64);
export const actor: ActorContext = {
  actorId: 'owner',
  tenantId: 'protocol-test',
  env: 'evaluation',
  scopeId: 'scope',
  authorizationRevision: 1,
};
export const ZERO_COST = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicrousd: 0,
  unpricedCalls: 0,
  mongoOperations: 0,
  wallTimeMs: 0,
} as const;

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('TimedOutWaitingForCommittedState');
}

/** Byte equality of two BSON-serializable values, e.g. opaque change-stream resume tokens. */
export function sameBson(left: unknown, right: unknown): boolean {
  const bytes = (value: unknown) => Buffer.from(BSON.serialize(value as Document));
  return bytes(left).equals(bytes(right));
}

export type LiveEnvironment = {
  /** The setup principal: full rights on the throwaway databases, as the local test administrator. */
  service: MongoService;
  /** A client for another principal on the same throwaway databases (no auth locally, so rights are by code). */
  as(principal: Principal): Promise<MongoService>;
  /** Empties every collection but keeps validators and indexes. */
  reset(): Promise<void>;
  /** Drops the three throwaway databases and closes every client. */
  dispose(): Promise<void>;
};

/**
 * EXPUNGE_TEST_PER_PRINCIPAL=1 makes `env.as(principal)` a real, authenticated client: it creates the principal's role from
 * `atlasRoleManifests` and a user on the test server, then connects as that user, so any repository suite runs under the
 * privileges the manifest grants and nothing more. It needs an authenticated replica set (point MONGODB_TEST_URI at the
 * auth set with the administrator, e.g. the 27019 lane); on an open set every principal can do everything. Local evidence
 * only: this proves the manifest is enforceable by MongoDB, not that an Atlas custom role matches it.
 */
const PER_PRINCIPAL = process.env.EXPUNGE_TEST_PER_PRINCIPAL === '1';
const ACTION_NAMES: Record<string, string> = {
  FIND: 'find',
  INSERT: 'insert',
  UPDATE: 'update',
  REMOVE: 'remove',
  CHANGE_STREAM: 'changeStream',
};

/** Opens the setup principal against uniquely named databases so concurrent suites never collide. */
export async function openEnvironment(label: string, options?: SetupOptions): Promise<LiveEnvironment> {
  const prefix = `expunge_${label}_${randomUUID().replaceAll('-', '')}`;
  const names = {
    worldDatabase: `${prefix}_world`,
    controlDatabase: `${prefix}_control`,
    privateDatabase: `${prefix}_private`,
  };
  const others: MongoService[] = [];
  const provisioned = new Map<Principal, string>();
  const provision = async (principal: Principal): Promise<string> => {
    if (!PER_PRINCIPAL || principal === 'setup') return TEST_URI!;
    const existing = provisioned.get(principal);
    if (existing) return existing;
    const manifest = atlasRoleManifests({
      world: names.worldDatabase,
      control: names.controlDatabase,
      private: names.privateDatabase,
    })[principal];
    if (!manifest) throw new Error(`NoRoleManifest:${principal}`);
    const name = `${prefix}_${principal}`;
    const password = randomUUID();
    const admin = service.client.db('admin');
    await admin.command({
      createRole: name,
      privileges: manifest.actions.flatMap((action) =>
        action.resources.map((resource) => ({ resource, actions: [ACTION_NAMES[action.action]!] })),
      ),
      roles: [],
    });
    await admin.command({ createUser: name, pwd: password, roles: [{ role: name, db: 'admin' }] });
    const target = new URL(TEST_URI!);
    target.username = name;
    target.password = password;
    provisioned.set(principal, target.toString());
    return target.toString();
  };
  const service = createPrincipalService({ uris: { setup: TEST_URI! }, ...names }, 'setup');
  await service.client.connect();
  const hello = await service.world.command({ hello: 1 });
  expect(Boolean(hello.setName) || hello.msg === 'isdbgrid').toBe(true);
  await setupMongo(service, options);
  await installAuthority(service);
  return {
    service,
    async as(principal) {
      const other = createPrincipalService(
        { uris: { [principal]: await provision(principal) }, ...names },
        principal,
      );
      await other.client.connect();
      others.push(other);
      return other;
    },
    async reset() {
      for (const db of [service.world, service.control, service.privateDb!])
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray())
          await db.collection(name).deleteMany({});
      await installAuthority(service);
    },
    async dispose() {
      for (const other of others) await other.close();
      for (const principal of provisioned.keys()) {
        const admin = service.client.db('admin');
        await admin.command({ dropUser: `${prefix}_${principal}` }).catch(() => undefined);
        await admin.command({ dropRole: `${prefix}_${principal}` }).catch(() => undefined);
      }
      await service.world.dropDatabase();
      await service.control.dropDatabase();
      await service.privateDb!.dropDatabase();
      await service.close();
    },
  };
}

type IdDocument = Document & { _id: string };

const scopeKey = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
/** A queued cleanup job bound to a freshly created world (counter at 0, binding at scope revision 1). */
export async function createJob(
  service: MongoService,
  options: { id?: string; harnessHash?: string; contextInputs?: string[] } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  await new WorldRepository(service).create(scopeKey, `world-${id}`, 1);
  await new JobRepository(service).create(actor, {
    jobId: id,
    kind: 'cleanup',
    binding: {
      runId: `run-${id}`,
      worldId: `world-${id}`,
      harnessHash: options.harnessHash ?? HASH,
      scopeRevision: 1,
      workerProfileHash: HASH,
    },
    ...(options.contextInputs ? { contextInputs: options.contextInputs } : {}),
  });
  return id;
}

/**
 * Makes `bundle` the scope's active worker harness, as the setup administrator would: stores the artifact and
 * initializes the deployment pointer at it. Returns the bundle's hash, which a cleanup job must be pinned to.
 */
export async function deployWorker(
  service: MongoService,
  bundle: HarnessBundle = validBundle(),
): Promise<string> {
  const hash = (await new ArtifactRepository(service).insert(bundle))._id;
  await new DeploymentRepository(service).initialize(actor, 'worker', hash, 1);
  return hash;
}

/** Installs the scope's authoritative authorization row at revision 1 with the test floor hash. */
export async function installAuthority(service: MongoService, floorHash = HASH): Promise<void> {
  await new AuthorityRepository(service).install(scopeKey, floorHash, 1);
}

/** Records the gateway decision an intent claims, as the trusted gateway would before committing it. */
export async function recordDecisionFor(
  service: MongoService,
  claim: ActionIntent,
  as: ActorContext = actor,
): Promise<void> {
  await new DecisionRepository(service).record(
    as,
    {
      jobId: claim.jobId,
      runId: claim.runId,
      harnessHash: claim.harnessHash,
      stepId: claim.stepId,
      batchOrdinal: claim.batchOrdinal,
      argsDigest: claim.argsDigest,
    },
    claim.policyDecision,
  );
}

/**
 * An intent whose identity fields are derived exactly as the repository derives them. `toolCallId` models the
 * model/provider call that asked for the batch; it names the intent record but never the logical effect.
 */
export function intent(
  jobId: string,
  options: {
    stepId?: string;
    batchOrdinal?: number;
    targets?: DomainAddress[];
    effectKind?: EffectKind;
    toolCallId?: string;
    worldRevision?: number;
    /** Version each target is expected at, in target order; defaults to 1, the `_rev` fixtures start at. */
    versions?: number[];
  } = {},
): ActionIntent {
  const base = {
    jobId,
    runId: `run-${jobId}`,
    harnessHash: HASH,
    stepId: options.stepId ?? 'delete',
    approvedPlanHash: HASH,
    batchOrdinal: options.batchOrdinal ?? 0,
    targetAddresses: options.targets ?? [],
    effectKind: options.effectKind ?? ('delete' as const),
  };
  const expectedDocumentVersions = base.targetAddresses.map((address, index) => ({
    address,
    version: options.versions?.[index] ?? 1,
  }));
  const argsDigest = deriveArgsDigest({ ...base, expectedDocumentVersions });
  const policyDecision = { result: 'allow' as const, ruleIds: [], authorizationRevision: 1 };
  return {
    intentId: `intent-${options.toolCallId ?? 'call-1'}-${base.stepId}-${base.batchOrdinal}-${jobId}`,
    ...base,
    targetHash: deriveTargetHash(base.targetAddresses),
    expectedDocumentVersions,
    worldRevision: options.worldRevision ?? 0,
    policyDecision,
    effectKey: deriveEffectKey(base),
    argsDigest,
    decisionId: deriveDecisionId({ ...base, argsDigest, policyDecision }),
  };
}

/**
 * Inserts an admitting gate report and returns the digest the promoter will recompute. Omit `computedClass` to
 * model a report written before the gate recorded its classification.
 */
export async function insertGateReport(
  service: MongoService,
  ids: {
    parentHash: string;
    childHash: string;
    candidateId: string;
    reportId: string;
    computedClass?: MutationClass;
    knownAuthorityFlips?: string[];
    verdict?: GateReport['verdict'];
  },
): Promise<string> {
  const report: GateReport = {
    reportId: ids.reportId,
    candidateId: ids.candidateId,
    parentHash: ids.parentHash,
    childHash: ids.childHash,
    evaluatorHash: HASH,
    fixtureGeneratorHash: HASH,
    runtimeHash: HASH,
    workerProfileHash: HASH,
    splitManifestCommitment: HASH,
    pairedTrials: [],
    trialRowsDigest: contentHash([], 'trial-rows'),
    causalControls: {},
    knownAuthorityFlips: ids.knownAuthorityFlips ?? [],
    cost: { ...ZERO_COST },
    verdict: ids.verdict ?? 'admit',
    reasonCodes: [],
    ...(ids.computedClass ? { computedClass: ids.computedClass } : {}),
  };
  await service.control
    .collection<GateReport & IdDocument>('gate_reports')
    .insertOne({ _id: ids.reportId, ...report });
  return contentHash(report, 'gate-report');
}

/** A proposer-style candidate row: no class field, because the proposer cannot supply one. */
export function proposalOf(input: {
  candidateId: string;
  parentHash: string;
  childHash: string;
  claimedClass?: MutationClass;
}): CandidateProposal {
  return {
    candidateId: input.candidateId,
    actor: { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId },
    target: 'worker',
    parentHash: input.parentHash,
    childHash: input.childHash,
    patches: [],
    hypothesis: 'protocol test',
    sourceEvidence: [],
    claimedClass: input.claimedClass ?? 'behavioral',
    artifactHashes: [input.parentHash, input.childHash],
  };
}

/** The binding a grant for `reportId` must carry, derived from the stored gate report exactly as the repository does. */
export async function bindingFor(service: MongoService, reportId: string): Promise<GrantBinding> {
  const stored = await service.control
    .collection<GateReport & IdDocument>('gate_reports')
    .findOne({ _id: reportId });
  if (!stored) throw new Error(`no gate report ${reportId}`);
  const { _id: _ignored, ...report } = stored;
  return deriveGrantBinding(report, contentHash(report, 'gate-report'));
}

/**
 * Issues a grant for a stored gate report through the repository, with the binding derived from that report.
 * `overrides` change individual fields to build a forged grant; with `raw: true` the grant is inserted without
 * the issuer's checks, as a compromised or bypassing writer would.
 */
export async function issueGrant(
  service: MongoService,
  grant: {
    grantId: string;
    reportId: string;
    nonce: string;
    expiresAt?: Date;
    overrides?: Partial<ApprovalGrant>;
    raw?: boolean;
  },
): Promise<void> {
  const binding = await bindingFor(service, grant.reportId);
  const full: ApprovalGrant = {
    tenantId: actor.tenantId,
    env: actor.env,
    scopeId: actor.scopeId,
    target: 'worker',
    grantId: grant.grantId,
    proposalId: binding.proposalId,
    parentHash: binding.parentHash,
    childHash: binding.childHash,
    parentRevision: 0,
    approvedDescriptor: binding.approvedDescriptor,
    authorizationRevision: 1,
    scopeRevision: 1,
    flipSetDigest: binding.flipSetDigest,
    gateReportId: binding.gateReportId,
    gateReportDigest: binding.gateReportDigest,
    approverId: actor.actorId,
    expiresAt: grant.expiresAt ?? new Date(Date.now() + 100_000),
    nonce: grant.nonce,
    createdAt: new Date(),
    ...grant.overrides,
  };
  if (grant.raw) {
    await service.control.collection<IdDocument>('approvals').insertOne({ _id: grant.grantId, ...full });
    return;
  }
  await new ApprovalRepository(service).issue(actor, full);
}

/** A small valid registry for the test scope at revision 1. Fields default to none. */
export function registryOf(overrides: Partial<ScopeRegistry> = {}): ScopeRegistry {
  return {
    tenantId: actor.tenantId,
    env: actor.env,
    scopeId: actor.scopeId,
    revision: 1,
    collectionIds: ['customers'],
    fields: [],
    referenceEdges: [],
    allowedEffectKinds: ['delete', 'redact', 'restrict', 'tombstone'],
    eligibilityPolicyId: 'protocol-test-policy',
    eligibilityPolicyHash: HASH,
    documentLimits: { maxScanned: 100, maxChanged: 100 },
    discoveryCompleteness: { kind: 'declared', limitations: ['registered scope'] },
    ...overrides,
  };
}
export async function insertRegistry(service: MongoService, overrides: Partial<ScopeRegistry> = {}) {
  const registry = registryOf(overrides);
  await new ScopeRepository(service).insert(registry);
  return registry;
}
/** A receipt that exactly covers `registryOf()` at the job's bound world revision 0. */
export function completionReceipt(
  jobId: string,
  overrides: Partial<CompletionReceipt> = {},
): CompletionReceipt {
  return {
    receiptId: `receipt-${jobId}`,
    jobId,
    runId: `run-${jobId}`,
    harnessHash: HASH,
    scopeId: actor.scopeId,
    scopeRevision: 1,
    verifiedWorldRevision: 0,
    verificationPlanHash: HASH,
    inspectedCollectionIds: ['customers'],
    discoveredFieldIds: [],
    operationalResiduals: 0,
    excludedOrRetainedRecords: 0,
    limitations: ['registered scope'],
    domainStatus: 'complete_in_registered_scope',
    externalErasureStatus: 'not_required',
    ...overrides,
  };
}

/** A valid `campaign_freezes` row (the validator is strict); the hash fields are placeholders. */
export function freezeRow(campaignId: string) {
  return {
    _id: campaignId,
    campaignId,
    evaluatorHash: HASH,
    fixtureGeneratorHash: HASH,
    runtimeHash: HASH,
    compilerHash: HASH,
    workerProfileHash: HASH,
    budgetHash: HASH,
    maxAttemptsPerParent: 3,
    splitManifestCommitment: HASH,
    costCeilingMicrousd: null,
    freezeHash: HASH,
  };
}
/** A valid `gate_claims` row; its `_id` is the candidate key the gate derives. */
export function claimRow(claim: {
  campaignId: string;
  parentHash: string;
  childProjectionHash: string;
  state?: 'open' | 'held' | 'decided' | 'failed' | 'invalid';
}) {
  return {
    _id: contentHash(
      { parentHash: claim.parentHash, childProjectionHash: claim.childProjectionHash },
      'gate-candidate',
    ),
    parentHash: claim.parentHash,
    childProjectionHash: claim.childProjectionHash,
    campaignId: claim.campaignId,
    state: claim.state ?? 'open',
    ordinal: 1,
  };
}
