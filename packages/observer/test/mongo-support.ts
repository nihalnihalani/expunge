import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';
import type { ActorContext, ScopeKey } from '@expunge/contracts';
import {
  AuthorityRepository,
  JobRepository,
  WorldRepository,
  createPrincipalService,
  setupMongo,
  type MongoService,
  type Principal,
} from '@expunge/mongo';

/**
 * Real-MongoDB protocol lane for the observer and the telemetry outbox. This is a LOCAL replica set: it proves
 * transactions, fences, unique keys and validators, and is not evidence about Atlas RBAC or any invited deployment.
 */
export const TEST_URI = process.env.MONGODB_TEST_URI;
export const REQUIRE_LIVE_TESTS = process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1';

export const describeLive = ((name: string, factory: () => void) => {
  if (TEST_URI) return describe(name, factory);
  if (!REQUIRE_LIVE_TESTS) return describe.skip(name, factory);
  return describe(name, () => {
    it('requires MONGODB_TEST_URI (EXPUNGE_REQUIRE_LIVE_TESTS=1)', () => {
      throw new Error('MONGODB_TEST_URI is not set but live suites are required');
    });
  });
}) as typeof describe;

export const HASH = 'a'.repeat(64);
export const actor: ActorContext = {
  actorId: 'owner',
  tenantId: 'observer-protocol',
  env: 'evaluation',
  scopeId: 'scope',
  authorizationRevision: 1,
};
export const scope: ScopeKey = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

export type LiveEnvironment = {
  setup: MongoService;
  as(principal: Principal): Promise<MongoService>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
};

export async function openEnvironment(label: string): Promise<LiveEnvironment> {
  const prefix = `expunge_${label}_${randomUUID().replaceAll('-', '')}`;
  const names = {
    worldDatabase: `${prefix}_world`,
    controlDatabase: `${prefix}_control`,
    privateDatabase: `${prefix}_private`,
  };
  const others: MongoService[] = [];
  const setup = createPrincipalService({ uris: { setup: TEST_URI! }, ...names }, 'setup');
  await setup.client.connect();
  await setupMongo(setup);
  await new AuthorityRepository(setup).install(scope, HASH, 1);
  return {
    setup,
    async as(principal) {
      const service = createPrincipalService({ uris: { [principal]: TEST_URI! }, ...names }, principal);
      await service.client.connect();
      others.push(service);
      return service;
    },
    async reset() {
      for (const db of [setup.world, setup.control, setup.privateDb!])
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray())
          await db.collection(name).deleteMany({});
      await new AuthorityRepository(setup).install(scope, HASH, 1);
    },
    async dispose() {
      for (const service of others) await service.close();
      await setup.world.dropDatabase();
      await setup.control.dropDatabase();
      await setup.privateDb!.dropDatabase();
      await setup.close();
    },
  };
}

/** A queued cleanup job bound to a fresh world, as the trusted dispatcher would find it. */
export async function createJob(setup: MongoService, id = randomUUID()): Promise<string> {
  await new WorldRepository(setup).create(scope, `world-${id}`, 1);
  await new JobRepository(setup).create(actor, {
    jobId: id,
    kind: 'cleanup',
    binding: {
      runId: `run-${id}`,
      worldId: `world-${id}`,
      harnessHash: HASH,
      scopeRevision: 1,
      workerProfileHash: HASH,
    },
  });
  return id;
}
