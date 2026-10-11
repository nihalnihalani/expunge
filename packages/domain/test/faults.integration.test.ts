import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createWorldSpec, type FixtureFamily } from '../../fixtures/src/index.js';
import { gradeWorld, runReference } from '../../grader/src/index.js';
import { describeLive } from '../../mongo/test/support.js';
import { batchesOf } from '../src/index.js';
import { faultPlanHash, storedFaultPlan, type FaultPlan, type FaultSource } from '../src/faults.js';
import {
  SCRIPTED_DRIVER_LABEL,
  attempt,
  canonical,
  byId,
  openRig,
  toolsFor,
  type OpenRun,
  type Rig,
  type Seeded,
  type Step,
  type Tools,
} from './rig.js';

/**
 * The WorldSpec fault plan on the REAL gateway path (DA-5 P2-1): a transient failure before commit, a lost
 * acknowledgement after commit, an interruption after N effects with a takeover. The plan comes from a stored row
 * (`world_faults`) bound to the world; the driver below is a labeled fake that only retries what an agent would retry.
 * ${SCRIPTED_DRIVER_LABEL}.
 */
describeLive(`faults on the domain path, campaign worlds only (${SCRIPTED_DRIVER_LABEL})`, () => {
  let rig: Rig;
  const control = (name: string) => rig.env.service.control.collection(name);
  const faultRows = (jobId: string, kind: string) =>
    control('domain_steps').countDocuments({ jobId, kind: 'fault', 'payload.kind': kind });

  beforeAll(async () => {
    rig = await openRig('faults');
  }, 60000);
  beforeEach(() => rig.env.reset());
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 60000);

  /** `campaign: false` leaves the world as a production world; a campaign world is one whose stored binding names a campaign. */
  async function seedWith(
    family: FixtureFamily,
    plan: FaultPlan | 'spec' | null,
    options: { campaign?: boolean } = {},
  ): Promise<Seeded> {
    const seeded = await rig.seed(family);
    if (options.campaign ?? true)
      await rig.env.service.world
        .collection('world_scope_bindings')
        .updateOne({ _id: seeded.world.worldId as never }, { $set: { campaignId: 'campaign-faults' } });
    if (plan !== null) {
      const faults = plan === 'spec' ? createWorldSpec({ family, seed: `domain-${family}` }).faults : plan;
      await control('world_faults').insertOne(
        storedFaultPlan(seeded.binding, seeded.world.worldId, faults) as never,
      );
    }
    return seeded;
  }
  const attested = async (jobId: string) =>
    (await control('domain_steps').find({ jobId, kind: 'fault', 'payload.kind': 'attest' }).toArray()).map(
      (row) => (row.payload as { planHash: string | null }).planHash,
    );

  /** An agent that retries what it should: the same call after a transient failure, the committed batch after a lost acknowledgement, and the interrupted batch after a takeover. */
  async function drive(seeded: Seeded, run: OpenRun, kind: 'expert' | 'w0') {
    const trace: Step[] = [];
    let tools: Tools = run.tools;
    const committed = () => control('effects').countDocuments({ jobId: run.jobId });
    for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
      trace.push(await attempt(tools, tool));
    let replay: number | null = null;
    for (let guard = 0; guard < 24; guard++) {
      const step = await attempt(tools, 'apply_cleanup_batch', replay === null ? {} : { batch: replay });
      trace.push(step);
      if (step.ok) {
        replay = null;
        if (step.result.batchesRemaining === 0) break;
        continue;
      }
      if (step.code === 'TransientFault') continue;
      if (step.code === 'AcknowledgementLost') {
        replay = (await committed()) - 1;
        continue;
      }
      if (step.code === 'LostLease') {
        const job = await rig.domain.jobs.claim(seeded.actor, run.jobId, 'worker-2', 120_000);
        if (!job) throw new Error('takeover claim failed');
        tools = await toolsFor(rig.domain, {
          ...run.context,
          job,
          lease: { jobId: run.jobId, ownerId: 'worker-2', fence: job.lease.fence },
        });
        replay = (await committed()) - 1;
        continue;
      }
      break;
    }
    if (kind === 'expert') trace.push(await attempt(tools, 'verify_registered_scope'));
    trace.push(await attempt(tools, 'complete_cleanup'));
    return trace;
  }

  const brief = (trace: Step[]) =>
    JSON.stringify(trace.map((step) => [step.tool, step.ok ? 'ok' : (step as { code: string }).code]));
  const batchCount = async (seeded: Seeded, run: OpenRun) => {
    const plan = (await rig.domain.store.latestPlan(seeded.actor, run.jobId, `run-${run.jobId}`))!;
    return batchesOf(seeded.world.scope, plan.targets).length;
  };
  /** Every committed effect has exactly one saved receipt, and the effect keys are distinct. */
  async function receiptsAreExact(run: OpenRun, batches: number) {
    const effects = await control('effects').find({ jobId: run.jobId }).toArray();
    expect(effects).toHaveLength(batches);
    expect(new Set(effects.map((effect) => effect.effectKey)).size).toBe(batches);
    const receipts = await control('action_receipts').find({ jobId: run.jobId }).toArray();
    expect(receipts).toHaveLength(batches);
    expect(receipts.every((receipt) => receipt.status === 'committed')).toBe(true);
    expect(new Set(receipts.map((receipt) => receipt.receiptId)).size).toBe(batches);
  }
  const decisionsOf = async (seeded: Seeded, run: OpenRun) =>
    rig.domain.ledger.list(seeded.actor, run.jobId, 200);

  for (const kind of ['expert', 'w0'] as const) {
    it(`${kind} on partial_retry with the stored fault plan ACTIVE: every fault fires, each effect happens once, receipts are exact`, async () => {
      const seeded = await seedWith('partial_retry', 'spec');
      const run = await rig.open(seeded, kind);
      const trace = await drive(seeded, run, kind);
      expect(trace.at(-1), brief(trace)).toMatchObject({ tool: 'complete_cleanup', ok: true });

      // The plan that applied is attested once, takeover included, so a campaign can compare it with its trial.
      expect(await attested(run.jobId)).toEqual([
        faultPlanHash(
          seeded.binding,
          seeded.world.worldId,
          createWorldSpec({ family: 'partial_retry', seed: 'domain-partial_retry' }).faults,
        ),
      ]);
      // The plan was realized, not merely stored.
      expect(await faultRows(run.jobId, 'transient'), brief(trace)).toBe(1);
      // W0's shallow context plans fewer batches, and an interruption after N effects needs N batches to commit.
      const batches = await batchCount(seeded, run);
      expect(await faultRows(run.jobId, 'lost_ack')).toBeGreaterThanOrEqual(1);
      expect(await faultRows(run.jobId, 'interrupt')).toBe(batches >= 2 ? 1 : 0);
      expect(trace.filter((step) => !step.ok).map((step) => (step as { code: string }).code)).toEqual(
        expect.arrayContaining([
          'TransientFault',
          'AcknowledgementLost',
          ...(batches >= 2 ? ['LostLease'] : []),
        ]),
      );

      // retryable_error rode the apply self-edge: it advanced, no call was refused by the workflow, and the controls
      // never saw a violation.
      const workflow = (
        await control('domain_steps').find({ jobId: run.jobId, kind: 'workflow' }).toArray()
      ).map((row) => row.payload as { nodeId: string | null; callOutcome: string; advanced: boolean });
      expect(workflow.filter((row) => row.callOutcome === 'retryable_error')).toEqual(
        expect.arrayContaining([expect.objectContaining({ nodeId: 'apply', advanced: true })]),
      );
      expect((await decisionsOf(seeded, run)).filter((entry) => entry.decision.result !== 'allow')).toEqual(
        [],
      );

      // Exactly once.
      await receiptsAreExact(run, await batchCount(seeded, run));
      const status = (await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId)).status;
      // W0's narrative completion may honestly end a shallow run as failed; either way the job finished once.
      expect(kind === 'expert' ? ['succeeded'] : ['succeeded', 'failed']).toContain(status);

      if (kind === 'expert') {
        const actual = await rig.worldNow(seeded);
        const reference = runReference(seeded.world).world;
        expect(canonical(byId(actual.collections))).toBe(canonical(byId(reference.collections)));
        expect(gradeWorld(seeded.manifest, actual, { terminalStatus: 'complete' })).toMatchObject({
          usefulCompletion: true,
          targetedResiduals: 0,
          unrelatedRecordChanges: 0,
        });
      }
    }, 90000);

    it(`${kind}: a lost acknowledgement on the LAST batch does not strand the run`, async () => {
      const seeded = await seedWith('direct_nested', {
        partialAcknowledgements: 2,
        interruptAfterEffects: null,
        transientFailures: 0,
      });
      const run = await rig.open(seeded, kind);
      const trace = await drive(seeded, run, kind);
      expect(trace.at(-1), brief(trace)).toMatchObject({ tool: 'complete_cleanup', ok: true });
      const batches = await batchCount(seeded, run);
      // One lost acknowledgement per committed batch, up to the plan's two.
      expect(await faultRows(run.jobId, 'lost_ack')).toBe(Math.min(2, batches));
      await receiptsAreExact(run, batches);
    }, 90000);
  }

  it('a production world with no stored plan never sees a fault', async () => {
    const seeded = await seedWith('partial_retry', null, { campaign: false });
    const run = await rig.open(seeded, 'expert');
    const trace = await drive(seeded, run, 'expert');
    expect(trace.filter((step) => !step.ok)).toEqual([]);
    expect(await control('domain_steps').countDocuments({ jobId: run.jobId, kind: 'fault' })).toBe(0);
  }, 60000);

  it('a production world never queries world_faults, even when a plan row exists', async () => {
    const seeded = await seedWith('partial_retry', 'spec', { campaign: false });
    let reads = 0;
    const throwing: FaultSource = {
      async read() {
        reads += 1;
        throw new Error('no grant');
      },
    };
    (rig.domain as { faults?: FaultSource }).faults = throwing;
    try {
      const run = await rig.open(seeded, 'expert');
      const trace = await drive(seeded, run, 'expert');
      expect(trace.filter((step) => !step.ok)).toEqual([]);
      expect(reads).toBe(0);
      expect(await control('domain_steps').countDocuments({ jobId: run.jobId, kind: 'fault' })).toBe(0);
    } finally {
      delete (rig.domain as { faults?: FaultSource }).faults;
    }
  }, 60000);

  it('a campaign world with NO plan row is attested as none, never silently fault-free', async () => {
    const seeded = await seedWith('partial_retry', null);
    const run = await rig.open(seeded, 'expert');
    const trace = await drive(seeded, run, 'expert');
    expect(trace.filter((step) => !step.ok)).toEqual([]);
    expect(await attested(run.jobId)).toEqual([null]);
    expect(await faultRows(run.jobId, 'transient')).toBe(0);
  }, 60000);

  it('a stored plan whose hash does not match fails closed', async () => {
    const seeded = await seedWith('partial_retry', 'spec');
    await control('world_faults').updateOne(
      { _id: seeded.world.worldId as never },
      { $set: { 'plan.transientFailures': 0 } },
    );
    const run = await rig.open(seeded, 'expert');
    for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
      expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
    expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
      ok: false,
      code: 'FaultPlanTampered',
    });
    expect(await control('effects').countDocuments({ jobId: run.jobId })).toBe(0);
  }, 60000);
});
