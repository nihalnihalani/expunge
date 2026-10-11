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

const exportsPort = (
  rows: Array<{ generation: number; digest: string; count: number; subjectSetGeneration?: number }> = [],
  options: { raceOnce?: boolean; subjectSet?: number } = {},
) => {
  let raced = false;
  return {
    rows,
    calls: { latest: 0, record: 0 },
    latest: async function (this: { calls: { latest: number } }) {
      this.calls.latest++;
      return rows.length ? rows.reduce((a, b) => (b.generation > a.generation ? b : a)) : null;
    },
    subjectSetGeneration: async () => options.subjectSet ?? 4,
    record: async function (
      this: { calls: { record: number } },
      _scope: ScopeKey,
      input: { generation: number; digest: string; count: number; subjectSetGeneration: number },
      expectedLatest: number | null,
    ) {
      this.calls.record++;
      if (options.raceOnce && !raced) {
        raced = true;
        rows.push({ generation: (expectedLatest ?? 0) + 1, digest: 'f'.repeat(64), count: 1 }); // another export got in
        throw new Error('GuardExportRaced');
      }
      const newest = rows.reduce((m, r) => Math.max(m, r.generation), 0);
      if ((rows.length ? newest : null) !== expectedLatest) throw new Error('GuardExportRaced');
      rows.push(input);
    },
  };
};

describe('exportGuardFile', () => {
  it('writes a verified, owner-only file the evidence process can load', async () => {
    const path = join(dir, 'guard.json');
    const counts = await exportGuardFile({ tokens: store(3), exports: exportsPort() }, SCOPE, path, {
      providerOrganizationId: 'org-1',
    });
    expect(counts).toEqual({ literals: 3, privateIdHashes: 0, generation: 1 });
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
    await exportGuardFile({ tokens: store(1), exports: exportsPort() }, SCOPE, path, {
      providerOrganizationId: 'org-1',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('does not write through a symlink at the target name', async () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    const link = join(dir, 'link.json');
    symlinkSync(victim, link);
    await exportGuardFile({ tokens: store(1), exports: exportsPort() }, SCOPE, link, {
      providerOrganizationId: 'org-1',
    });
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
      exportGuardFile({ tokens: store(GUARD_LIST_LIMIT), exports: exportsPort() }, SCOPE, path, {
        providerOrganizationId: 'org-1',
      }),
    ).rejects.toMatchObject({ code: 'GuardIncomplete' });
    expect(() => statSync(path)).toThrow();
    await expect(guardFor({ tokens: store(GUARD_LIST_LIMIT - 1) }, SCOPE)).resolves.toBeDefined();
  });
  it('refuses an empty guard (nothing to look for would pass everything) and writes nothing', async () => {
    const path = join(dir, 'empty.json');
    await expect(
      exportGuardFile({ tokens: store(0), exports: exportsPort() }, SCOPE, path, {
        providerOrganizationId: 'org-1',
      }),
    ).rejects.toMatchObject({ code: 'MissingForbiddenLiterals' });
    expect(() => statSync(path)).toThrow();
  });
  it('removes its temp file and leaves the previous file untouched when the rename fails', async () => {
    const target = join(dir, 'is-a-dir');
    mkdirSync(target); // renaming a file over a directory fails
    await expect(
      exportGuardFile({ tokens: store(1), exports: exportsPort() }, SCOPE, target, {
        providerOrganizationId: 'org-1',
      }),
    ).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(statSync(target).isDirectory()).toBe(true);
  });
  it('records a rising generation per export, in the file and in guard_exports, written BEFORE the file', async () => {
    const port = exportsPort();
    const path = join(dir, 'gen.json');
    const first = await exportGuardFile({ tokens: store(2), exports: port }, SCOPE, path, {
      providerOrganizationId: 'org-1',
    });
    const second = await exportGuardFile({ tokens: store(3), exports: port }, SCOPE, path, {
      providerOrganizationId: 'org-1',
    });
    expect([first.generation, second.generation]).toEqual([1, 2]);
    expect(port.rows.map((r) => r.generation)).toEqual([1, 2]);
    const parsed = parseGuardFile(readFileSync(path, 'utf8'), {
      scope: SCOPE,
      providerOrganizationId: 'org-1',
    });
    expect(parsed.generation).toBe(2);
    expect(parsed.digest).toBe(port.rows[1]!.digest);
    // A failed record writes no file.
    const failing = {
      ...exportsPort(),
      record: async () => {
        throw new Error('GuardGenerationRegression');
      },
    };
    const other = join(dir, 'nofile.json');
    await expect(
      exportGuardFile({ tokens: store(1), exports: failing }, SCOPE, other, {
        providerOrganizationId: 'org-1',
      }),
    ).rejects.toThrow();
    expect(() => statSync(other)).toThrow();
  });
  it('records the subject-set generation read before the list, conditional on the latest export, and retries a lost race from the top', async () => {
    const port = exportsPort([], { raceOnce: true, subjectSet: 7 });
    const path = join(dir, 'race.json');
    const result = await exportGuardFile({ tokens: store(2), exports: port }, SCOPE, path, {
      providerOrganizationId: 'org-1',
    });
    expect(port.calls.record).toBe(2); // first lost the race, second succeeded
    expect(result.generation).toBe(2); // re-read latest (the racing export) and went one above it
    expect(port.rows.at(-1)).toMatchObject({ generation: 2, subjectSetGeneration: 7 });
    expect(
      parseGuardFile(readFileSync(path, 'utf8'), { scope: SCOPE, providerOrganizationId: 'org-1' })
        .generation,
    ).toBe(2);
  });
  it('gives up after repeated lost races and writes no file', async () => {
    const port = {
      ...exportsPort(),
      record: async () => {
        throw new Error('GuardExportRaced');
      },
    };
    const path = join(dir, 'always-race.json');
    await expect(
      exportGuardFile({ tokens: store(1), exports: port }, SCOPE, path, { providerOrganizationId: 'org-1' }),
    ).rejects.toThrow('GuardExportRaced');
    expect(() => statSync(path)).toThrow();
  });
});
