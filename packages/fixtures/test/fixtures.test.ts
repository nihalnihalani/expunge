import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contentHash } from '@expunge/contracts';
import {
  createWorldSpec,
  FAMILIES,
  FIXTURE_GENERATOR_HASH,
  generateWorld,
  publicSplitCommitment,
  validateWorldSpec,
  valuesAtPath,
  type JsonObject,
} from '../src/index.js';
import { assertManifestIntegrity, buildSealedSplitPlan, generateSealedFixture } from '../src/sealed.js';
import { testMasterSeed } from './helpers.js';
import { assignRecipePath } from '../src/paths.js';

describe('synthetic fixture admission surface', () => {
  it('replays byte-identical seeded worlds and sealed commitments', () => {
    const spec = createWorldSpec({ family: 'cycle_namesake', seed: 'replay-v1' });
    expect(generateSealedFixture(spec, 'replay-v1')).toEqual(generateSealedFixture(spec, 'replay-v1'));
    const different = createWorldSpec({ family: 'cycle_namesake', seed: 'replay-v2' });
    expect(generateWorld(different, 'replay-v2').worldId).not.toBe(generateWorld(spec, 'replay-v1').worldId);
  });
  it('has six collections, bounded capacity and synthetic identities only', () => {
    const spec = createWorldSpec({
      family: 'mixed_eligibility',
      seed: 'capacity',
      documentsPerCollection: 83,
    });
    const world = generateWorld(spec, 'capacity');
    expect(Object.keys(world.collections)).toHaveLength(6);
    expect(Object.values(world.collections).flat()).toHaveLength(498);
    const customer = world.collections.customers.find((document) => document._id === world.subjectHandle)!;
    expect((customer.data.identity as { email: string }).email).toMatch(/@example\.invalid$/);
    expect(
      Object.values(world.collections)
        .flat()
        .every((document) => document.tenantId === 'synthetic-evaluation-tenant'),
    ).toBe(true);
  });
  it('binds demo scope only through the trusted builder parameter', () => {
    const spec = createWorldSpec({ family: 'direct_nested', seed: 'demo-scope' });
    const demo = generateWorld(spec, 'demo-scope', {
      tenantId: 'demo-team',
      env: 'demo',
      scopeId: 'owner-registered-scope',
    });
    expect(demo.scope.env).toBe('demo');
    expect(demo.scope.scopeId).toBe('owner-registered-scope');
    expect(
      Object.values(demo.collections)
        .flat()
        .every((row) => row.env === 'demo' && row.tenantId === 'demo-team'),
    ).toBe(true);
    expect(demo.worldId).not.toBe(generateWorld(spec, 'demo-scope').worldId);
    expect(() => generateWorld({ ...spec, tenantId: 'model-forged' } as typeof spec, 'demo-scope')).toThrow(
      'unknown_spec_key',
    );
  });
  it('rejects answer/program injection, seed tampering, unsafe paths and excessive resources', () => {
    const clean = createWorldSpec({ family: 'direct_nested', seed: 'reject' });
    expect(() => generateWorld({ ...clean, expectedAnswer: [] } as typeof clean, 'reject')).toThrow(
      'unknown_spec_key',
    );
    expect(() => generateWorld(clean, 'wrong-seed')).toThrow('seed_commitment');
    const bad = structuredClone(clean);
    bad.collectionLayouts[1]!.identityPath = ['$where'];
    expect(() => generateWorld(bad, 'reject')).toThrow('unsafe_path');
    const large = structuredClone(clean);
    large.unrelatedRecipes.documentsPerCollection = 84;
    expect(() => generateWorld(large, 'reject')).toThrow('documents_per_collection');
    const altered = structuredClone(clean);
    altered.eligibilityPolicy.hash = '0'.repeat(64);
    expect(() => generateWorld(altered, 'reject')).toThrow('eligibility_policy');
  });
  it('keeps oracle fields absent from every visible payload and declared reference', () => {
    const spec = createWorldSpec({ family: 'diamond_alias', seed: 'no-leak' });
    const fixture = generateSealedFixture(spec, 'no-leak');
    const visible = JSON.stringify(fixture.world);
    for (const secret of [
      'manifestHash',
      'expectedState',
      'preservationHashes',
      'untouchedHashes',
      fixture.manifest.manifestHash,
    ])
      expect(visible).not.toContain(secret);
    expect(
      fixture.world.scope.referenceEdges.every(
        (edge) => !Object.keys(edge).some((key) => /targetIds|manifest/.test(key)),
      ),
    ).toBe(true);
    // Exact namesake display text exists on several distinct identities: it is never a join key.
    const subjectName = fixture.world.collections.customers.find(
      (document) => document._id === fixture.world.subjectHandle,
    )!.data.displayName;
    const sameNames = fixture.world.collections.customers.filter(
      (document) => document.data.displayName === subjectName,
    );
    expect(sameNames).toHaveLength(3);
    expect(new Set(sameNames.map((document) => (document.data.identity as { id: string }).id)).size).toBe(3);
  });
  it('pins independent intent poststates and detects manifest alteration', () => {
    const spec = createWorldSpec({ family: 'mixed_eligibility', seed: 'explicit-oracle' });
    const { world, manifest } = generateSealedFixture(spec, 'explicit-oracle');
    expect(manifest.effects.map((action) => action.effect)).toEqual([
      'tombstone',
      'restrict',
      'redact',
      'delete',
      'redact',
      'tombstone',
    ]);
    const accountId = manifest.effects.find((action) => action.address.collectionId === 'accounts')!.address
      .recordId;
    const initialAccount = world.collections.accounts.find((document) => document._id === accountId)!;
    const account = manifest.expectedState.accounts.find((document) => document._id === accountId)!;
    expect(account.data).toEqual(initialAccount.data);
    expect(account.access).toBe('restricted');
    expect(account._rev).toBe(2);
    const customer = manifest.expectedState.customers.find(
      (document) => document._id === world.subjectHandle,
    )!;
    expect(customer.lifecycle).toBe('tombstoned');
    expect(customer.data.identity).toEqual({ id: null, email: null });
    expect(customer.data.business).toEqual(
      world.collections.customers.find((document) => document._id === world.subjectHandle)!.data.business,
    );
    const eventId = manifest.effects.find((action) => action.address.collectionId === 'events')!.address
      .recordId;
    expect(manifest.expectedState.events.find((document) => document._id === eventId)).toBeUndefined();
    assertManifestIntegrity(manifest);
    account.access = 'open';
    expect(() => assertManifestIntegrity(manifest)).toThrow('ManifestIntegrityError');
  });
  it('does not expose target creation order or a target-only business ordinal', () => {
    const positions = new Set<number>();
    for (let n = 0; n < 8; n++) {
      const seed = `order-${n}`;
      const spec = createWorldSpec({ family: 'direct_nested', seed });
      const world = generateWorld(spec, seed);
      positions.add(world.collections.customers.findIndex((row) => row._id === world.subjectHandle));
      expect(
        world.collections.customers.find((row) => row._id === world.subjectHandle)!.data.business,
      ).not.toMatchObject({ ordinal: 0 });
    }
    expect(positions.size).toBeGreaterThan(1);
  });
  it('commits implementation source bytes rather than a version label alone', () => {
    const files = [
      'generator.ts',
      'derivation.ts',
      'entropy.ts',
      'recipes.ts',
      'paths.ts',
      'scope.ts',
      'types.ts',
      'sealed.ts',
      'shape.ts',
      'splits.ts',
      'source.ts',
      '../../contracts/src/index.ts',
    ].sort();
    const sources = files.map((moduleId) => ({
      moduleId,
      source: readFileSync(new URL(`../src/${moduleId}`, import.meta.url), 'utf8'),
    }));
    const sourceHash = contentHash({ sources }, 'fixture-source');
    const expected = contentHash(
      {
        version: 'expunge.synthetic.generator.v1',
        families: FAMILIES,
        sourceHash,
        safety: {
          syntheticOnly: true,
          maxDocuments: 500,
          maxHops: 5,
          collections: ['customers', 'accounts', 'messages', 'events', 'notes', 'archives'],
        },
      },
      'fixture-generator',
    );
    expect(FIXTURE_GENERATOR_HASH).toBe(expected);
    const changed = sources.map((source, index) =>
      index === 0 ? { ...source, source: `${source.source}\n// changed implementation bytes` } : source,
    );
    expect(contentHash({ sources: changed }, 'fixture-source')).not.toBe(sourceHash);
  });
  it('commits split-builder source bytes, including the contracts hash implementation', () => {
    const files = [
      'splits.ts',
      'recipes.ts',
      'source.ts',
      'types.ts',
      'entropy.ts',
      'derivation.ts',
      '../../contracts/src/index.ts',
    ].sort();
    const sources = files.map((moduleId) => ({
      moduleId,
      source: readFileSync(new URL(`../src/${moduleId}`, import.meta.url), 'utf8'),
    }));
    const expected = contentHash({ sources }, 'split-builder-source');
    const commitment = publicSplitCommitment(buildSealedSplitPlan(testMasterSeed('builder-bytes')));
    expect(commitment.splitBuilderHash).toBe(expected);
  });
  it('commits deterministic train/protected/validation/test structural splits', () => {
    const plan = buildSealedSplitPlan(testMasterSeed('held-out'));
    const publicManifest = publicSplitCommitment(plan);
    expect(publicManifest.counts).toEqual({ train: 2, protected: 8, validation: 8, test: 24 });
    expect(publicSplitCommitment(buildSealedSplitPlan(testMasterSeed('held-out')))).toEqual(publicManifest);
    expect(new Set(plan.map((entry) => entry.seed)).size).toBe(42);
    const trainShapes = new Set(plan.filter((row) => row.split === 'train').map((row) => row.structuralHash));
    const validationShapes = new Set(
      plan.filter((row) => row.split === 'validation').map((row) => row.structuralHash),
    );
    const testShapes = new Set(plan.filter((row) => row.split === 'test').map((row) => row.structuralHash));
    expect([...validationShapes].every((hash) => !trainShapes.has(hash))).toBe(true);
    expect([...testShapes].every((hash) => !trainShapes.has(hash) && !validationShapes.has(hash))).toBe(true);
    expect(JSON.stringify(publicManifest)).not.toContain(plan[0]!.seed);
    expect(JSON.stringify(publicManifest)).not.toContain('collectionLayouts');
    expect(contentHash(publicManifest, 'test-commitment')).toMatch(/^[a-f0-9]{64}$/);
  });
  it('reads registered nested/array paths with concrete positions', () => {
    expect(valuesAtPath({ a: [{ k: 'x' }, { k: 'y' }] }, ['a', '*', 'k'])).toEqual([
      { path: ['a', '0', 'k'], value: 'x' },
      { path: ['a', '1', 'k'], value: 'y' },
    ]);
    expect(valuesAtPath({ a: null }, ['a', '*', 'k'])).toEqual([]);
    expect(FAMILIES).toContain('archive_bridge');
  });
  it('rejects coerced path segments and object-root wildcard assignments', () => {
    const clean = createWorldSpec({ family: 'direct_nested', seed: 'path-types' });
    for (const path of [
      ['safe', true],
      ['safe', 42],
      ['safe', null],
      ['safe', {}],
      ['*'],
      ['*', 'binding'],
    ]) {
      const malformed = structuredClone(clean);
      malformed.collectionLayouts[1]!.identityPath = path as string[];
      expect(validateWorldSpec(malformed, 'path-types')).toContain('unsafe_path');
      expect(() => generateWorld(malformed, 'path-types')).toThrow('unsafe_path');
      expect(() => assignRecipePath({}, path as string[], ['x'])).toThrow('InvalidRecipePath');
    }
    expect(() => valuesAtPath({ safe: { true: 'x' } }, ['safe', true] as unknown as string[])).toThrow(
      'InvalidTraversalPath',
    );
  });
  it('generator assignment and registered traversal agree for every supported path shape', () => {
    for (const path of [
      ['id'],
      ['wrapper', 'id'],
      ['items', '*', 'id'],
      ['wrapper', 'items', '*', 'key'],
      ['items', '*'],
    ]) {
      const root: JsonObject = {};
      assignRecipePath(root, path, ['subject', 'unrelated']);
      expect(valuesAtPath(root, path).map((item) => item.value)).toEqual(
        path.includes('*') ? ['subject', 'unrelated'] : ['subject'],
      );
    }
  });
});
