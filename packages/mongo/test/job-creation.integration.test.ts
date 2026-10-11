import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobKind } from '@expunge/contracts';
import {
  ArtifactRepository,
  DeploymentRepository,
  JOB_CREATOR_PRINCIPALS,
  JobRepository,
  PRINCIPALS,
  WorldRepository,
  type MongoService,
  type Principal,
} from '../src/index.js';
import { projectionHash } from '@expunge/contracts';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import { HASH, actor, deployWorker, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const KINDS = Object.keys(JOB_CREATOR_PRINCIPALS) as JobKind[];

describe('the executable projection that names a campaign child (offline)', () => {
  // The parity with the gate's own projectionHash is asserted in packages/gate's tests (the mongo package must not
  // import the gate).
  it('ignores evidence and rule citations, and changes with anything a run reads', () => {
    const bundle = validBundle();
    const recited = {
      ...bundle,
      evidence: [],
      guardrails: bundle.guardrails.map((rule) => ({ ...rule, sourceEvidenceIds: ['e'] })),
    };
    expect(projectionHash(recited)).toBe(projectionHash(bundle));
    expect(
      projectionHash({ ...bundle, contextPolicy: { ...bundle.contextPolicy, referenceDepth: 9 } }),
    ).not.toBe(projectionHash(bundle));
    expect(projectionHash({ ...bundle, parentHash: 'a'.repeat(64) })).not.toBe(projectionHash(bundle));
  });
});

describe('who may create which job kind (DA-8 D8-3, offline)', () => {
  it('names at least one creator for every kind, only real principals, and never a grader for a cleanup', () => {
    for (const kind of KINDS) {
      expect(JOB_CREATOR_PRINCIPALS[kind].length, kind).toBeGreaterThan(0);
      for (const principal of JOB_CREATOR_PRINCIPALS[kind]) expect(PRINCIPALS).toContain(principal);
    }
    expect(JOB_CREATOR_PRINCIPALS.cleanup).toEqual(['domain_executor', 'promoter']);
    expect(JOB_CREATOR_PRINCIPALS.cleanup).not.toContain('setup');
  });
});

describeLive(
  'job creation is bound to who may create it and to a deployed harness (real replica set)',
  () => {
    let env: LiveEnvironment;
    let as: (principal: Principal) => Promise<MongoService>;
    let n = 0;

    beforeAll(async () => {
      env = await openEnvironment('jobcreate');
      as = (principal) => env.as(principal);
    }, 30000);
    beforeEach(() => env.reset());
    afterAll(async () => {
      if (env) await env.dispose();
    }, 30000);

    /** A fresh world, then a job of `kind` created by `creator`. */
    async function create(creator: MongoService, kind: JobKind, harnessHash: string) {
      const worldId = `world-${++n}`;
      await new WorldRepository(env.service).create(scope, worldId, 1);
      return new JobRepository(creator).create(actor, {
        kind,
        binding: { runId: `run-${n}`, worldId, harnessHash, scopeRevision: 1, workerProfileHash: HASH },
      });
    }

    describe('NT-3a: only a creator of the kind can queue it', () => {
      it('refuses every principal that does not own the kind, and writes no job', async () => {
        const deployed = await deployWorker(env.service);
        for (const kind of KINDS)
          for (const principal of PRINCIPALS) {
            if (principal === 'setup' || JOB_CREATOR_PRINCIPALS[kind].includes(principal)) continue;
            // Principals with no right to insert into jobs at all are refused earlier; both are PrincipalBoundary.
            await expect(
              create(await as(principal), kind, kind === 'cleanup' ? deployed : HASH),
              `${principal} -> ${kind}`,
            ).rejects.toThrow('PrincipalBoundary');
          }
        expect(await env.service.control.collection('jobs').countDocuments()).toBe(0);
      });

      it('lets each owner create its kind, and the setup administrator create any', async () => {
        const deployed = await deployWorker(env.service);
        for (const kind of KINDS) {
          const owner = JOB_CREATOR_PRINCIPALS[kind][0]!;
          expect(
            (await create(await as(owner), kind, kind === 'cleanup' ? deployed : HASH))._id,
            kind,
          ).toBeTruthy();
          expect((await create(env.service, kind, HASH))._id, `setup ${kind}`).toBeTruthy();
        }
      });
    });

    describe('NT-3b: a cleanup is pinned to the harness the scope has deployed', () => {
      it('refuses a domain_executor cleanup while the scope has no deployment pointer', async () => {
        const stored = (await new ArtifactRepository(env.service).insert(validBundle()))._id;
        await expect(create(await as('domain_executor'), 'cleanup', stored)).rejects.toThrow(
          'HarnessNotDeployed',
        );
        await expect(create(await as('promoter'), 'cleanup', stored)).rejects.toThrow('HarnessNotDeployed');
        expect(await env.service.control.collection('jobs').countDocuments()).toBe(0);
      });

      it('refuses a stored but never promoted harness, however well formed, and an invented hash', async () => {
        const deployed = await deployWorker(env.service);
        // A proposer-style candidate: a valid artifact that is in the store but is not what the scope runs.
        const candidate = (
          await new ArtifactRepository(env.service).insert({
            ...validBundle(),
            parentHash: deployed,
            contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 3 },
          })
        )._id;
        expect(candidate).not.toBe(deployed);
        const executor = await as('domain_executor');
        await expect(create(executor, 'cleanup', candidate)).rejects.toThrow('HarnessNotDeployed');
        await expect(create(executor, 'cleanup', 'f'.repeat(64))).rejects.toThrow('HarnessNotDeployed');
        expect((await create(executor, 'cleanup', deployed)).binding.harnessHash).toBe(deployed);
        expect(await env.service.control.collection('jobs').countDocuments()).toBe(1);
      });

      it("does not accept another scope's deployment as this scope's", async () => {
        const deployed = await deployWorker(env.service);
        await new DeploymentRepository(env.service).initialize(
          { ...actor, scopeId: 'elsewhere' },
          'worker',
          (await new ArtifactRepository(env.service).insert({ ...validBundle(), parentHash: deployed }))._id,
          1,
        );
        const executor = await as('domain_executor');
        await env.service.control.collection('deployments').deleteOne({ scopeId: actor.scopeId });
        await expect(create(executor, 'cleanup', deployed)).rejects.toThrow('HarnessNotDeployed');
      });

      it('follows the pointer: after it moves, the old harness is refused and the new one is accepted', async () => {
        const first = await deployWorker(env.service);
        const second = (
          await new ArtifactRepository(env.service).insert({ ...validBundle(), parentHash: first })
        )._id;
        const executor = await as('domain_executor');
        expect((await create(executor, 'cleanup', first))._id).toBeTruthy();
        await env.service.control
          .collection('deployments')
          .updateOne({ scopeId: actor.scopeId, target: 'worker' }, { $set: { activeHash: second } });
        await expect(create(executor, 'cleanup', first)).rejects.toThrow('HarnessNotDeployed');
        expect((await create(executor, 'cleanup', second))._id).toBeTruthy();
      });
    });

    describe('the worker can ask whether a queued cleanup still runs the deployed harness', () => {
      it('passes for the deployed harness, fails closed once the pointer moved or vanished, ignores other kinds', async () => {
        const first = await deployWorker(env.service);
        const executor = await as('domain_executor');
        const jobs = new JobRepository(executor);
        const queued = await create(executor, 'cleanup', first);
        await expect(jobs.assertHarnessDeployed(actor, queued._id)).resolves.toBeUndefined();

        const other = (
          await new ArtifactRepository(env.service).insert({ ...validBundle(), parentHash: first })
        )._id;
        await env.service.control
          .collection('deployments')
          .updateOne({ scopeId: actor.scopeId, target: 'worker' }, { $set: { activeHash: other } });
        await expect(jobs.assertHarnessDeployed(actor, queued._id)).rejects.toThrow('HarnessNotDeployed');

        await env.service.control.collection('deployments').deleteMany({});
        await expect(jobs.assertHarnessDeployed(actor, queued._id)).rejects.toThrow('HarnessNotDeployed');

        const observation = await create(await as('observer'), 'observe', HASH);
        await expect(
          new JobRepository(await as('observer')).assertHarnessDeployed(actor, observation._id),
        ).resolves.toBeUndefined();
      });

      describe('a grader creates cleanup jobs only on campaign worlds, pinned to the campaign claim', () => {
        const CAMPAIGN = 'campaign-1';
        async function campaign(
          options: { claimState?: string; freeze?: boolean; worldCampaign?: string | null } = {},
        ) {
          const parent = await deployWorker(env.service);
          const childBundle = {
            ...validBundle(),
            parentHash: parent,
            contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 4 },
          };
          const child = (await new ArtifactRepository(env.service).insert(childBundle))._id;
          const worldId = `campaign-world-${++n}`;
          await new WorldRepository(env.service).create(scope, worldId, 1, {
            ...(options.worldCampaign === null ? {} : { campaignId: options.worldCampaign ?? CAMPAIGN }),
          });
          if (options.freeze !== false)
            await env.service.control.collection('campaign_freezes').insertOne({ _id: CAMPAIGN as never });
          await env.service.control.collection('gate_claims').insertOne({
            _id: 'claim-1' as never,
            parentHash: parent,
            childProjectionHash: projectionHash(childBundle),
            campaignId: CAMPAIGN,
            state: options.claimState ?? 'open',
          });
          return { parent, child, worldId };
        }
        const create = async (principal: Principal, worldId: string, harnessHash: string) =>
          new JobRepository(await as(principal)).createCampaignJob(actor, {
            kind: 'cleanup',
            campaignId: CAMPAIGN,
            binding: { runId: `run-${++n}`, worldId, harnessHash, scopeRevision: 1, workerProfileHash: HASH },
          });

        it("admits the claim's parent and its exact child, and the worker start check accepts them without a pointer", async () => {
          const { parent, child, worldId } = await campaign();
          // The scope's own pointer is not what a campaign episode runs.
          await env.service.control.collection('deployments').deleteMany({});
          for (const hash of [parent, child]) {
            const job = await create('grader', worldId, hash);
            expect(job.binding.harnessHash).toBe(hash);
            await expect(
              new JobRepository(await as('domain_executor')).assertHarnessDeployed(actor, job._id),
            ).resolves.toBeUndefined();
          }
        });

        it('refuses a harness the campaign does not own: another parent, a changed child, an unstored hash', async () => {
          const { parent, worldId } = await campaign();
          const store = new ArtifactRepository(env.service);
          const otherParent = (
            await store.insert({
              ...validBundle(),
              contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 7 },
            })
          )._id;
          const sameParentOtherChild = (
            await store.insert({
              ...validBundle(),
              parentHash: parent,
              contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 6 },
            })
          )._id;
          for (const hash of [otherParent, sameParentOtherChild, 'f'.repeat(64)])
            await expect(create('grader', worldId, hash), hash.slice(0, 8)).rejects.toThrow(
              'HarnessNotInCampaign',
            );
        });

        it("refuses a child whose projection matches the claim but whose parent is not the claim's parent", async () => {
          const { parent, worldId } = await campaign();
          const strangerParent = (
            await new ArtifactRepository(env.service).insert({
              ...validBundle(),
              contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 8 },
            })
          )._id;
          const impostor = {
            ...validBundle(),
            parentHash: strangerParent,
            contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 5 },
          };
          const impostorHash = (await new ArtifactRepository(env.service).insert(impostor))._id;
          // The claim now names this very projection as its child, but the claim's parent is another artifact.
          await env.service.control
            .collection('gate_claims')
            .updateOne({ campaignId: CAMPAIGN }, { $set: { childProjectionHash: projectionHash(impostor) } });
          expect(impostor.parentHash).not.toBe(parent);
          await expect(create('grader', worldId, impostorHash)).rejects.toThrow('HarnessNotInCampaign');
        });

        it('refuses when the claim is not open, and when the campaign has no freeze or the world is not its world', async () => {
          for (const claimState of ['held', 'decided', 'failed']) {
            await env.reset();
            const { parent, worldId } = await campaign({ claimState });
            await expect(create('grader', worldId, parent), claimState).rejects.toThrow(
              'HarnessNotInCampaign',
            );
          }
          await env.reset();
          const noFreeze = await campaign({ freeze: false });
          await expect(create('grader', noFreeze.worldId, noFreeze.parent)).rejects.toThrow(
            'NotCampaignWorld',
          );
          await env.reset();
          const plain = await campaign({ worldCampaign: null });
          await expect(create('grader', plain.worldId, plain.parent)).rejects.toThrow('NotCampaignWorld');
          await env.reset();
          const other = await campaign({ worldCampaign: 'some-other-campaign' });
          await expect(create('grader', other.worldId, other.parent)).rejects.toThrow('NotCampaignWorld');
          expect(await env.service.control.collection('jobs').countDocuments()).toBe(0);
        });

        it("is the grader's alone: no other principal, and not the plain create path", async () => {
          const { parent, worldId } = await campaign();
          for (const principal of [
            'domain_executor',
            'promoter',
            'observer',
            'fixture_builder',
            'setup',
          ] as const)
            await expect(create(principal, worldId, parent), principal).rejects.toThrow('PrincipalBoundary');
          await expect(
            new JobRepository(await as('grader')).create(actor, {
              kind: 'cleanup',
              binding: {
                runId: 'r',
                worldId,
                harnessHash: parent,
                scopeRevision: 1,
                workerProfileHash: HASH,
              },
            }),
          ).rejects.toThrow('PrincipalBoundary');
        });

        it('a production world is not a campaign world: the deployed pointer still binds it', async () => {
          const deployed = await deployWorker(env.service);
          await new WorldRepository(env.service).create(scope, 'production-world', 1);
          const other = (
            await new ArtifactRepository(env.service).insert({ ...validBundle(), parentHash: deployed })
          )._id;
          const executor = await as('domain_executor');
          await expect(create('grader', 'production-world', deployed)).rejects.toThrow('NotCampaignWorld');
          await expect(
            new JobRepository(executor).create(actor, {
              kind: 'cleanup',
              binding: {
                runId: 'r',
                worldId: 'production-world',
                harnessHash: other,
                scopeRevision: 1,
                workerProfileHash: HASH,
              },
            }),
          ).rejects.toThrow('HarnessNotDeployed');
        });
      });
    });
  },
);
