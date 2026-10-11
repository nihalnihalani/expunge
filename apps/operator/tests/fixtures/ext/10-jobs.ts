/** FIXTURE scenarios for the jobs list and the workbench. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import {
  baseSnapshot,
  COLLECTIONS,
  event,
  hex,
  later,
  phaseStates,
  startedPayload,
} from '../expunge-data.js';
import type {
  ExpungeJobSnapshotV2,
  JobStatus,
  TypedProjectionEvent,
} from '../../../src/shared/expunge.js';

const statusEvent = (
  jobId: string,
  seq: number,
  from: JobStatus,
  to: JobStatus,
  reason: string,
) => event(jobId, seq, 'job_status_changed', { from, to, reason });

const decided = (
  jobId: string,
  seq: number,
  toolId:
    | 'inspect_scope'
    | 'resolve_subject'
    | 'discover_references'
    | 'preview_cleanup'
    | 'apply_cleanup_batch'
    | 'verify_registered_scope',
  phase: 'inspect' | 'resolve' | 'discover' | 'preview' | 'apply' | 'verify',
  summary: string,
  decision: 'allow' | 'ask' | 'deny' = 'allow',
) =>
  event(jobId, seq, 'tool_decided', {
    stepId: `step-${seq}`,
    phase,
    toolId,
    decision,
    ruleIds: [],
    summary,
  });

function add(
  state: FixtureState,
  snapshot: ExpungeJobSnapshotV2,
  events: TypedProjectionEvent[],
) {
  state.jobs.set(snapshot.jobId, { snapshot, events });
}

export default function register(state: FixtureState) {
  // Running at discover; advances when POST /__fixture/advance/job-live is called.
  const live = 'job-live';
  const liveEvents: TypedProjectionEvent[] = [
    event(live, 1, 'job_started', startedPayload),
    statusEvent(live, 2, 'queued', 'running', 'claimed by worker'),
    decided(live, 3, 'inspect_scope', 'inspect', 'Read the registered scope.'),
    decided(
      live,
      4,
      'resolve_subject',
      'resolve',
      'Resolved the exact subject identity.',
    ),
  ];
  add(
    state,
    baseSnapshot(live, {
      sequence: 4,
      phase: 'discover',
      phaseStates: phaseStates('discover', 2),
    }),
    liveEvents,
  );
  const steps: Array<
    (job: {
      snapshot: ExpungeJobSnapshotV2;
      events: TypedProjectionEvent[];
    }) => void
  > = [
    (job) => {
      job.events.push(
        decided(
          live,
          5,
          'discover_references',
          'discover',
          'Discovered references in accounts.',
        ),
      );
      job.snapshot = {
        ...job.snapshot,
        sequence: 5,
        coverage: {
          ...job.snapshot.coverage,
          inspectedCollectionIds: [
            'customers',
            'accounts',
            'orders',
            'tickets',
          ],
        },
        limits: { ...job.snapshot.limits, toolCalls: { used: 12, cap: 96 } },
        updatedAt: later(120),
      };
    },
    (job) => {
      job.events.push(
        decided(live, 6, 'preview_cleanup', 'preview', 'Previewed 9 effects.'),
      );
      job.snapshot = {
        ...job.snapshot,
        sequence: 6,
        phase: 'preview',
        phaseStates: phaseStates('preview', 3),
        limits: { ...job.snapshot.limits, toolCalls: { used: 13, cap: 96 } },
        updatedAt: later(180),
      };
    },
    (job) => {
      job.events.push(
        statusEvent(
          live,
          7,
          'running',
          'waiting_evidence',
          'waiting for remote evidence',
        ),
      );
      job.snapshot = {
        ...job.snapshot,
        sequence: 7,
        status: 'waiting_evidence',
        updatedAt: later(240),
      };
    },
  ];
  let step = 0;
  state.advance.set(live, (current) => {
    const job = current.jobs.get(live)!;
    steps[Math.min(step, steps.length - 1)](job);
    step += 1;
  });

  add(
    state,
    baseSnapshot('job-approval', {
      status: 'waiting_approval',
      sequence: 6,
      phase: 'apply',
      phaseStates: phaseStates('apply', 4),
      approval: {
        state: 'pending',
        proposalId: 'proposal-1',
        expiresAt: '2026-10-11T12:00:00.000Z',
      },
      updatedAt: later(300),
    }),
    [
      event('job-approval', 1, 'job_started', startedPayload),
      statusEvent('job-approval', 2, 'queued', 'running', 'claimed by worker'),
      decided(
        'job-approval',
        3,
        'preview_cleanup',
        'preview',
        'Previewed 9 effects.',
      ),
      decided(
        'job-approval',
        4,
        'apply_cleanup_batch',
        'apply',
        'Batch needs approval.',
        'ask',
      ),
      event('job-approval', 5, 'approval_required', {
        proposalId: 'proposal-1',
        candidateId: 'cand-1',
        computedClass: 'authority_expansion',
        flipSetDigest: hex('flip-1'),
        expiresAt: '2026-10-11T12:00:00.000Z',
      }),
      statusEvent(
        'job-approval',
        6,
        'running',
        'waiting_approval',
        'approval required',
      ),
    ],
  );

  add(
    state,
    baseSnapshot('job-evidence', {
      status: 'waiting_evidence',
      sequence: 4,
      evidence: {
        outboxState: 'query_visible',
        evidenceReady: false,
        truncated: true,
      },
      updatedAt: later(200),
    }),
    [
      event('job-evidence', 1, 'job_started', startedPayload),
      statusEvent('job-evidence', 2, 'queued', 'running', 'claimed by worker'),
      event('job-evidence', 3, 'evidence_ready', {
        evidenceId: 'ev-1',
        provider: 'raindrop',
        externalEventId: 'evt_remote_01',
        externalTraceId: 'trace_remote_01',
        externalSignalIds: ['sig_1'],
        origin: 'raindrop_classifier',
        outboxState: 'query_visible',
        truncated: true,
        missing: ['required span'],
        contentHash: hex('ev-1'),
        permittedUse: 'display_only',
      }),
      statusEvent(
        'job-evidence',
        4,
        'running',
        'waiting_evidence',
        'evidence not yet complete',
      ),
    ],
  );

  const done = (jobId: string, complete: boolean) => {
    const inspected = complete ? [...COLLECTIONS] : COLLECTIONS.slice(0, 5);
    add(
      state,
      baseSnapshot(jobId, {
        status: 'succeeded',
        sequence: 6,
        phase: 'complete',
        phaseStates: phaseStates('complete', 7),
        coverage: {
          registeredCollectionIds: [...COLLECTIONS],
          inspectedCollectionIds: [...inspected],
          discoveredFieldIds: [
            'customers.email',
            'accounts.ownerId',
            'orders.accountId',
            'tickets.requester',
          ],
          completeness: complete ? 'declared' : 'partial',
          limitations: complete
            ? []
            : ['payments_archive is registered but was not inspected.'],
        },
        limits: {
          ...baseSnapshot(jobId).limits,
          changedDocuments: { used: 9, cap: 50 },
        },
        receipt: { receiptId: `rcpt-${jobId}`, sequence: 6 },
        updatedAt: later(900),
      }),
      [
        event(jobId, 1, 'job_started', startedPayload),
        statusEvent(jobId, 2, 'queued', 'running', 'claimed by worker'),
        decided(
          jobId,
          3,
          'apply_cleanup_batch',
          'apply',
          'Applied the approved batch.',
        ),
        decided(
          jobId,
          4,
          'verify_registered_scope',
          'verify',
          'Verified the registered scope.',
        ),
        statusEvent(jobId, 5, 'running', 'succeeded', 'completed'),
        event(jobId, 6, 'receipt_committed', {
          receiptId: `rcpt-${jobId}`,
          domainStatus: complete
            ? 'complete_in_registered_scope'
            : 'incomplete',
          externalErasureStatus: 'pending',
          verifiedWorldRevision: 215,
        }),
      ],
    );
    const job = state.jobs.get(jobId)!;
    (job.snapshot as { receiptVerdict?: string }).receiptVerdict = complete
      ? 'complete'
      : 'incomplete';
    job.snapshot.receipt = { receiptId: `rcpt-${jobId}`, sequence: 6 };
  };
  done('job-complete', true);
  done('job-incomplete', false);

  add(
    state,
    baseSnapshot('job-failed', {
      status: 'failed',
      sequence: 4,
      phase: 'apply',
      phaseStates: { ...phaseStates('apply', 4), apply: 'failed' },
      updatedAt: later(400),
    }),
    [
      event('job-failed', 1, 'job_started', startedPayload),
      statusEvent('job-failed', 2, 'queued', 'running', 'claimed by worker'),
      decided(
        'job-failed',
        3,
        'apply_cleanup_batch',
        'apply',
        'Batch was denied.',
        'deny',
      ),
      event('job-failed', 4, 'job_failed', {
        code: 'policy_denied',
        retryable: false,
        phase: 'apply',
        message: 'The owner floor denied the batch.',
      }),
    ],
  );

  add(
    state,
    baseSnapshot('job-cancelled', {
      status: 'cancelled',
      sequence: 5,
      cancellation: { requested: true, requestedAt: later(350) },
      updatedAt: later(420),
    }),
    [
      event('job-cancelled', 1, 'job_started', startedPayload),
      statusEvent('job-cancelled', 2, 'queued', 'running', 'claimed by worker'),
      decided(
        'job-cancelled',
        3,
        'discover_references',
        'discover',
        'Discovered references.',
      ),
      event('job-cancelled', 4, 'cancel_requested', {
        requestedAt: later(350),
        by: 'owner',
      }),
      statusEvent(
        'job-cancelled',
        5,
        'running',
        'cancelled',
        'owner requested cancellation',
      ),
    ],
  );

  // The list endpoint reports the receipt verdict for finished jobs.
  state.advance.set('__list_verdicts__', () => undefined);
}
