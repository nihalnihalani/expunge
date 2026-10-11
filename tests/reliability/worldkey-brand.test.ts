/**
 * The WorldKey brand: a repository method that reads or writes a world must refuse a bare string, a hand-built
 * object, and a copy of a real key, both at compile time and at run time.
 *
 * The compile-time half is enforced by `npm run typecheck`: every `@ts-expect-error` below must still be an error,
 * so loosening the type makes the typecheck fail. The run-time half needs no database: the key is checked before
 * any query, and the MongoClient is created lazily and never connects here.
 */
import { describe, expect, it } from 'vitest';
import { ScopeRepository, createPrincipalService, type WorldKey } from '@expunge/mongo';
// The minting function is package-internal (not exported from the package index); the test reaches it by path so it
// can hold a genuinely issued key. The path import and the index share one module instance, hence one issued-set.
import { worldKeyOf } from '../../packages/mongo/src/worldkey.js';

const service = createPrincipalService(
  {
    uris: { domain_executor: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100' },
    worldDatabase: 'wk_world',
    controlDatabase: 'wk_control',
    privateDatabase: 'wk_private',
  },
  'domain_executor',
);
const repo = new ScopeRepository(service);

const job = {
  _id: 'job-wk-1',
  actor: {
    actorId: 'owner',
    tenantId: 't',
    env: 'evaluation' as const,
    scopeId: 's',
    authorizationRevision: 1,
  },
  binding: {
    jobId: 'job-wk-1',
    runId: 'run-wk-1',
    worldId: 'world-wk-1',
    harnessHash: 'a'.repeat(64),
    scopeRevision: 1,
    workerProfileHash: 'a'.repeat(64),
  },
};
const registry = {} as never;

/** Never called: it exists so the compiler checks that unbranded values are rejected. */
export function compileTimeOnly(realKey: WorldKey): void {
  const handBuilt = {
    tenantId: 't',
    env: 'evaluation',
    scopeId: 's',
    worldId: 'w',
    scopeRevision: 1,
    jobId: null,
  };
  // @ts-expect-error a bare world id is not a WorldKey
  void repo.scan('world-wk-1', registry, 'customers');
  // @ts-expect-error a hand-built object with the right fields is not a WorldKey
  void repo.scan(handBuilt, registry, 'customers');
  // The brand lives in a symbol-keyed property, so a spread copy keeps it as far as the TYPE is concerned. Only the
  // run-time issued-set check can tell a copy from the real key (see the first run-time test below).
  void repo.scan({ ...realKey }, registry, 'customers');
  void repo.scan(realKey, registry, 'customers');
}

describe('WorldKey brand at run time', () => {
  const code = async (key: unknown) => {
    try {
      await repo.scan(key as never, registry, 'customers');
      return 'resolved';
    } catch (error) {
      return error instanceof Error
        ? ((error as Error & { code?: string }).code ?? error.message)
        : String(error);
    }
  };

  it('refuses a bare string, a plain object, null and a copy of a real key with InvalidWorldKey', async () => {
    const real = worldKeyOf(job);
    expect(await code('world-wk-1')).toBe('InvalidWorldKey');
    expect(
      await code({
        tenantId: 't',
        env: 'evaluation',
        scopeId: 's',
        worldId: 'w',
        scopeRevision: 1,
        jobId: null,
      }),
    ).toBe('InvalidWorldKey');
    expect(await code(null)).toBe('InvalidWorldKey');
    expect(await code(undefined)).toBe('InvalidWorldKey');
    expect(await code({ ...real })).toBe('InvalidWorldKey');
    expect(await code(JSON.parse(JSON.stringify(real)))).toBe('InvalidWorldKey');
    expect(await code(Object.create(real))).toBe('InvalidWorldKey');
  });

  it('does not refuse a key the module issued (it gets past the brand check and fails later, on the empty registry)', async () => {
    const outcome = await code(worldKeyOf(job));
    expect(outcome).not.toBe('InvalidWorldKey');
  });

  it('a key cannot be built for an empty world id or a non-positive scope revision', () => {
    expect(() => worldKeyOf({ ...job, binding: { ...job.binding, worldId: '' } })).toThrow(/InvalidWorldKey/);
    expect(() => worldKeyOf({ ...job, binding: { ...job.binding, scopeRevision: 0 } })).toThrow(
      /InvalidWorldKey/,
    );
  });

  it('issued keys are frozen', () => {
    const key = worldKeyOf(job);
    expect(Object.isFrozen(key)).toBe(true);
    expect(() => {
      (key as { worldId: string }).worldId = 'other-world';
    }).toThrow();
  });
});
