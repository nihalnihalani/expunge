import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ScopeKey } from '@expunge/contracts';
import { parseGuardFile } from '@expunge/observability';
import {
  GUARD_LIST_LIMIT,
  exportGuardFile,
  guardFor,
  type SubjectTokenEntry,
  type SubjectTokenStore,
} from '../src/index.js';

const SCOPE: ScopeKey = { tenantId: 't1', env: 'evaluation', scopeId: 's1' };
const dir = mkdtempSync(join(tmpdir(), 'export-guard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (n: number): SubjectTokenEntry => ({
  subjectHandle: `subject-handle-${n}`,
  provider: 'raindrop',
  tokenGeneration: 1,
  tokens: [],
  registeredAt: new Date(0),
});
const store = (count: number): SubjectTokenStore => ({
  put: async () => 'created',
  // Honors the limit like the Mongo repository does, so truncation is real.
  list: async (_scope, limit = 1000) => Array.from({ length: Math.min(count, limit) }, (_v, i) => entry(i)),
  tokensFor: async () => [],
});

describe('exportGuardFile', () => {
  it('writes a verified, owner-only file the evidence process can load', async () => {
    const path = join(dir, 'guard.json');
    const counts = await exportGuardFile({ tokens: store(3) }, SCOPE, path, {
      providerOrganizationId: 'org-1',
    });
    expect(counts).toEqual({ literals: 3, privateIdHashes: 0 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const parsed = parseGuardFile(readFileSync(path, 'utf8'), {
      scope: SCOPE,
      providerOrganizationId: 'org-1',
    });
    expect(parsed.guard.forbiddenLiterals).toHaveLength(3);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('replaces a pre-existing permissive file with a 0600 one instead of inheriting its mode', async () => {
    const path = join(dir, 'loose.json');
    writeFileSync(path, 'old');
    chmodSync(path, 0o644);
    await exportGuardFile({ tokens: store(1) }, SCOPE, path, { providerOrganizationId: 'org-1' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('does not write through a symlink at the target name', async () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    const link = join(dir, 'link.json');
    symlinkSync(victim, link);
    await exportGuardFile({ tokens: store(1) }, SCOPE, link, { providerOrganizationId: 'org-1' });
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(statSync(link).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(link, 'utf8')).format).toBe('expunge-guard-v1');
  });
  it('refuses to export a guard that may be incomplete (as many entries as one read can return)', async () => {
    await expect(guardFor({ tokens: store(GUARD_LIST_LIMIT) }, SCOPE)).rejects.toMatchObject({
      code: 'GuardIncomplete',
    });
    const path = join(dir, 'never.json');
    await expect(
      exportGuardFile({ tokens: store(GUARD_LIST_LIMIT) }, SCOPE, path, { providerOrganizationId: 'org-1' }),
    ).rejects.toMatchObject({ code: 'GuardIncomplete' });
    expect(() => statSync(path)).toThrow();
    await expect(guardFor({ tokens: store(GUARD_LIST_LIMIT - 1) }, SCOPE)).resolves.toBeDefined();
  });
  it('refuses an empty guard (nothing to look for would pass everything) and writes nothing', async () => {
    const path = join(dir, 'empty.json');
    await expect(
      exportGuardFile({ tokens: store(0) }, SCOPE, path, { providerOrganizationId: 'org-1' }),
    ).rejects.toMatchObject({ code: 'MissingForbiddenLiterals' });
    expect(() => statSync(path)).toThrow();
  });
  it('removes its temp file and leaves the previous file untouched when the rename fails', async () => {
    const target = join(dir, 'is-a-dir');
    mkdirSync(target); // renaming a file over a directory fails
    await expect(
      exportGuardFile({ tokens: store(1) }, SCOPE, target, { providerOrganizationId: 'org-1' }),
    ).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(statSync(target).isDirectory()).toBe(true);
  });
});
