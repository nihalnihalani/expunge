/**
 * MA-F2 (redesigned, GB-1): the fixture builder installs a campaign instance's authority into `campaign_authority`, never
 * into `authority_revisions`. The fence reads it only for env 'evaluation'. Local replica-set protocol evidence; made-up scope.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { scopeIdentity } from '@expunge/contracts';
import { AuthorityRepository } from '../src/index.js';
import { HASH, actor, deployWorker, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

const key = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

describeLive('campaign authority installer and fence (local protocol lane)', () => {
  let env: LiveEnvironment;
  let builder: AuthorityRepository;
  let executorService: Awaited<ReturnType<LiveEnvironment['as']>>;
  beforeAll(async () => {
    env = await openEnvironment('authcamp');
    builder = new AuthorityRepository(await env.as('fixture_builder'));
    executorService = await env.as('domain_executor');
  }, 30_000);
  beforeEach(async () => {
    await env.reset();
    await env.service.control.collection('authority_revisions').deleteMany({});
    await env.service.control.collection('authority_touches').deleteMany({});
  });
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  const fence = (scope = key, revision = 1) =>
    executorService.transaction((session) =>
      new AuthorityRepository(executorService).fence(scope, revision, session),
    );

  it('installs into campaign_authority only, and an identical repeat returns the stored row', async () => {
    const row = await builder.installForCampaign(key, HASH);
    expect(row).toMatchObject({ authorizationRevision: 1, floorHash: HASH });
    expect(await env.service.control.collection('campaign_authority').countDocuments({})).toBe(1);
    expect(await env.service.control.collection('campaign_authority_touches').countDocuments({})).toBe(1);
    expect(await env.service.control.collection('authority_revisions').countDocuments({})).toBe(0);
    expect(await env.service.control.collection('authority_touches').countDocuments({})).toBe(0);
    expect((await builder.installForCampaign(key, HASH)).floorHash).toBe(HASH);
  });
  it('never changes an existing row: a different floor is AuthorityConflict', async () => {
    await builder.installForCampaign(key, HASH);
    await expect(builder.installForCampaign(key, 'd'.repeat(64))).rejects.toThrow('AuthorityConflict');
    expect((await new AuthorityRepository(env.service).read(key)).floorHash).toBe(HASH);
  });
  it('is refused outside the evaluation environment and in a scope with a worker deployment pointer', async () => {
    await expect(builder.installForCampaign({ ...key, env: 'demo' }, HASH)).rejects.toThrow(
      'NotCampaignWorld',
    );
    await deployWorker(env.service);
    await expect(builder.installForCampaign(key, HASH)).rejects.toThrow('NotCampaignWorld');
  });
  it('is the fixture builder only; install stays setup-only', async () => {
    const executor = new AuthorityRepository(executorService);
    await expect(executor.installForCampaign(key, HASH)).rejects.toThrow('PrincipalBoundary');
    await expect(builder.install(key, HASH)).rejects.toThrow('PrincipalBoundary');
    await expect(builder.installForCampaign(key, 'nothex')).rejects.toThrow('InvalidAuthority');
  });
  it('the fence honours a campaign row in an evaluation scope and counts touches on it', async () => {
    await builder.installForCampaign(key, HASH);
    expect((await fence()).floorHash).toBe(HASH);
    await fence();
    const touches = await env.service.control.collection('campaign_authority_touches').findOne({});
    expect(touches!.touches).toBe(2);
    // The authority row itself is never touched by the fence.
    expect(await env.service.control.collection('campaign_authority').findOne({})).not.toHaveProperty(
      'touches',
    );
    await expect(fence(key, 2)).rejects.toThrow('AuthorityRevisionStale');
  });
  it('ignores a campaign_authority row for a non-evaluation scope: nothing is authorized', async () => {
    const demo = { ...key, env: 'demo' as const };
    // The validator already refuses this row; bypass it to prove the fence ignores it on its own.
    await env.service.control.collection('campaign_authority').insertOne(
      {
        _id: scopeIdentity(demo),
        ...demo,
        authorizationRevision: 1,
        floorHash: HASH,
        updatedAt: new Date(),
      } as never,
      { bypassDocumentValidation: true },
    );
    await expect(new AuthorityRepository(env.service).read(demo)).rejects.toThrow('AuthorityMissing');
    await expect(fence(demo)).rejects.toThrow('AuthorityMissing');
  });
  it('a standing authority row wins over a campaign row', async () => {
    await builder.installForCampaign(key, HASH);
    await new AuthorityRepository(env.service).install(key, 'e'.repeat(64));
    expect((await fence()).floorHash).toBe('e'.repeat(64));
  });
});
