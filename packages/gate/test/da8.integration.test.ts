/**
 * DA-8 demonstrated findings, each as a negative test on a real replica set. Ports are SCRIPTED/FAKE; the ones that
 * declare committed evidence do so to exercise the admission rule end to end (rule tests only).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import {
  ClaimStore,
  FreezeStore,
  candidateKeyOf,
  childProjectionOf,
  GateStore,
  ZERO_COST,
} from '../src/index.js';
import { ScriptedEpisodePort } from '../src/testing/index.js';
import { describeLive } from '../../mongo/test/support.js';
import { RUNTIME_HASH, fullPlan, gateView, openGate, rulePort, uniqueChild, type Gate } from './support.js';

let gate: Gate;
let n = 0;
const next = () => `da8-${++n}`;
const fresh = async (wall?: number) => gate.insertBundle(uniqueChild(gate.parent, gate.parentHash, wall));
const attempts = async () =>
  (
    await gate.grader.control
      .collection<{ attempts: number }>('gate_attempts')
      .findOne({ _id: gate.parentHash as never })
  )?.attempts ?? 0;

describeLive('DA-8 findings (real replica set)', () => {
  beforeAll(async () => {
    gate = await openGate('da8');
  }, 60_000);
  afterAll(async () => {
    if (gate) await gate.env.dispose();
  }, 30_000);

  it('blanket-delete and blanket-refuse candidates are rejected; failed and timed-out arms stay as rows (D8-7)', async () => {
    for (const behavior of ['blanket_delete', 'blanket_refuse', 'failed_but_correct'] as const) {
      const id = next();
      const port = rulePort(gate, 'claim_without_work', behavior);
      await gate.freezeCampaign(id, {}, port);
      const out = await gate.run(await fresh(), id, port);
      expect(out.verdict, behavior).toBe('reject');
      expect(out.reasonCodes).toContain('trigger_gain_insufficient');
      expect(out.rows).toHaveLength(38);
      if (behavior === 'failed_but_correct') {
        expect(out.report!.causalControls).toMatchObject({ outcomes: { failed: 38 } });
        expect(out.rows.every((row) => !row.candidate.metrics.usefulCompletion)).toBe(true);
      }
    }
  }, 240_000);

  it('D8-1: a tampered view throws before any episode; the final split reaches no stored row', async () => {
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, {}, port);
    const view = gateView();
    view.entries.push(structuredClone(fullPlan().find((entry) => entry.split === 'test')!) as never);
    await expect(gate.run(await fresh(), id, port, { view })).rejects.toThrow(/PlanShape|GatePlanView/);
    expect(port.requests).toHaveLength(0);
    // After a full run, nothing the gate wrote names a seed or a fixture id of any split.
    const id2 = next();
    const port2 = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id2, {}, port2);
    const out = await gate.run(await fresh(), id2, port2);
    expect(out.verdict).toBe('admit');
    const dump: string[] = [];
    for (const db of [gate.env.service.control, gate.env.service.world, gate.env.service.privateDb!])
      for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray())
        if (name !== 'artifacts') dump.push(JSON.stringify(await db.collection(name).find({}).toArray()));
    const text = dump.join('\n');
    for (const entry of fullPlan()) {
      expect(text).not.toContain(entry.seed);
      expect(text).not.toContain(`"${entry.fixtureId}"`);
    }
  }, 240_000);

  it('D8-2: frozen values come from the stored freeze and a mismatch can fail', async () => {
    const wrongFreeze: Array<[string, Parameters<Gate['freezeCampaign']>[1], string]> = [
      ['evaluator', { evaluatorHash: 'e'.repeat(64) }, 'evaluator_hash_mismatch'],
      ['generator', { fixtureGeneratorHash: 'e'.repeat(64) }, 'fixture_generator_hash_mismatch'],
      ['compiler', { compilerHash: 'e'.repeat(64) }, 'compiler_hash_mismatch'],
      ['profile', { workerProfileHash: 'e'.repeat(64) }, 'worker_profile_mismatch'],
      ['budget', { budgetHash: 'e'.repeat(64) }, 'budget_mismatch'],
      ['runtime', { runtimeHash: 'e'.repeat(64) }, 'runtime_hash_mismatch'],
    ];
    for (const [label, over, reason] of wrongFreeze) {
      const id = next();
      const port = rulePort(gate, 'claim_without_work', 'solve');
      await gate.freezeCampaign(id, over, port);
      const out = await gate.run(await fresh(), id, port);
      expect(out.verdict, label).toBe('reject');
      expect(out.reasonCodes, label).toContain(reason);
      expect(port.requests, `${label}: rejected before any episode`).toHaveLength(0);
    }
  }, 120_000);

  it('D8-2/V-2: a self-consistent view that is not the frozen one is refused before the claim', async () => {
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, { splitManifestCommitment: 'e'.repeat(64) }, port);
    const childHash = await fresh();
    await expect(gate.run(childHash, id, port)).rejects.toThrow('GatePlanViewCommitmentMismatch');
    expect(port.requests).toHaveLength(0);
    // Nothing was consumed: the same candidate can still be gated under a correct freeze.
    const ok = next();
    await gate.freezeCampaign(ok, {}, port);
    expect((await gate.run(childHash, ok, port)).verdict).toBe('admit');
  }, 120_000);

  it('D8-2: a worker that attests another runtime is rejected, a missing attestation holds, a mix rejects', async () => {
    const other = 'e'.repeat(64);
    const swap = rulePort(gate, 'claim_without_work', 'solve', { runtimeHash: other });
    const none = rulePort(gate, 'claim_without_work', 'solve', { runtimeHash: undefined });
    let k = 0;
    const mixed = rulePort(gate, 'claim_without_work', 'solve', {
      runtimeHash: () => (k++ === 3 ? other : RUNTIME_HASH),
    });
    const expectations: Array<[ScriptedEpisodePort, string, string]> = [
      [swap, 'reject', 'runtime_hash_mismatch'],
      [none, 'hold', 'runtime_unattested'],
      [mixed, 'reject', 'runtime_hash_mismatch'],
    ];
    for (const [port, verdict, reason] of expectations) {
      const id = next();
      await gate.freezeCampaign(id, {}, port);
      const out = await gate.run(await fresh(), id, port);
      expect(out.verdict, reason).toBe(verdict);
      expect(out.reasonCodes).toContain(reason);
    }
  }, 240_000);

  it('F-2: a veto hook can only add ineligibility; stored eligibility and labels are not switchable', async () => {
    const evidence = {
      provider: 'raindrop',
      externalSignalIds: [],
      localSourceIds: ['s-revoked'],
      origin: 'verifier_feedback' as const,
      redactionPolicy: 'p',
      retrievedAt: '2026-10-11T00:00:00.000Z',
      contentHash: '9'.repeat(64),
    };
    const scope = { tenantId: 'owner-tenant', env: 'dev' as const, scopeId: 'owner-scope' };
    const cases: Array<[string, 'training' | 'revoked', boolean]> = [
      ['label revoked, hook says false', 'revoked', false],
      ['stored row revoked, label training, hook says false', 'training', false],
    ];
    for (const [label, permittedUse, hook] of cases) {
      const bundle = {
        ...uniqueChild(gate.parent, gate.parentHash),
        evidence: [{ ...evidence, permittedUse }],
      };
      const childHash = await gate.insertBundle(bundle);
      if (label.startsWith('stored'))
        await gate.env.service.control.collection('artifact_eligibility').insertOne({
          ...scope,
          artifactHash: evidence.contentHash,
          state: 'revoked',
          policyHash: 'a'.repeat(64),
          reasonCode: 'source_retracted',
          sourceIds: [],
          updatedAt: new Date(),
        } as never);
      const id = next();
      const port = rulePort(gate, 'claim_without_work', 'solve');
      await gate.freezeCampaign(id, {}, port);
      const out = await gate.run(childHash, id, port, { sourcesIneligible: async () => hook });
      expect(out.verdict, label).toBe('reject');
      expect(out.reasonCodes, label).toContain('source_ineligible');
      expect(port.requests, label).toHaveLength(0);
    }
    // And the hook alone can veto.
    const clean = await fresh();
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, {}, port);
    const vetoed = await gate.run(clean, id, port, { sourcesIneligible: async () => true });
    expect(vetoed.reasonCodes).toContain('source_ineligible');
  }, 120_000);

  it('D8-4/D8-16: one gate run per executable child; a rerun, a rename and an evidence reorder are refused', async () => {
    const childBundle = uniqueChild(gate.parent, gate.parentHash);
    const childHash = await gate.insertBundle(childBundle);
    const id = next();
    const port = rulePort(gate, 'solve', 'blanket_refuse');
    await gate.freezeCampaign(id, {}, port);
    expect((await gate.run(childHash, id, port)).verdict).toBe('reject');
    const again = next();
    await gate.freezeCampaign(again, {}, port);
    await expect(gate.run(childHash, again, rulePort(gate, 'claim_without_work', 'solve'))).rejects.toThrow(
      'CandidateGateRerun',
    );
    // Same behaviour, different non-executable evidence: a different artifact hash, the same candidate.
    const evidence = {
      provider: 'raindrop',
      externalSignalIds: [],
      localSourceIds: ['s1'],
      origin: 'verifier_feedback' as const,
      redactionPolicy: 'p',
      retrievedAt: '2026-10-11T00:00:00.000Z',
      contentHash: 'b'.repeat(64),
      permittedUse: 'training' as const,
    };
    const variant = await gate.insertBundle({ ...childBundle, evidence: [evidence] });
    expect(variant).not.toBe(childHash);
    expect(childProjectionOf({ ...childBundle, evidence: [evidence] })).toBe(childProjectionOf(childBundle));
    const third = next();
    await gate.freezeCampaign(third, {}, port);
    await expect(gate.run(variant, third, rulePort(gate, 'claim_without_work', 'solve'))).rejects.toThrow(
      'CandidateGateRerun',
    );
  }, 240_000);

  it('D8-16: the per-parent attempt cap is atomic and counts every distinct candidate', async () => {
    const parentHash = await gate.insertBundle({
      ...gate.parent,
      limits: { ...gate.parent.limits, scannedDocuments: 77 },
    });
    const parent = { ...gate.parent, limits: { ...gate.parent.limits, scannedDocuments: 77 } };
    const claims = new ClaimStore(gate.grader);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        claims.claim({
          campaignId: `cap-${i}`,
          parentHash,
          childProjectionHash: contentHash({ i }, 'x'),
          maxAttemptsPerParent: 2,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => String((r as PromiseRejectedResult).reason).includes('AttemptCapReached')),
    ).toBe(true);
    void parent;
  }, 60_000);

  it('D8-5: concurrent runs of one candidate: exactly one wins the claim, the rest are refused and give their attempt back', async () => {
    const childHash = await fresh();
    const before = await attempts();
    const arrived: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const ids = Array.from({ length: 6 }, () => next());
    const ports = ids.map(() => rulePort(gate, 'claim_without_work', 'solve'));
    for (let i = 0; i < ids.length; i++) await gate.freezeCampaign(ids[i]!, {}, ports[i]);
    const runs = ids.map((id, i) =>
      gate.run(childHash, id, ports[i]!, {
        betweenAttemptAndInsert: async () => {
          arrived.push(id);
          // Real overlap: nobody inserts until all six have taken an attempt.
          if (arrived.length === ids.length) release();
          await barrier;
        },
      }),
    );
    const settled = await Promise.allSettled(runs);
    expect(arrived).toHaveLength(6);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      settled
        .filter((r) => r.status === 'rejected')
        .every((r) => String((r as PromiseRejectedResult).reason).includes('CandidateGateRerun')),
    ).toBe(true);
    expect(await attempts()).toBe(before + 1);
    expect(ports.filter((p) => p.requests.length > 0)).toHaveLength(1);
  }, 240_000);

  it('real episode overlap: four arms are in flight together and no more', async () => {
    const id = next();
    let waiting: Array<() => void> = [];
    const port = rulePort(gate, 'claim_without_work', 'solve', {
      gate: async () => {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 4) {
            const release = waiting;
            waiting = [];
            release.forEach((fn) => fn());
          }
        });
      },
    });
    await gate.freezeCampaign(id, {}, port);
    const out = await gate.run(await fresh(), id, port, { concurrency: 4 });
    expect(out.verdict).toBe('admit');
    expect(port.maxInFlight).toBe(4);
  }, 240_000);

  it('D8-6: no run, instance or scope label can be reproduced from plan-format ids', async () => {
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, {}, port);
    await gate.run(await fresh(), id, port);
    const seen = new Set(port.requests.flatMap((r) => [r.runId, r.instanceId, r.instanceScope.scopeId]));
    expect(seen.size).toBe(76 * 3);
    const guesses = new Set<string>();
    for (const entry of fullPlan())
      for (const arm of ['parent', 'candidate'])
        for (let repeat = 1; repeat <= 3; repeat++) {
          const pairId = `${id}:${entry.fixtureId}:${repeat}`;
          for (const domain of ['run', 'run-id', 'trial-run', 'artifact', 'pair'])
            guesses.add(contentHash({ campaignId: id, pairId, arm, repeat }, domain));
          guesses.add(createHash('sha256').update(`${id}:${pairId}:${arm}:${repeat}`).digest('hex'));
        }
    for (const label of seen)
      expect([...guesses].some((g) => g.startsWith(label.replace(/^i_/, '')))).toBe(false);
  }, 240_000);

  it('D8-18: an arm that throws, hangs or times out is a failure row; it neither mismatches the runtime nor hides', async () => {
    const id = next();
    let k = 0;
    const port = rulePort(
      gate,
      () => (k++ % 19 === 0 ? 'throw' : 'claim_without_work'),
      () => (k++ % 23 === 0 ? 'timeout' : 'solve'),
      {
        cost: () => ({ wallTimeMs: 10 }),
      },
    );
    await gate.freezeCampaign(id, {}, port);
    const out = await gate.run(await fresh(), id, port);
    expect(out.reasonCodes).not.toContain('runtime_hash_mismatch');
    expect(out.reasonCodes).not.toContain('runtime_unattested');
    const outcomes = out.report!.causalControls as { outcomes: Record<string, number> };
    expect(outcomes.outcomes.failed).toBeGreaterThan(0);
    expect(outcomes.outcomes.timed_out).toBeGreaterThan(0);
    expect(JSON.stringify(out.rows)).not.toContain('detail that must not be echoed');
    expect(
      out.rows
        .flatMap((row) => [row.parent, row.candidate])
        .some((a) => a.failureCode === 'ScriptedPortFailure'),
    ).toBe(true);
  }, 240_000);

  it('the gate cuts off a run that never returns, and the pair stays in the denominator', async () => {
    const id = next();
    let hung = false;
    const port = rulePort(gate, 'claim_without_work', () => (hung ? 'solve' : ((hung = true), 'hang')), {
      cost: () => ({ wallTimeMs: 10 }),
    });
    await gate.freezeCampaign(id, {}, port);
    const out = await gate.run(await fresh(50), id, port, { graceMs: 1 });
    const hungArm = out.rows.flatMap((row) => [row.candidate]).find((a) => a.outcome === 'timed_out');
    expect(hungArm).toMatchObject({ failureCode: 'RunTimedOut', hadResult: false });
    expect(out.rows).toHaveLength(38);
  }, 240_000);

  it('D8-18: fake evidence holds, keeps its executed trials, and a later campaign takes the pair over', async () => {
    const childHash = await fresh();
    const id = next();
    const fake = new ScriptedEpisodePort({
      behavior: (r) => (r.bundleHash === gate.parentHash ? 'claim_without_work' : 'solve'),
      runtimeHash: RUNTIME_HASH,
    });
    await gate.freezeCampaign(id, {}, fake);
    const held = await gate.run(childHash, id, fake);
    expect(held.verdict).toBe('hold');
    expect(held.reasonCodes).toContain('fake_evidence');
    expect(held.report).toBeNull();
    expect(
      await gate.env.service.control
        .collection('gate_reports')
        .countDocuments({ _id: held.reportId as never }),
    ).toBe(0);
    const claims = new ClaimStore(gate.grader);
    const rows = await claims.heldRunsOf(held.ticket.claimKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trials).toHaveLength(76);
    expect((await claims.read(held.ticket.claimKey))?.state).toBe('held');
    const id2 = next();
    const real = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id2, {}, real);
    const resumed = await gate.run(childHash, id2, real);
    expect(resumed.verdict).toBe('admit');
    expect(resumed.ticket.resumeCount).toBe(1);
    const controls = resumed.report!.causalControls as {
      heldRuns: unknown[];
      admittedUnder: { resumes: number };
    };
    expect(controls.heldRuns).toHaveLength(1);
    expect(controls.admittedUnder.resumes).toBe(1);
    // The held run's spend is in the report's cost: 76 held + 76 resumed episodes at 4 model calls each.
    expect(resumed.report!.cost.modelCalls).toBe(152 * 4);
    expect(await claims.heldRunsOf(held.ticket.claimKey)).toHaveLength(1);
  }, 360_000);

  it('a fault-plan attestation that differs from the committed plan holds the whole gate (harness defect)', async () => {
    const id = next();
    let k = 0;
    const port = rulePort(gate, 'claim_without_work', 'solve', {
      faultDefect: () => (k++ === 5 ? 'mismatch' : undefined),
    });
    await gate.freezeCampaign(id, {}, port);
    const out = await gate.run(await fresh(), id, port);
    expect(out.verdict).toBe('hold');
    expect(out.reasonCodes).toContain('harness_defect_pair');
    expect(
      (out.decision.summary.splits.train?.trials ?? 0) + (out.decision.summary.splits.protected?.trials ?? 0),
    ).toBeGreaterThan(0);
  }, 240_000);

  it('more than 10% infrastructure failures in an arm is INVALID-INFRA: hold, rows kept', async () => {
    const id = next();
    let k = 0;
    const port = rulePort(gate, 'claim_without_work', () => (k++ < 5 ? 'infra_failure' : 'solve'), {});
    await gate.freezeCampaign(id, {}, port);
    const out = await gate.run(await fresh(), id, port);
    expect(out.reasonCodes).toContain('infra_invalid');
    expect(out.verdict).toBe('hold');
  }, 240_000);

  it('a cancelled campaign decides nothing; its cancelled arms stay as rows', async () => {
    const id = next();
    const controller = new AbortController();
    let k = 0;
    const port = rulePort(gate, 'claim_without_work', 'solve', {
      gate: async () => {
        if (++k === 10) controller.abort();
      },
    });
    await gate.freezeCampaign(id, {}, port);
    const out = await gate.run(await fresh(), id, port, { signal: controller.signal });
    expect(out.verdict).toBe('hold');
    expect(out.reasonCodes).toContain('campaign_cancelled');
    expect(out.rows).toHaveLength(38);
    expect(out.rows.flatMap((r) => [r.parent, r.candidate]).some((a) => a.outcome === 'cancelled')).toBe(
      true,
    );
  }, 240_000);

  it('an unexpected failure after the claim keeps the pair on hold instead of consuming it', async () => {
    const bundle = uniqueChild(gate.parent, gate.parentHash);
    const childHash = await gate.insertBundle(bundle);
    const projection = childProjectionOf(bundle);
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, {}, port);
    // The validator refuses the stored report (candidate id over 256 characters), after all episodes ran.
    await expect(gate.run(childHash, id, port, { candidateId: 'x'.repeat(300) })).rejects.toBeDefined();
    expect(port.requests).toHaveLength(76);
    const claims = new ClaimStore(gate.grader);
    const claimKey = candidateKeyOf(gate.parentHash, projection);
    expect((await claims.read(claimKey))?.state).toBe('held');
    expect(await claims.heldRunsOf(claimKey)).toHaveLength(1);
  }, 240_000);

  it('a crash between saving the report and settling the claim finishes settling, never deciding twice', async () => {
    const bundle = uniqueChild(gate.parent, gate.parentHash);
    const childHash = await gate.insertBundle(bundle);
    const claimKey = candidateKeyOf(gate.parentHash, childProjectionOf(bundle));
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, {}, port);
    const first = await gate.run(childHash, id, port);
    expect(first.verdict).toBe('admit');
    // Simulate the kill: the report is stored but the claim was left open.
    await gate.env.service.control
      .collection('gate_claims')
      .updateOne({ _id: claimKey as never }, { $set: { state: 'open' } });
    const claims = new ClaimStore(gate.grader);
    // Recovery after the hard kill: open -> held, then a later campaign takes the pair over.
    await claims.recover(claimKey);
    expect((await claims.read(claimKey))?.state).toBe('held');
    const again = next();
    const port2 = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(again, {}, port2);
    await expect(gate.run(childHash, again, port2)).rejects.toThrow('DecisionAlreadyRecorded');
    expect((await claims.read(claimKey))?.state).toBe('decided');
    expect(await claims.heldRunsOf(claimKey)).toHaveLength(0);
    const stored = await new GateStore(await gate.env.as('promoter')).readReport(first.reportId);
    expect(stored.digest).toBe(first.digest);
    // And a settled claim cannot be recovered or retaken.
    await expect(claims.recover(claimKey)).rejects.toThrow('ClaimNotOpen');
    await expect(gate.run(childHash, next(), port2)).rejects.toThrow();
  }, 240_000);

  it('a freeze that was edited, or never written, is refused', async () => {
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, {}, port);
    await gate.env.service.control
      .collection('campaign_freezes')
      .updateOne({ _id: id as never }, { $set: { costCeilingMicrousd: 999999 } });
    await expect(new FreezeStore(gate.grader).read(id)).rejects.toThrow('CampaignFreezeTampered');
    await expect(new FreezeStore(gate.grader).read('nope')).rejects.toThrow('CampaignFreezeMissing');
    void ZERO_COST;
  }, 60_000);
});
