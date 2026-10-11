import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { parseEventsPage } from '../src/server/expunge/schemas.js';
import {
  CANDIDATE_STATES,
  EFFECT_KINDS,
  EXTERNAL_ERASURE_STATUSES,
  JOB_FAILURE_CODES,
  JOB_KINDS,
  JOB_PHASES,
  JOB_STATUSES,
  MUTATION_CLASSES,
  OUTBOX_STATES,
  POLICY_RESULTS,
  PROJECTION_KINDS,
  PROVIDER_ERASURE_STATUSES,
  SOURCE_ORIGINS,
  TARGET_KINDS,
  TOOL_IDS,
} from '../src/shared/expunge.js';
import { hex } from './fixtures/expunge-data.js';

// The operator is a standalone npm project and cannot import @expunge/contracts as a package.
// Its mirrored vocabulary is compared with the contracts source text, and its payload schemas
// are run differentially against the contracts' own strict schemas, so a rename, a new member,
// or a bound the backend may write but the operator would refuse fails here instead of in
// production.
const index = new URL(
  '../../../packages/contracts/src/index.ts',
  import.meta.url,
);
const projection = new URL(
  '../../../packages/contracts/src/projection.ts',
  import.meta.url,
);
const present = existsSync(index) && existsSync(projection);
const source = present
  ? readFileSync(index, 'utf8') + '\n' + readFileSync(projection, 'utf8')
  : '';
