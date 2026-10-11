import { afterEach, beforeEach, expect, it } from 'vitest';
import { HttpExpungeDomainService } from '../src/server/expunge/domain-service.js';
import { setRejectionSink } from '../src/server/expunge/log.js';
import {
  MAX_EVENT_PAYLOAD_BYTES,
  ProjectionRejected,
  parseArtifact,
  parseEventsPage,
  snapshotSchema,
} from '../src/server/expunge/schemas.js';
import { PROJECTION_KINDS } from '../src/shared/expunge.js';
import {
  baseSnapshot,
  event,
  hex,
  startedPayload,
} from './fixtures/expunge-data.js';
import { recordingTransport } from './fixtures/expunge-transport.js';

// DA-1 K9: nothing from the domain reaches the browser unless it passes a per-kind schema.
const READ = 'internal-read-token-unique-1234567890';
const logged: string[] = [];
beforeEach(() => setRejectionSink((line) => logged.push(line)));
afterEach(() => {
  setRejectionSink();
  logged.splice(0);
});
const CANARIES = {
  manifest: { expectedPostState: 'secret' },
  seed: 'private-seed',
  expectedPostState: 'x',
  subjectLiteral: 'jane@example.invalid',
  grader: { answer: 1 },
};
const samples: Record<string, object> = {
  job_started: startedPayload,
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
    expiresAt: '2026-10-11T10:00:00.000Z',
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
  job_status_changed: {
    from: 'running',
    to: 'waiting_evidence',
    reason: 'r',
  },
  cancel_requested: { requestedAt: '2026-10-11T09:00:00.000Z', by: 'owner' },
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

const eventsFor = (
  kind: string,
  payload: unknown,
  jobId = 'job-1',
  sequence = 1,
) => ({
  events: [{ eventId: 'e', sequence, jobId, kind, artifactIds: [], payload }],
  nextSequence: sequence,
});

it('has a valid sample for every projection kind', () => {
  expect(Object.keys(samples).sort()).toEqual([...PROJECTION_KINDS].sort());
  for (const kind of PROJECTION_KINDS)
    expect(() =>
      parseEventsPage(eventsFor(kind, samples[kind]), 'job-1', 0),
    ).not.toThrow();
});

it('strips unknown and forbidden fields from every kind', () => {
  for (const kind of PROJECTION_KINDS) {
    const page = parseEventsPage(
      eventsFor(kind, { ...samples[kind], ...CANARIES }),
      'job-1',
      0,
    );
    const text = JSON.stringify(page);
    for (const key of Object.keys(CANARIES))
      expect(text).not.toContain(`"${key}"`);
    expect(text).not.toContain('private-seed');
    expect(text).not.toContain('jane@example.invalid');
  }
});

it('rejects wrong types, oversized strings, arrays and payloads', () => {
  expect(() =>
    parseEventsPage(
      eventsFor('tool_decided', { ...samples.tool_decided, decision: 'maybe' }),
      'job-1',
      0,
    ),
  ).toThrow(ProjectionRejected);
  expect(() =>
    parseEventsPage(
      eventsFor('tool_decided', {
        ...samples.tool_decided,
        summary: 'x'.repeat(201),
      }),
      'job-1',
      0,
    ),
  ).toThrow(ProjectionRejected);
  expect(() =>
    parseEventsPage(
      eventsFor('effect_committed', {
        ...samples.effect_committed,
        nodeIds: Array.from({ length: 101 }, (_, i) => `n${i}`),
      }),
      'job-1',
      0,
    ),
  ).toThrow(ProjectionRejected);
  expect(() =>
    parseEventsPage(
      eventsFor('job_failed', {
        ...samples.job_failed,
        message: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES),
      }),
      'job-1',
      0,
    ),
  ).toThrow(/rejected/);
  expect(() =>
    parseEventsPage(
      { events: new Array(501).fill({}), nextSequence: 1 },
      'job-1',
      0,
    ),
  ).toThrow(ProjectionRejected);
});

it('rejects the whole page when any single event is invalid, so no gap is fabricated', () => {
  const page = {
    events: [
      {
        eventId: 'e1',
        sequence: 1,
        jobId: 'job-1',
        kind: 'job_started',
        artifactIds: [],
        payload: startedPayload,
      },
      {
        eventId: 'e2',
        sequence: 2,
        jobId: 'job-1',
        kind: 'tool_decided',
        artifactIds: [],
        payload: { nope: true },
      },
    ],
    nextSequence: 2,
  };
  expect(() => parseEventsPage(page, 'job-1', 0)).toThrow(ProjectionRejected);
});

it('keeps an unknown kind as unknown_kind with its payload dropped', () => {
  const parsed = parseEventsPage(
    eventsFor('future_kind_v9', { anything: 'secret', nested: { a: 1 } }),
    'job-1',
    0,
  );
  expect(parsed.events[0]).toMatchObject({
    kind: 'unknown_kind',
    originalKind: 'future_kind_v9',
    payload: {},
  });
  expect(JSON.stringify(parsed)).not.toContain('secret');
  const weird = parseEventsPage(eventsFor('Bad Kind!', {}), 'job-1', 0);
  expect(weird.events[0]).toMatchObject({ originalKind: 'invalid' });
});

