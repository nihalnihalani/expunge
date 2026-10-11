import { createPrincipalService, mongoConfigFromEnv, seedOptionsFromEnv, setupMongo } from '@expunge/mongo';
const service = createPrincipalService(mongoConfigFromEnv(), 'setup');
try {
  await service.client.connect();
  console.log(
    JSON.stringify({
      setup: await setupMongo(service, seedOptionsFromEnv()),
      roles:
        'Atlas role manifest must be applied with Atlas administration rights; driver setup does not create roles',
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof Error ? error.name : 'SetupError',
      message: 'MongoDB setup failed; inspect configuration and server logs privately',
    }),
  );
  process.exitCode = 1;
} finally {
  await service.close();
}
