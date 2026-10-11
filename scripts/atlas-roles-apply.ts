import { pathToFileURL } from 'node:url';
import {
  ATLAS_ACCEPT,
  databaseNamesFromEnv,
  diffRole,
  planAtlasRoles,
  sameRole,
  type AtlasPlan,
  type PlannedRole,
  type PlannedUser,
} from './atlas-roles-plan.js';

/**
 * Applies the committed `atlasRoleManifests()` to Atlas through the Administration API v2, with a service account
 * (OAuth client credentials: ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET) and ATLAS_PROJECT_ID, all read by NAME. The database names
 * come from EXPUNGE_WORLD_DB, EXPUNGE_CONTROL_DB and EXPUNGE_PRIVATE_DB; unset names are refused, never defaulted.
 *
 * Safe by construction:
 * - `--dry-run` is the default; it makes read-only GETs (when credentials are set) and writes nothing. `--apply` is explicit.
 * - Per role the report lists the entries an apply would ADD and REMOVE (flattened `ACTION@db.collection`), and per user the
 *   Atlas roles it would remove, so what an apply strips from running services is visible before it happens.
 * - Roles are compared as flattened (action, resource) sets, so Atlas's own grouping cannot look like a difference. A role is
 *   PATCHed with the full action list only when it differs, then read back and compared again.
 * - A database user is created ONLY when missing, with its password read from ATLAS_USER_PASSWORD_<PRINCIPAL> (a value this
 *   script never prints or stores). An existing user is NEVER given a new password: if its roles differ, only the roles are
 *   patched. No `.env` is read or written, and no URI is produced.
 * - When a run stops, the error lists which roles and users were already written.
 * - Output carries names, entries and HTTP statuses only; the project id appears only as set/missing.
 */
const API = 'https://cloud.mongodb.com/api/atlas/v2';
const TOKEN_URL = 'https://cloud.mongodb.com/api/oauth/token';

export type AtlasFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ApplyReport = {
  mode: 'dry-run' | 'apply';
  projectId: 'set' | 'missing';
  roles: Array<{
    roleName: string;
    action: 'noop' | 'create' | 'patch' | 'unknown';
    verified?: boolean;
    /** Flattened `ACTION@db.collection` entries the apply adds to, and strips from, the role as it is now. */
    added?: string[];
    removed?: string[];
  }>;
  users: Array<{
    username: string;
    action: 'noop' | 'create' | 'patch-roles' | 'unknown';
    reason?: string;
    /** Atlas roles (`database.role`) a patch removes from, or adds to, the user. */
    removedRoles?: string[];
    addedRoles?: string[];
  }>;
};
type Result = { status: number; json: Record<string, unknown> };

export class AtlasApplyError extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'AtlasApplyError';
  }
}

export async function applyAtlasRoles(options: {
  apply: boolean;
  env: NodeJS.ProcessEnv;
  fetch?: AtlasFetch;
  plan?: AtlasPlan;
}): Promise<ApplyReport> {
  const { apply, env } = options;
  // The configured database names, never the defaults: a role for the wrong database would strip the running services.
  const plan = options.plan ?? planAtlasRoles(databaseNamesFromEnv(env));
  const projectId = env.ATLAS_PROJECT_ID ?? null;
  const report: ApplyReport = {
    mode: apply ? 'apply' : 'dry-run',
    projectId: projectId ? 'set' : 'missing',
    roles: [],
    users: [],
  };
  const haveCredentials = Boolean(env.ATLAS_CLIENT_ID && env.ATLAS_CLIENT_SECRET && projectId);
  if (apply && !haveCredentials) throw new AtlasApplyError('MissingConfiguration', { names: missing(env) });
  if (!haveCredentials) {
    report.roles = plan.roles.map((role) => ({ roleName: role.roleName, action: 'unknown' }));
    report.users = plan.users.map((user) => ({
      username: user.username,
      action: 'unknown',
      reason: 'no credentials',
    }));
    return report;
  }
  try {
    await run(options.fetch ?? ((url, init) => fetch(url, init)), env, plan, apply, projectId!, report);
  } catch (error) {
    if (error instanceof AtlasApplyError && apply)
      throw new AtlasApplyError(error.code, {
        ...error.detail,
        alreadyApplied: {
          roles: report.roles
            .filter((r) => r.action === 'create' || r.action === 'patch')
            .map((r) => r.roleName),
          users: report.users
            .filter((u) => u.action === 'create' || u.action === 'patch-roles')
            .map((u) => u.username),
        },
      });
    throw error;
  }
  return report;
}

