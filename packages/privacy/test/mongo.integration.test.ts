/**
 * Privacy protocols against the REAL ProvenanceRepository, artifact_eligibility, jobs and external_deletions on a local
 * replica set (MONGODB_TEST_URI), as the `privacy_controller` principal. This is MongoDB protocol evidence only: not
 * Atlas RBAC, and the Raindrop side is the labeled FAKE server.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ErasureSuppressionRepository,
  JobRepository,
  ProvenanceRepository,
  type MongoService,
} from '@expunge/mongo';
import { RaindropQueryClient } from '@expunge/observer';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import {
  HASH,
  actor,
  createJob,
  describeLive,
  openEnvironment,
  type LiveEnvironment,
} from '../../mongo/test/support.js';
import {
  DEFAULT_OWNER_POLICY,
  ErasureService,
  bindOrganization,
  MongoEligibilityStore,
  MongoErasureStore,
  MongoRunObserver,
  RetractionRunner,
  failClosed,
  type ArtifactKind,
  type ProvenancePort,
  type RetractionState,
} from '../src/index.js';
import { FakePurger, FakeRawStore, FakeRegeneration } from './fakes.js';

const SCOPE = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const POLICY = 'owner-policy-v1';
const USER_A = 'u_00000000000000000000000000000a01';
const USER_B = 'u_00000000000000000000000000000b02';

describeLive('privacy protocols on a real replica set (local protocol lane)', () => {
  const fake = new FakeRaindrop();
  let env: LiveEnvironment;
  let privacy: MongoService;
  let repository: ProvenanceRepository;
  let eligibility: MongoEligibilityStore;
  const traces: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    await fake.start();
    env = await openEnvironment('priv');
    privacy = await env.as('privacy_controller');
    repository = new ProvenanceRepository(privacy);
    eligibility = new MongoEligibilityStore(privacy);
  }, 30000);
  beforeEach(async () => {
    fake.reset();
    await env.reset();
  });
  afterAll(async () => {
    mkdirSync('.expunge/tmp', { recursive: true });
    writeFileSync('.expunge/tmp/privacy-closure-traces.json', JSON.stringify(traces, null, 2));
    await fake.stop();
    if (env) await env.dispose();
  }, 30000);

  const states = async (ids: string[]) =>
    Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, (await eligibility.get(SCOPE, id))?.state ?? null])),
    );

  async function permit(...ids: string[]) {
    for (const id of ids) await eligibility.permit(SCOPE, id, POLICY, 'registered');
  }
  async function link(pairs: Array<[string, string]>) {
    for (const [from, to] of pairs) await repository.append(SCOPE, from, to, 'derived_from');
  }
  function runnerFor(over: { provenance?: ProvenancePort; kind?: ArtifactKind } = {}) {
    return new RetractionRunner({
      provenance: over.provenance ?? repository,
      eligibility,
      catalog: { classify: async () => over.kind ?? 'evidence_bundle' },
      raw: new FakeRawStore(),
      purger: new FakePurger(),
      runs: new MongoRunObserver(privacy),
      regeneration: new FakeRegeneration(),
      policy: DEFAULT_OWNER_POLICY(POLICY),
      disposalBatch: 50,
    });
  }
  const record = (shape: string, state: RetractionState, extra: Record<string, unknown> = {}) =>
    traces.push({
      shape,
      phase: state.phase,
      steps: state.step,
      closureRounds: state.closureRounds,
      discovered: state.discovered,
      closureComplete: state.closureComplete,
      deleted: state.deleted,
      regenerated: state.regenerated,
      failClosed: failClosed(state),
      ...extra,
    });

  it('fanout: a source with 300 children completes in bounded steps and every child is source_deleted', async () => {
    const children = Array.from({ length: 300 }, (_, i) => `child-${String(i).padStart(3, '0')}`);
    await permit('src', ...children);
    await link(children.map((c) => ['src', c]));
    const state = await runnerFor().run(SCOPE, 'src', 'source_retracted' as const, {
      bounds: { maxNodes: 100 },
    });
    record('fanout-300', state);
    expect(state).toMatchObject({ phase: 'complete', closureComplete: true, discovered: 301 });
    expect(state.closureRounds).toBeGreaterThan(1);
    expect(Object.values(await states(['src', ...children]))).toEqual(Array(301).fill('source_deleted'));
  });

  it('restart: a retraction stopped after one closure step fails closed, its frontier is persisted, and a FRESH runner resumes it to completion', async () => {
    const children = Array.from({ length: 250 }, (_, i) => `child-${String(i).padStart(3, '0')}`);
    await permit('src', ...children);
    await link(children.map((c) => ['src', c]));
    const first = await runnerFor().run(SCOPE, 'src', 'source_retracted' as const, {
      bounds: { maxNodes: 60 },
      maxSteps: 1,
    });
    expect(first).toMatchObject({ phase: 'closing', closureComplete: false });
    expect(failClosed(first)).toBe(true);
    const row = await env.service.control
      .collection('provenance_closures')
      .findOne({ sourceId: 'src' } as never);
    expect(row).toMatchObject({ sourceId: 'src', status: 'open' }); // persisted, not held in the process
    expect(await repository.permitted(SCOPE, children)).toEqual([]); // nothing under the source is retrievable yet

    // "Process restart": a brand new runner and repository object, same database.
    const resumed = await new RetractionRunner({
      provenance: new ProvenanceRepository(privacy),
      eligibility: new MongoEligibilityStore(privacy),
      catalog: { classify: async () => 'evidence_bundle' },
      raw: new FakeRawStore(),
      purger: new FakePurger(),
      runs: new MongoRunObserver(privacy),
      regeneration: new FakeRegeneration(),
      policy: DEFAULT_OWNER_POLICY(POLICY),
      disposalBatch: 50,
    }).run(SCOPE, 'src', 'source_retracted' as const, { bounds: { maxNodes: 60 } });
    record('restart-resume-250', resumed, { resumedFromPersistedFrontier: true });
    expect(resumed).toMatchObject({ phase: 'complete', closureComplete: true, discovered: 251 });
    expect(failClosed(resumed)).toBe(false);
    expect(Object.values(await states(['src', ...children]))).toEqual(Array(251).fill('source_deleted'));
    expect(
      await env.service.control
        .collection('provenance_closures')
        .countDocuments({ sourceId: 'src' } as never),
    ).toBe(1);
  });

  it('deep chain: 40 levels deep completes, and retrieval of the deep tail stays denied (ancestry bound) throughout', async () => {
    const chain = Array.from({ length: 40 }, (_, i) => `link-${String(i).padStart(2, '0')}`);
    await permit('src', ...chain);
    await link([['src', chain[0]!], ...chain.slice(1).map((c, i): [string, string] => [chain[i]!, c])]);
    expect(await repository.permitted(SCOPE, [chain[39]!])).toEqual([]); // deeper than the ancestry levels: fail closed even before any retraction
    const state = await runnerFor().run(SCOPE, 'src', 'source_retracted' as const);
    record('deep-chain-40', state);
    expect(state).toMatchObject({ phase: 'complete', closureComplete: true, discovered: 41 });
    expect((await states(chain))[chain[39]!]).toBe('source_deleted');
  });

  it('cycle: a -> b -> c -> a under the source terminates and revokes each node once', async () => {
    await permit('src', 'a', 'b', 'c');
    await link([
      ['src', 'a'],
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ]);
    const state = await runnerFor().run(SCOPE, 'src', 'source_retracted' as const);
    record('cycle', state);
    expect(state).toMatchObject({ phase: 'complete', discovered: 4 });
    expect(await states(['a', 'b', 'c'])).toEqual({
      a: 'source_deleted',
      b: 'source_deleted',
      c: 'source_deleted',
    });
  });

  it('concurrent new derivation: an edge added after its parent was expanded is still found before the closure completes', async () => {
    const children = Array.from({ length: 120 }, (_, i) => `kid-${String(i).padStart(3, '0')}`);
    await permit('src', 'late', ...children);
    await link(children.map((c) => ['src', c]));
    let calls = 0;
    const interleaving: ProvenancePort = {
      append: (...args) => repository.append(...args),
      closure: (...args) => repository.closure(...args),
      permitted: (...args) => repository.permitted(...args),
      revoke: async (...args) => {
        const result = await repository.revoke(...args);
        // Between two closure calls, a parent that is already revoked gains a new child.
        if (++calls === 1) await repository.append(SCOPE, 'kid-000', 'late', 'derived_from');
        return result;
      },
    };
    const state = await runnerFor({ provenance: interleaving }).run(
      SCOPE,
      'src',
      'source_retracted' as const,
      {
        bounds: { maxNodes: 40 },
      },
    );
    record('concurrent-derivation', state, { lateChildStatus: (await states(['late'])).late });
    expect(state).toMatchObject({ phase: 'complete', closureComplete: true });
    expect((await states(['late'])).late).toBe('source_deleted');
    expect(state.discovered).toBe(122);
  });

  it('an incomplete closure fails closed: nothing under the source can be retrieved until it completes', async () => {
    const children = Array.from({ length: 60 }, (_, i) => `kid-${String(i).padStart(3, '0')}`);
    await permit('src', ...children);
    await link(children.map((c) => ['src', c]));
    const partial = await runnerFor().run(SCOPE, 'src', 'source_retracted' as const, {
      maxSteps: 1,
      bounds: { maxNodes: 10 },
    });
    record('incomplete-closure', partial);
    expect(partial).toMatchObject({ phase: 'closing', closureComplete: false });
    expect(failClosed(partial)).toBe(true);
    expect(await repository.permitted(SCOPE, ['src', ...children])).toEqual([]); // reached or not, every one is denied
    const finished = await runnerFor().run(SCOPE, 'src', 'source_retracted' as const, {
      bounds: { maxNodes: 10 },
    });
    expect(finished.phase).toBe('complete');
  });

  it('cancels a live run that holds revoked content, and the runner reports exactly that job', async () => {
    await permit('src');
    const jobId = await createJob(env.service, { contextInputs: ['src'] });
    const state = await runnerFor().run(SCOPE, 'src', 'source_retracted' as const);
    expect(state.cancelledJobs).toEqual([jobId]);
    const job = await new JobRepository(env.service).collection.findOne({ _id: jobId } as never);
    expect(job).toMatchObject({ cancellationRequested: true });
  });

  it('re-registering an eligibility never resurrects a revoked artifact', async () => {
    await permit('src');
    await runnerFor().run(SCOPE, 'src', 'source_retracted' as const);
    await eligibility.permit(SCOPE, 'src', POLICY, 'registered-again');
    expect((await eligibility.get(SCOPE, 'src'))?.state).toBe('source_deleted');
  });

  describe('external_deletions store', () => {
    const request = {
      requestKey: 'erase-req-1',
      providerOrganizationId: 'org-1',
      requester: 'privacy-officer@example.invalid',
      regulation: 'other' as const,
      namespacedUserIds: [USER_A, USER_B],
    };
    function service() {
      const client = new RaindropQueryClient({
        queryKey: fake.keys().queryKey,
        projectId: 'proj-1',
        baseUrl: fake.queryUrl,
        maxAttempts: 1,
        sleep: async () => undefined,
      });
      return new ErasureService({
        store: new MongoErasureStore(privacy, new ErasureSuppressionRepository(privacy)),
        provider: bindOrganization(client, 'org-1'),
      });
    }
    const rows = () => env.service.control.collection('external_deletions');

    it('stores the lifecycle with dates preserved, one row per request, and compare-and-swaps on history', async () => {
      const erasure = service();
      await erasure.create(SCOPE, request);
      await erasure.create(SCOPE, request); // idempotent
      expect(await rows().countDocuments({})).toBe(1);
      const submitted = await erasure.submit(SCOPE, request.requestKey);
      const stored = await new MongoErasureStore(privacy, new ErasureSuppressionRepository(privacy)).get(
        SCOPE,
        request.requestKey,
      );
      expect(stored).toMatchObject({
        providerStatus: 'pending',
        remoteJobId: submitted.remoteJobId,
        localExportSuppression: 'active',
      });
      expect(stored?.receivedAt).toBeInstanceOf(Date);
      expect(stored?.history.map((h) => h.status)).toEqual(['unsubmitted', 'submitting', 'pending']);
      // A stale writer (expecting the old history length) loses.
      expect(
        await new MongoErasureStore(privacy, new ErasureSuppressionRepository(privacy)).replace(stored!, 2),
      ).toBe(false);
      expect(
        await new MongoErasureStore(privacy, new ErasureSuppressionRepository(privacy)).replace(stored!, 3),
      ).toBe(true);
    });

    it('two pollers cannot both append the same transition', async () => {
      const erasure = service();
      await erasure.create(SCOPE, request);
      await erasure.submit(SCOPE, request.requestKey);
      [...fake.deletions.values()][0]!.status = 'in_progress';
      const results = await Promise.allSettled([
        erasure.poll(SCOPE, request.requestKey),
        erasure.poll(SCOPE, request.requestKey),
      ]);
      const stored = await new MongoErasureStore(privacy, new ErasureSuppressionRepository(privacy)).get(
        SCOPE,
        request.requestKey,
      );
      expect(stored?.history.filter((h) => h.status === 'in_progress')).toHaveLength(1);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('suppresses only jobs under active suppression, for the provider organization (any scope)', async () => {
      const erasure = service();
      await erasure.create(SCOPE, request);
      expect((await erasure.suppressedUserIds('org-1')).size).toBe(2);
      expect((await erasure.suppressedUserIds('org-other')).size).toBe(0);
      await erasure.releaseExportSuppression(SCOPE, request.requestKey);
      expect((await erasure.suppressedUserIds('org-1')).size).toBe(0);
    });
  });

  it('uses the privacy_controller principal only', () => {
    expect(privacy.principal).toBe('privacy_controller');
    void HASH;
  });
});
