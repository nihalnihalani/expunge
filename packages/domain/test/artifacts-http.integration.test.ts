/**
 * Completion-receipt artifacts and the deployment view over the real HTTP route, on a real replica set. The receipt comes
 * from a job the gateway really ran (SCRIPTED DRIVER, no model). The deployment history is written as RAW stored rows with
 * the repositories' shapes (labeled: they are not produced by promote()/rollback(), whose full authority path is covered
 * in the mongo and deployment packets); the view's chain logic is what is under test. Every response is parsed with the
 * operator's own strict schemas.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deploymentIdentity } from '@expunge/contracts';
import { HASH, describeLive } from '../../mongo/test/support.js';
import {
  deploymentSchema,
  parseArtifact,
  snapshotSchema,
} from '../../../apps/operator/src/server/expunge/schemas.js';
import {
  createDomainService,
  readDeployment,
  serviceConfigFromEnv,
  type DomainService,
} from '../src/index.js';
import { driveExpert, openRig, type Rig, type Seeded } from './rig.js';

const READ = 'r'.repeat(32);
const JOB = 'j'.repeat(32);
const APPROVAL = 'a'.repeat(32);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

describeLive(
  'receipt artifacts and the deployment view over the real HTTP route (local protocol lane)',
  () => {
    let rig: Rig;
    let seeded: Seeded;
    let other: Seeded;
    let service: DomainService;
    let otherService: DomainService;
    let jobId: string;

    const configFor = (scope: Seeded) =>
      serviceConfigFromEnv({
        EXPUNGE_INTERNAL_TOKEN: READ,
        EXPUNGE_JOB_WRITE_TOKEN: JOB,
        EXPUNGE_APPROVAL_TOKEN: APPROVAL,
        OWNER_ID: 'owner',
        EXPUNGE_TENANT_ID: scope.binding.tenantId,
        EXPUNGE_ENV: scope.binding.env,
        EXPUNGE_SCOPE_ID: scope.binding.scopeId,
        EXPUNGE_WORKER_PROFILE_HASH: HASH,
      });
    const get = async (
      target: DomainService,
      path: string,
      headers: Record<string, string> = { authorization: `Bearer ${READ}`, 'x-expunge-owner-id': 'owner' },
    ) => {
      const response = await target.handle(
        new Request(`http://domain.test/internal/projection${path}`, { headers }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    beforeAll(async () => {
      rig = await openRig('artifactshttp');
      seeded = await rig.seed('direct_nested', 'art-a');
      other = await rig.seed('direct_nested', 'art-b');
      const run = await rig.open(seeded, 'expert');
      jobId = run.jobId;
      await driveExpert(run.tools);
      service = createDomainService({ env: rig.domain, config: configFor(seeded), wake: null });
      otherService = createDomainService({ env: rig.domain, config: configFor(other), wake: null });
    }, 120_000);
    afterAll(async () => {
      await rig?.dispose();
    });

    it("the snapshot indexes the receipt and GET artifacts serves it in the operator's shape, with its sequence, hash and effect counts", async () => {
      const snapshot = snapshotSchema.parse((await get(service, `/jobs/${jobId}`)).body);
      expect(snapshot.artifacts).toHaveLength(1);
      const ref = snapshot.artifacts[0]!;
      expect(ref).toMatchObject({
        kind: 'completion_receipt',
        committedAtSequence: snapshot.receipt!.sequence,
      });
      expect(ref.artifactId).toBe(snapshot.receipt!.receiptId);

      const response = await get(service, `/artifacts/${ref.artifactId}`);
      expect(response.status).toBe(200);
      const artifact = parseArtifact(response.body);
      expect(artifact).toMatchObject({
        artifactId: ref.artifactId,
        kind: 'completion_receipt',
        jobId,
        committedAtSequence: ref.committedAtSequence,
      });
      expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const payload = artifact.payload as Record<string, unknown> & {
        effectCounts: Record<string, number>;
        actionReceiptIds: string[];
      };
      expect(payload).toMatchObject({
        domainStatus: 'complete_in_registered_scope',
        scopeId: seeded.binding.scopeId,
        operationalResiduals: 0,
      });
      expect(payload.registeredCollectionIds).toEqual(seeded.world.scope.collectionIds);
      expect(
        Object.values(payload.effectCounts as Record<string, number>).reduce((a, b) => a + b, 0),
      ).toBeGreaterThan(0);
      expect(payload.actionReceiptIds.length).toBeGreaterThan(0);
      // Immutable: a second read is byte-identical.
      expect((await get(service, `/artifacts/${ref.artifactId}`)).body).toEqual(response.body);
    });

    it('refuses what it should: another scope and unknown ids are 404, a cursor is 400, no/other tokens are 401/403', async () => {
      const snapshot = snapshotSchema.parse((await get(service, `/jobs/${jobId}`)).body);
      const id = snapshot.receipt!.receiptId;
      expect((await get(otherService, `/artifacts/${id}`)).status).toBe(404);
      expect((await get(service, '/artifacts/not-a-receipt')).status).toBe(404);
      expect((await get(service, `/artifacts/${id}?cursor=abc`)).status).toBe(400);
      expect((await get(service, `/artifacts/${id}`, { 'x-expunge-owner-id': 'owner' })).status).toBe(401);
      expect(
        (
          await get(service, `/artifacts/${id}`, {
            authorization: `Bearer ${JOB}`,
            'x-expunge-owner-id': 'owner',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await get(service, '/deployments/worker', {
            authorization: `Bearer ${JOB}`,
            'x-expunge-owner-id': 'owner',
          })
        ).status,
      ).toBe(403);
      expect((await get(service, '/deployments/worker', { authorization: `Bearer ${READ}` })).status).toBe(
        403,
      );
    });

    it('the deployment view is 404 without a pointer, 400 for an unknown target, and walks the stored chain with a rolled-back version', async () => {
      expect((await get(service, '/deployments/improver')).status).toBe(404);
      expect((await get(service, '/deployments/everything')).status).toBe(400);
      const scope = seeded.binding;
      const key = { ...scope, target: 'worker' as const };
      const control = rig.env.service.control;
      const at = (n: number) => new Date(Date.UTC(2026, 9, 11, 12, n));
      const receipt = (
        n: number,
        from: string,
        to: string,
        fromRevision: number,
        gateReportId: string,
        extra: Record<string, unknown> = {},
      ) => ({
        _id: `promo-${n}`,
        ...key,
        promotionId: `promo-${n}`,
        fromHash: from,
        toHash: to,
        fromRevision,
        toRevision: fromRevision + 1,
        gateReportId,
        gateReportDigest: 'd'.repeat(64),
        runtimeHash: '9'.repeat(64),
        evaluatorHash: gateReportId === 'rollback' ? 'rollback' : 'e'.repeat(64),
        reason: gateReportId === 'rollback' ? 'regression found after promotion' : 'gate admitted',
        createdAt: at(n),
        ...extra,
      });
      // The pointer ends at H2 after: H1 -> H2 (promotion), H2 -> H3 (promotion), H3 -> H2 (rollback).
      await control.collection('deployments').insertOne({
        _id: deploymentIdentity(key),
        ...key,
        activeHash: H2,
        revision: 3,
        scopeRevision: 1,
        authorizationRevision: 1,
        updatedAt: at(9),
      } as never);
      for (const row of [
        receipt(1, H1, H2, 0, 'gate-report-1'),
        receipt(2, H2, H3, 1, 'gate-report-2', { consumedGrantId: 'grant-1' }),
        receipt(3, H3, H2, 2, 'rollback'),
      ])
        await control.collection('promotions').insertOne(row as never);

      const response = await get(service, '/deployments/worker');
      expect(response.status).toBe(200);
      const view = deploymentSchema.parse(response.body);
      expect(view).toMatchObject({ target: 'worker', activeHash: H2, revision: 3, initialBundleHash: H1 });
      expect(view.versions.map((v) => [v.hash, v.state, v.parentHash])).toEqual([
        [H1, 'previous', null],
        [H2, 'active', H1],
        [H3, 'rolled_back', H2],
      ]);
      const h3 = view.versions[2]!;
      expect(h3.promotion).toMatchObject({
        promotionId: 'promo-2',
        gateReportId: 'gate-report-2',
        consumedGrantId: 'grant-1',
      });
      expect(h3.rollback).toMatchObject({
        promotionId: 'promo-3',
        toHash: H2,
        reason: 'regression found after promotion',
      });
      expect(view.versions[1]!.promotion).toMatchObject({ promotionId: 'promo-1', consumedGrantId: null });
      expect(view.versions[0]!.promotion).toBeNull();
      // Refused rollbacks: insert-only audit rows, newest first, scoped; shaped like the operator's field.
      expect((response.body as { refusedRollbacks?: unknown }).refusedRollbacks).toEqual([]);
      for (const [n, code, toHash, scopeId] of [
        [1, 'RollbackNeedsGrant', H1, key.scopeId],
        [2, 'StaleParent', H3, key.scopeId],
        [3, 'RollbackNeedsGrant', H1, 'another-scope'],
      ] as const)
        await control.collection('rollback_refusals').insertOne({
          _id: `refusal-${n}`,
          ...key,
          scopeId,
          toHash,
          code,
          at: at(n),
          actor: { actorId: 'operator-1', authorizationRevision: 1 },
        } as never);
      const refused = (await get(service, '/deployments/worker')).body as {
        refusedRollbacks?: Array<{ toHash: string; code: string; at: string }>;
      };
      expect(refused.refusedRollbacks?.map((r) => [r.toHash, r.code])).toEqual([
        [H3, 'StaleParent'],
        [H1, 'RollbackNeedsGrant'],
      ]);
      expect(refused.refusedRollbacks?.[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Omission is ONLY for an authorization error; any other read error fails the request (FAKE collection failures).
      const failing = (error: unknown) => {
        const control = rig.domain.service.control;
        const controlProxy = new Proxy(control, {
          get: (target, prop) =>
            prop === 'collection'
              ? (name: string) =>
                  name === 'rollback_refusals'
                    ? {
                        find: () => ({
                          toArray: () => Promise.reject(error),
                        }),
                      }
                    : target.collection(name)
              : Reflect.get(target, prop, target),
        });
        const serviceProxy = new Proxy(rig.domain.service, {
          get: (target, prop) => (prop === 'control' ? controlProxy : Reflect.get(target, prop, target)),
        });
        return { ...rig.domain, service: serviceProxy } as typeof rig.domain;
      };
      const config = configFor(seeded);
      const unauthorized = await readDeployment(
        failing({ code: 13, codeName: 'Unauthorized' }),
        config,
        'worker',
      );
      expect('refusedRollbacks' in unauthorized).toBe(false);
      expect(unauthorized.activeHash).toBe(H2);
      await expect(readDeployment(failing(new Error('network down')), config, 'worker')).rejects.toThrow(
        'network down',
      );
      // Another scope has no pointer of its own.
      expect((await get(otherService, '/deployments/worker')).status).toBe(404);
    });
  },
);
