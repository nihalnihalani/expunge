import { createHash, randomBytes } from 'node:crypto';
import { atlasRoleManifests, PRINCIPAL_URI_VARIABLES, type Principal } from '@expunge/mongo';

/**
 * Pure planning for the Atlas custom database roles and database users that `atlasRoleManifests()` describes, plus the
 * manual UI checklist and the digest authentication the Atlas Administration API accepts for a project API key.
 *
 * Endpoints (Atlas Administration API v2, version header `application/vnd.atlas.2023-01-01+json`):
 *   GET/POST   /api/atlas/v2/groups/{groupId}/customDBRoles/roles
 *   GET/PATCH  /api/atlas/v2/groups/{groupId}/customDBRoles/roles/{roleName}      (PATCH body: actions, inheritedRoles)
 *   GET/POST   /api/atlas/v2/groups/{groupId}/databaseUsers   (POST body: databaseName, username, roles, password; 201)
 *   GET/PATCH  /api/atlas/v2/groups/{groupId}/databaseUsers/{databaseName}/{username}
 * The apply script authenticates with a service account (OAuth client credentials). The digest helpers below are for a
 * project API key, the alternative the API also accepts; the role requirement is Project Owner or Project Database Access Admin. Nothing here reads a secret value: only variable NAMES are used.
 */
/** The one Accept version both Atlas scripts use. */
export const ATLAS_ACCEPT = 'application/vnd.atlas.2023-01-01+json';
/** Service-account (OAuth client credentials) variables a live apply needs, by name. */
export const ATLAS_ENV_NAMES = ['ATLAS_CLIENT_ID', 'ATLAS_CLIENT_SECRET', 'ATLAS_PROJECT_ID'] as const;
export const DATABASE_ENV_NAMES = ['EXPUNGE_WORLD_DB', 'EXPUNGE_CONTROL_DB', 'EXPUNGE_PRIVATE_DB'] as const;

/** The configured database names. Unset names are refused (a role for the wrong database is worse than no role). */
export function databaseNamesFromEnv(env: NodeJS.ProcessEnv): {
  world: string;
  control: string;
  private: string;
} {
  const unset = DATABASE_ENV_NAMES.filter((name) => !env[name]);
  if (unset.length > 0) throw new Error(`MissingConfiguration:${unset.join(',')}`);
  return { world: env.EXPUNGE_WORLD_DB!, control: env.EXPUNGE_CONTROL_DB!, private: env.EXPUNGE_PRIVATE_DB! };
}

export type PlannedRole = {
  principal: Principal;
  roleName: string;
  actions: Array<{ action: string; resources: Array<{ db: string; collection: string; cluster: false }> }>;
  inheritedRoles: [];
};
export type PlannedUser = {
  principal: Principal;
  username: string;
  databaseName: 'admin';
  roles: Array<{ roleName: string; databaseName: 'admin' }>;
  /** Name of the environment variable that will hold this principal's connection string (never its value). */
  uriVariable: string;
  /** Name of the environment variable the apply step reads the password from (never its value). */
  passwordVariable: string;
};
export type AtlasPlan = { roles: PlannedRole[]; users: PlannedUser[] };

const RESOURCE_ORDER = (a: { db: string; collection: string }, b: { db: string; collection: string }) =>
  `${a.db}.${a.collection}`.localeCompare(`${b.db}.${b.collection}`);

/**
 * Atlas refuses a role that names the same action twice, and the manifest lists an action once per database, so the
 * actions are merged into one entry per action with de-duplicated, sorted namespaces. Order is deterministic.
 */
export function planAtlasRoles(
  names = { world: 'expunge_world', control: 'expunge_control', private: 'expunge_private' },
): AtlasPlan {
  const manifests = atlasRoleManifests(names);
  const roles: PlannedRole[] = [];
  const users: PlannedUser[] = [];
  for (const principal of Object.keys(manifests).sort() as Principal[]) {
    const manifest = manifests[principal]!;
    const merged = new Map<string, Map<string, { db: string; collection: string; cluster: false }>>();
    for (const action of manifest.actions) {
      const namespaces = merged.get(action.action) ?? new Map();
      for (const resource of action.resources)
        namespaces.set(`${resource.db}.${resource.collection}`, { ...resource, cluster: false as const });
      merged.set(action.action, namespaces);
    }
    roles.push({
      principal,
      roleName: manifest.roleName,
      actions: [...merged]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([action, namespaces]) => ({
          action,
          resources: [...namespaces.values()].sort(RESOURCE_ORDER),
        })),
      inheritedRoles: [],
    });
    users.push({
      principal,
      username: `expunge-${principal.replace(/_/g, '-')}`,
      databaseName: 'admin',
      roles: [{ roleName: manifest.roleName, databaseName: 'admin' }],
      uriVariable: PRINCIPAL_URI_VARIABLES[principal],
      passwordVariable: `ATLAS_USER_PASSWORD_${principal.toUpperCase()}`,
    });
  }
  return { roles, users };
}

