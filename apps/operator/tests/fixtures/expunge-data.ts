/**
 * Deterministic synthetic data for Expunge UI and protocol tests.
 * FIXTURE DATA: nothing here is a live job, a model run or a database result.
 */
import { createHash } from 'node:crypto';
import type {
  ExpungeJobSnapshotV2,
  GraphNodeState,
  JobPhase,
  PhaseState,
  ProjectionKind,
  ProjectionPayloadByKind,
  TypedProjectionEvent,
  WorldSummary,
  CleanupPreview,
} from '../../src/shared/expunge.js';
import { JOB_PHASES } from '../../src/shared/expunge.js';

export const hex = (seed: string) =>
  createHash('sha256').update(seed).digest('hex');
export const NOW = '2026-10-11T09:00:00.000Z';
export const later = (seconds: number) =>
  new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const zeroStates: Record<GraphNodeState, number> = {
  discovered: 0,
  inspected: 0,
  previewed: 0,
  applied: 0,
  retained: 0,
  excluded: 0,
  residual: 0,
  not_inspected: 0,
};

export const COLLECTIONS = [
  'customers',
  'accounts',
  'orders',
  'tickets',
  'audit_events',
  'payments_archive',
] as const;

export function phaseStates(
  active: JobPhase | null,
  committedThrough: number,
): Record<JobPhase, PhaseState> {
  return Object.fromEntries(
    JOB_PHASES.map((phase, index) => [
      phase,
      index < committedThrough
        ? 'committed'
        : phase === active
          ? 'active'
          : 'pending',
    ]),
  ) as Record<JobPhase, PhaseState>;
}

export function baseSnapshot(
  jobId: string,
  patch: Partial<ExpungeJobSnapshotV2> = {},
): ExpungeJobSnapshotV2 {
  return {
    schemaVersion: 2,
    jobId,
    kind: 'cleanup',
    status: 'running',
    sequence: 3,
    runId: `run-${jobId}`,
    harness: {
      hash: hex('harness-w0'),
      parentHash: null,
      activeRevision: 1,
    },
    scope: { scopeId: 'synthetic-company', scopeRevision: 4, env: 'demo' },
    world: {
      worldId: 'world-northwind',
      revision: 214,
      maintenanceMode: false,
    },
    subject: {
      display: 'customers / 7f3a…c1 (objectId)',
      identityHash: hex('subject-7f3a'),
      idType: 'objectId',
    },
    phase: 'discover',
    phaseStates: phaseStates('discover', 2),
    cancellation: { requested: false, requestedAt: null },
    coverage: {
      registeredCollectionIds: [...COLLECTIONS],
      inspectedCollectionIds: ['customers', 'accounts', 'orders'],
      discoveredFieldIds: [
        'customers.email',
        'accounts.ownerId',
        'orders.accountId',
      ],
      completeness: 'declared',
      limitations: [],
    },
    limits: {
      modelCalls: { used: 4, cap: 12 },
      toolCalls: { used: 11, cap: 96 },
      scannedDocuments: { used: 212, cap: 500 },
      changedDocuments: { used: 0, cap: 50 },
      traversalDepth: { used: 2, cap: 5 },
      graphNodes: { used: 18, cap: 300 },
      graphEdges: { used: 21, cap: 600 },
      wallTimeMs: { used: 18_000, cap: 120_000 },
      totalTokens: { used: 6_400, cap: 24_000 },
      costMicrousd: { used: 8_100, cap: 200_000 },
      unpricedCalls: 0,
    },
    graph: {
      artifactId: null,
      nodeCount: 0,
      edgeCount: 0,
      truncated: false,
      byState: { ...zeroStates },
    },
    evidence: { outboxState: null, evidenceReady: false, truncated: false },
    approval: { state: 'none', proposalId: null, expiresAt: null },
    receipt: null,
    artifacts: [],
    externalErasure: null,
    cost: {
      modelCalls: 4,
      toolCalls: 11,
      inputTokens: 5_100,
      outputTokens: 1_300,
      costMicrousd: 8_100,
      unpricedCalls: 0,
      mongoOperations: 37,
      wallTimeMs: 18_000,
    },
    updatedAt: later(60),
    ...patch,
  };
}

export function event<K extends ProjectionKind>(
  jobId: string,
  sequence: number,
  kind: K,
  payload: ProjectionPayloadByKind[K],
  artifactIds: string[] = [],
): TypedProjectionEvent {
  return {
    eventId: `evt-${jobId}-${sequence}`,
    sequence,
    jobId,
    runId: `run-${jobId}`,
    kind,
    artifactIds,
    payload,
  } as TypedProjectionEvent;
}

export const startedPayload: ProjectionPayloadByKind['job_started'] = {
  jobKind: 'cleanup',
  harnessHash: hex('harness-w0'),
  worldId: 'world-northwind',
  scopeRevision: 4,
  attempt: 1,
};

export const world: WorldSummary = {
  worldId: 'world-northwind',
  label: 'Northwind Synthetics (synthetic demo company)',
  env: 'demo',
  scopeId: 'synthetic-company',
  scopeRevision: 4,
  worldRevision: 214,
  maintenanceMode: false,
  collectionIds: [...COLLECTIONS],
  fieldCount: 31,
  referenceEdgeCount: 9,
  allowedEffectKinds: ['delete', 'redact', 'restrict', 'tombstone'],
  eligibilityPolicyId: 'owner-policy-v1',
  eligibilityPolicyHash: hex('owner-policy-v1'),
  documentLimits: { maxScanned: 500, maxChanged: 50 },
  discoveryCompleteness: {
    kind: 'partial',
    limitations: [
      'payments_archive is registered but its reference fields are not declared.',
    ],
  },
};

export const preview: CleanupPreview = {
  previewId: 'preview-1',
  basis: 'expert_static_discovery',
  worldId: world.worldId,
  worldRevision: 214,
  scopeRevision: 4,
  subject: {
    display: 'customers / 7f3a…c1 (objectId)',
    identityHash: hex('subject-7f3a'),
    idType: 'objectId',
  },
  perCollection: [
    {
      collectionId: 'customers',
      exactIdentityMatches: 1,
      eligibleEffects: { delete: 1 },
      retained: 0,
      notInspected: false,
    },
    {
      collectionId: 'accounts',
      exactIdentityMatches: 2,
      eligibleEffects: { redact: 2 },
      retained: 1,
      notInspected: false,
    },
    {
      collectionId: 'orders',
      exactIdentityMatches: 5,
      eligibleEffects: { tombstone: 3, restrict: 2 },
      retained: 4,
      notInspected: false,
    },
    {
      collectionId: 'payments_archive',
      exactIdentityMatches: 0,
      eligibleEffects: {},
      retained: 0,
      notInspected: true,
    },
  ],
  limitations: [
    'payments_archive was not inspected: it declares no reference fields.',
  ],
  expiresAt: later(900),
};
