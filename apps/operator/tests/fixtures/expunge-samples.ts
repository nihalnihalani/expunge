/** Historical fixture payloads, excluded from real-data/default acceptance. Never import into production. */
import type { ProjectionPayloadByKind } from '../../src/shared/expunge.js';
import { hex } from './expunge-data.js';

const when = '2026-10-11T09:00:00.000Z';
/** Retired fields stay in this test-only alias; current worker-readable payload types remain minimized. */
type HistoricalProjectionPayloadByKind = Omit<
  ProjectionPayloadByKind,
  'trial_completed' | 'campaign_row_committed'
> & {
  trial_completed: ProjectionPayloadByKind['trial_completed'] & {
    split: 'train' | 'protected' | 'validation' | 'final';
    parentUseful: boolean;
    candidateUseful: boolean;
  };
  campaign_row_committed: ProjectionPayloadByKind['campaign_row_committed'] & {
    admitted?: boolean;
  };
};
export const samplePayloads: HistoricalProjectionPayloadByKind = {
  job_started: {
    jobKind: 'cleanup',
    harnessHash: hex('h'),
    worldId: 'world-northwind',
    scopeRevision: 4,
    attempt: 1,
  },
  tool_decided: {
    stepId: 's1',
    phase: 'discover',
    toolId: 'discover_references',
    decision: 'allow',
    ruleIds: ['r1'],
    summary: 'Discovered references.',
  },
  effect_committed: {
    receiptId: 'r1',
    stepId: 's2',
    batchOrdinal: 0,
    effectKind: 'redact',
    collectionId: 'accounts',
    appliedCount: 2,
    resultingWorldRevision: 215,
    nodeIds: ['n1'],
  },
  evidence_ready: {
    evidenceId: 'e1',
    provider: 'raindrop',
    externalSignalIds: [],
    origin: 'verifier_feedback',
    outboxState: 'evidence_ready',
    truncated: false,
    missing: [],
    contentHash: hex('c'),
    permittedUse: 'training',
  },
  candidate_proposed: {
    candidateId: 'c1',
    target: 'worker',
    parentHash: hex('p'),
    childHash: hex('c'),
    claimedClass: 'tightening',
    computedClass: 'tightening',
    surfaces: ['guardrails'],
    hypothesis: 'h',
    state: 'proposed',
  },
  trial_completed: {
    reportId: null,
    candidateId: 'c1',
    pairId: 'p1',
    family: 'f',
    split: 'train',
    parentUseful: false,
    candidateUseful: true,
    verdict: null,
  },
  approval_required: {
    proposalId: 'prop1',
    candidateId: 'c1',
    computedClass: 'authority_expansion',
    flipSetDigest: hex('f'),
    expiresAt: when,
  },
  harness_promoted: {
    promotionId: 'pr1',
    target: 'worker',
    fromHash: hex('a'),
    toHash: hex('b'),
    fromRevision: 1,
    toRevision: 2,
    gateReportId: 'g1',
    consumedGrantId: null,
  },
  receipt_committed: {
    receiptId: 'rc1',
    domainStatus: 'incomplete',
    externalErasureStatus: 'pending',
    verifiedWorldRevision: 215,
  },
  external_erasure_updated: {
    requestKey: 'rk1',
    providerStatus: 'pending',
    dueBy: null,
    completedAt: null,
    subjectCount: 1,
    snapshotHash: hex('s'),
  },
  job_failed: {
    code: 'internal_error',
    retryable: false,
    phase: null,
    message: 'm',
  },
  job_status_changed: { from: 'running', to: 'waiting_evidence', reason: 'r' },
  cancel_requested: { requestedAt: when, by: 'owner' },
  approval_resolved: {
    proposalId: 'prop1',
    decision: 'declined',
    grantId: null,
  },
  harness_rolled_back: {
    promotionId: 'pr2',
    target: 'worker',
    fromHash: hex('b'),
    toHash: hex('a'),
    testedParentHash: hex('a'),
    reason: 'r',
  },
  retraction_progress: {
    retractionId: 'ret1',
    sourceId: 'src1',
    frontierSize: 2,
    visited: 10,
    closureComplete: false,
    revoked: 1,
    regenerated: 0,
    runsCancelled: 0,
    failClosed: true,
  },
  campaign_row_committed: {
    campaignId: 'cp1',
    manifestHash: hex('m'),
    kind: 'meta',
    rowId: 'row1',
    result: 'null',
  },
};
