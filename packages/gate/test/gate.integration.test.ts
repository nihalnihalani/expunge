import { afterAll, beforeAll, expect, it } from 'vitest';
import { GateStore, ClaimStore, candidateKeyOf, childProjectionOf, reportDigestOf } from '../src/index.js';
import { describeLive } from '../../mongo/test/support.js';
import { childOf, openGate, rulePort, type Gate } from './support.js';

let gate: Gate;
let n = 0;
const next = () => `camp-${++n}`;

describeLive('runGate on a real replica set (SCRIPTED port declaring committed evidence: rule tests)', () => {
  beforeAll(async () => {
    gate = await openGate('gate');
  }, 60_000);
  afterAll(async () => {
    if (gate) await gate.env.dispose();
  }, 30_000);

  it('admits a child that fixes what the parent misses, and stores one digest-checked report', async () => {
    const childHash = await gate.insertBundle(childOf(gate.parent, gate.parentHash, 4));
    const id = next();
    const port = rulePort(gate, 'claim_without_work', 'solve');
    await gate.freezeCampaign(id, {}, port);
    const out = await gate.run(childHash, id, port);
    expect(out.reasonCodes).toEqual([]);
    expect(out.verdict).toBe('admit');
    expect(out.rows).toHaveLength(38);
    expect(port.requests).toHaveLength(76);
    const stored = await new GateStore(await gate.env.as('promoter')).readReport(out.reportId);
    expect(stored.digest).toBe(out.digest);
    expect(stored.digest).toBe(reportDigestOf(out.report!));
    expect(stored.report.computedClass).toBe('behavioral');
    expect(stored.report.verdict).toBe('admit');
    expect(stored.report.pairedTrials).toHaveLength(38);
    const claim = await new ClaimStore(gate.grader).read(
      candidateKeyOf(gate.parentHash, childProjectionOf(childOf(gate.parent, gate.parentHash, 4))),
    );
    expect(claim?.state).toBe('decided');
  }, 120_000);
});
