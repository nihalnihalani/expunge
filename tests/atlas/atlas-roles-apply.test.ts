import { describe, expect, it } from 'vitest';
import { AtlasApplyError, applyAtlasRoles, type AtlasFetch } from '../../scripts/atlas-roles-apply.js';
import { planAtlasRoles } from '../../scripts/atlas-roles-plan.js';

const SECRET = 'client-secret-value';
const PASSWORD = 'user-password-value';
const plan = planAtlasRoles();
const env = {
  ATLAS_CLIENT_ID: 'client-id',
  ATLAS_CLIENT_SECRET: SECRET,
  ATLAS_PROJECT_ID: 'a'.repeat(24),
  EXPUNGE_WORLD_DB: 'expunge_world',
  EXPUNGE_CONTROL_DB: 'expunge_control',
  EXPUNGE_PRIVATE_DB: 'expunge_private',
} as NodeJS.ProcessEnv;
const dbs = {
  EXPUNGE_WORLD_DB: 'expunge_world',
  EXPUNGE_CONTROL_DB: 'expunge_control',
  EXPUNGE_PRIVATE_DB: 'expunge_private',
} as NodeJS.ProcessEnv;
const passwords = Object.fromEntries(plan.users.map((u) => [u.passwordVariable, PASSWORD]));

