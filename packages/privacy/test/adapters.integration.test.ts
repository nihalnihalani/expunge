/**
 * D3 / P34-8 Mongo adapters on a real replica set (local protocol lane, no Atlas RBAC): the erasure store flips the
 * export suppression in the same transaction as the job write, reconcile repairs and never removes, the observer's
 * suppression source holds on a truncated list, and the content purger removes raw sources and lessons. Principals are
 * selected by code (the local replica set has no auth); the grants are covered by the mongo packet.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ExternalErasureJob } from '@expunge/contracts';
import {
  ErasureSuppressionRepository,
  LessonRepository,
  RawArtifactRepository,
  type MongoService,
} from '@expunge/mongo';
import { createMongoExportSuppression, suppressionUserKey } from '@expunge/observer';
import { actor, describeLive, openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';
import { MongoContentPurger, MongoErasureStore, reconcileExportSuppression } from '../src/index.js';

const SCOPE = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const ORG = 'org-adapters';
const POLICY = 'f'.repeat(64);
const LONG_ID = `u_${'x'.repeat(300)}`; // not a valid row identifier: hashed like every other id
const K = suppressionUserKey;

const job = (over: Partial<ExternalErasureJob> = {}): ExternalErasureJob => ({
  ...SCOPE,
  requestKey: 'req-1',
  providerOrganizationId: ORG,
  requester: 'dpo@example.test',
  regulation: 'gdpr',
  namespacedUserIds: ['u_a', 'u_b'],
  localExportSuppression: 'active',
  remoteJobId: null,
  receivedAt: new Date(),
  dueBy: null,
  completedAt: null,
  providerStatus: 'unsubmitted',
  subjectEntries: [],
  providerSnapshot: null,
  history: [{ at: new Date(), status: 'unsubmitted', snapshotHash: 'h0' }],
  ...over,
});

describeLive('privacy Mongo adapters on a real replica set (local protocol lane)', () => {
  let env: LiveEnvironment;
  let privacy: MongoService;
  let observer: MongoService;
  let suppression: ErasureSuppressionRepository;
  let store: MongoErasureStore;

  beforeAll(async () => {
    env = await openEnvironment('privadapt');
    privacy = await env.as('privacy_controller');
    observer = await env.as('observer');
    suppression = new ErasureSuppressionRepository(privacy);
    store = new MongoErasureStore(privacy, suppression);
  }, 30000);
  beforeEach(async () => {
    await env.reset();
  });
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  const active = async (org = ORG) => (await suppression.activeUserKeys(org)).sort();
  const keys = (...ids: string[]) => ids.map(K).sort();

  it('insert suppresses every id (hashed keys) in the same transaction; a duplicate insert changes nothing', async () => {
    expect(await store.insert(job({ namespacedUserIds: ['u_a', LONG_ID] }))).toBe('created');
    expect(await active()).toEqual(keys('u_a', LONG_ID));
    expect(await store.insert(job({ namespacedUserIds: ['u_other'] }))).toBe('exists');
    expect(await active()).toEqual(keys('u_a', LONG_ID));
  });

  it('a compare-and-swap miss writes no suppression change; a hit releases or revokes in the same write', async () => {
    const created = job();
    await store.insert(created);
    const released = { ...created, localExportSuppression: 'released' as const };
    expect(await store.replace(released, 99)).toBe(false); // wrong history length: nothing changes
    expect(await active()).toEqual(keys('u_a', 'u_b'));
    expect(await store.replace(released, 1)).toBe(true);
    expect(await active()).toEqual([]);
    // A subject revoked at the provider leaves suppression while its sibling stays suppressed.
    const again = {
      ...released,
      localExportSuppression: 'active' as const,
      history: [...created.history, created.history[0]!],
    };
    expect(await store.replace(again, 1)).toBe(true);
    const revoked = {
      ...again,
      subjectEntries: [{ user_id: 'u_a', requested_on: '2026-10-11', revoked_at: '2026-10-11' }],
      history: [...again.history, again.history[0]!],
    };
    expect(await store.replace(revoked, 2)).toBe(true);
    expect(await active()).toEqual(keys('u_b'));
  });

  it('P34-9: two jobs erasing the same user; releasing one leaves the user suppressed and the export gate still holds', async () => {
    const a = job({ requestKey: 'req-A', namespacedUserIds: ['u_shared', 'u_only_a'] });
    const b = job({ requestKey: 'req-B', namespacedUserIds: ['u_shared'] });
    await store.insert(a);
    await store.insert(b);
    const gate = createMongoExportSuppression(observer);
    expect((await gate.suppressedUserIds(ORG)).has('u_shared')).toBe(true);
    // Release A: its own rows clear, B's row for the shared user stays.
    expect(await store.replace({ ...a, localExportSuppression: 'released' }, 1)).toBe(true);
    const after = await gate.suppressedUserIds(ORG);
    expect(after.has('u_shared')).toBe(true);
    expect(after.has('u_only_a')).toBe(false);
    // Release B too: now nothing holds the user.
    expect(await store.replace({ ...b, localExportSuppression: 'released' }, 1)).toBe(true);
    expect((await gate.suppressedUserIds(ORG)).has('u_shared')).toBe(false);
  });

  it('P34-11: organizations whose ids collide when joined with a colon never share suppression', async () => {
    // org 'a' + key 'b:c' and org 'a:b' + key 'c' are the same string `a:b:c` under naive colon-joining.
    const entry = (org: string, userKey: string, jobId: string) => ({
      ...SCOPE,
      providerOrganizationId: org,
      userKey,
      jobId,
    });
    await suppression.setActive(entry('a', 'b:c', 'j1'), true);
    await suppression.setActive(entry('a:b', 'c', 'j2'), true);
    expect(await suppression.activeUserKeys('a')).toEqual(['b:c']);
    expect(await suppression.activeUserKeys('a:b')).toEqual(['c']);
    await suppression.setActive(entry('a', 'b:c', 'j1'), false);
    expect(await suppression.activeUserKeys('a')).toEqual([]);
    expect(await suppression.activeUserKeys('a:b')).toEqual(['c']); // untouched by the other org's release
  });

  it('the observer reads the list across scopes, answers for raw ids, and a list over its bound HOLDS (throws)', async () => {
    await store.insert(job({ namespacedUserIds: ['u_a', LONG_ID] }));
    await store.insert(job({ requestKey: 'req-2', scopeId: 'other-scope', namespacedUserIds: ['u_c'] }));
    const ids = await createMongoExportSuppression(observer).suppressedUserIds(ORG);
    expect(ids.has('u_a')).toBe(true);
    expect(ids.has('u_c')).toBe(true); // another scope: the erasure is organization-wide
    expect(ids.has(LONG_ID)).toBe(true); // raw id, hashed key
    expect(ids.has('u_unrelated')).toBe(false);
    expect(ids.has(K('u_a'))).toBe(false); // a user whose raw id is another user's KEY is not that user
    expect((await createMongoExportSuppression(observer).suppressedUserIds('org-none')).has('u_a')).toBe(
      false,
    );
    await expect(
      createMongoExportSuppression(observer, { limit: 2 }).suppressedUserIds(ORG),
    ).rejects.toThrow();
  });

  it('reconcile repairs a missing row under its own job, clears a row its job no longer expects, and never touches another job', async () => {
    // Job A's row is written DIRECTLY, without its suppression: the drift the reconcile has to repair.
    const a = job({ requestKey: 'req-A', namespacedUserIds: ['u_a', 'u_b'] });
    await privacy.control.collection('external_deletions').insertOne({ _id: 'drift-A', ...a } as never);
    // Job B (through the store) also suppresses u_a, correctly.
    const b = job({ requestKey: 'req-B', namespacedUserIds: ['u_a'] });
    await store.insert(b);
    expect(await active()).toEqual(keys('u_a'));
    expect(await reconcileExportSuppression(privacy, ORG)).toEqual({ expected: 3, repaired: 2, cleared: 0 });
    expect(await active()).toEqual(keys('u_a', 'u_b'));
    expect(await reconcileExportSuppression(privacy, ORG)).toEqual({ expected: 3, repaired: 0, cleared: 0 });
    // A subject of job A is revoked at the provider (job row updated directly): only A's row for that user clears.
    await privacy.control.collection('external_deletions').updateOne({ _id: 'drift-A' } as never, {
      $set: {
        subjectEntries: [{ user_id: 'u_a', requested_on: '2026-10-11', revoked_at: '2026-10-11' }],
      },
    });
    expect(await reconcileExportSuppression(privacy, ORG)).toEqual({ expected: 2, repaired: 0, cleared: 1 });
    expect(await active()).toEqual(keys('u_a', 'u_b')); // u_a is still held by job B
  });

  it('the content purger tombstones raw sources and lessons with the retraction policy and closure, and is honest about the rest', async () => {
    const raw = new RawArtifactRepository(privacy);
    const lessons = new LessonRepository(privacy);
    await raw.put(
      SCOPE,
      {
        sourceId: 'src-1',
        kind: 'transcript',
        contentSha256: 'a'.repeat(64),
        sizeBytes: 5,
        retention: 'raw',
        registeredAt: new Date(),
      },
      'hello',
    );
    await lessons.put(SCOPE, {
      lessonId: 'lesson-1',
      moduleId: 'm',
      family: 'f',
      structure: { counts: 1 },
      retention: 'structural',
      sourceIds: ['src-1'],
      policyHash: POLICY,
      registeredAt: new Date(),
    });
    const purger = new MongoContentPurger(privacy);
    const extra = { policyHash: POLICY, closureId: 'closure-1' };
    expect(await purger.purge(SCOPE, 'src-1', 'raw_source', 'source_retracted', extra)).toBe('purged');
    expect(await raw.get(SCOPE, 'src-1')).toBeNull();
    expect(await raw.getTombstone(SCOPE, 'src-1')).toMatchObject({
      kind: 'transcript',
      policyHash: POLICY,
      closureId: 'closure-1',
    });
    expect(await purger.purge(SCOPE, 'src-1', 'raw_source', 'source_retracted', extra)).toBe('tombstoned');
    expect(await purger.purge(SCOPE, 'lesson-1', 'lesson', 'source_retracted', extra)).toBe('purged');
    expect(await lessons.get(SCOPE, 'lesson-1')).toBeNull();
    expect(await purger.purge(SCOPE, 'nothing', 'raw_source', 'source_retracted', extra)).toBe('not_found');
    // Kinds whose bytes live where this package cannot write are NOT claimed purged.
    for (const kind of ['evidence_bundle', 'candidate', 'harness', 'unknown'] as const)
      expect(await purger.purge(SCOPE, 'x', kind, 'source_retracted', extra)).toBe('not_found');
  });
});
