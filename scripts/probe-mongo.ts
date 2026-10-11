import { createPrincipalService, mongoConfigFromEnv } from '@expunge/mongo';
const config = mongoConfigFromEnv();
const service = createPrincipalService(config, 'setup');
try {
  await service.client.connect();
  const hello = await service.world.command({ hello: 1 });
  const build = await service.world.command({ buildInfo: 1 });
  const status = await service.world.command({ connectionStatus: 1, showPrivileges: true });
  console.log(
    JSON.stringify({
      serverVersion: build.version,
      replicaSet: typeof hello.setName === 'string',
      mongos: hello.msg === 'isdbgrid',
      transactionSupport: typeof hello.setName === 'string' || hello.msg === 'isdbgrid',
      logicalSessionTimeoutMinutes: hello.logicalSessionTimeoutMinutes,
      authenticatedRoleNames: status.authInfo?.authenticatedUserRoles?.map((r: { role: string }) => r.role),
      configuredPrincipals: Object.keys(config.uris),
      atlasTier: 'not inferable from driver; confirm in Atlas console',
      searchIndexes: 'not provisioned by this probe',
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof Error ? error.name : 'ProbeError',
      message: 'MongoDB probe failed; credentials and server responses withheld',
    }),
  );
  process.exitCode = 1;
} finally {
  await service.close();
}
