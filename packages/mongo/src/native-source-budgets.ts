import type { ClientSession } from 'mongodb';
import {
  contentHash,
  nativeRegistrationHash,
  type ActorContext,
  type NativeSourceRegistration,
  type ResourceLimits,
  type ScopeKey,
} from '@expunge/contracts';
import { ArtifactRepository } from './artifacts.js';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';
import { NativeSourceRepository } from './native-source-registry.js';
import type { LeaseBinding } from './jobs.js';

export type NativeRuntimeBudgetProfile = {
  _id: string;
  spec: string;
  pricing: { inputMicrousdPerMillion?: number; outputMicrousdPerMillion?: number };
  limits: ResourceLimits;
  runtimeHash: string;
  profileDigest: string;
  createdAt: Date;
};
export type NativeRuntimeBudgetProfileInput = Pick<
  NativeRuntimeBudgetProfile,
  'spec' | 'pricing' | 'limits' | 'runtimeHash'
>;
export type NativeBudgetCaps = {
  scanned: number;
  changed: number;
  operations: number;
  hops: number;
  nodes: number;
  edges: number;
};
export function nativeRuntimeBudgetProfileHash(
  input: Pick<NativeRuntimeBudgetProfile, 'spec' | 'pricing' | 'limits' | 'runtimeHash'>,
): string {
  return contentHash(
    { spec: input.spec, pricing: input.pricing, limits: input.limits, runtimeHash: input.runtimeHash },
    'native-runtime-budget-profile-v2',
  );
}
export type NativeBudgetState = ScopeKey & {
  _id: string;
  jobId: string;
  sourceId: string;
  registrationHash: string;
  harnessHash: string;
  workerProfileHash: string;
  profileDigest: string;
  caps: NativeBudgetCaps;
  scannedReserved: number;
  changed: number;
  operations: number;
  revision: number;
  updatedAt: Date;
};
const counters = [
  'modelCalls',
  'toolCalls',
  'scannedDocuments',
  'changedDocuments',
  'traversalDepth',
  'graphNodes',
  'graphEdges',
  'wallTimeMs',
  'totalTokens',
  'maxCostMicrousd',
] as const;
function assertLimits(limits: ResourceLimits): void {
  for (const key of counters)
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) fail('NativeBudgetProfileInvalid');
  if (limits.toolCalls < 1 || limits.scannedDocuments < 1 || limits.graphNodes < 1)
    fail('NativeBudgetProfileInvalid');
}

const profileKeys = new Set([
  '_id',
  'spec',
  'pricing',
  'limits',
  'runtimeHash',
  'profileDigest',
  'createdAt',
]);
const pricingKeys = new Set(['inputMicrousdPerMillion', 'outputMicrousdPerMillion']);
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Explicit deep capture excludes caller-supplied identity/metadata and detaches all immutable profile fields. */
export function captureNativeRuntimeBudgetProfile(
  input: NativeRuntimeBudgetProfileInput,
): NativeRuntimeBudgetProfileInput {
  if (!plainRecord(input) || !plainRecord(input.pricing) || !plainRecord(input.limits))
    fail('NativeBudgetProfileInvalid');
  const captured = Object.freeze({
    spec: input.spec,
    pricing: Object.freeze({
      inputMicrousdPerMillion: input.pricing.inputMicrousdPerMillion,
      outputMicrousdPerMillion: input.pricing.outputMicrousdPerMillion,
    }),
    limits: Object.freeze({
      modelCalls: input.limits.modelCalls,
      toolCalls: input.limits.toolCalls,
      scannedDocuments: input.limits.scannedDocuments,
      changedDocuments: input.limits.changedDocuments,
      traversalDepth: input.limits.traversalDepth,
      graphNodes: input.limits.graphNodes,
      graphEdges: input.limits.graphEdges,
      wallTimeMs: input.limits.wallTimeMs,
      totalTokens: input.limits.totalTokens,
      maxCostMicrousd: input.limits.maxCostMicrousd,
    }),
    runtimeHash: input.runtimeHash,
  });
  assertLimits(captured.limits);
  if (
    typeof captured.spec !== 'string' ||
    captured.spec.length > 256 ||
    !/^(openai|anthropic)\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(captured.spec) ||
    typeof captured.runtimeHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(captured.runtimeHash) ||
    !Number.isSafeInteger(captured.pricing.inputMicrousdPerMillion) ||
    captured.pricing.inputMicrousdPerMillion! < 0 ||
    !Number.isSafeInteger(captured.pricing.outputMicrousdPerMillion) ||
    captured.pricing.outputMicrousdPerMillion! < 0
  )
    fail('NativeBudgetProfileInvalid');
  return captured;
}

