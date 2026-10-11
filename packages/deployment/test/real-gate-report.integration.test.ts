/**
 * DP-1: a report written by a real `runGate` (here over the labeled SCRIPTED port that declares committed evidence, the
 * only way to get an admit without a provider model) is read by the deployment loader. It has the shape the gate really
 * builds, and the loader refuses it unless the test lifts the SCRIPTED label refusal.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeLive } from '../../mongo/test/support.js';
import { childOf, openGate, rulePort, type Gate } from '../../gate/test/support.js';
import { loadAdmittedReport } from './api.js';

let gate: Gate;
describeLive('loadAdmittedReport on a report a real runGate wrote', () => {
  beforeAll(async () => {
    gate = await openGate('depgate');
  }, 60_000);
  afterAll(async () => {
    if (gate) await gate.env.dispose();
  }, 30_000);

  it('reads the gate-built report; the SCRIPTED label is refused outside the tests', async () => {
    const childHash = await gate.insertBundle(childOf(gate.parent, gate.parentHash, 4));
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign('dep-gate-1', {}, port);
    const out = await gate.run(childHash, 'dep-gate-1', port);
    expect(out.verdict).toBe('admit');
    const promoter = await gate.env.as('promoter');
    const request = {
      reportId: out.reportId,
      parentHash: gate.parentHash,
      childHash,
      scope: { tenantId: 'owner-tenant', env: 'dev' as const, scopeId: 'owner-scope' },
    };
    await expect(loadAdmittedReport(promoter, request)).rejects.toThrow('GateReportFixture');
    const loaded = await loadAdmittedReport(
      promoter,
      { ...request, expectedDigest: out.digest! },
      { allowTestFixtures: true },
    );
    expect(loaded.digest).toBe(out.digest);
    expect(loaded.computedClass).toBe('behavioral');
    expect(loaded.admittedUnder.attempt).toEqual({ ordinal: 1, parentAttempts: 1 });
    expect(loaded.report.pairedTrials).toHaveLength(38);
  }, 120_000);
});
