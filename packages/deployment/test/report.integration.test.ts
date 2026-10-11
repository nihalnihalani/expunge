import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeLive } from '../../mongo/test/support.js';
import { loadAdmittedReport } from './api.js';
import { TEST_FIXTURE_LABEL } from '../src/report.js';
import { insertLabeledAdmitReport } from './admitted-report.js';
import { childBundle, openRig, scope, type Rig } from './support.js';

let rig: Rig;
let n = 0;
const OPTS = { allowTestFixtures: true };

/** Stores a labeled admit report for a fresh child and returns what a consumer would be handed. */
async function stage(
  over: Partial<Parameters<typeof insertLabeledAdmitReport>[1]> = {},
  childOver: Parameters<typeof childBundle>[1] = {},
) {
  const child = childBundle(rig.parentHash, childOver);
  const childHash = await rig.insert(child);
  const stored = await insertLabeledAdmitReport(rig.grader, {
    candidateId: `cand-${++n}`,
    parentHash: rig.parentHash,
    childHash,
    parent: rig.parent,
    child,
    ...over,
  });
  return {
    child,
    childHash,
    request: {
      reportId: stored.report.reportId,
      parentHash: rig.parentHash,
      childHash,
      scope,
    },
    stored,
  };
}

describeLive('loadAdmittedReport refuses everything it cannot re-derive (real replica set)', () => {
  beforeAll(async () => {
    rig = await openRig('depreport');
  }, 60_000);
  afterAll(async () => {
    if (rig) await rig.env.dispose();
  }, 30_000);

  it('loads a genuine admit with every field recomputed', async () => {
    const { request, stored } = await stage();
    const loaded = await loadAdmittedReport(
      rig.promoter,
      { ...request, expectedDigest: stored.digest },
      OPTS,
    );
    expect(loaded.digest).toBe(stored.digest);
    expect(loaded.computedClass).toBe('behavioral');
    expect(loaded.report.verdict).toBe('admit');
  });

  const refuse = (label: string, code: string, run: () => Promise<unknown>) =>
    it(`${label} -> ${code}`, async () => {
      await expect(run()).rejects.toThrow(code);
    });

  refuse('a label-bearing fixture report without the opt-in', 'GateReportFixture', async () => {
    const { request } = await stage();
    return loadAdmittedReport(rig.promoter, request);
  });
  refuse('a report that was rejected', 'GateReportNotAdmitted', async () => {
    const { request } = await stage({ verdict: 'reject' });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report id the request invented', 'GateReportIdMismatch', async () => {
    const { request } = await stage();
    return loadAdmittedReport(rig.promoter, { ...request, reportId: 'a'.repeat(64) }, OPTS);
  });
  refuse('a different artifact with the same projection (N-2)', 'GateReportChildMismatch', async () => {
    const { request, child } = await stage();
    const sibling = await rig.insert({
      ...child,
      evidence: [
        {
          provider: 'raindrop',
          externalSignalIds: [],
          localSourceIds: ['s'],
          origin: 'verifier_feedback',
          redactionPolicy: 'p',
          retrievedAt: '2026-10-11T00:00:00.000Z',
          contentHash: 'b'.repeat(64),
          permittedUse: 'training',
        },
      ],
    });
    return loadAdmittedReport(rig.promoter, { ...request, childHash: sibling }, OPTS);
  });
  refuse('a class that is not the recomputed one', 'GateReportClassMismatch', async () => {
    const { request } = await stage({ computedClass: 'tightening' });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('flips that are not the recomputed ones', 'GateReportFlipsMismatch', async () => {
    const { request } = await stage({ over: { knownAuthorityFlips: ['toolPolicy.grants'] } });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a digest that is not the stored body', 'GateReportDigestMismatch', async () => {
    const { request } = await stage();
    return loadAdmittedReport(rig.promoter, { ...request, expectedDigest: 'f'.repeat(64) }, OPTS);
  });
  refuse('a report decided under another evaluator (D8-11)', 'GateReportEvaluatorStale', async () => {
    const { request } = await stage({ over: { evaluatorHash: '1'.repeat(64) } });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report decided under another generator', 'GateReportGeneratorStale', async () => {
    const { request } = await stage({ over: { fixtureGeneratorHash: '1'.repeat(64) } });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report decided under another compiler', 'GateReportCompilerStale', async () => {
    const { request } = await stage({ underOver: { compilerHash: '1'.repeat(64) } });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report decided under another rule', 'GateReportRuleStale', async () => {
    const { request } = await stage({ underOver: { ruleHash: '1'.repeat(64) } });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report decided on a fake port', 'GateReportEvidenceNotReal', async () => {
    const { request } = await stage({
      underOver: {
        evidence: { portKind: 'fake', portLabel: TEST_FIXTURE_LABEL, modelKind: 'provider', profileId: 'x' },
      },
    });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report decided on a fake model', 'GateReportEvidenceNotReal', async () => {
    const { request } = await stage({
      underOver: {
        evidence: { portKind: 'worker', portLabel: TEST_FIXTURE_LABEL, modelKind: 'fake', profileId: 'x' },
      },
    });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report with no provenance of how it was decided', 'GateReportEvidenceMissing', async () => {
    const { request } = await stage({ over: { causalControls: {} } });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a child whose evidence source has since been revoked', 'GateReportSourceIneligible', async () => {
    const evidence = {
      provider: 'raindrop',
      externalSignalIds: [],
      localSourceIds: ['s'],
      origin: 'verifier_feedback' as const,
      redactionPolicy: 'p',
      retrievedAt: '2026-10-11T00:00:00.000Z',
      contentHash: '7'.repeat(64),
      permittedUse: 'training' as const,
    };
    const { request } = await stage({}, { evidence: [evidence] });
    await rig.env.service.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash: evidence.contentHash,
      state: 'revoked',
      policyHash: 'a'.repeat(64),
      reasonCode: 'source_retracted',
      sourceIds: [],
      updatedAt: new Date(),
    } as never);
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  refuse('a report that does not exist', 'GateReportMissing', async () => {
    const { request } = await stage();
    await rig.env.service.control.collection('gate_reports').deleteOne({ _id: request.reportId as never });
    return loadAdmittedReport(rig.promoter, request, OPTS);
  });
  it('an edited stored report no longer matches the digest the grant was bound to', async () => {
    const { request, stored } = await stage();
    await rig.env.service.control
      .collection('gate_reports')
      .updateOne(
        { _id: request.reportId as never },
        { $set: { cost: { ...stored.report.cost, modelCalls: 1 } } },
      );
    await expect(
      loadAdmittedReport(rig.promoter, { ...request, expectedDigest: stored.digest }, OPTS),
    ).rejects.toThrow('GateReportDigestMismatch');
  });
});
