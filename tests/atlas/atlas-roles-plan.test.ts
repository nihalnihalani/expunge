import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRINCIPALS, atlasRoleManifests } from '@expunge/mongo';
import {
  ATLAS_ENV_NAMES,
  databaseNamesFromEnv,
  diffRole,
  digestAuthorization,
  dryRunReport,
  flattenRole,
  manualChecklist,
  parseDigestChallenge,
  planAtlasRoles,
  sameRole,
} from '../../scripts/atlas-roles-plan.js';

describe('Atlas roles plan (no network, no secrets)', () => {
  const plan = planAtlasRoles();
  it('has one role and one user per manifest principal, and exactly the privileges of the manifest', () => {
    const manifests = atlasRoleManifests();
    expect(plan.roles.map((r) => r.principal).sort()).toEqual(Object.keys(manifests).sort());
    for (const role of plan.roles) {
      const manifest = manifests[role.principal]!;
      const wanted = new Set(
        manifest.actions.flatMap((a) => a.resources.map((r) => `${a.action}|${r.db}.${r.collection}`)),
      );
      const planned = new Set(
        role.actions.flatMap((a) => a.resources.map((r) => `${a.action}|${r.db}.${r.collection}`)),
      );
      expect(planned).toEqual(wanted);
      // Atlas refuses a duplicate action within a role.
      expect(new Set(role.actions.map((a) => a.action)).size).toBe(role.actions.length);
      expect(role.inheritedRoles).toEqual([]);
    }
    expect(plan.users).toHaveLength(plan.roles.length);
    for (const user of plan.users)
      expect(user.roles).toEqual([{ roleName: manifests[user.principal]!.roleName, databaseName: 'admin' }]);
    // No principal other than the setup principal is missing a role by accident.
    expect(PRINCIPALS.filter((p) => !(p in manifests))).toEqual(['setup']);
  });
  it('is deterministic and compares role bodies as sets', () => {
    expect(planAtlasRoles()).toEqual(planAtlasRoles());
    const role = plan.roles[0]!;
    const shuffled = {
      actions: [...role.actions].reverse().map((a) => ({ ...a, resources: [...a.resources].reverse() })),
    };
    expect(sameRole(role, shuffled)).toBe(true);
    expect(sameRole(role, { actions: role.actions.slice(1) })).toBe(false);
  });
  it('the dry-run names variables only: it reports set/MISSING, never a value, and blocks live apply without the keys', () => {
    const secret = 'super-secret-value-123';
    const report = dryRunReport(plan, {
      ATLAS_CLIENT_ID: secret,
      ATLAS_USER_PASSWORD_DOMAIN_EXECUTOR: secret,
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain(secret);
    expect(report.liveApply).toMatch(/^BLOCKED/);
    expect(report.credentials).toEqual({
      ATLAS_CLIENT_ID: 'set',
      ATLAS_CLIENT_SECRET: 'MISSING',
      ATLAS_PROJECT_ID: 'MISSING',
    });
    const all = Object.fromEntries(ATLAS_ENV_NAMES.map((n) => [n, 'x']));
    expect(dryRunReport(plan, all).liveApply).toBe('possible');
  });
  it('the manual checklist lists every role, privilege and user, and no secret', () => {
    const text = manualChecklist(plan);
    for (const role of plan.roles) expect(text).toContain(role.roleName);
    for (const user of plan.users) expect(text).toContain(user.username);
    expect(text).toContain('FIND');
    expect(text).not.toMatch(/mongodb(\+srv)?:\/\//);
  });
});

describe('flattened role comparison and database names', () => {
  const plan = planAtlasRoles();
  it('flattens to ACTION@db.collection entries and ignores how Atlas groups them', () => {
    const role = plan.roles.find((r) => r.principal === 'domain_executor')!;
    const flat = flattenRole(role);
    expect(flat).toContain('FIND@expunge_control.jobs');
    expect(new Set(flat).size).toBe(flat.length);
    // The same entries split across several action blocks (Atlas may normalize either way) are the same role.
    const regrouped = {
      actions: role.actions.flatMap((a) => a.resources.map((r) => ({ action: a.action, resources: [r] }))),
    };
    expect(sameRole(role, regrouped)).toBe(true);
    expect(diffRole(role, regrouped)).toEqual({ added: [], removed: [] });
  });
  it('reports exactly what an apply adds and strips', () => {
    const role = plan.roles[0]!;
    const existing = {
      actions: [
        ...role.actions.slice(1),
        {
          action: 'REMOVE',
          resources: [{ db: 'expunge_world', collection: 'customers', cluster: false as const }],
        },
      ],
    };
    const diff = diffRole(role, existing);
    expect(diff.removed).toEqual(['REMOVE@expunge_world.customers']);
    expect(diff.added).toEqual(flattenRole({ actions: [role.actions[0]!] }));
    expect(diffRole(role, null).removed).toEqual([]);
  });
  it('refuses unset database names instead of defaulting them', () => {
    expect(() => databaseNamesFromEnv({})).toThrow(
      'MissingConfiguration:EXPUNGE_WORLD_DB,EXPUNGE_CONTROL_DB,EXPUNGE_PRIVATE_DB',
    );
    expect(
      databaseNamesFromEnv({ EXPUNGE_WORLD_DB: 'w', EXPUNGE_CONTROL_DB: 'c', EXPUNGE_PRIVATE_DB: 'p' }),
    ).toEqual({
      world: 'w',
      control: 'c',
      private: 'p',
    });
  });
});

describe('HTTP digest authentication', () => {
  it('parses a challenge and computes the RFC 2617 reference response (MD5, qop=auth)', () => {
    // The worked example from RFC 2617 section 3.5.
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
    const header = digestAuthorization({
      username: 'Mufasa',
      password: 'Circle Of Life',
      method: 'GET',
      uri: '/dir/index.html',
      challenge,
      nonceCount: 1,
      cnonce: '0a4f113b',
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
  });
  it('supports SHA-256 and refuses an unknown algorithm or a non-digest challenge', () => {
    const challenge = parseDigestChallenge('Digest realm="r", nonce="n", qop="auth", algorithm=SHA-256');
    const header = digestAuthorization({
      username: 'u',
      password: 'p',
      method: 'GET',
      uri: '/x',
      challenge,
      cnonce: 'c',
    });
    const ha1 = createHash('sha256').update('u:r:p').digest('hex');
    const ha2 = createHash('sha256').update('GET:/x').digest('hex');
    const expected = createHash('sha256').update(`${ha1}:n:00000001:c:auth:${ha2}`).digest('hex');
    expect(header).toContain(`response="${expected}"`);
    expect(() =>
      digestAuthorization({
        username: 'u',
        password: 'p',
        method: 'GET',
        uri: '/x',
        challenge: { ...challenge, algorithm: 'SHA-512' },
      }),
    ).toThrow('UnsupportedDigestAlgorithm');
    expect(() => parseDigestChallenge('Bearer abc')).toThrow('NotDigestChallenge');
  });
});
