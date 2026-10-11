import type {
  ActorContext,
  CostSummary,
  HarnessBundle,
  ResourceLimits,
  RunBinding,
  ScopeKey,
  WorldSpec,
} from '@expunge/contracts';
import { storedFaultPlan } from '@expunge/domain';
import { COLLECTION_IDS, type VisibleWorld } from '@expunge/fixtures';
import {
  ArtifactRepository,
  JobRepository,
  ScopeRepository,
  WorldRepository,
  type MongoService,
} from '@expunge/mongo';
import type { EpisodePort, EpisodeRequest, EpisodeResult, WorkerProfile } from './types.js';
import { ZERO_COST } from './types.js';

/**
 * The gate-side port over the real worker and domain path. It seeds the instance's world (fixture_builder), stores the
 * instance's fault plan, hands the run to the worker-side runner (`WorkerEpisodeRunner` in apps/worker, which drives the
 * real Dispatcher and the real domain tools and reads the run back from COMMITTED state at majority), then reads the
 * world back as the grader. The model is whatever the worker was built with: a FAKE model makes the profile `fake` and
 * the gate holds.
 *
 * Types below are structural copies of the worker's `EpisodeRequest`, `SeededInstance` and `EpisodeResult`; the gate
 * does not import `apps/worker` (it would put the evaluator beside runtime code).
 */
export type SeededInstance = {
  actor: ActorContext;
  worldId: string;
  collectionIds: string[];
  scopeRevision: number;
  subjectHandle: string;
};
export type WorkerRunRequest = {
  campaignId: string;
  runId: string;
  instanceId: string;
  bundle: HarnessBundle;
  bundleHash: string;
  profile: WorkerProfile;
  limits: ResourceLimits;
  faults: WorldSpec['faults'];
  signal: AbortSignal;
};
export type WorkerRunResult = {
  outcome: EpisodeResult['outcome'];
  failureCode?: string;
  jobId?: string;
  terminal: EpisodeResult['terminal'];
  runtimeHash?: string;
  receipt?: EpisodeResult['receipt'];
  retryFailures: number;
  cost: CostSummary;
};
export interface WorkerRunner {
  run(request: WorkerRunRequest, instance: SeededInstance): Promise<WorkerRunResult>;
}

/** The privileged half the runner needs, on the grader and fixture-builder principals (never setup). */
export interface EpisodeHost {
  pinBundle(instance: SeededInstance, bundle: HarnessBundle, bundleHash: string): Promise<void>;
  createJob(
    instance: SeededInstance,
    job: { jobId: string; binding: Omit<RunBinding, 'jobId'> },
    subjectHandle: string,
  ): Promise<void>;
}
export class GraderEpisodeHost implements EpisodeHost {
  constructor(
    private readonly deps: {
      grader: MongoService;
      subjects: {
        putSubject(
          actor: ActorContext,
          jobId: string,
          subject: { idType: 'string'; value: string },
        ): Promise<unknown>;
      };
    },
  ) {}
  /** Permits the artifact for this campaign's scope only: parent or exact child of the open claim, nothing else. */
  async pinBundle(instance: SeededInstance, _bundle: HarnessBundle, bundleHash: string): Promise<void> {
    const { grader } = this.deps;
    const campaignId = await new WorldRepository(grader).campaignOf(instance.actor, instance.worldId);
    if (!campaignId) throw Object.assign(new Error('NotCampaignWorld'), { name: 'NotCampaignWorld' });
    await new ArtifactRepository(grader).permitForCampaign(instance.actor, campaignId, bundleHash);
  }
  async createJob(
    instance: SeededInstance,
    job: { jobId: string; binding: Omit<RunBinding, 'jobId'> },
    subjectHandle: string,
  ): Promise<void> {
    const { grader, subjects } = this.deps;
    const campaignId = await new WorldRepository(grader).campaignOf(instance.actor, instance.worldId);
    if (!campaignId) throw Object.assign(new Error('NotCampaignWorld'), { name: 'NotCampaignWorld' });
    await new JobRepository(grader).createCampaignJob(instance.actor, {
      jobId: job.jobId,
      kind: 'cleanup',
      campaignId,
      binding: job.binding,
    });
    await subjects.putSubject(instance.actor, job.jobId, { idType: 'string', value: subjectHandle });
  }
}

export type MongoPortDeps = {
  grader: MongoService;
  builder: MongoService;
  runner: WorkerRunner;
  /**
   * Installs the instance scope's authorization row. Today only `setup` can (AuthorityRepository.install); a campaign
   * deployment must provide an installer restricted to campaign scopes (evaluation env, no production deployment).
   */
  installAuthority(scope: ScopeKey, floorHash: string): Promise<void>;
  floorHash: string;
  profile: WorkerProfile;
  /** Keep the instance's world after the run (default). Dropping is the campaign's retention choice. */
  label?: string;
};

export class MongoEpisodePort implements EpisodePort {
  readonly kind = 'worker' as const;
  readonly label: string;
  readonly profile: WorkerProfile;
  constructor(private readonly deps: MongoPortDeps) {
    this.profile = deps.profile;
    this.label =
      deps.label ??
      (deps.profile.modelKind === 'fake'
        ? 'REAL worker/domain path with a FAKE model (protocol evidence only)'
        : 'REAL worker/domain path with a provider model');
  }

