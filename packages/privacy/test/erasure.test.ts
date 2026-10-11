import { validateProjectionPayload } from '@expunge/contracts';
import { RaindropQueryClient } from '@expunge/observer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import {
  ErasureService,
  PrivacyError,
  bindOrganization,
  completionView,
  isOverdue,
  registerRetentionBoundary,
  type ErasureRequest,
} from '../src/index.js';
import { FakeBoundaries, FakeErasureStore, ORG, RecordingProjection, SCOPE } from './fakes.js';

/** Labeled FAKE Raindrop deletion endpoint (packages/observability/test/fake-raindrop.ts): nothing here reaches Raindrop. */
const fake = new FakeRaindrop();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const USER_A = 'u_00000000000000000000000000000a01';
const USER_B = 'u_00000000000000000000000000000b02';
const request: ErasureRequest = {
  requestKey: 'erase-req-1',
  providerOrganizationId: 'org-1',
  requester: 'privacy-officer@example.invalid',
  regulation: 'other',
  namespacedUserIds: [USER_B, USER_A],
};

function rig() {
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    sent.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return fetch(input, init);
  };
  const client = new RaindropQueryClient({
    queryKey: fake.keys().queryKey,
    projectId: 'proj-1',
    baseUrl: fake.queryUrl,
    fetch: recordingFetch,
    maxAttempts: 1,
    sleep: async () => undefined,
  });
  const provider = bindOrganization(client, ORG);
  const store = new FakeErasureStore();
  const projection = new RecordingProjection();
  let clock = new Date('2026-06-02T00:00:00Z');
  const service = new ErasureService({ store, provider, projection, now: () => clock });
  return {
    service,
    store,
    projection,
    sent,
    client,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
}
const remote = () => [...fake.deletions.values()][0]!;

