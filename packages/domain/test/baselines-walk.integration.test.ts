import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeLive } from '../../mongo/test/support.js';
import { batchesOf } from '../src/index.js';
import {
  SCRIPTED_DRIVER_LABEL,
  attempt,
  baseFields,
  driveExpert,
  driveW0,
  field,
  openRig,
  type CustomWorld,
  type OpenRun,
  type Rig,
  type Seeded,
} from './rig.js';

/**
 * The shipped baseline bundles walked through the REAL gateway (workflow enforcement, budgets, decisions) on a real
 * replica set: a plan of four batches, a world with transient failures, replays, a skipped ordinal and an empty plan.
 * ${SCRIPTED_DRIVER_LABEL}.
 */
describeLive(`baseline workflows through the real gateway (${SCRIPTED_DRIVER_LABEL})`, () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await openRig('walk');
  }, 60000);
  beforeEach(() => rig.env.reset());
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 60000);

  const position = async (seeded: Seeded, run: OpenRun) =>
    (await rig.domain.store.latestStep(seeded.actor, run.jobId, 'workflow'))!.payload as unknown as {
      nodeId: string | null;
      outcome: string;
      visits: Record<string, number>;
    };
  // `complete_cleanup` ends the job and its lease, so the last call has a call row but no workflow row after it.
  const lastCall = async (seeded: Seeded, run: OpenRun) =>
    (await rig.domain.store.latestStep(seeded.actor, run.jobId, 'call'))!.payload as unknown as {
      toolId: string;
      nodeId: string | null;
      admitted: boolean;
    };
  const batchCount = async (seeded: Seeded, run: OpenRun) => {
    const plan = (await rig.domain.store.latestPlan(seeded.actor, run.jobId, `run-${run.jobId}`))!;
    return batchesOf(seeded.world.scope, plan.targets).length;
  };

  for (const family of ['mixed_eligibility', 'partial_retry'] as const) {
    // The WorldSpec fault plan (transient failures, interrupts) is NOT injected on the domain path (DA-5 P2-1), so the
    // partial_retry world is walked fault-free here and retryable_error is not driven by this test.
    const label = family === 'partial_retry' ? 'partial_retry (fault plan NOT injected, DA-5 P2-1)' : family;
    it(`${label}: the expert bundle completes the whole plan batch by batch and verifies before completing`, async () => {
      const seeded = await rig.seed(family);
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      expect(trace.filter((step) => !step.ok)).toEqual([]);
      const batches = await batchCount(seeded, run);
      if (family === 'mixed_eligibility') expect(batches).toBe(4);
      const visits = (await position(seeded, run)).visits;
      expect(visits.apply).toBe(batches);
      expect(visits.verify).toBeGreaterThanOrEqual(1);
      expect(await lastCall(seeded, run)).toMatchObject({
        toolId: 'complete_cleanup',
        nodeId: 'complete',
        admitted: true,
      });
      expect((await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId)).status).toBe('succeeded');
      expect(await rig.env.service.control.collection('effects').countDocuments({ jobId: run.jobId })).toBe(
        batches,
      );
    }, 60000);

    it(`${label}: W0 applies the same plan and finishes without ever verifying`, async () => {
      const seeded = await rig.seed(family);
      const run = await rig.open(seeded, 'w0');
      const trace = await driveW0(run.tools);
      expect(trace.filter((step) => !step.ok)).toEqual([]);
      const batches = await batchCount(seeded, run);
      const visits = (await position(seeded, run)).visits;
      expect(visits.apply).toBe(batches);
      expect(visits.verify).toBeUndefined();
      expect(await lastCall(seeded, run)).toMatchObject({
        toolId: 'complete_cleanup',
        nodeId: 'complete',
        admitted: true,
      });
      // W0 is not granted verification: a verify call is a denied decision, not a missing node.
      expect(await attempt(run.tools, 'verify_registered_scope')).toMatchObject({
        ok: false,
        code: 'PolicyDenied',
      });
    }, 60000);
  }

  it('apply reports batches_remaining until the last batch; a replay of a committed ordinal is not progress', async () => {
    const seeded = await rig.seed('mixed_eligibility');
    const run = await rig.open(seeded, 'expert');
    for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
      expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
    expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
      ok: true,
      result: { batchOrdinal: 0, batchesRemaining: 3 },
    });
    expect(await position(seeded, run)).toMatchObject({ outcome: 'batches_remaining', visits: { apply: 1 } });
    const before = await rig.env.service.control
      .collection('domain_steps')
      .countDocuments({ jobId: run.jobId, kind: 'workflow' });

    const replay = await attempt(run.tools, 'apply_cleanup_batch', { batch: 0 });
    expect(replay).toMatchObject({ ok: true, result: { batchOrdinal: 0, replayed: true } });
    expect(await position(seeded, run)).toMatchObject({ outcome: 'batches_remaining', visits: { apply: 1 } });
    expect(
      await rig.env.service.control
        .collection('domain_steps')
        .countDocuments({ jobId: run.jobId, kind: 'workflow' }),
    ).toBe(before);
    expect(await rig.env.service.control.collection('effects').countDocuments({ jobId: run.jobId })).toBe(1);

    for (const expected of [1, 2]) {
      expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
        ok: true,
        result: { batchOrdinal: expected },
      });
    }
    expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
      ok: true,
      result: { batchOrdinal: 3, batchesRemaining: 0 },
    });
    expect(await position(seeded, run)).toMatchObject({ outcome: 'success', visits: { apply: 4 } });
  }, 60000);

  it('replaying an EARLIER ordinal after later batches committed returns the saved receipt, and batchesRemaining comes from the committed prefix', async () => {
    const seeded = await rig.seed('mixed_eligibility');
    const run = await rig.open(seeded, 'expert');
    for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
      expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
    const first = await attempt(run.tools, 'apply_cleanup_batch');
    const second = await attempt(run.tools, 'apply_cleanup_batch');
    expect(second).toMatchObject({ ok: true, result: { batchOrdinal: 1, batchesRemaining: 2 } });
    const replay = await attempt(run.tools, 'apply_cleanup_batch', { batch: 0 });
    // Two of four batches are committed: two remain, whatever ordinal the arguments named (an args-derived count
    // would say three).
    expect(replay).toMatchObject({
      ok: true,
      result: { batchOrdinal: 0, replayed: true, batchesRemaining: 2 },
    });
    expect(replay.ok && first.ok && replay.result.receiptId).toBe(first.ok && first.result.receiptId);
    expect(await rig.env.service.control.collection('effects').countDocuments({ jobId: run.jobId })).toBe(2);
    expect(await position(seeded, run)).toMatchObject({ outcome: 'batches_remaining', visits: { apply: 2 } });
  }, 60000);

  it('an illegal transition is denied by the workflow graph itself, so dropping enforcement fails this test', async () => {
    const seeded = await rig.seed('mixed_eligibility');
    const run = await rig.open(seeded, 'expert');
    expect((await attempt(run.tools, 'inspect_scope')).ok).toBe(true);
    // The grants and prerequisites would also stop apply here; the graph's rule id must be among the reasons.
    expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
      ok: false,
      code: 'PolicyDenied',
    });
    expect(await attempt(run.tools, 'verify_registered_scope')).toMatchObject({
      ok: false,
      code: 'PolicyDenied',
    });
    const decisions = await rig.domain.ledger.list(seeded.actor, run.jobId, 50);
    for (const toolId of ['apply_cleanup_batch', 'verify_registered_scope'])
      expect(decisions.find((entry) => entry.toolId === toolId)?.decision.ruleIds, toolId).toContain(
        'gateway:workflow_transition_denied',
      );
    // A denied call took no node: the run is still where inspect left it.
    expect(await position(seeded, run)).toMatchObject({ nodeId: 'inspect', visits: { inspect: 1 } });
    const w0 = await rig.open(seeded, 'w0');
    expect((await attempt(w0.tools, 'inspect_scope')).ok).toBe(true);
    expect(await attempt(w0.tools, 'verify_registered_scope')).toMatchObject({
      ok: false,
      code: 'PolicyDenied',
    });
    expect(
      (await rig.domain.ledger.list(seeded.actor, w0.jobId, 50)).find(
        (e) => e.toolId === 'verify_registered_scope',
      )?.decision.ruleIds,
    ).toContain('gateway:workflow_transition_denied');
  }, 60000);

  it('a skipped ordinal is BatchOutOfOrder and takes no visit; the right ordinal still goes through', async () => {
    const seeded = await rig.seed('mixed_eligibility');
    const run = await rig.open(seeded, 'expert');
    for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
      expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
    expect(await attempt(run.tools, 'apply_cleanup_batch', { batch: 2 })).toEqual({
      tool: 'apply_cleanup_batch',
      ok: false,
      code: 'BatchOutOfOrder',
    });
    expect((await position(seeded, run)).visits.apply).toBeUndefined();
    expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
      ok: true,
      result: { batchOrdinal: 0 },
    });
    expect((await position(seeded, run)).visits.apply).toBe(1);
  }, 60000);

  describe('a plan with no batches', () => {
    // The subject's only record carries no eligibility metadata, so the owner policy cannot say what to do with it.
    const world: CustomWorld = {
      fields: baseFields('customers', field('customers', 'identity_binding', ['data', 'identity', 'id'])),
      edges: [],
      docs: [
        {
          collection: 'customers',
          id: 'C1',
          data: { identity: { id: 'tok-c1' }, payload: 'p' },
          effect: null,
        },
      ],
      subject: { idType: 'string', value: 'C1' },
    };
    it('apply commits nothing and succeeds with emptyPlan, and the run reaches verify, which says it is not done', async () => {
      const seeded = await rig.seedCustom(world);
      const run = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
        expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
      expect(await batchCount(seeded, run)).toBe(0);
      const applied = await attempt(run.tools, 'apply_cleanup_batch');
      expect(applied).toMatchObject({
        ok: true,
        result: { emptyPlan: true, appliedEffects: 0, committed: false },
      });
      expect(await rig.env.service.control.collection('effects').countDocuments({ jobId: run.jobId })).toBe(
        0,
      );
      expect(
        await rig.env.service.control.collection('action_receipts').countDocuments({ jobId: run.jobId }),
      ).toBe(0);
      expect(await position(seeded, run)).toMatchObject({ outcome: 'success', visits: { apply: 1 } });
      const verified = await attempt(run.tools, 'verify_registered_scope');
      expect(verified).toMatchObject({ ok: true, result: { verified: false } });
      // A named batch on an empty plan is not an empty-plan success.
      expect(await attempt(run.tools, 'apply_cleanup_batch', { batch: 1 })).toMatchObject({ ok: false });
    }, 60000);
  });
});