/** Replays and execution revalidate the full stored schema and recompute both immutable v2 identities. */
export function decodeNativeRuntimeBudgetProfile(
  input: unknown,
  expectedId?: string,
): NativeRuntimeBudgetProfile {
  if (
    !plainRecord(input) ||
    Object.keys(input).some((key) => !profileKeys.has(key)) ||
    !plainRecord(input.pricing) ||
    Object.keys(input.pricing).some((key) => !pricingKeys.has(key)) ||
    !plainRecord(input.limits) ||
    Object.keys(input.limits).some((key) => !counters.some((counter) => counter === key)) ||
    typeof input._id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input._id) ||
    typeof input.profileDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.profileDigest) ||
    !(input.createdAt instanceof Date) ||
    !Number.isFinite(input.createdAt.getTime())
  )
    fail('NativeBudgetProfileCorrupt');
  let captured: NativeRuntimeBudgetProfileInput;
  try {
    captured = captureNativeRuntimeBudgetProfile(input as NativeRuntimeBudgetProfileInput);
  } catch {
    fail('NativeBudgetProfileCorrupt');
  }
  const digest = nativeRuntimeBudgetProfileHash(captured);
  if (
    input._id !== digest ||
    input.profileDigest !== digest ||
    (expectedId !== undefined && expectedId !== digest)
  )
    fail('NativeBudgetProfileCorrupt');
  return {
    _id: digest,
    spec: captured.spec,
    pricing: captured.pricing,
    limits: captured.limits,
    runtimeHash: captured.runtimeHash,
    profileDigest: digest,
    createdAt: new Date(input.createdAt.getTime()),
  };
}
export function deriveNativeBudgetCaps(
  source: NativeSourceRegistration,
  harness: ResourceLimits,
  profile: ResourceLimits,
): NativeBudgetCaps {
  assertLimits(harness);
  assertLimits(profile);
  return {
    scanned: Math.min(source.limits.maxTotalScanned, harness.scannedDocuments, profile.scannedDocuments),
    changed: Math.min(source.limits.maxTotalChanged, harness.changedDocuments, profile.changedDocuments),
    operations: Math.min(source.limits.maxOperations, harness.toolCalls, profile.toolCalls),
    hops: Math.min(source.limits.maxHops, harness.traversalDepth, profile.traversalDepth),
    nodes: Math.min(source.limits.maxScanned, harness.graphNodes, profile.graphNodes),
    edges: Math.min(harness.graphEdges, profile.graphEdges),
  };
}
export function nextNativeBudget(
  state: Pick<NativeBudgetState, 'caps' | 'scannedReserved' | 'changed' | 'operations'>,
  charge: { scanned?: number; changed?: number; operations?: number },
): Pick<NativeBudgetState, 'scannedReserved' | 'changed' | 'operations'> {
  for (const amount of Object.values(charge))
    if (!Number.isSafeInteger(amount) || amount < 0) fail('NativeBudgetChargeInvalid');
  const next = {
    scannedReserved: state.scannedReserved + (charge.scanned ?? 0),
    changed: state.changed + (charge.changed ?? 0),
    operations: state.operations + (charge.operations ?? 0),
  };
  if (
    next.scannedReserved > state.caps.scanned ||
    next.changed > state.caps.changed ||
    next.operations > state.caps.operations
  )
    fail('NativeJobBudgetExceeded');
  return next;
}

/** Immutable profile installation belongs to trusted setup; a caller/model cannot supply its execution ceilings. */
export async function installNativeRuntimeBudgetProfile(
  service: MongoService,
  input: NativeRuntimeBudgetProfileInput,
): Promise<NativeRuntimeBudgetProfile> {
  requirePrincipal(service, ['setup']);
  const captured = captureNativeRuntimeBudgetProfile(input);
  const _id = nativeRuntimeBudgetProfileHash(captured);
  const profileDigest = _id;
  const rows = service.control.collection<NativeRuntimeBudgetProfile>('native_source_runtime_profiles');
  const saved = await rows.findOne({ _id });
  if (saved) return decodeNativeRuntimeBudgetProfile(saved, _id);
  const row: NativeRuntimeBudgetProfile = {
    _id,
    spec: captured.spec,
    pricing: captured.pricing,
    limits: captured.limits,
    runtimeHash: captured.runtimeHash,
    profileDigest,
    createdAt: new Date(),
  };
  await rows.insertOne(row);
  return row;
}