type Call = { method: string; path: string; body?: Record<string, unknown> };
/** An in-memory Atlas: custom roles and database users keyed by name. Records every call. */
function fakeAtlas(
  initial: { roles?: Record<string, unknown>; users?: Record<string, unknown>; ignorePatch?: boolean } = {},
) {
  const roles = new Map<string, Record<string, unknown>>(Object.entries(initial.roles ?? {}) as never);
  const users = new Map<string, Record<string, unknown>>(Object.entries(initial.users ?? {}) as never);
  const calls: Call[] = [];
  const respond = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch: AtlasFetch = async (url, init) => {
    if (url.endsWith('/oauth/token')) return respond(200, { access_token: 'token-value' });
    const path = new URL(url).pathname.replace('/api/atlas/v2', '');
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    const roleMatch = path.match(/\/customDBRoles\/roles(?:\/(.+))?$/);
    if (roleMatch) {
      const name = roleMatch[1];
      if (method === 'GET')
        return name && roles.has(name)
          ? respond(200, roles.get(name))
          : respond(404, { errorCode: 'RESOURCE_NOT_FOUND' });
      if (method === 'POST') return (roles.set(String(body!.roleName), body!), respond(201, body));
      if (method === 'PATCH') {
        if (!initial.ignorePatch) roles.set(name!, { roleName: name, ...roles.get(name), ...body });
        return respond(200, roles.get(name!));
      }
    }
    const userMatch = path.match(/\/databaseUsers(?:\/admin\/(.+))?$/);
    if (userMatch) {
      const name = userMatch[1];
      if (method === 'GET')
        return name && users.has(name)
          ? respond(200, users.get(name))
          : respond(404, { errorCode: 'USERNAME_NOT_FOUND' });
      if (method === 'POST')
        return (users.set(String(body!.username), { ...body, password: undefined }), respond(201, {}));
      if (method === 'PATCH') return (users.set(name!, { ...users.get(name!), ...body }), respond(200, {}));
    }
    return respond(500);
  };
  return { fetch, calls, roles, users };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const seedAll = () => ({
  roles: Object.fromEntries(
    plan.roles.map((r) => [r.roleName, { roleName: r.roleName, actions: r.actions, inheritedRoles: [] }]),
  ),
  users: Object.fromEntries(plan.users.map((u) => [u.username, { username: u.username, roles: u.roles }])),
});

describe('Atlas roles apply (fake Atlas, no network)', () => {
  it('dry-run is the default: it reads, reports what would change, and writes nothing', async () => {
    const atlas = fakeAtlas();
    const report = await applyAtlasRoles({ apply: false, env: { ...env, ...passwords }, fetch: atlas.fetch });
    expect(report.mode).toBe('dry-run');
    expect(report.roles.every((r) => r.action === 'create')).toBe(true);
    expect(report.users.every((u) => u.action === 'create')).toBe(true);
    expect(writes(atlas.calls)).toEqual([]);
  });
  it('without credentials a dry-run reports the plan as unknown and makes no call; apply refuses', async () => {
    const atlas = fakeAtlas();
    const report = await applyAtlasRoles({ apply: false, env: dbs, fetch: atlas.fetch });
    expect(report.roles.every((r) => r.action === 'unknown')).toBe(true);
    expect(atlas.calls).toEqual([]);
    await expect(applyAtlasRoles({ apply: true, env: dbs, fetch: atlas.fetch })).rejects.toMatchObject({
      code: 'MissingConfiguration',
      detail: { names: ['ATLAS_CLIENT_ID', 'ATLAS_CLIENT_SECRET', 'ATLAS_PROJECT_ID'] },
    });
  });
  it('apply creates missing roles and users and verifies each role by reading it back', async () => {
    const atlas = fakeAtlas();
    const report = await applyAtlasRoles({ apply: true, env: { ...env, ...passwords }, fetch: atlas.fetch });
    expect(report.roles.every((r) => r.action === 'create' && r.verified === true)).toBe(true);
    expect(atlas.roles.size).toBe(plan.roles.length);
    expect(atlas.users.size).toBe(plan.users.length);
    const created = atlas.calls.find((c) => c.method === 'POST' && c.path.endsWith('/databaseUsers'))!;
    expect(created.body).toMatchObject({ databaseName: 'admin', password: PASSWORD });
  });
  it('is idempotent: a second apply against matching state writes nothing, and role order does not matter', async () => {
    const seeded = seedAll();
    const reversed = Object.fromEntries(
      Object.entries(seeded.roles).map(([k, v]) => [
        k,
        { ...(v as object), actions: [...(v as { actions: unknown[] }).actions].reverse() },
      ]),
    );
    const atlas = fakeAtlas({ roles: reversed, users: seeded.users });
    const report = await applyAtlasRoles({ apply: true, env, fetch: atlas.fetch });
    expect(report.roles.every((r) => r.action === 'noop')).toBe(true);
    expect(report.users.every((u) => u.action === 'noop')).toBe(true);
    expect(writes(atlas.calls)).toEqual([]);
  });
  it('patches only a role that differs, with the full action list, and never touches an existing user password', async () => {
    const seeded = seedAll();
    const drifted = {
      ...seeded.roles,
      [plan.roles[0]!.roleName]: {
        roleName: plan.roles[0]!.roleName,
        actions: plan.roles[0]!.actions.slice(1),
        inheritedRoles: [],
      },
    };
    const users = {
      ...seeded.users,
      [plan.users[1]!.username]: {
        username: plan.users[1]!.username,
        roles: [{ roleName: 'readAnyDatabase', databaseName: 'admin' }],
      },
    };
    const atlas = fakeAtlas({ roles: drifted, users });
    const report = await applyAtlasRoles({ apply: true, env: { ...env, ...passwords }, fetch: atlas.fetch });
    expect(report.roles.filter((r) => r.action === 'patch').map((r) => r.roleName)).toEqual([
      plan.roles[0]!.roleName,
    ]);
    const patch = atlas.calls.find((c) => c.method === 'PATCH' && c.path.includes('/customDBRoles/'))!;
    expect(patch.body).toEqual({ actions: plan.roles[0]!.actions, inheritedRoles: [] });
    const userPatch = atlas.calls.filter((c) => c.method === 'PATCH' && c.path.includes('/databaseUsers/'));
    expect(userPatch).toHaveLength(1);
    expect(userPatch[0]!.body).toEqual({ roles: plan.users[1]!.roles });
    expect(JSON.stringify(atlas.calls)).not.toContain(PASSWORD);
    expect(atlas.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
  it('fails the run when a role does not read back as planned', async () => {
    const seeded = seedAll();
    const drifted = {
      ...seeded.roles,
      [plan.roles[0]!.roleName]: { roleName: plan.roles[0]!.roleName, actions: [], inheritedRoles: [] },
    };
    const atlas = fakeAtlas({ roles: drifted, users: seeded.users, ignorePatch: true });
    await expect(applyAtlasRoles({ apply: true, env, fetch: atlas.fetch })).rejects.toMatchObject({
      code: 'RoleVerifyMismatch',
    });
  });
  it('creating a missing user needs its password variable; it is never generated', async () => {
    const seeded = seedAll();
    const { [plan.users[0]!.username]: _gone, ...users } = seeded.users;
    const atlas = fakeAtlas({ roles: seeded.roles, users });
    await expect(applyAtlasRoles({ apply: true, env, fetch: atlas.fetch })).rejects.toMatchObject({
      code: 'MissingPasswordVariable',
      detail: { variable: plan.users[0]!.passwordVariable },
    });
    expect(atlas.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
  it('never leaks a secret into the report or an error', async () => {
    const atlas = fakeAtlas();
    const report = await applyAtlasRoles({ apply: true, env: { ...env, ...passwords }, fetch: atlas.fetch });
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
    const denied: AtlasFetch = async () => new Response('{}', { status: 401 });
    const error = await applyAtlasRoles({ apply: true, env: { ...env, ...passwords }, fetch: denied }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AtlasApplyError);
    expect(error).toMatchObject({ code: 'AtlasTokenFailed', detail: { status: 401 } });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it('AR-1: the dry-run lists, per role, what would be added and removed, and per user the roles it would strip', async () => {
    const seeded = seedAll();
    const first = plan.roles[0]!;
    const drifted = {
      ...seeded.roles,
      [first.roleName]: {
        roleName: first.roleName,
        actions: [
          ...first.actions.slice(1),
          { action: 'REMOVE', resources: [{ db: 'expunge_world', collection: 'customers', cluster: false }] },
        ],
        inheritedRoles: [],
      },
    };
    const users = {
      ...seeded.users,
      [plan.users[1]!.username]: {
        username: plan.users[1]!.username,
        roles: [{ roleName: 'readWriteAnyDatabase', databaseName: 'admin' }],
      },
    };
    const atlas = fakeAtlas({ roles: drifted, users });
    const report = await applyAtlasRoles({ apply: false, env, fetch: atlas.fetch });
    const patched = report.roles.find((r) => r.roleName === first.roleName)!;
    expect(patched.action).toBe('patch');
    expect(patched.removed).toEqual(['REMOVE@expunge_world.customers']);
    expect(patched.added!.length).toBeGreaterThan(0);
    const user = report.users.find((u) => u.username === plan.users[1]!.username)!;
    expect(user.removedRoles).toEqual(['admin.readWriteAnyDatabase']);
    expect(user.addedRoles).toEqual([`admin.${plan.users[1]!.roles[0]!.roleName}`]);
    expect(writes(atlas.calls)).toEqual([]);
  });
  it('AR-2: refuses to run without the configured database names, and uses them in the roles it writes', async () => {
    const atlas = fakeAtlas();
    const { EXPUNGE_WORLD_DB: _w, ...noWorld } = env;
    await expect(applyAtlasRoles({ apply: false, env: noWorld, fetch: atlas.fetch })).rejects.toThrow(
      'MissingConfiguration:EXPUNGE_WORLD_DB',
    );
    expect(atlas.calls).toEqual([]);
    await applyAtlasRoles({
      apply: true,
      env: { ...env, ...passwords, EXPUNGE_WORLD_DB: 'tenant_world', EXPUNGE_CONTROL_DB: 'tenant_control' },
      fetch: atlas.fetch,
    });
    const written = JSON.stringify([...atlas.roles.values()]);
    expect(written).toContain('tenant_world');
    expect(written).toContain('tenant_control');
    expect(written).not.toContain('"expunge_world"');
  });
  it('AR-3: Atlas regrouping an applied role is not a verify mismatch, and a stop reports what was already applied', async () => {
    const seeded = seedAll();
    const drifted = {
      ...seeded.roles,
      [plan.roles[0]!.roleName]: { roleName: plan.roles[0]!.roleName, actions: [], inheritedRoles: [] },
    };
    const atlas = fakeAtlas({ roles: drifted, users: seeded.users });
    const regroup = atlas.fetch;
    const splitting: AtlasFetch = async (url, init) => {
      const response = await regroup(url, init);
      if ((init.method ?? 'GET') !== 'GET' || !/customDBRoles\/roles\/[^/]+$/.test(url)) return response;
      const body = (await response.json()) as { actions?: Array<{ action: string; resources: unknown[] }> };
      const actions = (body.actions ?? []).flatMap((a) =>
        a.resources.map((r) => ({ action: a.action, resources: [r] })),
      );
      return new Response(JSON.stringify({ ...body, actions }), { status: 200 });
    };
    const report = await applyAtlasRoles({ apply: true, env, fetch: splitting });
    expect(report.roles.find((r) => r.roleName === plan.roles[0]!.roleName)).toMatchObject({
      action: 'patch',
      verified: true,
    });
    // A later failure names the roles already written.
    const seeded2 = seedAll();
    const two = {
      ...seeded2.roles,
      [plan.roles[0]!.roleName]: { roleName: plan.roles[0]!.roleName, actions: [], inheritedRoles: [] },
    };
    const atlas2 = fakeAtlas({ roles: two, users: {} });
    const error = await applyAtlasRoles({ apply: true, env, fetch: atlas2.fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MissingPasswordVariable' });
    expect((error as AtlasApplyError).detail.alreadyApplied).toEqual({
      roles: [plan.roles[0]!.roleName],
      users: [],
    });
  });
  it('AR-4: the project id is reported only as set or missing', async () => {
    const atlas = fakeAtlas();
    const report = await applyAtlasRoles({ apply: false, env, fetch: atlas.fetch });
    expect(report.projectId).toBe('set');
    expect(JSON.stringify(report)).not.toContain(env.ATLAS_PROJECT_ID!);
    expect((await applyAtlasRoles({ apply: false, env: dbs, fetch: atlas.fetch })).projectId).toBe('missing');
  });
});