it('enforces job binding, increasing sequences and the cursor', () => {
  expect(() =>
    parseEventsPage(
      eventsFor('job_started', startedPayload, 'job-2'),
      'job-1',
      0,
    ),
  ).toThrow(/rejected/);
  expect(() =>
    parseEventsPage(
      eventsFor('job_started', startedPayload, 'job-1', 3),
      'job-1',
      3,
    ),
  ).toThrow(/rejected/);
  expect(() =>
    parseEventsPage(
      { ...eventsFor('job_started', startedPayload), nextSequence: 9 },
      'job-1',
      0,
    ),
  ).toThrow(/rejected/);
});

it('validates snapshots, strips unknown fields and rejects malformed ones', () => {
  const good = baseSnapshot('job-1');
  expect(
    snapshotSchema.safeParse({ ...good, ...CANARIES }).data,
  ).not.toHaveProperty('manifest');
  expect(snapshotSchema.safeParse({ ...good, status: 'done' }).success).toBe(
    false,
  );
  expect(snapshotSchema.safeParse({ ...good, sequence: -1 }).success).toBe(
    false,
  );
  expect(
    snapshotSchema.safeParse({
      ...good,
      coverage: { ...good.coverage, limitations: Array(21).fill('x') },
    }).success,
  ).toBe(false);
});

it('validates artifacts by kind and refuses kinds it cannot serve', () => {
  const envelope = (kind: string, payload: unknown) => ({
    artifactId: 'a1',
    kind,
    jobId: 'job-1',
    committedAtSequence: 4,
    contentHash: null,
    payload,
  });
  expect(() =>
    parseArtifact(
      envelope('model_narrative', {
        jobId: 'job-1',
        text: 't',
        replayed: false,
        producedAt: '2026-10-11T09:00:00.000Z',
      }),
    ),
  ).not.toThrow();
  expect(() =>
    parseArtifact(
      envelope('model_narrative', {
        jobId: 'job-1',
        text: 'x'.repeat(4001),
        replayed: false,
        producedAt: '2026-10-11T09:00:00.000Z',
      }),
    ),
  ).toThrow(ProjectionRejected);
  expect(() => parseArtifact(envelope('action_receipt', {}))).toThrow(
    /rejected/,
  );
  const stripped = parseArtifact(
    envelope('model_narrative', {
      jobId: 'job-1',
      text: 't',
      replayed: false,
      producedAt: '2026-10-11T09:00:00.000Z',
      ...CANARIES,
    }),
  );
  expect(JSON.stringify(stripped)).not.toContain('private-seed');
});

it('logs a rejection once, without values, and a throwing logger cannot change the result', async () => {
  const bad = {
    events: [
      {
        eventId: 'e1',
        sequence: 1,
        jobId: 'job-1',
        kind: 'tool_decided',
        artifactIds: [],
        payload: { secretValue: 'jane@example.invalid' },
      },
    ],
    nextSequence: 1,
  };
  const { transport } = recordingTransport(() => bad);
  const service = new HttpExpungeDomainService(
    'http://127.0.0.1:4320',
    { readToken: READ },
    'o',
    transport,
  );
  const { expungeRoutes } = await import('../src/server/expunge/routes.js');
  const app = expungeRoutes(service, undefined, { ownerAuthenticated: true });
  const response = await app.request(
    '/expunge/jobs/job-1/events?afterSequence=0',
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ code: 'bad_response' });
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain('route=events');
  expect(logged[0]).toContain('job=job-1');
  expect(logged[0]).not.toContain('jane@example.invalid');
  expect(logged[0]).not.toContain('secretValue');
  setRejectionSink(() => {
    throw new Error('sink failed');
  });
  const again = await app.request('/expunge/jobs/job-1/events?afterSequence=0');
  expect(again.status).toBe(502);
});

it('forwards the schema output, not the raw upstream body', async () => {
  const raw = {
    events: [
      event('job-1', 1, 'job_started', {
        ...startedPayload,
        ...CANARIES,
      } as never),
    ],
    nextSequence: 1,
  };
  const { transport } = recordingTransport(() => raw);
  const service = new HttpExpungeDomainService(
    'http://127.0.0.1:4320',
    { readToken: READ },
    'o',
    transport,
  );
  const { expungeRoutes } = await import('../src/server/expunge/routes.js');
  const response = await expungeRoutes(service, undefined, {
    ownerAuthenticated: true,
  }).request('/expunge/jobs/job-1/events?afterSequence=0');
  const text = await response.text();
  for (const key of Object.keys(CANARIES))
    expect(text).not.toContain(`"${key}"`);
});
