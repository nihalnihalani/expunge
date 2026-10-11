import {
  MongoClient,
  type Db,
  type ClientSession,
  type Document,
  type Filter,
  type ObjectId,
  type Long,
} from 'mongodb';
import type { ActorContext, ScopeKey } from '@expunge/contracts';

export const PRINCIPALS = [
  'setup',
  'domain_executor',
  'observer',
  'proposer',
  'grader',
  'approval_issuer',
  'promoter',
  'projection_reader',
  'privacy_controller',
  'fixture_builder',
] as const;
export type Principal = (typeof PRINCIPALS)[number];
export const PRINCIPAL_URI_VARIABLES: Record<Principal, string> = Object.fromEntries(
  PRINCIPALS.map((p) => [p, `MONGODB_${p.toUpperCase()}_URI`]),
) as Record<Principal, string>;
export type RuntimeDocument = {
  _id: string | ObjectId | number | Long;
  tenantId: string;
  env: ActorContext['env'];
  worldId: string;
  _rev: number;
  [key: string]: unknown;
};
export type MongoConfig = {
  uris: Partial<Record<Principal, string>>;
  worldDatabase?: string;
  controlDatabase?: string;
  privateDatabase?: string;
  appName?: string;
};
export type MongoService = {
  principal: Principal;
  client: MongoClient;
  world: Db;
  control: Db;
  privateDb?: Db;
  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};
const privatePrincipals: Principal[] = ['setup', 'grader', 'fixture_builder'];
export function mongoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  const uris: MongoConfig['uris'] = {};
  for (const p of PRINCIPALS) if (env[PRINCIPAL_URI_VARIABLES[p]]) uris[p] = env[PRINCIPAL_URI_VARIABLES[p]];
  return {
    uris,
    worldDatabase: env.EXPUNGE_WORLD_DB,
    controlDatabase: env.EXPUNGE_CONTROL_DB,
    privateDatabase: env.EXPUNGE_PRIVATE_DB,
  };
}
/** Each principal gets a distinct MongoClient. No fallback to setup credentials. */
export function createPrincipalService(config: MongoConfig, principal: Principal): MongoService {
  const uri = config.uris[principal];
  if (!uri) throw new Error(`MissingConfiguration:${PRINCIPAL_URI_VARIABLES[principal]}`);
  const client = new MongoClient(uri, {
    appName: `${config.appName ?? 'expunge'}:${principal}`,
    maxPoolSize: 8,
    serverSelectionTimeoutMS: 8000,
    retryWrites: true,
  });
  return {
    principal,
    client,
    world: client.db(config.worldDatabase ?? 'expunge_world'),
    control: client.db(config.controlDatabase ?? 'expunge_control'),
    ...(privatePrincipals.includes(principal)
      ? { privateDb: client.db(config.privateDatabase ?? 'expunge_private') }
      : {}),
    async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
      return client.withSession((session) =>
        session.withTransaction(() => work(session), {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          maxCommitTimeMS: 10000,
        }),
      );
    },
    close: () => client.close(),
  };
}
export function createMongoServices(config: MongoConfig): Partial<Record<Principal, MongoService>> {
  return Object.fromEntries(
    PRINCIPALS.filter((p) => config.uris[p]).map((p) => [p, createPrincipalService(config, p)]),
  );
}
export const createDomainExecutor = (config: MongoConfig) =>
  createPrincipalService(config, 'domain_executor');
export const createObserver = (config: MongoConfig) => createPrincipalService(config, 'observer');
export const createProposer = (config: MongoConfig) => createPrincipalService(config, 'proposer');
export const createGrader = (config: MongoConfig) => createPrincipalService(config, 'grader');
export const createApprovalIssuer = (config: MongoConfig) =>
  createPrincipalService(config, 'approval_issuer');
export const createPromoter = (config: MongoConfig) => createPrincipalService(config, 'promoter');
export const createProjectionReader = (config: MongoConfig) =>
  createPrincipalService(config, 'projection_reader');
export const createPrivacyController = (config: MongoConfig) =>
  createPrincipalService(config, 'privacy_controller');
export const createFixtureBuilder = (config: MongoConfig) =>
  createPrincipalService(config, 'fixture_builder');
export function requirePrincipal(service: MongoService, permitted: Principal[]): void {
  if (!permitted.includes(service.principal)) throw new Error('PrincipalBoundary');
}
export function scopeFilter(key: ScopeKey): ScopeKey {
  return { tenantId: key.tenantId, env: key.env, scopeId: key.scopeId };
}
/** Operators that run server-side JavaScript. A generated predicate must never carry one. */
const SERVER_SIDE_JAVASCRIPT = new Set(['$where', '$function', '$accumulator']);
const MAX_PREDICATE_DEPTH = 32;
function assertNoServerSideJavascript(value: unknown, depth = 0): void {
  if (depth > MAX_PREDICATE_DEPTH) fail('UnsafePredicate');
  if (Array.isArray(value)) {
    for (const item of value) assertNoServerSideJavascript(item, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object' || (value as { _bsontype?: unknown })._bsontype) return;
  for (const [key, child] of Object.entries(value)) {
    if (SERVER_SIDE_JAVASCRIPT.has(key)) fail('UnsafePredicate');
    assertNoServerSideJavascript(child, depth + 1);
  }
}
/**
 * Conjoins the trusted tenant/env/world binding with a generated predicate. The binding cannot be widened by the
 * predicate, and predicates carrying server-side JavaScript operators are refused outright.
 */
export function worldFilter(
  actor: Pick<ActorContext, 'tenantId' | 'env'>,
  worldId: string,
  generated: Document,
): Filter<RuntimeDocument> {
  assertNoServerSideJavascript(generated);
  return { $and: [{ tenantId: actor.tenantId, env: actor.env, worldId }, generated] };
}
export class ProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ProtocolError';
  }
}
export function fail(code: string): never {
  throw new ProtocolError(code);
}
