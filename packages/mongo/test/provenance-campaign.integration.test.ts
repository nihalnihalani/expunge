/**
 * MA-F1: a campaign-pinned harness is permitted to enter context through the grader's campaign permit, only in a campaign
 * scope, and never over an eligibility row. Local replica-set protocol evidence (MONGODB_TEST_URI); made-up hashes.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ProvenanceRepository } from '../src/index.js';
import { HASH, actor, deployWorker, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

const key = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const H1 = 'b'.repeat(64);
const H2 = 'c'.repeat(64);

describeLive('campaign permits in the provenance gate (local protocol lane)', () => {
  let env: LiveEnvironment;
  let executor: ProvenanceRepository;
  beforeAll(async () => {
    env = await openEnvironment('provcamp');
    executor = new ProvenanceRepository(await env.as('domain_executor'));
  }, 30_000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  const permit = (artifactHash: string, scope = key) =>
    env.service.control.collection('campaign_artifact_permits').insertOne({
      _id: `c:${artifactHash}` as never,
      ...scope,
      campaignId: 'c',
      artifactHash,
      freezeHash: HASH,
      createdAt: new Date(),
    });
  const eligibility = (artifactHash: string, state: string) =>
    env.service.control.collection('artifact_eligibility').insertOne({
      ...key,
      artifactHash,
      state,
      policyHash: HASH,
      reasonCode: 'x',
      sourceIds: [],
      updatedAt: new Date(),
    } as never);

  it('permits a hash with a campaign permit and no eligibility row, in a campaign scope', async () => {
    await permit(H1);
    expect(await executor.permitted(key, [H1, H2])).toEqual([H1]);
  });
  it('refuses with no permit', async () => {
    expect(await executor.permitted(key, [H1])).toEqual([]);
  });
  it('refuses when the scope has a worker deployment pointer', async () => {
    await permit(H1);
    await deployWorker(env.service);
    expect(await executor.permitted(key, [H1])).toEqual([]);
  });
  it('refuses outside the evaluation environment', async () => {
    const demo = { ...key, env: 'demo' as const };
    await permit(H1, demo);
    expect(await executor.permitted(demo, [H1])).toEqual([]);
  });
  it('an eligibility row that is not permitted wins over a permit; a permitted row still works', async () => {
    await permit(H1);
    await permit(H2);
    await eligibility(H1, 'revoked');
    await eligibility(H2, 'permitted');
    expect(await executor.permitted(key, [H1, H2])).toEqual([H2]);
  });
  it('a permit in another scope does not leak', async () => {
    await permit(H1, { ...key, scopeId: 'other-scope' });
    expect(await executor.permitted(key, [H1])).toEqual([]);
  });
});
