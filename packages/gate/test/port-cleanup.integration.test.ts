/**
 * DA-11 F-11: a held-out world instance is deleted once the port has taken its read-back; a training instance stays.
 * The worker half is a stub that reports a completed run: this test is about what the port does to the world.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuthorityRepository } from '@expunge/mongo';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { ZERO_COST, type EpisodeRequest } from '../src/index.js';
import { MongoEpisodePort, type WorkerRunner } from '../src/mongo-port.js';
import { CampaignKeyStore, campaignCrypto } from '../src/keys.js';
import { describeLive, openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';
import { BASE_SCOPE, BUDGET, gateView, w0 } from './support.js';

let env: LiveEnvironment;
describeLive('MongoEpisodePort retention of instance worlds', () => {
  beforeAll(async () => {
    env = await openEnvironment('gportclean');
  }, 60_000);
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  it('deletes a withheld-split instance after the read-back and keeps a training one', async () => {
    const builder = await env.as('fixture_builder');
    const grader = await env.as('grader');
    const campaignId = 'clean-1';
    const crypto = campaignCrypto(await new CampaignKeyStore(builder).mint(campaignId));
    const bundle = w0();
    const runner: WorkerRunner = {
      run: async () => ({
        outcome: 'completed',
        terminal: { status: 'complete', claim: 'registered_scope' },
        retryFailures: 0,
        cost: { ...ZERO_COST },
      }),
    };
    const port = new MongoEpisodePort({
      grader,
      builder,
      runner,
      // MA-F2: the fixture builder installs a campaign instance's authority itself, no setup principal.
      installAuthority: async (scope, floorHash) =>
        void (await new AuthorityRepository(builder).installForCampaign(scope, floorHash)),
      floorHash: 'd'.repeat(64),
      profile: { profileId: 'p', modelId: 'm', modelKind: 'fake', params: {} },
    });
    const entry = gateView().entries.find((candidate) => candidate.split === 'train')!;
    const counts: Record<string, number> = {};
    for (const retain of [true, false]) {
      const scope = { ...BASE_SCOPE, scopeId: `i_clean_${retain}` };
      const fixture = generateSealedFixture(entry.spec, entry.seed, scope, undefined, {
        derivation: crypto.derivation,
      });
      const request: EpisodeRequest = {
        campaignId,
        runId: crypto.label('run', { retain }, 40),
        instanceId: crypto.label('instance', { retain }, 24),
        instanceScope: scope,
        bundle,
        bundleHash: 'b'.repeat(64),
        profile: port.profile,
        limits: bundle.limits,
        budget: BUDGET,
        retainWorld: retain,
        world: structuredClone(fixture.world),
        faults: entry.spec.faults,
        signal: new AbortController().signal,
      };
      const result = await port.run(request);
      // The read-back was taken before the delete: the grader still gets the whole world.
      expect(result.world?.collections.customers.length).toBeGreaterThan(0);
      counts[String(retain)] = (
        await Promise.all(
          ['customers', 'accounts', 'messages', 'events', 'notes', 'archives'].map((id) =>
            env.service.world.collection(id).countDocuments({ worldId: fixture.world.worldId }),
          ),
        )
      ).reduce((a, b) => a + b, 0);
    }
    expect(counts.true).toBeGreaterThan(0);
    expect(counts.false).toBe(0);
  }, 60_000);
});