describe('external erasure lifecycle against the FAKE Raindrop deletion endpoint', () => {
  it('records the request locally first: unsubmitted, export suppression active, nothing sent', async () => {
    const r = rig();
    const job = await r.service.create(SCOPE, request);
    expect(job).toMatchObject({
      providerStatus: 'unsubmitted',
      localExportSuppression: 'active',
      remoteJobId: null,
      completedAt: null,
    });
    expect(job.namespacedUserIds).toEqual([USER_A, USER_B]);
    expect(r.sent).toHaveLength(0);
    expect(await r.service.suppressedUserIds(ORG)).toEqual(new Set([USER_A, USER_B]));
    expect((await r.service.create(SCOPE, request)).requestKey).toBe('erase-req-1'); // idempotent
  });

  it('sends the exact request schema, and an acknowledgement is PENDING with a due date, never completed', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    const job = await r.service.submit(SCOPE, request.requestKey);
    expect(r.sent[0]).toEqual({
      method: 'POST',
      path: '/v1/deletions/users',
      body: { user_ids: [USER_A, USER_B], requester: 'privacy-officer@example.invalid', regulation: 'other' },
    });
    expect(job).toMatchObject({ providerStatus: 'pending', completedAt: null, remoteJobId: remote().id });
    expect(job.dueBy).toBeInstanceOf(Date);
    expect(job.subjectEntries.map((e) => e.user_id).sort()).toEqual([USER_A, USER_B]);
    // A second submit never files a second org-wide job for the same request.
    await r.service.submit(SCOPE, request.requestKey);
    expect(fake.deletions.size).toBe(1);
    expect(r.sent.filter((s) => s.method === 'POST')).toHaveLength(1);
  });

  it('walks pending -> in_progress -> completed only on the provider status; completed needs completed_at', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.submit(SCOPE, request.requestKey);
    const before = (await r.store.get(SCOPE, request.requestKey))!.history.length;
    expect((await r.service.poll(SCOPE, request.requestKey)).history).toHaveLength(before); // unchanged snapshot: no new history
    remote().status = 'in_progress';
    expect((await r.service.poll(SCOPE, request.requestKey)).providerStatus).toBe('in_progress');
    remote().status = 'completed';
    await expect(r.service.poll(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'ProviderResponseInvalid',
    });
    remote().completed_at = '2026-06-20T00:00:00.000Z';
    const done = await r.service.poll(SCOPE, request.requestKey);
    expect(done).toMatchObject({ providerStatus: 'completed' });
    expect(done.completedAt?.toISOString()).toBe('2026-06-20T00:00:00.000Z');
    expect(done.history.map((h) => h.status)).toEqual([
      'unsubmitted',
      'submitting',
      'pending',
      'in_progress',
      'completed',
    ]);
  });

  it('records a provider rejection as rejected, not as completed', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.submit(SCOPE, request.requestKey);
    remote().status = 'rejected';
    expect((await r.service.poll(SCOPE, request.requestKey)).providerStatus).toBe('rejected');
  });

  it('cancelling a subject is DELETE-as-cancel: data is KEPT, the job never becomes completed, all cancelled -> cancelled', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.submit(SCOPE, request.requestKey);
    const afterOne = await r.service.cancelPendingSubject(SCOPE, request.requestKey, USER_A);
    expect(
      r.sent.some((s) => s.method === 'DELETE' && s.path === `/v1/deletions/users/${remote().id}/${USER_A}`),
    ).toBe(true);
    expect(afterOne.providerStatus).toBe('pending'); // USER_B is still being deleted
    expect(afterOne.subjectEntries.find((e) => e.user_id === USER_A)?.revoked_at).not.toBeNull();
    const suppressed = await r.service.suppressedUserIds(ORG);
    expect(suppressed.has(USER_A)).toBe(false); // cancelled at the provider: its telemetry is kept
    expect(suppressed.has(USER_B)).toBe(true);
    const afterAll = await r.service.cancelPendingSubject(SCOPE, request.requestKey, USER_B);
    expect(afterAll.providerStatus).toBe('cancelled');
    expect(afterAll.completedAt).toBeNull();
    // A cancelled job cannot be cancelled again, and nothing here ever called a purge route.
    await expect(r.service.cancelPendingSubject(SCOPE, request.requestKey, USER_B)).rejects.toMatchObject({
      code: 'ErasureNotCancellable',
    });
    expect(r.sent.every((s) => s.method !== 'DELETE' || s.path.split('/').length === 6)).toBe(true);
  });

  it('refuses to cancel once the provider is working or has finished', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.submit(SCOPE, request.requestKey);
    remote().status = 'in_progress';
    await r.service.poll(SCOPE, request.requestKey);
    await expect(r.service.cancelPendingSubject(SCOPE, request.requestKey, USER_A)).rejects.toMatchObject({
      code: 'ErasureNotCancellable',
    });
    await expect(
      r.service.cancelPendingSubject(SCOPE, request.requestKey, 'someone-else'),
    ).rejects.toMatchObject({ code: 'ErasureNotCancellable' });
  });

  it('reports a job past its due date honestly, and only while it is not completed or rejected', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    const job = await r.service.submit(SCOPE, request.requestKey);
    const late = new Date(job.dueBy!.getTime() + 86_400_000 * 2);
    expect(isOverdue(job, new Date(job.dueBy!.getTime() - 1000))).toBe(false);
    expect(isOverdue(job, late)).toBe(true);
    remote().status = 'completed';
    remote().completed_at = '2026-06-20T00:00:00.000Z';
    expect(isOverdue(await r.service.poll(SCOPE, request.requestKey), late)).toBe(false);
  });

  it('a domain job can be succeeded while the external erasure is accurately pending', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    const pending = await r.service.submit(SCOPE, request.requestKey);
    expect(completionView('succeeded', pending)).toEqual({
      domain: 'succeeded',
      external: 'pending',
      fullyErased: false,
    });
    expect(completionView('succeeded', null)).toMatchObject({
      external: 'not_requested',
      fullyErased: false,
    });
    remote().status = 'completed';
    remote().completed_at = '2026-06-20T00:00:00.000Z';
    const done = await r.service.poll(SCOPE, request.requestKey);
    expect(completionView('succeeded', done).fullyErased).toBe(true);
    expect(completionView('failed', done).fullyErased).toBe(false);
  });

  it('suppresses export until the suppression is explicitly released', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.submit(SCOPE, request.requestKey);
    remote().status = 'completed';
    remote().completed_at = '2026-06-20T00:00:00.000Z';
    await r.service.poll(SCOPE, request.requestKey);
    expect((await r.service.suppressedUserIds(ORG)).size).toBe(2); // completion alone does not release it
    await r.service.releaseExportSuppression(SCOPE, request.requestKey);
    expect((await r.service.suppressedUserIds(ORG)).size).toBe(0);
  });

  it('emits external_erasure_updated only when the provider status changes, and each payload satisfies the contract', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.submit(SCOPE, request.requestKey);
    await r.service.poll(SCOPE, request.requestKey); // unchanged: no event
    remote().status = 'in_progress';
    await r.service.poll(SCOPE, request.requestKey);
    expect(r.projection.events.map((e) => e.payload.providerStatus)).toEqual(['pending', 'in_progress']);
    for (const event of r.projection.events)
      expect(() => validateProjectionPayload('external_erasure_updated', event.payload)).not.toThrow();
    expect(JSON.stringify(r.projection.events)).not.toContain(USER_A); // counts and hashes only
  });

  it('rejects malformed requests before anything is stored or sent', async () => {
    const r = rig();
    const bad = (over: Partial<ErasureRequest>) => r.service.create(SCOPE, { ...request, ...over });
    await expect(bad({ namespacedUserIds: [] })).rejects.toMatchObject({ code: 'InvalidErasureRequest' });
    await expect(
      bad({ namespacedUserIds: Array.from({ length: 101 }, (_, i) => `u_${String(i).padStart(32, '0')}`) }),
    ).rejects.toMatchObject({ code: 'InvalidErasureRequest' });
    await expect(bad({ requester: '' })).rejects.toMatchObject({ code: 'InvalidErasureRequest' });
    await expect(bad({ regulation: 'hipaa' as never })).rejects.toMatchObject({
      code: 'InvalidErasureRequest',
    });
    expect(r.store.rows.size).toBe(0);
    expect(r.sent).toHaveLength(0);
  });
});

