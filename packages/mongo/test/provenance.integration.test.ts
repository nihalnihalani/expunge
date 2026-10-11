import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from 'mongodb';
import { contentHash, type ScopeKey } from '@expunge/contracts';
import {
  ANCESTRY_MAX_LEVELS,
  JobRepository,
  ProvenanceRepository,
  RETRIEVAL_MAX_HASHES,
  type ClosureBounds,
  type ProvenanceClosure,
} from '../src/index.js';
import { HASH, actor, createJob, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

const key: ScopeKey = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const POLICY = 'owner-policy-v1';

describeLive(
  'provenance closure, fail-closed retrieval and context-input revocation (real replica set)',
  () => {
    let env: LiveEnvironment;
    let provenance: ProvenanceRepository;
    let jobs: JobRepository;

    beforeAll(async () => {
      env = await openEnvironment('provenance');
      provenance = new ProvenanceRepository(env.service);
      jobs = new JobRepository(env.service);
    }, 30000);
    beforeEach(() => env.reset());
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      if (env) await env.dispose();
    }, 30000);

    const eligibility = () => env.service.control.collection<Document>('artifact_eligibility');
    async function permit(...ids: string[]): Promise<void> {
      for (let index = 0; index < ids.length; index += 1000) {
        await eligibility().insertMany(
          ids.slice(index, index + 1000).map((artifactHash) => ({
            ...key,
            artifactHash,
            state: 'permitted',
            policyHash: POLICY,
            reasonCode: 'initial',
            sourceIds: [],
            updatedAt: new Date(),
          })),
        );
      }
    }
    /** Bulk edge insert with the exact key shape `ProvenanceRepository.append` writes. */
    async function link(pairs: Array<[string, string]>): Promise<void> {
      const rows = pairs.map(([fromId, toId]) => {
        const edgeKey = contentHash({ ...key, fromId, toId, kind: 'derived_from' }, 'provenance-edge');
        return { _id: edgeKey, ...key, edgeKey, fromId, toId, kind: 'derived_from', createdAt: new Date() };
      });
      for (let index = 0; index < rows.length; index += 1000) {
        await env.service.control
          .collection<Document & { _id: string }>('provenance_edges')
          .insertMany(rows.slice(index, index + 1000));
      }
    }
    const chain = (prefix: string, length: number) =>
      Array.from({ length }, (_, index) => `${prefix}${index}`);
    const revokedCount = () => eligibility().countDocuments({ state: 'revoked' });
    async function permittedAll(ids: string[]): Promise<string[]> {
      const allowed: string[] = [];
      for (let index = 0; index < ids.length; index += RETRIEVAL_MAX_HASHES)
        allowed.push(...(await provenance.permitted(key, ids.slice(index, index + RETRIEVAL_MAX_HASHES))));
      return allowed;
    }
    /** Calls `revoke` repeatedly (a resumable job) until it reports completion. */
    async function revokeToCompletion(source: string, bounds: ClosureBounds, maxCalls = 200) {
      let result = await provenance.revoke(key, source, POLICY, 'source_retracted', bounds);
      for (let call = 1; !result.complete && call < maxCalls; call++) {
        result = await provenance.revoke(key, source, POLICY, 'source_retracted', bounds);
      }
      return result;
    }

    describe('closure width, depth and cycles', () => {
      it('revokes more than 500 direct roots without truncation', async () => {
        const children = chain('child-', 1200);
        await permit('source', ...children);
        await link(children.map((child) => ['source', child] as [string, string]));

        const read = await provenance.descendants(key, 'source');
        expect(read.complete).toBe(true);
        expect(read.ids).toHaveLength(1200);

        const result = await provenance.revoke(key, 'source', POLICY, 'source_retracted');
        expect(result).toMatchObject({ complete: true, frontier: [], discovered: 1201 });
        expect(result.ids).toHaveLength(1201);
        expect(await revokedCount()).toBe(1201);
        expect(await permittedAll(children)).toEqual([]);
      });

      it('denies the whole affected set, not just the discovered part, until the closure is complete', async () => {
        const children = chain('child-', 1200);
        await permit('source', 'unrelated', ...children);
        await link(children.map((child) => ['source', child] as [string, string]));

        const first = await provenance.revoke(key, 'source', POLICY, 'source_retracted', {
          maxNodes: 100,
          maxRounds: 4,
          batchSize: 10,
        });
        expect(first.complete).toBe(false);
        expect(first.stalledReason).toBe('node_budget');
        expect(first.frontier.length).toBeGreaterThan(0);
        const discovered = await revokedCount();
        expect(discovered).toBeLessThan(1201);
        // Every child is denied, including the ones this call never reached.
        expect(await permittedAll(children)).toEqual([]);
        expect(await provenance.permitted(key, ['unrelated'])).toEqual(['unrelated']);

        const done = await revokeToCompletion('source', { maxNodes: 100, maxRounds: 4, batchSize: 10 });
        expect(done.complete).toBe(true);
        expect(done.discovered).toBe(1201);
        expect(await revokedCount()).toBe(1201);
        const stored = (await provenance.closure(key, 'source')) as ProvenanceClosure;
        expect(stored).toMatchObject({ status: 'complete', frontier: [], expanding: null });
        expect(stored.completedAt).toBeInstanceOf(Date);
      });

      it('persists the frontier for chains deeper than the per-call bound and fails closed in between', async () => {
        const nodes = chain('c', ANCESTRY_MAX_LEVELS + 28);
        await permit(...nodes, 'bystander', 'bystander-parent');
        await link(nodes.slice(1).map((node, index) => [nodes[index]!, node] as [string, string]));
        await link([['bystander-parent', 'bystander']]);

        const bounds = { maxRounds: 10, maxNodes: 5000, batchSize: 5 };
        const first = await provenance.revoke(key, 'c0', POLICY, 'source_retracted', bounds);
        expect(first.complete).toBe(false);
        expect(first.frontier.length).toBeGreaterThan(0);
        const stored = (await provenance.closure(key, 'c0')) as ProvenanceClosure;
        expect(stored.status).toBe('open');
        expect(stored.frontier.length + (stored.expanding?.parents.length ?? 0)).toBeGreaterThan(0);

        // A node near the source is denied by a revoked ancestor; the deepest node is denied because its
        // ancestry cannot be read within the bound. Neither relies on the closure having reached it.
        const deepest = nodes.at(-1)!;
        expect(await provenance.permitted(key, ['c5', deepest])).toEqual([]);
        expect(await provenance.permitted(key, ['bystander'])).toEqual(['bystander']);

        const done = await revokeToCompletion('c0', bounds);
        expect(done.complete).toBe(true);
        expect(await revokedCount()).toBe(nodes.length);
        expect(await provenance.permitted(key, ['bystander'])).toEqual(['bystander']);
      });

      it('terminates on cycles and self-loops without duplicate revocations', async () => {
        await permit('a', 'b', 'c');
        await link([
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'a'],
          ['b', 'b'],
        ]);
        const read = await provenance.descendants(key, 'a');
        expect(read.complete).toBe(true);
        expect([...read.ids].sort()).toEqual(['b', 'c']);

        const result = await provenance.revoke(key, 'a', POLICY, 'source_retracted');
        expect(result.complete).toBe(true);
        expect(result.discovered).toBe(3);
        expect([...result.ids].sort()).toEqual(['a', 'b', 'c']);
        expect(await revokedCount()).toBe(3);
        expect(await eligibility().countDocuments({ artifactHash: 'a', sourceIds: { $size: 1 } })).toBe(1);
      });

      it('rejects out-of-range bounds and oversized retrieval requests', async () => {
        await expect(provenance.descendants(key, 'x', { maxRounds: 0 })).rejects.toThrow('TraversalBounds');
        await expect(provenance.revoke(key, 'x', POLICY, 'r', { batchSize: 5000 })).rejects.toThrow(
          'TraversalBounds',
        );
        await expect(provenance.permitted(key, chain('h', RETRIEVAL_MAX_HASHES + 1))).rejects.toThrow(
          'RetrievalBounds',
        );
      });
    });

    describe('derivations added during or after traversal', () => {
      it('picks up an edge written from an already-expanded node while the walk is in flight', async () => {
        await permit('s', 'x1', 'x2', 'x3', 'late');
        await link([
          ['s', 'x1'],
          ['x1', 'x2'],
          ['x2', 'x3'],
        ]);
        let injected = false;
        const result = await provenance.revoke(key, 's', POLICY, 'source_retracted', {
          onRound: async ({ round }) => {
            // Round 1 has just expanded x1. A concurrent writer now derives `late` from x1.
            if (round === 1 && !injected) {
              injected = true;
              await provenance.append(key, 'x1', 'late', 'derived_from');
            }
          },
        });
        expect(injected).toBe(true);
        expect(result.complete).toBe(true);
        expect(result.ids).toContain('late');
        expect(await revokedCount()).toBe(5);
        expect(await provenance.permitted(key, ['late'])).toEqual([]);
      });

      it('denies a derivation written after the closure completed, via read-time ancestry', async () => {
        await permit('s', 'x1', 'afterwards');
        await link([['s', 'x1']]);
        expect((await provenance.revoke(key, 's', POLICY, 'source_retracted')).complete).toBe(true);
        await provenance.append(key, 'x1', 'afterwards', 'derived_from');
        expect(await provenance.permitted(key, ['afterwards'])).toEqual([]);
      });

      it('resumes from persisted state after the caller crashes between rounds', async () => {
        const nodes = chain('n', 25);
        await permit(...nodes);
        await link(nodes.slice(1).map((node, index) => [nodes[index]!, node] as [string, string]));
        await expect(
          provenance.revoke(key, 'n0', POLICY, 'source_retracted', {
            batchSize: 2,
            onRound: async ({ round }) => {
              if (round === 3) throw new Error('simulated worker crash');
            },
          }),
        ).rejects.toThrow('simulated worker crash');
        const partial = (await provenance.closure(key, 'n0')) as ProvenanceClosure;
        expect(partial.status).toBe('open');
        expect(partial.rounds).toBe(4);

        const restarted = new ProvenanceRepository(env.service);
        const done = await restarted.revoke(key, 'n0', POLICY, 'source_retracted', { batchSize: 2 });
        expect(done.complete).toBe(true);
        expect(done.discovered).toBe(nodes.length);
        expect(await revokedCount()).toBe(nodes.length);
      });

      it('lets two concurrent revokers share one closure without double counting', async () => {
        const children = chain('k', 300);
        await permit('src', ...children);
        await link(children.map((child) => ['src', child] as [string, string]));
        const bounds = { maxNodes: 40, maxRounds: 3, batchSize: 5 };
        const runners = [0, 1].map(async () => {
          let result = await provenance.revoke(key, 'src', POLICY, 'source_retracted', bounds);
          for (let call = 0; !result.complete && call < 200; call++) {
            result = await provenance.revoke(key, 'src', POLICY, 'source_retracted', bounds);
          }
          return result;
        });
        const results = await Promise.all(runners);
        expect(results.every((r) => r.complete)).toBe(true);
        const stored = (await provenance.closure(key, 'src')) as ProvenanceClosure;
        expect(stored.discovered).toBe(301);
        expect(await revokedCount()).toBe(301);
      });
    });

    describe('jobs holding revoked material in any context input', () => {
      const jobState = async (id: string) =>
        (await env.service.control.collection<Document>('jobs').findOne({ _id: id as never }))!;

      it('cancels a job pinned to an unrevoked harness that holds a revoked lesson', async () => {
        await permit('lesson-1', 'lesson-2');
        const holder = await createJob(env.service, { contextInputs: ['lesson-1'] });
        const bystander = await createJob(env.service, { contextInputs: ['lesson-2'] });
        const noInputs = await createJob(env.service);
        expect((await jobState(holder)).binding.harnessHash).toBe(HASH);

        await provenance.revoke(key, 'lesson-1', POLICY, 'source_retracted');
        expect(await jobState(holder)).toHaveProperty('cancellationRequested', true);
        expect(await jobState(bystander)).toHaveProperty('cancellationRequested', false);
        expect(await jobState(noInputs)).toHaveProperty('cancellationRequested', false);
      });

      it('cancels a running job that recorded a lesson, and stops its lease from renewing', async () => {
        await permit('lesson');
        const id = await createJob(env.service);
        const claimed = (await jobs.claim(actor, id, 'worker', 10000))!;
        const lease = { jobId: id, ownerId: 'worker', fence: claimed.lease.fence };
        expect(await jobs.recordContextInputs(actor, lease, ['lesson', 'lesson'])).toEqual(['lesson']);
        expect((await jobState(id)).contextInputs).toEqual(['lesson']);

        await provenance.revoke(key, 'lesson', POLICY, 'source_retracted');
        expect(await jobState(id)).toHaveProperty('cancellationRequested', true);
        await expect(jobs.renew(actor, lease)).rejects.toThrow('LostLease');
      });

      it('cancels a job holding a descendant lesson derived from the revoked source', async () => {
        await permit('raw-trace', 'lesson');
        await link([['raw-trace', 'lesson']]);
        const holder = await createJob(env.service, { contextInputs: ['lesson'] });
        await provenance.revoke(key, 'raw-trace', POLICY, 'source_retracted');
        expect(await jobState(holder)).toHaveProperty('cancellationRequested', true);
      });

      it('still cancels by pinned harness hash and leaves terminal jobs and other scopes alone', async () => {
        const harness = 'b'.repeat(64);
        await permit(harness);
        const pinned = await createJob(env.service, { harnessHash: harness });
        const finished = await createJob(env.service, { harnessHash: harness });
        await env.service.control
          .collection<Document>('jobs')
          .updateOne({ _id: finished as never }, { $set: { status: 'succeeded', outputRefs: ['receipt'] } });
        await provenance.revoke(key, harness, POLICY, 'source_retracted');
        expect(await jobState(pinned)).toHaveProperty('cancellationRequested', true);
        expect(await jobState(finished)).toHaveProperty('cancellationRequested', false);

        const otherScope = { ...key, scopeId: 'other-scope' };
        await eligibility().insertOne({
          ...otherScope,
          artifactHash: 'shared',
          state: 'permitted',
          policyHash: POLICY,
          reasonCode: 'initial',
          sourceIds: [],
          updatedAt: new Date(),
        });
        const sameHashJob = await createJob(env.service, { contextInputs: ['shared'] });
        await provenance.revoke(otherScope, 'shared', POLICY, 'source_retracted');
        expect(await jobState(sameHashJob)).toHaveProperty('cancellationRequested', false);
      });

      it('refuses to record context inputs that are revoked, unregistered or descended from revoked material', async () => {
        await permit('good', 'root', 'mid', 'child');
        await link([
          ['root', 'mid'],
          ['mid', 'child'],
        ]);
        const id = await createJob(env.service);
        const claimed = (await jobs.claim(actor, id, 'worker', 10000))!;
        const lease = { jobId: id, ownerId: 'worker', fence: claimed.lease.fence };
        // One round reaches `mid` only: the closure stays open and `child` is not yet marked revoked.
        const partial = await provenance.revoke(key, 'root', POLICY, 'source_retracted', { maxRounds: 1 });
        expect(partial.complete).toBe(false);
        expect(await eligibility().findOne({ artifactHash: 'child' })).toHaveProperty('state', 'permitted');

        for (const hashes of [['unknown'], ['root'], ['mid'], ['child'], ['good', 'child']])
          await expect(jobs.recordContextInputs(actor, lease, hashes)).rejects.toThrow(
            'ContextInputNotPermitted',
          );
        expect((await jobState(id)).contextInputs).toEqual([]);
        expect(await jobs.recordContextInputs(actor, lease, ['good'])).toEqual(['good']);
      });

      it('requires a live lease to record context inputs', async () => {
        await permit('lesson');
        const id = await createJob(env.service);
        const claimed = (await jobs.claim(actor, id, 'worker', 10000))!;
        await expect(
          jobs.recordContextInputs(actor, { jobId: id, ownerId: 'worker', fence: claimed.lease.fence + 1 }, [
            'lesson',
          ]),
        ).rejects.toThrow('LostLease');
      });

      it('cancels the job when a revocation lands between the permission check and the write (fake permitted sequence)', async () => {
        await permit('lesson');
        const id = await createJob(env.service);
        const claimed = (await jobs.claim(actor, id, 'worker', 10000))!;
        const lease = { jobId: id, ownerId: 'worker', fence: claimed.lease.fence };
        // Labeled fake: the first check sees the lesson permitted, the re-check sees it revoked.
        vi.spyOn(ProvenanceRepository.prototype, 'permitted')
          .mockResolvedValueOnce(['lesson'])
          .mockResolvedValueOnce([]);
        await expect(jobs.recordContextInputs(actor, lease, ['lesson'])).rejects.toThrow(
          'ContextInputRevoked',
        );
        expect(await jobState(id)).toHaveProperty('cancellationRequested', true);
      });
    });
  },
);
