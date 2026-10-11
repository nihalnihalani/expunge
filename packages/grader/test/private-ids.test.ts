import { describe, expect, it } from 'vitest';
import { privateIdHash } from '@expunge/contracts';
import { createWorldSpec } from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { detectLeak } from '@expunge/observability';
import { mintPrivateIdSalt, privateIdSetOf } from '../src/index.js';

describe('privateIdSetOf (P1b)', () => {
  const spec = createWorldSpec({ family: 'alias_two_hop', seed: 'private-id-set' });
  const { world, manifest } = generateSealedFixture(spec, 'private-id-set');
  const salt = mintPrivateIdSalt();
  const set = privateIdSetOf(manifest, world, salt);

  it('holds salted hashes of target and decoy record IDs, identity tokens and handles, and no raw value', () => {
    expect(set.salt).toBe(salt);
    expect(set.hashes).toEqual([...new Set(set.hashes)].sort());
    const targetId = manifest.effects[0]!.address.recordId;
    expect(set.hashes).toContain(privateIdHash(salt, targetId));
    expect(set.hashes).toContain(privateIdHash(salt, manifest.subjectHandle));
    for (const collection of Object.values(world.collections))
      for (const row of collection) expect(set.hashes).toContain(privateIdHash(salt, row._id));
    expect(JSON.stringify(set)).not.toContain(targetId);
  });

  it('is stable for the same salt, differs for another, and refuses a short salt', () => {
    expect(privateIdSetOf(manifest, world, salt)).toEqual(set);
    expect(privateIdSetOf(manifest, world, mintPrivateIdSalt()).hashes).not.toEqual(set.hashes);
    expect(() => privateIdSetOf(manifest, world, 'short')).toThrow('InvalidPrivateIdSalt');
  });

  it('drives the observability leak guard: a bundle carrying a target ID is caught, an unrelated one is not', () => {
    const targetId = manifest.effects[0]!.address.recordId;
    const guard = { forbiddenLiterals: [], privateIds: set };
    expect(detectLeak({ note: `saw ${targetId} in the output` }, guard)?.code).toBe('PrivateIdLeak');
    expect(detectLeak({ note: 'nothing to see here' }, guard)).toBeNull();
  });
});

describe('privateIdSetOf minimum length', () => {
  it('leaves out values shorter than 4 characters (they would match ordinary text) and keeps 4-character ones', () => {
    const spec = createWorldSpec({ family: 'alias_two_hop', seed: 'private-id-short' });
    const { world, manifest } = generateSealedFixture(spec, 'private-id-short');
    const salt = mintPrivateIdSalt();
    const short = structuredClone(world);
    short.subjectHandle = 'abc';
    const exact = structuredClone(world);
    exact.subjectHandle = 'abcd';
    const base = { ...manifest, subjectHandle: 'zzz' };
    const withShort = privateIdSetOf(base, short, salt).hashes;
    const withFour = privateIdSetOf({ ...base, subjectHandle: 'zzzz' }, exact, salt).hashes;
    expect(withShort).not.toContain(privateIdHash(salt, 'abc'));
    expect(withShort).not.toContain(privateIdHash(salt, 'zzz'));
    expect(withFour).toContain(privateIdHash(salt, 'abcd'));
    expect(withFour).toContain(privateIdHash(salt, 'zzzz'));
  });
});

describe('the evaluator hash covers the second reference solver (D8-15)', () => {
  it('its sources and payload include the indexed solver', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/grade.ts', import.meta.url), 'utf8');
    expect(source).toContain('indexedSolverHash: INDEXED_SOLVER_HASH');
    expect(source).toContain("'reference2.ts'");
  });
});
