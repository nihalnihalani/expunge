/** FIXTURE deployment lineage for the worker target; improver has none, hider has the initial bundle only. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex } from '../expunge-data.js';
import type { DeploymentView } from '../../../src/shared/expunge.js';

export default function registerLineage(state: FixtureState) {
  const w0 = hex('bundle-w0');
  const v1 = hex('bundle-v1');
  const v2 = hex('bundle-v2');
  const v3 = hex('bundle-v3');
  const worker: DeploymentView & { refusedRollbacks: unknown[] } = {
    target: 'worker',
    activeHash: v2,
    revision: 4,
    scopeRevision: 4,
    authorizationRevision: 2,
    initialBundleHash: w0,
    versions: [
      {
        hash: w0,
        parentHash: null,
        testedParentHash: null,
        authorityClass: null,
        state: 'previous',
        promotion: null,
        rollback: null,
      },
      {
        hash: v1,
        parentHash: w0,
        testedParentHash: w0,
        authorityClass: 'behavioral',
        state: 'previous',
        promotion: {
          promotionId: 'promo-1',
          gateReportId: 'gate-1',
          consumedGrantId: null,
          at: '2026-10-11T09:10:00.000Z',
        },
        rollback: null,
      },
      {
        hash: v2,
        parentHash: v1,
        testedParentHash: w0,
        authorityClass: 'authority_expansion',
        state: 'active',
        promotion: {
          promotionId: 'promo-2',
          gateReportId: 'gate-2',
          consumedGrantId: 'grant-proposal-1',
          at: '2026-10-11T09:40:00.000Z',
        },
        rollback: null,
      },
      {
        hash: v3,
        parentHash: v1,
        testedParentHash: v1,
        authorityClass: 'tightening',
        state: 'rolled_back',
        promotion: {
          promotionId: 'promo-3',
          gateReportId: 'gate-3',
          consumedGrantId: null,
          at: '2026-10-11T09:20:00.000Z',
        },
        rollback: {
          promotionId: 'rollback-1',
          toHash: v1,
          reason: 'regression on protected rows after promotion',
          at: '2026-10-11T09:30:00.000Z',
        },
      },
    ],
    rejected: [
      {
        candidateId: 'cand-unsafe',
        childHash: hex('bundle-unsafe'),
        reasonCodes: ['retention_violation', 'untruthful_terminal'],
      },
    ],
    refusedRollbacks: [
      {
        toHash: w0,
        code: 'RollbackNeedsGrant',
        at: '2026-10-11T09:50:00.000Z',
      },
    ],
  };
  state.deployments.set('worker', worker);
  state.deployments.set('hider', {
    target: 'hider',
    activeHash: hex('hider-w0'),
    revision: 1,
    scopeRevision: 4,
    authorizationRevision: 2,
    initialBundleHash: hex('hider-w0'),
    versions: [
      {
        hash: hex('hider-w0'),
        parentHash: null,
        testedParentHash: null,
        authorityClass: null,
        state: 'active',
        promotion: null,
        rollback: null,
      },
    ],
    rejected: [],
  });
}