describe('CopilotKit Intelligence retention', () => {
  it('registers a retention boundary and never claims deletion', async () => {
    const boundaries = new FakeBoundaries();
    const boundary = await registerRetentionBoundary(boundaries, SCOPE, {
      provider: 'copilotkit_intelligence',
      note: 'conversation retention is governed by the provider; no purge API is available',
    });
    expect(boundary.state).toBe('retention_boundary_registered');
    expect(boundary.state).not.toBe('deleted');
    expect((await boundaries.list()).map((b) => b.state)).toEqual(['retention_boundary_registered']);
  });
});

describe('P34-1 submission is claimed before the provider is called and an unknown outcome is never re-sent (FAKE Raindrop)', () => {
  const providerCalls = () =>
    fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/deletions/users').length;

  it('two concurrent submits produce exactly one provider call; the loser sends nothing', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    const results = await Promise.allSettled([
      r.service.submit(SCOPE, request.requestKey),
      r.service.submit(SCOPE, request.requestKey),
    ]);
    expect(providerCalls()).toBe(1);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await r.store.get(SCOPE, request.requestKey))?.providerStatus).toBe('pending');
  });

  it('the provider accepted but the store write failed: the job is ambiguous, a second submit sends nothing, and nothing is auto-retried', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    const realReplace = r.store.replace.bind(r.store);
    let failures = 0;
    r.store.replace = async (job, expected) => {
      if ((job.providerStatus as string) === 'pending' && failures++ < 9) return false; // every write of the accepted state fails
      return realReplace(job, expected);
    };
    await expect(r.service.submit(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'SubmissionAmbiguous',
    });
    expect(providerCalls()).toBe(1);
    expect((await r.store.get(SCOPE, request.requestKey))?.providerStatus).toBe('submission_ambiguous');
    await expect(r.service.submit(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'SubmissionAmbiguous',
    });
    expect(providerCalls()).toBe(1); // never re-sent
  });

  it('a lost response (provider call throws) is ambiguous, not a retryable failure', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    const dead = new RaindropQueryClient({
      queryKey: 'wrong',
      projectId: 'proj-1',
      baseUrl: 'http://127.0.0.1:1',
      maxAttempts: 1,
      sleep: async () => undefined,
    });
    const service = new ErasureService({ store: r.store, provider: bindOrganization(dead, ORG) });
    await expect(service.submit(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'SubmissionAmbiguous',
    });
    expect((await r.store.get(SCOPE, request.requestKey))?.providerStatus).toBe('submission_ambiguous');
    expect(providerCalls()).toBe(0);
    await expect(r.service.submit(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'SubmissionAmbiguous',
    });
    expect(providerCalls()).toBe(0);
  });

  it('a claim left over from a crash goes ambiguous once stale, and a fresh claim is reported as in progress', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    const row = r.store.rows.get(request.requestKey)!;
    row.providerStatus = 'submitting' as never;
    row.history.push({ at: new Date('2026-06-02T00:00:00Z'), status: 'submitting', snapshotHash: 'x' });
    await expect(r.service.submit(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'SubmissionInProgress',
    });
    r.advance(2 * 60_000);
    await expect(r.service.submit(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'SubmissionAmbiguous',
    });
    expect(r.store.rows.get(request.requestKey)?.providerStatus).toBe('submission_ambiguous');
    expect(providerCalls()).toBe(0);
  });

  it('reconciles an ambiguous submission only from a stored remote id (GET) or a named human decision', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.submit(SCOPE, request.requestKey);
    const remoteId = remote().id as string;
    const row = r.store.rows.get(request.requestKey)!;
    row.providerStatus = 'submission_ambiguous' as never;
    row.remoteJobId = null;
    const reconciled = await r.service.reconcileSubmission(SCOPE, request.requestKey, {
      remoteJobId: remoteId,
    });
    expect(reconciled).toMatchObject({ providerStatus: 'pending', remoteJobId: remoteId });
    expect(providerCalls()).toBe(1); // the GET found it; nothing was sent again

    const second = rig();
    await second.service.create(SCOPE, { ...request, requestKey: 'erase-req-2' });
    second.store.rows.get('erase-req-2')!.providerStatus = 'submission_ambiguous' as never;
    await expect(
      second.service.reconcileSubmission(SCOPE, 'erase-req-2', { notSentDecidedBy: '  ' }),
    ).rejects.toBeInstanceOf(PrivacyError);
    const decided = await second.service.reconcileSubmission(SCOPE, 'erase-req-2', {
      notSentDecidedBy: 'privacy-officer',
    });
    expect(decided.providerStatus).toBe('unsubmitted');
  });
});