  async run(request: EpisodeRequest): Promise<EpisodeResult> {
    const { builder, grader } = this.deps;
    const { world } = request;
    const scope = request.instanceScope;
    const actor: ActorContext = { ...scope, actorId: 'owner', authorizationRevision: 1 };
    try {
      await this.deps.installAuthority(scope, this.deps.floorHash);
      await new ScopeRepository(builder).insert(world.scope);
      await new WorldRepository(builder).create(scope, world.worldId, world.scope.revision, {
        campaignId: request.campaignId,
      });
      for (const id of COLLECTION_IDS)
        if (world.collections[id].length)
          await builder.world.collection(id).insertMany(structuredClone(world.collections[id]) as never[]);
      await builder.control
        .collection('world_faults')
        .insertOne(storedFaultPlan(scope, world.worldId, request.faults) as never);
    } catch (error) {
      return setupFailure(error);
    }
    const instance: SeededInstance = {
      actor,
      worldId: world.worldId,
      collectionIds: [...world.scope.collectionIds],
      scopeRevision: world.scope.revision,
      subjectHandle: world.subjectHandle,
    };
    const ran = await this.deps.runner
      .run(
        {
          campaignId: request.campaignId,
          runId: request.runId,
          instanceId: request.instanceId,
          bundle: request.bundle,
          bundleHash: request.bundleHash,
          profile: request.profile,
          limits: request.limits,
          faults: request.faults,
          signal: request.signal,
        },
        instance,
      )
      .catch(() => failed('RunnerFailed'));
    // The world as committed state holds it, read by the grader principal.
    let readback: VisibleWorld | null = null;
    let faults: EpisodeResult['faults'];
    try {
      readback = await readWorld(grader, world);
      faults = ran.jobId ? await readFaults(grader, scope, ran.jobId) : undefined;
    } catch {
      readback = null;
    }
    if (!readback)
      return {
        outcome: 'failed',
        failureCode: 'CommittedStateUnreadable',
        ...(ran.jobId ? { jobId: ran.jobId } : {}),
        terminal: { status: 'incomplete', claim: 'registered_scope' },
        retryFailures: ran.retryFailures,
        cost: ran.cost,
        world: null,
        evidence: 'committed',
      };
    return {
      outcome: ran.outcome,
      ...(ran.failureCode ? { failureCode: ran.failureCode } : {}),
      ...(ran.jobId ? { jobId: ran.jobId } : {}),
      terminal: ran.terminal,
      ...(ran.runtimeHash ? { runtimeHash: ran.runtimeHash } : {}),
      ...(ran.receipt ? { receipt: ran.receipt } : {}),
      retryFailures: ran.retryFailures,
      cost: ran.cost,
      world: readback,
      evidence: 'committed',
      ...(faults ? { faults } : {}),
    };
  }
}

const failed = (code: string): WorkerRunResult => ({
  outcome: 'failed',
  failureCode: code,
  terminal: { status: 'incomplete', claim: 'registered_scope' },
  retryFailures: 0,
  cost: { ...ZERO_COST },
});
function setupFailure(error: unknown): EpisodeResult {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'SetupFailed';
  const code = name === 'Error' || name === 'MongoServerError' ? 'SetupFailed' : name;
  return {
    outcome: 'failed',
    failureCode: code,
    terminal: { status: 'incomplete', claim: 'registered_scope' },
    retryFailures: 0,
    cost: { ...ZERO_COST },
    world: null,
    evidence: 'committed',
  };
}

/** The committed world: the initial world's registry and schema (a cleanup never edits them) over the stored records. */
export async function readWorld(grader: MongoService, initial: VisibleWorld): Promise<VisibleWorld> {
  const majority = { readConcern: { level: 'majority' as const } };
  const collections = {} as VisibleWorld['collections'];
  for (const id of COLLECTION_IDS)
    collections[id] = (await grader.world
      .collection(id)
      .find({ worldId: initial.worldId, tenantId: initial.scope.tenantId, env: initial.scope.env }, majority)
      .sort({ _id: 1 })
      .toArray()) as unknown as VisibleWorld['collections'][typeof id];
  return { ...structuredClone(initial), collections };
}

/** What the domain gateway attested and spent for this job, from its fenced step log. */
export async function readFaults(
  grader: MongoService,
  scope: ScopeKey,
  jobId: string,
): Promise<NonNullable<EpisodeResult['faults']>> {
  const steps = grader.control.collection<{ payload: { kind: string; planHash?: string | null } }>(
    'domain_steps',
  );
  const filter = { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, jobId, kind: 'fault' };
  const rows = await steps.find(filter, { readConcern: { level: 'majority' } }).toArray();
  const count = (kind: string) => rows.filter((row) => row.payload.kind === kind).length;
  const attest = rows.find((row) => row.payload.kind === 'attest');
  return {
    attestedPlanHash: attest ? (attest.payload.planHash ?? null) : null,
    injected: { transient: count('transient'), lostAck: count('lost_ack'), interrupted: count('interrupt') },
  };
}
