import { createPrincipalService, mongoConfigFromEnv, type Principal } from '@expunge/mongo';
const config = mongoConfigFromEnv();

/**
 * What the worker-facing principal can reach, measured against the server rather than read from our own manifest:
 * its granted privileges must not name the private database, and a direct read of it must be refused (code 13).
 * Booleans and counts only; no URI, credential or server message is printed. Local replica sets without auth
 * grant everything to everyone, so there the result says `rbacEnforced: false` and proves nothing about Atlas.
 */
async function probeBoundary(principal: Principal) {
  const service = createPrincipalService(config, principal);
  try {
    await service.client.connect();
    const status = await service.world.command({ connectionStatus: 1, showPrivileges: true });
    const privileges: Array<{ resource?: { db?: string } }> =
      status.authInfo?.authenticatedUserPrivileges ?? [];
    const privateDb = config.privateDatabase ?? 'expunge_private';
    let privateReadRefused: boolean | null = null;
    try {
      await service.client.db(privateDb).collection('campaign_keys').findOne({});
      privateReadRefused = false;
    } catch (error) {
      privateReadRefused = Boolean(
        error && typeof error === 'object' && 'code' in error && error.code === 13,
      );
    }
    return {
      principal,
      authenticated: (status.authInfo?.authenticatedUsers?.length ?? 0) > 0,
      privilegeCount: privileges.length,
      privilegesNamePrivateDatabase: privileges.some((entry) => entry.resource?.db === privateDb),
      privateReadRefused,
      rbacEnforced: privileges.length > 0 && privateReadRefused === true,
    };
  } finally {
    await service.close();
  }
}
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
      boundary: config.uris.domain_executor
        ? await probeBoundary('domain_executor')
        : 'domain_executor not configured',
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