describe('P34-4 the provider organization is bound to the credential before anything is sent (FAKE Raindrop)', () => {
  it('refuses when the credential organization is unknown or different, sending nothing', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    for (const [bound, code] of [
      [null, 'OrganizationUnverified'],
      ['org-other', 'OrganizationMismatch'],
    ] as const) {
      const service = new ErasureService({ store: r.store, provider: bindOrganization(r.client, bound) });
      await expect(service.submit(SCOPE, request.requestKey)).rejects.toMatchObject({ code });
    }
    expect(fake.requests.filter((x) => x.method === 'POST')).toHaveLength(0);
    expect((await r.store.get(SCOPE, request.requestKey))?.providerStatus).toBe('unsubmitted');
  });

  it('suppression is keyed by the organization: another scope of the same organization is held, another organization is not', async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    expect((await r.service.suppressedUserIds(ORG)).size).toBe(2);
    expect((await r.service.suppressedUserIds('org-other')).size).toBe(0);
  });
});

describe('P34-7 a provider job is applied only to the request whose user ids it names (FAKE Raindrop)', () => {
  it("reconcile and poll refuse another request's deletion and change nothing", async () => {
    const r = rig();
    await r.service.create(SCOPE, request);
    await r.service.create(SCOPE, {
      ...request,
      requestKey: 'erase-req-other',
      namespacedUserIds: ['u_00000000000000000000000000000c03'],
    });
    await r.service.submit(SCOPE, 'erase-req-other');
    const otherRemote = remote();
    // The other request's job is done at the provider.
    otherRemote.status = 'completed';
    otherRemote.completed_at = new Date().toISOString();
    const row = r.store.rows.get(request.requestKey)!;
    row.providerStatus = 'submission_ambiguous' as never;
    const before = structuredClone(row);
    await expect(
      r.service.reconcileSubmission(SCOPE, request.requestKey, { remoteJobId: otherRemote.id as string }),
    ).rejects.toMatchObject({ code: 'RemoteJobMismatch' });
    expect(r.store.rows.get(request.requestKey)).toEqual(before);
    // Same size but a different id, and a superset, are both mismatches.
    row.remoteJobId = otherRemote.id as string;
    await expect(r.service.poll(SCOPE, request.requestKey)).rejects.toMatchObject({
      code: 'RemoteJobMismatch',
    });
    expect(r.store.rows.get(request.requestKey)?.providerStatus).toBe('submission_ambiguous');
  });
});