export class NativeSourceBudgetRepository {
  readonly registry: NativeSourceRepository;
  constructor(readonly service: MongoService) {
    this.registry = new NativeSourceRepository(service);
  }
  private get rows() {
    return this.service.control.collection<NativeBudgetState>('native_source_budgets');
  }
  private async state(
    actor: ActorContext,
    lease: LeaseBinding,
    source: NativeSourceRegistration,
    session: ClientSession,
  ): Promise<NativeBudgetState> {
    const job = await this.registry.jobs.readAuthorized(actor, lease.jobId, session);
    const harness = await new ArtifactRepository(this.service).readPermitted(
      actor,
      job.binding.harnessHash,
      session,
    );
    const rawProfile = await this.service.control
      .collection<NativeRuntimeBudgetProfile>('native_source_runtime_profiles')
      .findOne({ _id: job.binding.workerProfileHash }, { session });
    if (!rawProfile) fail('NativeRuntimeProfileUnregistered');
    const profile = decodeNativeRuntimeBudgetProfile(rawProfile, job.binding.workerProfileHash);
    const runtime =
      job.checkpoint && typeof job.checkpoint === 'object' && !Array.isArray(job.checkpoint)
        ? job.checkpoint.attestedRuntimeHash
        : undefined;
    if (typeof runtime !== 'string' || runtime !== profile.runtimeHash)
      fail('NativeRuntimeProfileAttestationMissingOrMismatched');
    const caps = deriveNativeBudgetCaps(source, harness.payload.limits, profile.limits);
    const saved = await this.rows.findOne({ _id: lease.jobId, ...scopeFilter(actor) }, { session });
    if (saved) {
      if (
        saved.registrationHash !== nativeRegistrationHash(source) ||
        saved.harnessHash !== job.binding.harnessHash ||
        saved.workerProfileHash !== profile._id ||
        saved.profileDigest !== profile.profileDigest ||
        contentHash(saved.caps, 'native-budget-caps-v2') !== contentHash(caps, 'native-budget-caps-v2')
      )
        fail('NativeBudgetBindingChanged');
      return saved;
    }
    const row: NativeBudgetState = {
      _id: lease.jobId,
      ...scopeFilter(actor),
      jobId: lease.jobId,
      sourceId: source.sourceId,
      registrationHash: nativeRegistrationHash(source),
      harnessHash: job.binding.harnessHash,
      workerProfileHash: profile._id,
      profileDigest: profile.profileDigest,
      caps,
      scannedReserved: 0,
      changed: 0,
      operations: 0,
      revision: 0,
      updatedAt: new Date(),
    };
    await this.rows.insertOne(row, { session });
    return row;
  }
  private async charge(
    actor: ActorContext,
    lease: LeaseBinding,
    source: NativeSourceRegistration,
    amounts: { scanned?: number; changed?: number; operations?: number },
    session: ClientSession,
  ): Promise<NativeBudgetState> {
    const state = await this.state(actor, lease, source, session);
    const next = nextNativeBudget(state, amounts);
    const result = await this.rows.updateOne(
      { _id: lease.jobId, ...scopeFilter(actor), revision: state.revision },
      { $set: next, $inc: { revision: 1 }, $currentDate: { updatedAt: true } },
      { session },
    );
    if (result.matchedCount !== 1) fail('NativeBudgetConcurrentUpdate');
    return { ...state, ...next, revision: state.revision + 1 };
  }
  async beginOperation(
    actor: ActorContext,
    lease: LeaseBinding,
    source: NativeSourceRegistration,
  ): Promise<NativeBudgetState> {
    return this.service.transaction(async (session) => {
      await this.registry.fence(actor, lease, nativeRegistrationHash(source), session);
      return this.charge(actor, lease, source, { operations: 1 }, session);
    });
  }
  /** Reserve before EACH source transaction callback invocation. Failed/retried scans keep their reservations. */
  async reserveScan(
    actor: ActorContext,
    lease: LeaseBinding,
    source: NativeSourceRegistration,
    requested: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(requested) || requested < 1) fail('NativeBudgetChargeInvalid');
    return this.service.transaction(async (session) => {
      await this.registry.fence(actor, lease, nativeRegistrationHash(source), session);
      const state = await this.state(actor, lease, source, session);
      const allowance = Math.min(requested, state.caps.scanned - state.scannedReserved);
      if (allowance < 1) fail('NativeJobBudgetExceeded');
      await this.charge(actor, lease, source, { scanned: allowance }, session);
      return allowance;
    });
  }
  async chargeCommittedChanges(
    actor: ActorContext,
    lease: LeaseBinding,
    source: NativeSourceRegistration,
    count: number,
    session: ClientSession,
  ): Promise<void> {
    await this.charge(actor, lease, source, { changed: count }, session);
  }
}
