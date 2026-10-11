import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { serializeGuardFile, type LeakGuard } from '@expunge/observability';
import { EvidenceSourceError, loadGuardFile, windowFromEnv } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'observer-sources-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: unknown, mode = 0o600) => {
  const path = join(dir, name);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  chmodSync(path, mode);
  return path;
};

const SCOPE = { tenantId: 't1', env: 'evaluation' as const, scopeId: 's1' };
const EXPECT = { scope: SCOPE, providerOrganizationId: 'org-1' };
const guardText = (
  guard = { forbiddenLiterals: ['subject-handle-1', 'subject-handle-2'] } as LeakGuard,
  meta = {},
) => serializeGuardFile(guard, { scope: SCOPE, providerOrganizationId: 'org-1', ...meta });

describe('loadGuardFile', () => {
  it('returns undefined when no file is configured (the process stays BLOCKED)', () => {
    expect(loadGuardFile(undefined, EXPECT)).toBeUndefined();
    expect(loadGuardFile('  ', EXPECT)).toBeUndefined();
  });
  it('loads literals and a private-id set from an owner-only file for this scope and organization', () => {
    const guard = loadGuardFile(
      write(
        'ok.json',
        guardText({
          forbiddenLiterals: ['subject-handle-1'],
          privateIds: { salt: 's', hashes: ['a'.repeat(64)] },
        }),
      ),
      EXPECT,
    );
    expect(guard?.forbiddenLiterals).toEqual(['subject-handle-1']);
    expect(guard?.privateIds?.hashes).toHaveLength(1);
  });
  const reason = (path: string) => {
    try {
      loadGuardFile(path, EXPECT);
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceSourceError);
      return String(error);
    }
    throw new Error('expected a refusal');
  };
  it('refuses a group- or world-readable file, naming the variable and never the contents', () => {
    const text = reason(write('open.json', guardText(), 0o644));
    expect(text).toContain('EXPUNGE_LEAK_GUARD_FILE:mode');
    expect(text).not.toContain('subject-handle');
  });
  it('refuses another scope and another provider organization', () => {
    const other = serializeGuardFile(
      { forbiddenLiterals: ['x-handle'] },
      { scope: { ...SCOPE, scopeId: 'other' }, providerOrganizationId: 'org-1' },
    );
    expect(reason(write('scope.json', other))).toContain('scope_mismatch');
    const org = serializeGuardFile(
      { forbiddenLiterals: ['x-handle'] },
      { scope: SCOPE, providerOrganizationId: 'org-2' },
    );
    expect(reason(write('org.json', org))).toContain('organization_mismatch');
  });
  it('refuses a truncated or edited file (count and digest are checked)', () => {
    const file = JSON.parse(guardText());
    expect(
      reason(
        write('trunc.json', JSON.stringify({ ...file, forbiddenLiterals: file.forbiddenLiterals.slice(1) })),
      ),
    ).toContain('count_mismatch');
    expect(
      reason(
        write(
          'edit.json',
          JSON.stringify({ ...file, forbiddenLiterals: ['subject-handle-1', 'changed-handle-9'] }),
        ),
      ),
    ).toContain('digest_mismatch');
    expect(reason(write('half.json', guardText().slice(0, 40)))).toContain('not_json');
  });
  it('refuses a malformed privateIds block instead of dropping it', () => {
    const file = JSON.parse(
      guardText({
        forbiddenLiterals: ['subject-handle-1'],
        privateIds: { salt: 's', hashes: ['a'.repeat(64)] },
      }),
    );
    for (const bad of [{ salt: 5, hashes: [] }, { salt: 's', hashes: 'nope' }, null, {}])
      expect(reason(write('pid.json', JSON.stringify({ ...file, privateIds: bad })))).toContain('privateIds');
  });
  it('refuses unknown format, malformed literals, an empty guard and a missing file', () => {
    const file = JSON.parse(guardText());
    expect(reason(write('fmt.json', JSON.stringify({ ...file, format: 'v0' })))).toContain('format');
    expect(reason(write('lit.json', JSON.stringify({ ...file, forbiddenLiterals: [1] })))).toContain(
      'forbiddenLiterals',
    );
    expect(() =>
      serializeGuardFile({ forbiddenLiterals: [] }, { scope: SCOPE, providerOrganizationId: 'org-1' }),
    ).toThrow();
    expect(reason(join(dir, 'missing.json'))).toContain('unreadable');
  });
});

describe('windowFromEnv', () => {
  it('is absent when unset, so only the outbox dispatcher runs', () => {
    expect(windowFromEnv({})).toBeUndefined();
  });
  it('parses a fixed window with a default version and optional event name', () => {
    expect(
      windowFromEnv({
        EXPUNGE_OBSERVER_WINDOW_START: '2026-10-01T00:00:00Z',
        EXPUNGE_OBSERVER_WINDOW_END: '2026-10-08T00:00:00Z',
        EXPUNGE_OBSERVER_EVENT_NAME: 'expunge.run',
      }),
    ).toEqual({
      filter: { eventName: 'expunge.run' },
      windowStart: '2026-10-01T00:00:00Z',
      windowEnd: '2026-10-08T00:00:00Z',
      observerVersion: 'v1',
    });
  });
  it('refuses half a window, a reversed window, a non-UTC instant and a bad version', () => {
    const base = {
      EXPUNGE_OBSERVER_WINDOW_START: '2026-10-01T00:00:00Z',
      EXPUNGE_OBSERVER_WINDOW_END: '2026-10-02T00:00:00Z',
    };
    expect(() =>
      windowFromEnv({ EXPUNGE_OBSERVER_WINDOW_START: base.EXPUNGE_OBSERVER_WINDOW_START }),
    ).toThrow(EvidenceSourceError);
    expect(() => windowFromEnv({ ...base, EXPUNGE_OBSERVER_WINDOW_START: '2026-10-03T00:00:00Z' })).toThrow(
      EvidenceSourceError,
    );
    expect(() =>
      windowFromEnv({ ...base, EXPUNGE_OBSERVER_WINDOW_END: '2026-10-02T00:00:00+02:00' }),
    ).toThrow(EvidenceSourceError);
    expect(() => windowFromEnv({ ...base, EXPUNGE_OBSERVER_VERSION: 'bad version' })).toThrow(
      EvidenceSourceError,
    );
  });
});
