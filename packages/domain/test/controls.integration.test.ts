import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeLive } from '../../mongo/test/support.js';
import type { FixtureFamily } from '../../fixtures/src/index.js';
import { ControlState } from '../src/budget.js';
import { attempt, openRig, SCRIPTED_DRIVER_LABEL, toolsFor, type Rig, type Seeded } from './rig.js';
import { expertWith, hold, PLANNING, takeOver, walk, withMaxVisits } from './controls-helpers.js';

const TRANSITION = 'gateway:workflow_transition_denied';
const VISITS = 'gateway:workflow_visits_exceeded';
const CALLS = 'gateway:tool_call_budget_exceeded';
const SCANNED = 'gateway:scanned_documents_budget_exceeded';
const CHANGED = 'gateway:changed_documents_budget_exceeded';
const MISMATCH = 'gateway:call_replay_digest_mismatch';

/**
 * The gateway controls against a real replica set. The direct tests drive `begin` and `end` the way the gateway does
 * (SCRIPTED DRIVER, a labeled fake); the last block goes through the tools. Lease fencing, budgets and visits are read from
 * the job's own rows, so each case that matters opens a second session or a takeover.
 */
describeLive(
  `gateway controls: durable workflow and budgets against a real replica set (${SCRIPTED_DRIVER_LABEL})`,
  () => {
    let rig: Rig;
    const steps = (kind: string) =>
      rig.env.service.control.collection('domain_steps').find({ kind }).toArray();
    const countRows = (jobId: string, kind: string) =>
      rig.env.service.control.collection('domain_steps').countDocuments({ jobId, kind });

    async function started(
      options: { jobId?: string; bundle?: ReturnType<typeof expertWith>; family?: FixtureFamily } = {},
    ): Promise<{ seeded: Seeded; run: Awaited<ReturnType<Rig['open']>> }> {
      const { family, ...open } = options;
      const seeded = await rig.seed(family ?? 'direct_nested');
      const run = await rig.open(seeded, 'expert', open);
      return { seeded, run };
    }

    beforeAll(async () => {
      rig = await openRig('controls');
    }, 60000);
    beforeEach(() => rig.env.reset());
    afterAll(async () => {
      if (rig) await rig.dispose();
    }, 60000);

    describe('workflow graph', () => {
      it('admits the entry tool first and then only the edges the last call opened', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        const admissions = await walk(held, PLANNING);
        expect(admissions.map((admission) => admission.violations)).toEqual([[], [], [], []]);
        expect(admissions.map((admission) => admission.callNumber)).toEqual([1, 2, 3, 4]);
      });

      it('denies a tool with no admitted edge from the current node (gateway:workflow_transition_denied)', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        // From the start only the entry node's tool is admitted.
        const early = await held.controls.begin(held.rt, { toolId: 'resolve_subject', documentsToChange: 0 });
        expect(early.violations).toEqual([TRANSITION]);
        await held.controls.end(held.rt, {
          toolId: 'resolve_subject',
          callNumber: early.callNumber,
          outcome: 'denied',
        });
        await walk(held, [
          ['inspect_scope', 'success'],
          ['resolve_subject', 'success'],
        ]);
        // After resolve the only edge goes to discover, so skipping to apply is denied too.
        const skip = await held.controls.begin(held.rt, {
          toolId: 'apply_cleanup_batch',
          documentsToChange: 0,
        });
        expect(skip.violations).toContain(TRANSITION);
      });

      it('a denied call does not move the run: the correct next call is still admitted', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        const bad = await held.controls.begin(held.rt, { toolId: 'preview_cleanup', documentsToChange: 0 });
        expect(bad.violations).toContain(TRANSITION);
        await held.controls.end(held.rt, {
          toolId: 'preview_cleanup',
          callNumber: bad.callNumber,
          outcome: 'denied',
        });
        const good = await held.controls.begin(held.rt, { toolId: 'inspect_scope', documentsToChange: 0 });
        expect(good.violations).toEqual([]);
      });

      it('denies a node past its maxVisits (gateway:workflow_visits_exceeded)', async () => {
        const bundle = expertWith({ workflow: withMaxVisits('discover', 1) });
        const { run } = await started({ bundle });
        const held = await hold(rig, run);
        await walk(held, [
          ['inspect_scope', 'success'],
          ['resolve_subject', 'success'],
          ['discover_references', 'more_references'],
        ]);
        // The self edge on more_references exists, so the transition is admitted but the node has no visits left.
        const second = await held.controls.begin(held.rt, {
          toolId: 'discover_references',
          documentsToChange: 0,
        });
        expect(second.violations).toEqual([VISITS]);
      });

      it('lets a node with visits left repeat along an admitted self edge', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        const admissions = await walk(held, [
          ['inspect_scope', 'success'],
          ['resolve_subject', 'success'],
          ['discover_references', 'more_references'],
          ['discover_references', 'more_references'],
          ['discover_references', 'success'],
        ]);
        expect(admissions.flatMap((admission) => admission.violations)).toEqual([]);
        const fourth = await held.controls.begin(held.rt, {
          toolId: 'discover_references',
          documentsToChange: 0,
        });
        expect(fourth.violations).toContain(TRANSITION);
      });

      it('follows retryable_error back into the same node and counts the visit', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await walk(held, [...PLANNING, ['apply_cleanup_batch', 'retryable_error']]);
        const retry = await held.controls.begin(held.rt, {
          toolId: 'apply_cleanup_batch',
          documentsToChange: 0,
        });
        expect(retry.violations).toEqual([]);
        // A retryable_error takes an edge, so the next call opens a new visit rather than spending a retry.
        expect(retry.callsToThisTool).toBe(1);
      });

      it('walks a four-batch plan of the real expert bundle: batches_remaining x3, then success, then a fifth apply is denied', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        const admissions = await walk(held, [
          ...PLANNING,
          ['apply_cleanup_batch', 'batches_remaining'],
          ['apply_cleanup_batch', 'batches_remaining'],
          ['apply_cleanup_batch', 'batches_remaining'],
          ['apply_cleanup_batch', 'success'],
        ]);
        expect(admissions.flatMap((admission) => admission.violations)).toEqual([]);
        // After the last batch ended in success the only admitted edge leads to verify.
        const fifth = await held.controls.begin(held.rt, {
          toolId: 'apply_cleanup_batch',
          documentsToChange: 0,
        });
        expect(fifth.violations).toContain(TRANSITION);
        await held.controls.end(held.rt, {
          toolId: 'apply_cleanup_batch',
          callNumber: fifth.callNumber,
          outcome: 'denied',
        });
        const verify = await held.controls.begin(held.rt, {
          toolId: 'verify_registered_scope',
          documentsToChange: 0,
        });
        expect(verify.violations).toEqual([]);
      });

      it('a call that failed for good does not advance the run or use a visit', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await walk(held, [...PLANNING, ['apply_cleanup_batch', 'failed']]);
        const position = await new ControlState(held.rt).position();
        expect(position).toMatchObject({ nodeId: 'preview', outcome: 'success' });
        expect(position.visits.apply ?? 0).toBe(0);
      });

      it('inspect_harness and report_diagnostic are outside the graph: any position, no visit, no move', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        const before = await held.controls.begin(held.rt, {
          toolId: 'inspect_harness',
          documentsToChange: 0,
        });
        expect(before.violations).toEqual([]);
        await held.controls.end(held.rt, {
          toolId: 'inspect_harness',
          callNumber: before.callNumber,
          outcome: 'success',
        });
        await walk(held, [
          ['inspect_scope', 'success'],
          ['report_diagnostic', 'success'],
          ['resolve_subject', 'success'],
          ['inspect_harness', 'success'],
          ['discover_references', 'success'],
        ]);
        const position = await new ControlState(held.rt).position();
        expect(position).toMatchObject({ nodeId: 'discover', outcome: 'success' });
        expect(position.visits).toEqual({ inspect: 1, resolve: 1, discover: 1 });
        // Exempt tools are admitted again after the graph is exhausted, but they still spend tool calls.
        const late = await held.controls.begin(held.rt, {
          toolId: 'report_diagnostic',
          documentsToChange: 0,
        });
        expect(late.violations).toEqual([]);
        expect(late.callNumber).toBe(7);
      });
    });

    describe('lease fencing and takeover', () => {
      it('a session without the live fence cannot append a call or a workflow row', async () => {
        const { seeded, run } = await started();
        const stale = await hold(rig, run);
        const first = await stale.controls.begin(stale.rt, { toolId: 'inspect_scope', documentsToChange: 0 });
        expect(first.callNumber).toBe(1);

        const next = await takeOver(rig, seeded, run, run.context, 'worker-2');
        expect(next.lease.fence).toBeGreaterThan(run.context.lease.fence);

        const calls = await countRows(run.jobId, 'call');
        await expect(
          stale.controls.begin(stale.rt, { toolId: 'resolve_subject', documentsToChange: 0 }),
        ).rejects.toMatchObject({ code: 'LostLease' });
        await expect(
          stale.controls.end(stale.rt, { toolId: 'inspect_scope', callNumber: 1, outcome: 'success' }),
        ).rejects.toMatchObject({ code: 'LostLease' });
        expect(await countRows(run.jobId, 'call')).toBe(calls);
        expect(await countRows(run.jobId, 'workflow')).toBe(0);

        // The live holder carries on from the same durable state under the next number.
        const live = await hold(rig, run, next);
        await live.controls.end(live.rt, { toolId: 'inspect_scope', callNumber: 1, outcome: 'success' });
        const resume = await live.controls.begin(live.rt, {
          toolId: 'resolve_subject',
          documentsToChange: 0,
        });
        expect(resume).toMatchObject({ callNumber: 2, violations: [] });
      });

      it('call numbers and workflow position survive a takeover', async () => {
        const { seeded, run } = await started();
        const before = await hold(rig, run);
        await walk(before, PLANNING.slice(0, 3));
        const next = await takeOver(rig, seeded, run, run.context, 'worker-2');
        const after = await hold(rig, run, next);
        expect(await new ControlState(after.rt).position()).toMatchObject({ nodeId: 'discover' });
        const admission = await after.controls.begin(after.rt, {
          toolId: 'preview_cleanup',
          documentsToChange: 0,
        });
        expect(admission).toMatchObject({ callNumber: 4, callsToThisTool: 1, violations: [] });
      });
    });

    describe('cumulative per-job budgets', () => {
      it('counts tool calls across sessions and refuses the call over the limit without writing a row', async () => {
        const bundle = expertWith({ limits: { toolCalls: 5 } });
        const { seeded, run } = await started({ bundle });
        const one = await hold(rig, run);
        await walk(one, PLANNING);
        const next = await takeOver(rig, seeded, run, run.context, 'worker-2');
        const two = await hold(rig, run, next);
        const fifth = await two.controls.begin(two.rt, { toolId: 'inspect_harness', documentsToChange: 0 });
        expect(fifth).toMatchObject({ callNumber: 5, violations: [] });
        await two.controls.end(two.rt, { toolId: 'inspect_harness', callNumber: 5, outcome: 'success' });

        const sixth = await two.controls.begin(two.rt, { toolId: 'inspect_harness', documentsToChange: 0 });
        expect(sixth.violations).toEqual([CALLS]);
        await two.controls.end(two.rt, {
          toolId: 'inspect_harness',
          callNumber: sixth.callNumber,
          outcome: 'denied',
        });
        expect(await countRows(run.jobId, 'call')).toBe(5);

        // Another session, and another takeover, see the same count.
        const third = await hold(rig, run, await takeOver(rig, seeded, run, next, 'worker-3'));
        const seventh = await third.controls.begin(third.rt, {
          toolId: 'inspect_scope',
          documentsToChange: 0,
        });
        expect(seventh.violations).toEqual([CALLS]);
        expect(await countRows(run.jobId, 'call')).toBe(5);
      });

      it('a denied call spends a tool call, so probing the graph cannot be free', async () => {
        const bundle = expertWith({ limits: { toolCalls: 2 } });
        const { run } = await started({ bundle });
        const held = await hold(rig, run);
        for (const toolId of ['verify_registered_scope', 'complete_cleanup'] as const) {
          const denied = await held.controls.begin(held.rt, { toolId, documentsToChange: 0 });
          expect(denied.violations).toContain(TRANSITION);
          await held.controls.end(held.rt, { toolId, callNumber: denied.callNumber, outcome: 'denied' });
        }
        const over = await held.controls.begin(held.rt, { toolId: 'inspect_scope', documentsToChange: 0 });
        expect(over.violations).toEqual([CALLS]);
      });

      it('gates discovery on the documents scanned by every earlier discovery of the job', async () => {
        const { seeded, run } = await started();
        const held = await hold(rig, run);
        await walk(held, PLANNING.slice(0, 2));
        const discovery = (scannedDocuments: number) => ({
          depth: 0,
          depths: { outgoing: 0, incoming: 0 },
          selected: [],
          frontiers: { outgoing: [], incoming: [] },
          frontierOpen: 0,
          truncated: false,
          scannedDocuments,
          inspectedArrayFieldIds: [],
        });
        const append = (rt: typeof held.rt, scanned: number) =>
          rt.store.appendStep(rt.actor, rt.run, 'discovery', discovery(scanned), 0);
        await append(held.rt, 300);
        expect(
          (await held.controls.begin(held.rt, { toolId: 'discover_references', documentsToChange: 0 }))
            .violations,
        ).toEqual([]);
        // The first discovery's session ends; a later session adds more and the sum counts.
        const later = await hold(rig, run, await takeOver(rig, seeded, run, run.context, 'worker-2'));
        await append(later.rt, 200);
        const gated = await later.controls.begin(later.rt, {
          toolId: 'discover_references',
          documentsToChange: 0,
        });
        expect(gated.violations).toContain(SCANNED);
        // Only discovery is gated on scanned documents.
        const other = await later.controls.begin(later.rt, {
          toolId: 'inspect_harness',
          documentsToChange: 0,
        });
        expect(other.violations).toEqual([]);
      });
    });

    describe('retry of the same logical effect (DA-5 DG6) and replay digests', () => {
      const KEY = 'effect-key-1';
      const apply = (digest: string, documentsToChange = 0) => ({
        toolId: 'apply_cleanup_batch' as const,
        documentsToChange,
        argsDigest: digest,
        effectKey: KEY,
      });

      it('a call that began and never ended resumes under its own number, in any session', async () => {
        const { seeded, run } = await started();
        const one = await hold(rig, run);
        await walk(one, PLANNING);
        const first = await one.controls.begin(one.rt, apply('d'.repeat(64)));
        expect(first).toMatchObject({ callNumber: 5, callsToThisTool: 1, violations: [] });

        // The session dies before `end`; the next holder retries the same logical effect.
        const next = await takeOver(rig, seeded, run, run.context, 'worker-2');
        const two = await hold(rig, run, next);
        const again = await two.controls.begin(two.rt, apply('d'.repeat(64)));
        expect(again).toMatchObject({ callNumber: 5, callsToThisTool: 1, violations: [] });
        expect(await countRows(run.jobId, 'call')).toBe(5);

        await two.controls.end(two.rt, { toolId: 'apply_cleanup_batch', callNumber: 5, outcome: 'success' });
        expect(await countRows(run.jobId, 'workflow')).toBe(5);
        // Ending the same call twice writes nothing more.
        await two.controls.end(two.rt, { toolId: 'apply_cleanup_batch', callNumber: 5, outcome: 'success' });
        expect(await countRows(run.jobId, 'workflow')).toBe(5);
      });

      it('does not resume a call the controls had refused: the retry is judged again', async () => {
        const { seeded, run } = await started();
        const one = await hold(rig, run);
        // Out of order: apply before anything was planned. The session dies before it can end the refused call.
        const refused = await one.controls.begin(one.rt, apply('d'.repeat(64)));
        expect(refused.violations).toContain(TRANSITION);
        const two = await hold(rig, run, await takeOver(rig, seeded, run, run.context, 'worker-2'));
        const again = await two.controls.begin(two.rt, apply('d'.repeat(64)));
        expect(again.violations).toContain(TRANSITION);
        expect(again.callNumber).toBe(refused.callNumber + 1);
      });

      it('a failed attempt that retries is a new call and counts toward retry_count', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await walk(held, PLANNING);
        const first = await held.controls.begin(held.rt, apply('d'.repeat(64)));
        await held.controls.end(held.rt, {
          toolId: 'apply_cleanup_batch',
          callNumber: first.callNumber,
          outcome: 'retryable_error',
        });
        const second = await held.controls.begin(held.rt, apply('d'.repeat(64)));
        expect(second).toMatchObject({ callNumber: 6, callsToThisTool: 2, violations: [] });
        await held.controls.end(held.rt, {
          toolId: 'apply_cleanup_batch',
          callNumber: 6,
          outcome: 'retryable_error',
        });
        expect((await held.controls.begin(held.rt, apply('d'.repeat(64)))).callsToThisTool).toBe(3);
      });

      it('denies a replay of the logical effect whose inputs digest differs', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await walk(held, PLANNING);
        const first = await held.controls.begin(held.rt, apply('a'.repeat(64)));
        const forged = await held.controls.begin(held.rt, apply('b'.repeat(64)));
        expect(forged).toMatchObject({ callNumber: first.callNumber, violations: [MISMATCH] });
        await held.controls.end(held.rt, {
          toolId: 'apply_cleanup_batch',
          callNumber: forged.callNumber,
          outcome: 'denied',
        });
        // The digest binds the row for good: the same effect with other inputs is still refused after the call ended.
        const later = await held.controls.begin(held.rt, apply('b'.repeat(64)));
        expect(later.violations).toEqual([MISMATCH]);
        expect(await countRows(run.jobId, 'call')).toBe(5);
      });

      it('records the inputs digest and the logical key in the call row', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await held.controls.begin(held.rt, {
          toolId: 'inspect_scope',
          documentsToChange: 0,
          argsDigest: 'c'.repeat(64),
        });
        const [row] = (await steps('call')) as unknown as Array<{ payload: Record<string, unknown> }>;
        expect(row!.payload).toMatchObject({
          toolId: 'inspect_scope',
          callNumber: 1,
          toolCallNumber: 1,
          inputsDigest: 'c'.repeat(64),
          logicalKey: null,
          nodeId: 'inspect',
          admitted: true,
        });
      });
    });

    describe('retry_count means retries spent on the current step (GC-b)', () => {
      const batch = (ordinal: number, documentsToChange = 0) => ({
        toolId: 'apply_cleanup_batch' as const,
        documentsToChange,
        argsDigest: String(ordinal).repeat(64).slice(0, 64),
        effectKey: `batch-${ordinal}`,
      });

      it('a clean four-batch plan presents zero retries on every batch', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await walk(held, PLANNING);
        const spent: number[] = [];
        for (let ordinal = 0; ordinal < 4; ordinal++) {
          const admission = await held.controls.begin(held.rt, batch(ordinal));
          expect(admission.violations).toEqual([]);
          spent.push(admission.callsToThisTool - 1);
          await held.controls.end(held.rt, {
            toolId: 'apply_cleanup_batch',
            callNumber: admission.callNumber,
            outcome: ordinal < 3 ? 'batches_remaining' : 'success',
          });
        }
        expect(spent).toEqual([0, 0, 0, 0]);
      });

      it('a retried batch presents one retry, then two, while the next batch starts again at zero', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await walk(held, PLANNING);
        const spent: number[] = [];
        for (const [ordinal, outcome] of [
          [0, 'retryable_error'],
          [0, 'retryable_error'],
          [0, 'batches_remaining'],
          [1, 'success'],
        ] as const) {
          const admission = await held.controls.begin(held.rt, batch(ordinal));
          expect(admission.violations).toEqual([]);
          spent.push(admission.callsToThisTool - 1);
          await held.controls.end(held.rt, {
            toolId: 'apply_cleanup_batch',
            callNumber: admission.callNumber,
            outcome,
          });
        }
        expect(spent).toEqual([0, 1, 2, 0]);
      });

      it('a read counts the calls it spent since the run last took an edge', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        const spent: number[] = [];
        for (const toolId of ['discover_references', 'discover_references'] as const) {
          const admission = await held.controls.begin(held.rt, { toolId, documentsToChange: 0 });
          expect(admission.violations).toContain(TRANSITION);
          spent.push(admission.callsToThisTool - 1);
          await held.controls.end(held.rt, { toolId, callNumber: admission.callNumber, outcome: 'denied' });
        }
        const moved = await walk(held, [['inspect_scope', 'success']]);
        spent.push(moved[0]!.callsToThisTool - 1);
        expect(spent).toEqual([0, 1, 0]);
      });
    });

    describe('overlapping calls of one holder serialise (GC-a)', () => {
      it('two concurrent begin() calls at budget-1 admit exactly one', async () => {
        const bundle = expertWith({ limits: { toolCalls: 3 } });
        const { run } = await started({ bundle });
        const held = await hold(rig, run);
        await walk(held, [
          ['inspect_harness', 'success'],
          ['inspect_harness', 'success'],
        ]);
        const [left, right] = await Promise.all([
          held.controls.begin(held.rt, { toolId: 'inspect_harness', documentsToChange: 0 }),
          held.controls.begin(held.rt, { toolId: 'inspect_harness', documentsToChange: 0 }),
        ]);
        const admitted = [left, right].filter((admission) => admission.violations.length === 0);
        expect(admitted).toHaveLength(1);
        expect([left, right].filter((admission) => admission.violations.includes(CALLS))).toHaveLength(1);
        expect(await countRows(run.jobId, 'call')).toBe(3);
      });

      it('overlapping begin/end pairs keep every visit', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        await walk(held, PLANNING.slice(0, 2));
        // Two discoveries overlap. Either order is legal (both may begin before either ends, or the second may begin
        // after the first moved the run), but no end may overwrite the other's visit.
        const pair = await Promise.all(
          [0, 1].map(async () => {
            const admission = await held.controls.begin(held.rt, {
              toolId: 'discover_references',
              documentsToChange: 0,
            });
            await held.controls.end(held.rt, {
              toolId: 'discover_references',
              callNumber: admission.callNumber,
              outcome: admission.violations.length === 0 ? 'success' : 'denied',
            });
            return admission;
          }),
        );
        const advanced = pair.filter((admission) => admission.violations.length === 0).length;
        expect(advanced).toBeGreaterThanOrEqual(1);
        expect((await new ControlState(held.rt).position()).visits.discover).toBe(advanced);
      });
    });

    describe('overlap never admits past a limit or an illegal transition (NT-a)', () => {
      it('two overlapping calls for a node with one visit admit exactly one, and the visit is exact', async () => {
        const { run } = await started();
        const held = await hold(rig, run);
        // inspect has maxVisits 1: the second overlapping inspect_scope has no visit left even though the first has
        // not ended, because the first reserved it when it began.
        const pair = await Promise.all(
          [0, 1].map(async () => {
            const admission = await held.controls.begin(held.rt, {
              toolId: 'inspect_scope',
              documentsToChange: 0,
            });
            await held.controls.end(held.rt, {
              toolId: 'inspect_scope',
              callNumber: admission.callNumber,
              outcome: admission.violations.length === 0 ? 'success' : 'denied',
            });
            return admission;
          }),
        );
        expect(pair.filter((admission) => admission.violations.length === 0)).toHaveLength(1);
        // Which rule refuses the second depends on timing: no visit left while the first is in flight, or no edge out
        // of inspect once the first has ended. Either way it is refused.
        const refused = pair.flatMap((admission) => admission.violations);
        expect(refused).toHaveLength(1);
        expect([VISITS, TRANSITION]).toContain(refused[0]);
        expect((await new ControlState(held.rt).position()).visits).toEqual({ inspect: 1 });
        expect(await countRows(run.jobId, 'call')).toBe(2);
        expect(await countRows(run.jobId, 'workflow')).toBe(2);
      });

      it('an overlapping pair never exceeds toolCalls', async () => {
        const bundle = expertWith({ limits: { toolCalls: 4 } });
        const { run } = await started({ bundle });
        const held = await hold(rig, run);
        const calls = await Promise.all(
          Array.from({ length: 6 }, () =>
            held.controls.begin(held.rt, { toolId: 'inspect_harness', documentsToChange: 0 }),
          ),
        );
        expect(calls.filter((admission) => admission.violations.length === 0)).toHaveLength(4);
        expect(await countRows(run.jobId, 'call')).toBe(4);
      });
    });

    describe('overlapping applies from the same settled position (disclosed behaviour)', () => {
      const planned = async () => {
        const { seeded, run } = await started();
        for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
          expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
        const effects = () =>
          rig.env.service.control.collection('effects').countDocuments({ jobId: run.jobId });
        return { seeded, run, effects };
      };

      it('both are admitted within maxVisits, yet the effect commits exactly once', async () => {
        const { run, effects } = await planned();
        const held = await hold(rig, run);
        const results = await Promise.all([
          attempt(run.tools, 'apply_cleanup_batch', { batch: 0 }),
          attempt(run.tools, 'apply_cleanup_batch', { batch: 0 }),
        ]);
        // The same logical effect: one commit and one saved receipt, whichever call won, or a refusal from a guard.
        // (The `replayed` flag is decided before the commit, so the losing call can still say false; the receipt is the truth.)
        const receipts = new Set(results.flatMap((step) => (step.ok ? [step.result.receiptId] : [])));
        expect(receipts.size).toBeLessThanOrEqual(1);
        expect(results.some((step) => step.ok)).toBe(true);
        expect(await effects()).toBe(1);
        const position = await new ControlState(held.rt).position();
        expect(position.visits.apply ?? 0).toBeLessThanOrEqual(
          held.rt.bundle.workflow.nodes.find((node) => node.id === 'apply')!.maxVisits,
        );
      });

      it('a second batch started while the first is in flight is refused by the tool, not committed twice', async () => {
        const { run, effects } = await planned();
        const results = await Promise.all([
          attempt(run.tools, 'apply_cleanup_batch', { batch: 0 }),
          attempt(run.tools, 'apply_cleanup_batch', { batch: 1 }),
        ]);
        // Batches commit in order: batch 1 is either refused for its turn or follows batch 0, never ahead of it.
        expect(results[0]).toMatchObject({ ok: true });
        if (!results[1]!.ok)
          expect(['BatchOutOfOrder', 'PolicyDenied', 'StaleWorldRevision']).toContain(results[1]!.code);
        expect(await effects()).toBeLessThanOrEqual(2);
        expect(await effects()).toBeGreaterThanOrEqual(1);
      });
    });

    describe('retry_count guardrail through the tools (NT-b)', () => {
      const secondAttempt = {
        ruleId: 'deny_second_attempt',
        predicate: {
          op: 'compare' as const,
          comparator: 'gte' as const,
          left: { kind: 'fact' as const, factId: 'retry_count' },
          right: { kind: 'constant' as const, value: 1 },
        },
        result: 'deny' as const,
        sourceEvidenceIds: [],
        appliesTo: ['apply_cleanup_batch'],
      };
      const planning = ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'];

      it('admits every batch of a clean four-batch plan', async () => {
        const bundle = expertWith({ guardrails: [secondAttempt] });
        const { seeded, run } = await started({ bundle, family: 'mixed_eligibility' });
        for (const tool of planning) expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
        const plan = (await rig.domain.store.latestPlan(seeded.actor, run.jobId, `run-${run.jobId}`))!;
        expect(plan.targets.length).toBeGreaterThan(0);
        for (let ordinal = 0; ordinal < 4; ordinal++)
          expect((await attempt(run.tools, 'apply_cleanup_batch')).ok, `batch ${ordinal}`).toBe(true);
      });

      it('denies the second attempt of one batch', async () => {
        const bundle = expertWith({ guardrails: [secondAttempt] });
        const { seeded, run } = await started({ bundle });
        for (const tool of planning) expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
        const plan = (await rig.domain.store.latestPlan(seeded.actor, run.jobId, `run-${run.jobId}`))!;
        const stale = plan.targets[0]!;
        await rig.env.service.world
          .collection(stale.address.collectionId)
          .updateOne({ _id: stale.address.recordId as never }, { $inc: { _rev: 1 } });
        expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
          ok: false,
          code: 'StaleDocumentVersion',
        });
        expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
          ok: false,
          code: 'PolicyDenied',
        });
        const decisions = await rig.domain.ledger.list(seeded.actor, run.jobId, 100);
        expect(decisions.at(-1)?.decision.ruleIds).toContain('deny_second_attempt');
      });
    });

    describe('a job that is cancelled or failed mid-plan (NT-F)', () => {
      async function afterBatchZero() {
        const { seeded, run } = await started();
        for (const tool of [
          'inspect_scope',
          'resolve_subject',
          'discover_references',
          'preview_cleanup',
          'apply_cleanup_batch',
        ])
          expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
        const effects = () =>
          rig.env.service.control.collection('effects').countDocuments({ jobId: run.jobId });
        return { seeded, run, before: await effects(), effects };
      }

      it('cancelled: the next batch is refused with LostLease and nothing is applied', async () => {
        const { seeded, run, before, effects } = await afterBatchZero();
        await rig.domain.jobs.cancel(seeded.actor, run.jobId);
        expect(await attempt(run.tools, 'apply_cleanup_batch', { batch: 1 })).toMatchObject({
          ok: false,
          code: 'LostLease',
        });
        expect(await effects()).toBe(before);
      });

      it('failed: the next batch changes nothing', async () => {
        const { seeded, run, before, effects } = await afterBatchZero();
        await rig.domain.jobs.finish(seeded.actor, run.context.lease, 'failed', []);
        const late = await attempt(run.tools, 'apply_cleanup_batch', { batch: 1 });
        expect(late.ok).toBe(false);
        expect(await effects()).toBe(before);
      });
    });

    describe('changed documents come from committed receipts, and a replay of a committed effect costs nothing', () => {
      async function afterFirstBatch() {
        // Plan and commit batch 0 through the real tools to learn the plan's size and what the first batch changed. Then
        // pin a ceiling equal to the plan's size (a preview over the ceiling is refused on its own) and run it again.
        const probe = await started();
        const planning = ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'];
        for (const tool of planning) expect((await attempt(probe.run.tools, tool)).ok, tool).toBe(true);
        const plan = (await rig.domain.store.latestPlan(
          probe.seeded.actor,
          probe.run.jobId,
          `run-${probe.run.jobId}`,
        ))!;
        const total = plan.targets.length;
        await rig.env.reset();

        const bundle = expertWith({ limits: { changedDocuments: total } });
        const seeded = await rig.seed('direct_nested');
        const run = await rig.open(seeded, 'expert', { bundle });
        for (const tool of [...planning, 'apply_cleanup_batch'])
          expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
        const committed = await new ControlState((await hold(rig, run)).rt).committedChangedDocuments();
        expect(committed).toBeGreaterThan(0);
        expect(committed).toBeLessThanOrEqual(total);
        return { seeded, run, committed, total };
      }

      it('sums the applied effects of committed receipts and refuses a batch that would pass the limit', async () => {
        const { run, committed, total } = await afterFirstBatch();
        const held = await hold(rig, run);
        expect(await new ControlState(held.rt).committedChangedDocuments()).toBe(committed);
        const over = await held.controls.begin(held.rt, {
          toolId: 'apply_cleanup_batch',
          documentsToChange: total - committed + 1,
          effectKey: 'a-different-batch',
          argsDigest: 'e'.repeat(64),
        });
        expect(over.violations).toContain(CHANGED);
        // The same total fits, and a failed attempt left no receipt to count.
        const fits = await held.controls.begin(held.rt, {
          toolId: 'apply_cleanup_batch',
          documentsToChange: total - committed,
          effectKey: 'another-batch',
          argsDigest: 'f'.repeat(64),
        });
        expect(fits.violations).not.toContain(CHANGED);
      });

      it('an effect that already committed is a free replay that the limit never refuses', async () => {
        // Charging the effect's documents again, on top of what it changed, would pass the ceiling.
        const { seeded, run, total } = await afterFirstBatch();
        const held = await hold(rig, run);
        const [effect] = await rig.env.service.control
          .collection('effects')
          .find({ jobId: run.jobId })
          .toArray();
        const call = {
          toolId: 'apply_cleanup_batch' as const,
          documentsToChange: total,
          effectKey: effect!.effectKey as string,
          argsDigest: effect!.argsDigest as string,
        };
        const first = await held.controls.begin(held.rt, call);
        expect(first.violations).not.toContain(CHANGED);
        const rows = await countRows(run.jobId, 'call');

        const replay = await held.controls.begin(held.rt, call);
        expect(replay).toMatchObject({ callNumber: first.callNumber, violations: [] });
        expect(await countRows(run.jobId, 'call')).toBe(rows);
        // Another session, after a takeover, replays it for free as well.
        const next = await hold(rig, run, await takeOver(rig, seeded, run, run.context, 'worker-2'));
        expect(await next.controls.begin(next.rt, call)).toMatchObject({
          callNumber: first.callNumber,
          violations: [],
        });
        expect(await countRows(run.jobId, 'call')).toBe(rows);
      });
    });

    describe('through the tools', () => {
      it('refuses a tool out of order with PolicyDenied and records the workflow rule id in the decision ledger', async () => {
        const { seeded, run } = await started();
        expect(await attempt(run.tools, 'resolve_subject')).toEqual({
          tool: 'resolve_subject',
          ok: false,
          code: 'PolicyDenied',
        });
        const decisions = await rig.domain.ledger.list(seeded.actor, run.jobId, 100);
        expect(decisions.at(-1)?.decision.ruleIds).toContain(TRANSITION);
        // The refused call changed nothing: the entry tool is still the one that is admitted.
        expect((await attempt(run.tools, 'inspect_scope')).ok).toBe(true);
      });

      it('a new session on the same job keeps the budget and the position', async () => {
        const bundle = expertWith({ limits: { toolCalls: 3 } });
        const { seeded, run } = await started({ bundle });
        expect((await attempt(run.tools, 'inspect_scope')).ok).toBe(true);
        expect((await attempt(run.tools, 'resolve_subject')).ok).toBe(true);
        const next = await takeOver(rig, seeded, run, run.context, 'worker-2');
        const resumed = await toolsFor(rig.domain, next);
        expect((await attempt(resumed, 'discover_references')).ok).toBe(true);
        expect(await attempt(resumed, 'inspect_harness')).toEqual({
          tool: 'inspect_harness',
          ok: false,
          code: 'PolicyDenied',
        });
        const decisions = await rig.domain.ledger.list(seeded.actor, run.jobId, 100);
        expect(decisions.at(-1)?.decision.ruleIds).toContain(CALLS);
        // The old session cannot write another row, whatever it asks.
        const stale = await attempt(run.tools, 'inspect_harness');
        expect(stale.ok).toBe(false);
        expect(await countRows(run.jobId, 'call')).toBe(3);
      });

      it('after completion a new effectful call is refused and changes nothing', async () => {
        const { seeded, run } = await started();
        for (const tool of [
          ...PLANNING.map(([t]) => t),
          'apply_cleanup_batch',
          'apply_cleanup_batch',
          'verify_registered_scope',
          'complete_cleanup',
        ])
          expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
        expect(await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId)).toMatchObject({
          status: 'succeeded',
        });
        const effects = await rig.env.service.control
          .collection('effects')
          .countDocuments({ jobId: run.jobId });
        const calls = await countRows(run.jobId, 'call');
        // Anything that would write is refused by the fence the finished job no longer has.
        for (const tool of ['preview_cleanup', 'discover_references', 'verify_registered_scope'])
          expect(await attempt(run.tools, tool), tool).toMatchObject({ ok: false, code: 'LostLease' });
        // The one effectful tool can only hand back the batch's saved receipt; no second effect appears.
        expect(await attempt(run.tools, 'apply_cleanup_batch', { batch: 0 })).toMatchObject({
          ok: true,
          result: { replayed: true },
        });
        expect(await rig.env.service.control.collection('effects').countDocuments({ jobId: run.jobId })).toBe(
          effects,
        );
        expect(await countRows(run.jobId, 'call')).toBe(calls);
      });

      it('inspect_harness and report_diagnostic run between graph nodes without moving the run', async () => {
        const { run } = await started();
        expect((await attempt(run.tools, 'inspect_harness')).ok).toBe(true);
        expect((await attempt(run.tools, 'inspect_scope')).ok).toBe(true);
        expect((await attempt(run.tools, 'inspect_harness')).ok).toBe(true);
        expect((await attempt(run.tools, 'resolve_subject')).ok).toBe(true);
      });
    });
  },
);
