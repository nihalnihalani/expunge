// Seeds a drill database set through the real code paths, after scripts/setup-mongo.ts has created collections,
// validators, indexes, the authority row and approval policies. Run with the setup principal against a LOCAL throwaway
// replica set only (the drill refuses any other host). Rows: a world, an admitted harness artifact, the deployment pointer
// and a queued cleanup job, each through its repository so validators and unique indexes are exercised.
import { randomUUID } from 'node:crypto';
import {
  ArtifactRepository,
  DeploymentRepository,
  JobRepository,
  WorldRepository,
  createPrincipalService,
  mongoConfigFromEnv,
} from '@expunge/mongo';
import type { ActorContext } from '@expunge/contracts';
import { validBundle } from '../../../packages/contracts/test/valid-bundle.js';

const tenantId = process.env.EXPUNGE_TENANT_ID!;
const scopeId = process.env.EXPUNGE_SCOPE_ID!;
const scopeEnv = process.env.EXPUNGE_ENV as ActorContext['env'];
const key = { tenantId, env: scopeEnv, scopeId };
const actor: ActorContext = { actorId: 'owner', ...key, authorizationRevision: 1 };

const service = createPrincipalService(mongoConfigFromEnv(), 'setup');
try {
  await service.client.connect();
  const worlds = new WorldRepository(service);
  const jobs = new JobRepository(service);
  const hash = (await new ArtifactRepository(service).insert(validBundle()))._id;
  await new DeploymentRepository(service).initialize(actor, 'worker', hash, 1);
  const created: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = randomUUID();
    await worlds.create(key, `world-${id}`, 1);
    await jobs.create(actor, {
      jobId: id,
      kind: 'cleanup',
      binding: {
        runId: `run-${id}`,
        worldId: `world-${id}`,
        harnessHash: hash,
        scopeRevision: 1,
        workerProfileHash: 'a'.repeat(64),
      },
    });
    created.push(id);
  }
  console.log(JSON.stringify({ seeded: { artifacts: 1, deployments: 1, worlds: 3, jobs: created.length } }));
} finally {
  await service.close();
}
