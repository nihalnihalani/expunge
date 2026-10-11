import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { projectionHash } from '@expunge/contracts';
import { ArtifactRepository, WorldRepository, type MongoService, type Principal } from '../src/index.js';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import {
  HASH,
  actor,
  claimRow,
  deployWorker,
  describeLive,
  freezeRow,
  openEnvironment,
  type LiveEnvironment,
} from './support.js';

const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const CAMPAIGN = 'campaign-permit';

describeLive(
  'a campaign artifact is permitted by the grader, from the campaign rows alone (real replica set)',
  () => {
    let env: LiveEnvironment;
    const as = (principal: Principal): Promise<MongoService> => env.as(principal);

    beforeAll(async () => {
      env = await openEnvironment('permit');
    }, 30000);
    beforeEach(() => env.reset());
    afterAll(async () => {
      if (env) await env.dispose();
    }, 30000);

    async function campaign(options: { claimState?: string; freeze?: boolean; world?: boolean } = {}) {
      const store = new ArtifactRepository(env.service);
      const parent = (await store.insert(validBundle()))._id;
      const childBundle = {
        ...validBundle(),
        parentHash: parent,
        contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 4 },
      };
      const child = (await store.insert(childBundle))._id;
      const stranger = (
        await store.insert({
          ...validBundle(),
          contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 9 },
        })
      )._id;
      if (options.world !== false)
        await new WorldRepository(env.service).create(scope, 'campaign-world', 1, { campaignId: CAMPAIGN });
      if (options.freeze !== false)
        await env.service.control.collection('campaign_freezes').insertOne(freezeRow(CAMPAIGN) as never);
      await env.service.control.collection('gate_claims').insertOne(
        claimRow({
          campaignId: CAMPAIGN,
          parentHash: parent,
          childProjectionHash: projectionHash(childBundle),
          state: (options.claimState ?? 'open') as 'open',
        }) as never,
      );
      return { parent, child, stranger };
    }
    const permit = async (hash: string, principal: Principal = 'grader') =>
      new ArtifactRepository(await as(principal)).permitForCampaign(scope, CAMPAIGN, hash);
    const rows = () => env.service.control.collection('campaign_artifact_permits').find({}).toArray();

    it("permits the claim's parent and its exact child once, so the worker can read them", async () => {
      const { parent, child } = await campaign();
      expect(await permit(parent)).toBe('permitted');
      expect(await permit(child)).toBe('permitted');
      expect(await permit(child)).toBe('exists');
      expect((await rows()).map((row) => row.artifactHash).sort()).toEqual([parent, child].sort());
      // The permit is its own collection: nothing was written to the eligibility rows production context loading reads.
      expect(await env.service.control.collection('artifact_eligibility').countDocuments()).toBe(0);
      const worker = new ArtifactRepository(await as('domain_executor'));
      expect((await worker.readPermitted(scope, child))._id).toBe(child);
    });

    it('does not override an eligibility row: a revoked artifact stays unreadable, and a permit is useless outside a campaign scope', async () => {
      const { parent, child } = await campaign();
      await permit(parent);
      await permit(child);
      const worker = new ArtifactRepository(await as('domain_executor'));
      await env.service.control.collection('artifact_eligibility').insertOne({
        ...scope,
        artifactHash: parent,
        state: 'revoked',
        policyHash: HASH,
        reasonCode: 'source_retracted',
        sourceIds: [],
        updatedAt: new Date(),
      } as never);
      await expect(worker.readPermitted(scope, parent)).rejects.toThrow('ArtifactIneligible');
      // The same permit rows read from another scope, or from this one once a production pointer exists, permit nothing.
      await expect(worker.readPermitted({ ...scope, scopeId: 'production' }, child)).rejects.toThrow(
        'ArtifactIneligible',
      );
      await expect(worker.readPermitted({ ...scope, env: 'demo' }, child)).rejects.toThrow(
        'ArtifactIneligible',
      );
      await deployWorker(env.service, {
        ...validBundle(),
        contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 2 },
      });
      await expect(worker.readPermitted(scope, child)).rejects.toThrow('ArtifactIneligible');
    });

    it('refuses a hash the campaign does not own, a closed claim, and a scope without the campaign world', async () => {
      const { stranger } = await campaign();
      await expect(permit(stranger)).rejects.toThrow('HarnessNotInCampaign');
      await expect(permit('e'.repeat(64))).rejects.toThrow('HarnessNotInCampaign');
      for (const claimState of ['held', 'decided', 'failed']) {
        await env.reset();
        const { parent } = await campaign({ claimState });
        await expect(permit(parent), claimState).rejects.toThrow('HarnessNotInCampaign');
      }
      await env.reset();
      const noWorld = await campaign({ world: false });
      await expect(permit(noWorld.parent)).rejects.toThrow('NotCampaignWorld');
      await env.reset();
      const noFreeze = await campaign({ freeze: false });
      await expect(permit(noFreeze.parent)).rejects.toThrow('NotCampaignWorld');
      expect(await rows()).toEqual([]);
    });

    it('refuses a scope that has a production deployment or is not an evaluation scope', async () => {
      const { parent } = await campaign();
      await deployWorker(env.service, {
        ...validBundle(),
        contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 2 },
      });
      await expect(permit(parent)).rejects.toThrow('NotCampaignWorld');
      await env.service.control.collection('deployments').deleteMany({});
      await expect(
        new ArtifactRepository(await as('grader')).permitForCampaign(
          { ...scope, env: 'demo' },
          CAMPAIGN,
          parent,
        ),
      ).rejects.toThrow('NotCampaignWorld');
      expect(await rows()).toEqual([]);
    });

    it("is the grader's alone", async () => {
      const { parent } = await campaign();
      for (const principal of [
        'domain_executor',
        'fixture_builder',
        'promoter',
        'observer',
        'proposer',
        'setup',
      ] as const)
        await expect(permit(parent, principal), principal).rejects.toThrow('PrincipalBoundary');
      expect(await rows()).toEqual([]);
    });
  },
);
