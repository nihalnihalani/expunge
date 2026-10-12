import { contentHash } from '@expunge/contracts';
import {
  createDomainEnv,
  createDomainService,
  listWorlds,
  listenDomainService,
  serviceConfigFromEnv,
  type DomainService,
} from '@expunge/domain';
import { COLLECTION_IDS, ELIGIBILITY_POLICY_HASH } from '@expunge/fixtures';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { createPrincipalService, mongoConfigFromEnv } from '@expunge/mongo';

/**
 * Runs the domain service (the operator's backend for worlds, previews, jobs, projections, receipts and deployments)
 * as its own process. It connects as the `domain_executor` principal only and binds to the loopback address taken from
 * EXPUNGE_DOMAIN_URL (default http://127.0.0.1:4320); it is for the operator server, never a public interface. Tokens,
 * owner and scope come from serviceConfigFromEnv. Logs carry codes and names only, never values.
 */
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
const errorName = (error: unknown) =>
  error instanceof Error ? ((error as { code?: string }).code ?? error.name) : 'Error';

const origin = new URL(process.env.EXPUNGE_DOMAIN_URL?.trim() || 'http://127.0.0.1:4320');
const host = origin.hostname;
const port = Number(origin.port || 4320);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
  log({ status: 'BLOCKED', code: 'EXPUNGE_DOMAIN_URL:not_loopback' });
  process.exit(2);
}

const config = serviceConfigFromEnv(process.env);
const executor = createPrincipalService(mongoConfigFromEnv(), 'domain_executor');
await executor.client.connect();
const env = createDomainEnv(executor, {
  floors: [DEFAULT_AUTHORITY_FLOOR],
  report: (event) =>
    log({
      level: 'warn',
      kind: event.kind,
      ...('toolId' in event ? { toolId: event.toolId } : {}),
      ...('error' in event ? { code: errorName(event.error) } : {}),
    }),
});
const scope = config.owner.scope;

/**
 * Source registration for the worlds this service can vouch for. A synthetic world seeded from the fixture families
 * (scripts/seed-world.ts) is an isolated copy the owner created in a non-release scope, so it is reported as an
 * `isolated_replay` source: its identity and revisions come from the stored world binding, scope registry and the
 * scope's authority row, never from constants. Anything else (a registry not built by the fixture families, a release
 * environment, no authority row) gets no binding, and the operator keeps cleanup blocked. Cleaning a copy never
 * touches an original source.
 */
type SourceBinding = {
  sourceId: string;
  sourceKind: 'isolated_replay';
  registrationHash: string;
  registrationRevision: number;
  policyRevision: number;
  authorizationRevision: number;
};
const RELEASE_ENVIRONMENTS: readonly string[] = ['staging', 'production'];
const FIXTURE_COLLECTIONS: readonly string[] = COLLECTION_IDS;

async function isolatedReplaySource(worldId: string): Promise<SourceBinding | null> {
  if (RELEASE_ENVIRONMENTS.includes(scope.env)) return null;
  const authority = await env.authority.read(scope).catch(() => null);
  if (!authority) return null;
  const state = await env.worlds.read(scope, worldId);
  const registry = await env.scopes.read(scope, state.scopeRevision);
  const seededByFixtures =
    registry.eligibilityPolicyHash === ELIGIBILITY_POLICY_HASH &&
    registry.collectionIds.length > 0 &&
    registry.collectionIds.every((id) => FIXTURE_COLLECTIONS.includes(id));
  if (!seededByFixtures) return null;
  return {
    sourceId: `replay:${state.worldId}`,
    sourceKind: 'isolated_replay',
    registrationHash: contentHash(
      {
        sourceKind: 'isolated_replay',
        scope: { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId },
        worldId: state.worldId,
        scopeRevision: registry.revision,
        collectionIds: registry.collectionIds,
        fields: registry.fields,
        referenceEdges: registry.referenceEdges,
        allowedEffectKinds: registry.allowedEffectKinds,
        eligibilityPolicyId: registry.eligibilityPolicyId,
        eligibilityPolicyHash: registry.eligibilityPolicyHash,
        documentLimits: registry.documentLimits,
      },
      'source_registration',
    ),
    registrationRevision: state.scopeRevision,
    policyRevision: registry.revision,
    authorizationRevision: authority.authorizationRevision,
  };
}

const unbound = {
  sourceId: null,
  sourceKind: null,
  sourceRegistrationHash: null,
  registrationRevision: null,
  policyRevision: null,
  authorizationRevision: null,
};

/** One source per scope: exactly one world, seeded by the fixtures, with a current authority row. */
async function sourceReadiness() {
  const { worlds } = await listWorlds(env, config);
  if (worlds.length === 0) return { registration: 'missing', permission: 'not_checked', ...unbound };
  const source = worlds.length === 1 ? await isolatedReplaySource(worlds[0]!.worldId) : null;
  if (!source) return { registration: 'unsupported', permission: 'not_checked', ...unbound };
  const { registrationHash, ...rest } = source;
  return {
    registration: 'active',
    permission: 'authorized',
    ...rest,
    sourceRegistrationHash: registrationHash,
  };
}

const PROJECTION = '/internal/projection/';
const withJson = async (response: Response, edit: (body: Record<string, unknown>) => Promise<void>) => {
  const body = (await response.json()) as Record<string, unknown>;
  // A binding that cannot be read is left out, so the operator sees an unreported source and keeps cleanup blocked.
  await edit(body).catch((error: unknown) =>
    log({ level: 'warn', kind: 'source_binding', code: errorName(error) }),
  );
  return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
};

const domain = createDomainService({ env, config });
const service: DomainService = {
  async handle(request) {
    const { pathname } = new URL(request.url);
    const response = await domain.handle(request);
    if (response.status !== 200 || !pathname.startsWith(PROJECTION)) return response;
    const route = `${request.method} ${pathname.slice(PROJECTION.length).replace(/\/+$/, '')}`;
    if (route === 'GET readiness')
      return withJson(response, async (body) => {
        body.source = await sourceReadiness();
      });
    if (route === 'GET worlds')
      return withJson(response, async (body) => {
        for (const world of body.worlds as Array<{ worldId: string; source?: SourceBinding }>) {
          const source = await isolatedReplaySource(world.worldId);
          if (source) world.source = source;
        }
      });
    if (route === 'POST previews')
      return withJson(response, async (body) => {
        const source = await isolatedReplaySource(body.worldId as string);
        if (source) body.source = source;
      });
    return response;
  },
};
const server = await listenDomainService(service, { host: host === 'localhost' ? '127.0.0.1' : host, port });

log({
  status: 'READY',
  listening: `${host}:${server.port}`,
  scope: config.owner.scope,
  principals: Object.keys(config.tokens),
  wake: config.wake ? 'configured' : 'not configured (jobs queue without waking a worker)',
  submit: config.workerProfileHash ? 'enabled' : 'disabled (EXPUNGE_WORKER_PROFILE_HASH missing)',
});

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  log({ status: 'STOPPING', signal });
  await server.close();
  await executor.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