const literals = (text: string | undefined) =>
  [...(text ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
const unionOf = (name: string) =>
  literals(source.match(new RegExp(`export type ${name} =([^;]+);`))?.[1]);
const arrayOf = (name: string) =>
  literals(source.match(new RegExp(`${name} = \\[([^\\]]+)\\]`))?.[1]);
const fieldUnion = (field: string) =>
  literals(source.match(new RegExp(`${field}:([^;]+);`))?.[1]);
const sorted = (values: readonly string[]) => [...values].sort();

it.skipIf(!present)('mirrors the contracts vocabulary exactly', () => {
  expect(sorted(unionOf('JobKind'))).toEqual(sorted(JOB_KINDS));
  expect(sorted(unionOf('JobStatus'))).toEqual(sorted(JOB_STATUSES));
  expect(sorted(unionOf('EffectKind'))).toEqual(sorted(EFFECT_KINDS));
  expect(sorted(unionOf('OutboxState'))).toEqual(sorted(OUTBOX_STATES));
  expect(sorted(unionOf('SourceOrigin'))).toEqual(sorted(SOURCE_ORIGINS));
  expect(sorted(unionOf('MutationClass'))).toEqual(sorted(MUTATION_CLASSES));
  expect(sorted(unionOf('TargetKind'))).toEqual(sorted(TARGET_KINDS));
  expect(sorted(unionOf('JobPhase'))).toEqual(sorted(JOB_PHASES));
  expect(sorted(unionOf('PolicyResult'))).toEqual(sorted(POLICY_RESULTS));
  expect(sorted(unionOf('ToolId'))).toEqual(sorted(TOOL_IDS));
  expect(sorted(unionOf('CandidateState'))).toEqual(sorted(CANDIDATE_STATES));
  expect(sorted(unionOf('JobFailureCode'))).toEqual(sorted(JOB_FAILURE_CODES));
});

it.skipIf(!present)(
  'mirrors vocabulary declared inline in contract types',
  () => {
    expect(sorted(fieldUnion('externalErasureStatus'))).toEqual(
      sorted(EXTERNAL_ERASURE_STATUSES),
    );
    expect(sorted(arrayOf('PROVIDER_STATUSES'))).toEqual(
      sorted(PROVIDER_ERASURE_STATUSES),
    );
  },
);

it.skipIf(!present)('has exactly the same projection event kinds', () => {
  expect(sorted(arrayOf('PROJECTION_EVENT_KINDS'))).toEqual(
    sorted(PROJECTION_KINDS),
  );
});

type Contracts = {
  PROJECTION_EVENT_KINDS: readonly string[];
  validateProjectionPayload: (kind: string, payload: unknown) => unknown;
};
const when = '2026-10-11T09:00:00.000Z';
// One valid payload per kind, each at or near the contract's own maxima for ids and arrays.
const longId = 'i'.repeat(256);
const valid: Record<string, object> = {
  job_started: {
    jobKind: 'cleanup',
    harnessHash: hex('h'),
    worldId: longId,
    scopeRevision: 4,
    attempt: 1,
  },
  tool_decided: {
    stepId: longId,
    phase: 'apply',
    toolId: 'apply_cleanup_batch',
    decision: 'ask',
    ruleIds: Array(64).fill('r'),
    summary: 's'.repeat(200),
    targetCount: 3,
  },
  effect_committed: {
    receiptId: 'r',
    stepId: 's',
    batchOrdinal: 1,
    effectKind: 'tombstone',
    collectionId: 'c',
    appliedCount: 2,
    resultingWorldRevision: 9,
    nodeIds: Array(100).fill('n'),
  },
  evidence_ready: {
    evidenceId: 'e',
    provider: longId,
    externalEventId: longId,
    externalTraceId: longId,
    externalSignalIds: Array(256).fill('sig'),
    origin: 'raindrop_classifier',
    outboxState: 'query_visible',
    truncated: true,
    missing: Array(64).fill('m'),
    contentHash: hex('c'),
    permittedUse: 'display_only',
  },
  candidate_proposed: {
    candidateId: 'c',
    target: 'improver',
    parentHash: hex('p'),
    childHash: hex('q'),
    claimedClass: 'behavioral',
    computedClass: 'authority_expansion',
    surfaces: Array(16).fill('guardrails'),
    hypothesis: 'h'.repeat(1000),
    state: 'waiting_approval',
  },
  trial_completed: {
    reportId: null,
    candidateId: 'c',
    pairId: 'p',
    family: longId,
    split: 'final',
    parentUseful: true,
    candidateUseful: false,
    verdict: 'hold',
  },
  approval_required: {
    proposalId: 'p',
    candidateId: 'c',
    computedClass: 'authority_expansion',
    flipSetDigest: hex('f'),
    expiresAt: when,
  },
  harness_promoted: {
    promotionId: 'p',
    target: 'hider',
    fromHash: hex('a'),
    toHash: hex('b'),
    fromRevision: 1,
    toRevision: 2,
    gateReportId: 'g',
    consumedGrantId: 'grant',
  },
  receipt_committed: {
    receiptId: 'r',
    domainStatus: 'complete_in_registered_scope',
    externalErasureStatus: 'confirmed',
    verifiedWorldRevision: 5,
  },
  external_erasure_updated: {
    requestKey: 'k',
    providerStatus: 'in_progress',
    dueBy: when,
    completedAt: null,
    subjectCount: 100,
    snapshotHash: hex('s'),
  },
  job_failed: {
    code: 'lease_lost',
    retryable: true,
    phase: 'verify',
    message: 'm'.repeat(500),
  },
  job_status_changed: {
    from: 'queued',
    to: 'running',
    reason: 'r'.repeat(200),
  },
  cancel_requested: { requestedAt: when, by: 'system' },
  approval_resolved: { proposalId: 'p', decision: 'stale', grantId: null },
  harness_rolled_back: {
    promotionId: 'p',
    target: 'worker',
    fromHash: hex('a'),
    toHash: hex('b'),
    testedParentHash: hex('c'),
    reason: 'r'.repeat(300),
  },
  retraction_progress: {
    retractionId: 'r',
    sourceId: 's',
    frontierSize: 0,
    visited: 7,
    closureComplete: true,
    revoked: 2,
    regenerated: 1,
    runsCancelled: 1,
    failClosed: false,
  },
  campaign_row_committed: {
    campaignId: 'c',
    manifestHash: hex('m'),
    kind: 'hider',
    rowId: 'r',
    admitted: false,
    w0ResetProof: 'p'.repeat(256),
    budgetHash: hex('b'),
    result: 'invalid',
  },
};

it.skipIf(!present)(
  'accepts every payload the contracts accept, losslessly, at their bounds',
  async () => {
    const contracts = (await import(
      /* @vite-ignore */ pathToFileURL(fileURLToPath(projection)).href
    )) as Contracts;
    expect(Object.keys(valid).sort()).toEqual(
      sorted(contracts.PROJECTION_EVENT_KINDS),
    );
    for (const kind of contracts.PROJECTION_EVENT_KINDS) {
      const payload = valid[kind];
      // The sample is valid by the contracts' own strict schema...
      expect(() =>
        contracts.validateProjectionPayload(kind, payload),
      ).not.toThrow();
      // ...so the operator must forward it unchanged.
      const page = parseEventsPage(
        {
          events: [
            {
              eventId: 'e',
              sequence: 1,
              jobId: 'job-1',
              kind,
              artifactIds: [],
              payload,
            },
          ],
          nextSequence: 1,
        },
        'job-1',
        0,
      );
      expect(page.events[0].kind).toBe(kind);
      expect(page.events[0].payload).toEqual(payload);
    }
  },
);

it.skipIf(!present)(
  'refuses what the contracts refuse where the operator is the last line of defense',
  async () => {
    const contracts = (await import(
      /* @vite-ignore */ pathToFileURL(fileURLToPath(projection)).href
    )) as Contracts;
    for (const kind of contracts.PROJECTION_EVENT_KINDS) {
      const bad = { ...valid[kind], unexpectedField: 'x' };
      // The contract is strict and rejects; the operator strips instead of forwarding.
      expect(() => contracts.validateProjectionPayload(kind, bad)).toThrow();
      const page = parseEventsPage(
        {
          events: [
            {
              eventId: 'e',
              sequence: 1,
              jobId: 'job-1',
              kind,
              artifactIds: [],
              payload: bad,
            },
          ],
          nextSequence: 1,
        },
        'job-1',
        0,
      );
      expect(JSON.stringify(page)).not.toContain('unexpectedField');
    }
  },
);

it('has no duplicate vocabulary members', () => {
  for (const values of [
    JOB_KINDS,
    JOB_STATUSES,
    EFFECT_KINDS,
    OUTBOX_STATES,
    PROJECTION_KINDS,
    CANDIDATE_STATES,
    JOB_PHASES,
    TOOL_IDS,
  ])
    expect(new Set(values).size).toBe(values.length);
});