type RoleBody = { actions: PlannedRole['actions']; inheritedRoles?: unknown[] };
/** One entry per (action, resource): `ACTION@db.collection`, or `ACTION@cluster`. Atlas's own grouping cannot change it. */
export function flattenRole(role: RoleBody): string[] {
  const entries = new Set<string>();
  for (const entry of role.actions ?? [])
    for (const r of entry.resources ?? [])
      entries.add(
        `${entry.action}@${(r as { cluster?: boolean }).cluster ? 'cluster' : `${r.db}.${r.collection ?? ''}`}`,
      );
  return [...entries].sort();
}
/** What applying `desired` over `existing` adds and removes, as flattened entries. */
export function diffRole(
  desired: RoleBody,
  existing: RoleBody | null,
): { added: string[]; removed: string[] } {
  const want = new Set(flattenRole(desired));
  const have = new Set(existing ? flattenRole(existing) : []);
  return { added: [...want].filter((e) => !have.has(e)), removed: [...have].filter((e) => !want.has(e)) };
}
/** Equal when the flattened (action, resource) sets are equal and the inherited roles match. */
export function sameRole(a: RoleBody, b: RoleBody): boolean {
  const diff = diffRole(a, b);
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    JSON.stringify(a.inheritedRoles ?? []) === JSON.stringify(b.inheritedRoles ?? [])
  );
}

/** The dry-run report: what an apply would create or change, with names only. No value of any variable appears. */
export function dryRunReport(plan: AtlasPlan, env: NodeJS.ProcessEnv = process.env) {
  return {
    mode: 'dry-run',
    apiVersion: ATLAS_ACCEPT,
    credentials: Object.fromEntries(ATLAS_ENV_NAMES.map((name) => [name, env[name] ? 'set' : 'MISSING'])),
    liveApply: ATLAS_ENV_NAMES.every((name) => env[name]) ? 'possible' : 'BLOCKED: missing ATLAS_* variables',
    roles: plan.roles.map((role) => ({
      roleName: role.roleName,
      actions: role.actions.map((entry) => ({ action: entry.action, namespaces: entry.resources.length })),
    })),
    users: plan.users.map((user) => ({
      username: user.username,
      roles: user.roles.map((r) => r.roleName),
      passwordVariable: user.passwordVariable,
      passwordVariableSet: env[user.passwordVariable] ? 'set' : 'MISSING',
      uriVariable: user.uriVariable,
    })),
  };
}

/** Manual steps for the Atlas UI (Database Access > Custom Roles, then Database Users), generated from the plan. */
export function manualChecklist(plan: AtlasPlan): string {
  const lines: string[] = [
    '# Atlas manual setup: custom roles and database users',
    '',
    'Atlas UI > Security > Database & Network Access > Custom Roles > Add Custom Role. One role per row below; for each',
    'action choose "Collection Action"-level privileges and add every listed database.collection. Do not grant anything else.',
    '',
  ];
  plan.roles.forEach((role, index) => {
    lines.push(`${index + 1}. Role \`${role.roleName}\``);
    for (const entry of role.actions)
      lines.push(`   - ${entry.action}: ${entry.resources.map((r) => `${r.db}.${r.collection}`).join(', ')}`);
  });
  lines.push(
    '',
    'Then Database Access > Add New Database User > Password; Authentication Database `admin`; under Database User',
    'Privileges choose "Custom Role" and select exactly the role named for the user; restrict to no other role:',
    '',
  );
  plan.users.forEach((user, index) =>
    lines.push(
      `${index + 1}. User \`${user.username}\` with role \`${user.roles[0]!.roleName}\`; generate a unique password, store it in a ` +
        `secret manager, and set \`${user.uriVariable}\` (never paste a password into chat, logs or git).`,
    ),
  );
  lines.push(
    '',
    'Verify: each user connects and can only perform the actions of its role (run `npm run probe:mongo` with the role-scoped URIs set).',
  );
  return lines.join('\n');
}

// ---- HTTP digest authentication (RFC 7616, MD5 and SHA-256, qop=auth), for a project API key ------------------------------
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export type DigestChallenge = {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
};

export function parseDigestChallenge(header: string): DigestChallenge {
  if (!/^digest\s/i.test(header)) throw new Error('NotDigestChallenge');
  const fields: Record<string, string> = {};
  for (const match of header.replace(/^digest\s+/i, '').matchAll(/([a-z]+)=(?:"([^"]*)"|([^,\s]*))/gi))
    fields[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? '';
  if (!fields.realm || !fields.nonce) throw new Error('InvalidDigestChallenge');
  return {
    realm: fields.realm,
    nonce: fields.nonce,
    ...(fields.qop ? { qop: fields.qop } : {}),
    ...(fields.opaque ? { opaque: fields.opaque } : {}),
    ...(fields.algorithm ? { algorithm: fields.algorithm } : {}),
  };
}

/** The Authorization header for one request. `cnonce` is injectable so the computation is testable. */
export function digestAuthorization(input: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  nonceCount?: number;
  cnonce?: string;
}): string {
  const { challenge } = input;
  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  const hash = algorithm === 'SHA-256' ? sha256 : algorithm === 'MD5' ? md5 : null;
  if (!hash) throw new Error('UnsupportedDigestAlgorithm');
  const cnonce = input.cnonce ?? randomBytes(8).toString('hex');
  const nc = (input.nonceCount ?? 1).toString(16).padStart(8, '0');
  const qop = challenge.qop
    ?.split(',')
    .map((q) => q.trim())
    .includes('auth')
    ? 'auth'
    : undefined;
  const ha1 = hash(`${input.username}:${challenge.realm}:${input.password}`);
  const ha2 = hash(`${input.method}:${input.uri}`);
  const response = qop
    ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${input.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${input.uri}"`,
    `response="${response}"`,
    ...(challenge.algorithm ? [`algorithm=${challenge.algorithm}`] : []),
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
    ...(challenge.opaque ? [`opaque="${challenge.opaque}"`] : []),
  ];
  return `Digest ${parts.join(', ')}`;
}
