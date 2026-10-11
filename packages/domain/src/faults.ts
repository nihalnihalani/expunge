import { contentHash, type ScopeKey, type WorldSpec } from '@expunge/contracts';
import { ProtocolError, type MongoService } from '@expunge/mongo';
import { ToolRefusal, type ToolRuntime } from './runtime.js';

/** The fault plan a WorldSpec declares: acknowledgements lost after commit, one interruption, transient failures. */
export type FaultPlan = WorldSpec['faults'];

/**
 * Where the plan of a campaign world comes from. It is trusted stored data written by the fixture builder or setup
 * when the world is seeded; nothing the model sends, and nothing in the job, can add, change or remove it.
 */
export interface FaultSource {
  read(scope: ScopeKey, worldId: string): Promise<{ plan: FaultPlan; planHash: string } | null>;
}

export type StoredFaultPlan = ScopeKey & {
  _id: string;
  worldId: string;
  plan: FaultPlan;
  planHash: string;
  createdAt: Date;
};
const scopeOf = (scope: ScopeKey): ScopeKey => ({
  tenantId: scope.tenantId,
  env: scope.env,
  scopeId: scope.scopeId,
});
export const faultPlanHash = (scope: ScopeKey, worldId: string, plan: FaultPlan): string =>
  contentHash({ ...scopeOf(scope), worldId, plan }, 'world-fault-plan');
/** The row a seeder writes into `world_faults` for a campaign world. */
export function storedFaultPlan(scope: ScopeKey, worldId: string, plan: FaultPlan): StoredFaultPlan {
  return {
    _id: worldId,
    ...scopeOf(scope),
    worldId,
    plan,
    planHash: faultPlanHash(scope, worldId, plan),
    createdAt: new Date(),
  };
}

/** Reads `world_faults`. A row whose hash does not match its content is refused, so a tampered plan fails closed. */
export class MongoFaultSource implements FaultSource {
  constructor(private readonly service: MongoService) {}
  async read(scope: ScopeKey, worldId: string): Promise<{ plan: FaultPlan; planHash: string } | null> {
    const row = await this.service.control
      .collection<StoredFaultPlan>('world_faults')
      .findOne({ _id: worldId, ...scopeOf(scope) });
    if (!row) return null;
    if (row.worldId !== worldId || row.planHash !== faultPlanHash(row, worldId, row.plan))
      throw new ProtocolError('FaultPlanTampered');
    return { plan: row.plan, planHash: row.planHash };
  }
}
/** A source for tests that need no database: plans by world id. */
export class InMemoryFaultSource implements FaultSource {
  constructor(private readonly plans: ReadonlyMap<string, FaultPlan>) {}
  async read(scope: ScopeKey, worldId: string): Promise<{ plan: FaultPlan; planHash: string } | null> {
    const plan = this.plans.get(worldId);
    return plan ? { plan, planHash: faultPlanHash(scope, worldId, plan) } : null;
  }
}

const plans = new WeakMap<object, Promise<FaultPlan | null>>();
/**
 * The run's plan, read once per run context, and ONLY for a campaign world (its stored binding names a campaign). A
 * production world never queries `world_faults`, so a deployment without that collection or its grant is unaffected.
 * On a campaign world the plan that applies (its stored hash, or `null` when no row exists) is attested once per job in
 * the fenced step log, so a campaign can compare it with the plan the trial declared: a missing row is visible as an
 * attested `null`, never silently "no faults". An environment may inject a `faults` source; the default is Mongo.
 */
function planFor(rt: ToolRuntime): Promise<FaultPlan | null> {
  let found = plans.get(rt.run);
  if (!found) {
    found = (async () => {
      if ((await rt.env.worlds.campaignOf(rt.actor, rt.run.worldId)) === null) return null;
      const injected = (rt.env as { faults?: FaultSource }).faults;
      const source = injected ?? new MongoFaultSource(rt.env.service);
      const stored = await source.read(rt.actor, rt.run.worldId);
      if ((await consumed(rt, 'attest')) === 0)
        await rt.store.appendStep(
          rt.actor,
          rt.run,
          'fault',
          { kind: 'attest', batchOrdinal: 0, planHash: stored?.planHash ?? null },
          await rt.worldRevision(),
        );
      return stored?.plan ?? null;
    })();
    plans.set(rt.run, found);
  }
  return found;
}

type FaultKind = 'transient' | 'lost_ack' | 'interrupt' | 'attest';
const consumed = (rt: ToolRuntime, kind: FaultKind, batchOrdinal?: number) =>
  rt.env.store.countSteps(rt.actor, rt.job._id, 'fault', {
    kind,
    ...(batchOrdinal === undefined ? {} : { batchOrdinal }),
  });
/** Records a fault as spent BEFORE it takes effect, in the fenced step log, so no takeover can spend it twice. */
async function spend(rt: ToolRuntime, kind: FaultKind, batchOrdinal: number): Promise<void> {
  await rt.store.appendStep(rt.actor, rt.run, 'fault', { kind, batchOrdinal }, await rt.worldRevision());
}

/** The process dies after the lease is given up: the holder stops, and a takeover resumes from committed state. */
async function interrupt(rt: ToolRuntime, batchOrdinal: number): Promise<never> {
  await spend(rt, 'interrupt', batchOrdinal);
  await rt.env.jobs.release(rt.actor, rt.lease);
  throw new ProtocolError('LostLease');
}
async function interruptionDue(rt: ToolRuntime, plan: FaultPlan): Promise<boolean> {
  if (plan.interruptAfterEffects === null) return false;
  if ((await consumed(rt, 'interrupt')) > 0) return false;
  return (await rt.env.store.committedEffectCount(rt.actor, rt.job._id)) >= plan.interruptAfterEffects;
}

/**
 * Before a batch is committed: an interruption that is already due, or a transient failure. Nothing has been written
 * when it throws; the tool call ends `retryable_error`. A replay of a committed batch never reaches this.
 */
export async function injectBeforeCommit(rt: ToolRuntime, batchOrdinal: number): Promise<void> {
  const plan = await planFor(rt);
  if (!plan) return;
  if (await interruptionDue(rt, plan)) await interrupt(rt, batchOrdinal);
  if ((await consumed(rt, 'transient')) < plan.transientFailures) {
    await spend(rt, 'transient', batchOrdinal);
    throw new ToolRefusal('TransientFault');
  }
}

/**
 * After a batch committed: the run is interrupted once `interruptAfterEffects` effects have committed, or the
 * acknowledgement is lost (the caller sees an error although the effect is committed). A retry of that batch finds
 * the committed effect and returns the saved receipt, so each effect happens exactly once.
 */
export async function injectAfterCommit(rt: ToolRuntime, batchOrdinal: number): Promise<void> {
  const plan = await planFor(rt);
  if (!plan) return;
  if (await interruptionDue(rt, plan)) await interrupt(rt, batchOrdinal);
  if (
    (await consumed(rt, 'lost_ack')) < plan.partialAcknowledgements &&
    (await consumed(rt, 'lost_ack', batchOrdinal)) === 0
  ) {
    await spend(rt, 'lost_ack', batchOrdinal);
    throw new ToolRefusal('AcknowledgementLost');
  }
}