async function run(
  http: AtlasFetch,
  env: NodeJS.ProcessEnv,
  plan: AtlasPlan,
  apply: boolean,
  projectId: string,
  report: ApplyReport,
): Promise<void> {
  const bearer = await accessToken(http, env);
  const call = async (method: string, path: string, body?: unknown): Promise<Result> => {
    const response = await http(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: ATLAS_ACCEPT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const fail = (step: string, result: Result): never => {
    throw new AtlasApplyError(step, { status: result.status, errorCode: result.json.errorCode });
  };
  const rolePath = `/groups/${projectId}/customDBRoles/roles`;
  const userPath = `/groups/${projectId}/databaseUsers`;
  const written = (r: Result) => r.status >= 200 && r.status < 300;

  for (const role of plan.roles) {
    const body = { actions: role.actions, inheritedRoles: role.inheritedRoles };
    const existing = await call('GET', `${rolePath}/${role.roleName}`);
    if (existing.status === 404) {
      const diff = diffRole(role, null);
      if (apply) {
        const created = await call('POST', rolePath, { roleName: role.roleName, ...body });
        if (!written(created)) fail(`CreateRole:${role.roleName}`, created);
        const verified = await verify(call, rolePath, role);
        report.roles.push({ roleName: role.roleName, action: 'create', verified, ...diff });
      } else report.roles.push({ roleName: role.roleName, action: 'create', ...diff });
      continue;
    }
    if (existing.status !== 200) fail(`ReadRole:${role.roleName}`, existing);
    const current = existing.json as unknown as PlannedRole;
    const diff = diffRole(role, current);
    if (sameRole(role, current)) {
      report.roles.push({ roleName: role.roleName, action: 'noop', verified: true, added: [], removed: [] });
      continue;
    }
    if (apply) {
      const patched = await call('PATCH', `${rolePath}/${role.roleName}`, body);
      if (!written(patched)) fail(`UpdateRole:${role.roleName}`, patched);
      const verified = await verify(call, rolePath, role);
      report.roles.push({ roleName: role.roleName, action: 'patch', verified, ...diff });
    } else report.roles.push({ roleName: role.roleName, action: 'patch', ...diff });
  }

  for (const user of plan.users) {
    const existing = await call('GET', `${userPath}/admin/${user.username}`);
    if (existing.status === 404) {
      const password = env[user.passwordVariable];
      if (!apply) {
        report.users.push({
          username: user.username,
          action: 'create',
          reason: password ? 'password variable set' : `${user.passwordVariable} is not set`,
          addedRoles: userRoleKeys(user.roles),
        });
        continue;
      }
      if (!password)
        throw new AtlasApplyError('MissingPasswordVariable', { variable: user.passwordVariable });
      const created = await call('POST', userPath, {
        databaseName: user.databaseName,
        username: user.username,
        password,
        roles: user.roles,
      });
      if (!written(created)) fail(`CreateUser:${user.username}`, created);
      report.users.push({ username: user.username, action: 'create', addedRoles: userRoleKeys(user.roles) });
      continue;
    }
    if (existing.status !== 200) fail(`ReadUser:${user.username}`, existing);
    const have = new Set(userRoleKeys((existing.json.roles as UserRole[]) ?? []));
    const want = new Set(userRoleKeys(user.roles));
    const removedRoles = [...have].filter((r) => !want.has(r)).sort();
    const addedRoles = [...want].filter((r) => !have.has(r)).sort();
    if (removedRoles.length === 0 && addedRoles.length === 0) {
      report.users.push({ username: user.username, action: 'noop' });
      continue;
    }
    if (apply) {
      // Roles only: a PATCH body without `password` never changes the password.
      const patched = await call('PATCH', `${userPath}/admin/${user.username}`, { roles: user.roles });
      if (!written(patched)) fail(`UpdateUser:${user.username}`, patched);
    }
    report.users.push({ username: user.username, action: 'patch-roles', removedRoles, addedRoles });
  }
}

type UserRole = { roleName?: string; databaseName?: string };
const userRoleKeys = (roles: UserRole[]): string[] =>
  roles.map((r) => `${r.databaseName}.${r.roleName}`).sort();
function missing(env: NodeJS.ProcessEnv): string[] {
  return ['ATLAS_CLIENT_ID', 'ATLAS_CLIENT_SECRET', 'ATLAS_PROJECT_ID'].filter((name) => !env[name]);
}
async function accessToken(http: AtlasFetch, env: NodeJS.ProcessEnv): Promise<string> {
  const basic = Buffer.from(`${env.ATLAS_CLIENT_ID}:${env.ATLAS_CLIENT_SECRET}`).toString('base64');
  const response = await http(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) throw new AtlasApplyError('AtlasTokenFailed', { status: response.status });
  const token = ((await response.json()) as { access_token?: string }).access_token;
  if (!token) throw new AtlasApplyError('AtlasTokenFailed', { status: response.status });
  return token;
}
async function verify(
  call: (method: string, path: string) => Promise<Result>,
  rolePath: string,
  role: PlannedRole,
): Promise<boolean> {
  const back = await call('GET', `${rolePath}/${role.roleName}`);
  if (back.status !== 200 || !sameRole(role, back.json as unknown as PlannedRole))
    throw new AtlasApplyError('RoleVerifyMismatch', { roleName: role.roleName, status: back.status });
  return true;
}
export type { PlannedUser };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  try {
    console.log(JSON.stringify(await applyAtlasRoles({ apply, env: process.env }), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        code:
          error instanceof AtlasApplyError
            ? error.code
            : error instanceof Error
              ? error.message
              : 'AtlasApplyFailed',
        ...(error instanceof AtlasApplyError ? { detail: error.detail } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
