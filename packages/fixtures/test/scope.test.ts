import { describe, expect, it } from 'vitest';
import type { ActorContext, ScopeKey } from '@expunge/contracts';
import {
  DEFAULT_SCOPE_KEY,
  WorldSpecError,
  addressKey,
  createWorldSpec,
  deriveWorldScopeKey,
  generateWorld,
  resolveScopeKey,
  valuesAtPath,
  FAMILIES,
  type VisibleWorld,
} from '../src/index.js';
import { generateSealedFixture } from '../src/sealed.js';

const SPEC = createWorldSpec({ family: 'shared_array', seed: 'scope-isolation' });
const SEED = 'scope-isolation';

function everyDocument(world: VisibleWorld) {
  return Object.values(world.collections).flat();
}
function addressesOf(world: VisibleWorld): Set<string> {
  return new Set(
    Object.entries(world.collections).flatMap(([collectionId, documents]) =>
      documents.map((document) =>
        addressKey({ collectionId: collectionId as never, recordId: document._id }),
      ),
    ),
  );
}
/** Walk two same-shaped JSON values and collect every string pair that differs at the same position. */
function differingStrings(
  left: unknown,
  right: unknown,
  pairs: Array<[string, string]> = [],
): Array<[string, string]> {
  if (typeof left === 'string' && typeof right === 'string') {
    if (left !== right) pairs.push([left, right]);
  } else if (Array.isArray(left) && Array.isArray(right)) {
    expect(left.length).toBe(right.length);
    left.forEach((item, index) => differingStrings(item, right[index], pairs));
  } else if (left && right && typeof left === 'object' && typeof right === 'object') {
    expect(Object.keys(left).sort()).toEqual(Object.keys(right).sort());
    for (const key of Object.keys(left)) {
      differingStrings(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        pairs,
      );
    }
  } else {
    expect(left).toEqual(right);
  }
  return pairs;
}

describe('ScopeKey selection and the single default binding', () => {
  it('ignores extra ActorContext keys: they never reach a hash, a document or the registry', () => {
    const actor: ActorContext = {
      actorId: 'actor-secret-1',
      tenantId: 'tenant-a',
      env: 'dev',
      scopeId: 'scope-a',
      authorizationRevision: 7,
    };
    const exact: ScopeKey = { tenantId: 'tenant-a', env: 'dev', scopeId: 'scope-a' };
    const fromActor = generateWorld(SPEC, SEED, actor);
    const fromExact = generateWorld(SPEC, SEED, exact);
    const noisy = generateWorld(SPEC, SEED, {
      ...exact,
      authorizationRevision: 99,
      actorId: 'someone-else',
      role: 'admin',
    } as ScopeKey);
    expect(fromActor.worldId).toBe(fromExact.worldId);
    expect(noisy.worldId).toBe(fromExact.worldId);
    expect(fromActor).toEqual(fromExact);
    expect(noisy).toEqual(fromExact);
    const serialized = JSON.stringify(fromActor);
    for (const leaked of ['actor-secret-1', 'authorizationRevision', 'actorId', 'someone-else']) {
      expect(serialized).not.toContain(leaked);
    }
    // The trusted sealed manifest selects the same three keys.
    expect(generateSealedFixture(SPEC, SEED, actor).manifest.trustedScope).toEqual(exact);
    expect(Object.keys(resolveScopeKey(actor)).sort()).toEqual(['env', 'scopeId', 'tenantId']);
  });

  it('gives the implicit default and its explicit equivalent identical worldId and scopeId', () => {
    for (const family of FAMILIES) {
      const spec = createWorldSpec({ family, seed: `default-${family}` });
      const implicit = generateWorld(spec, `default-${family}`);
      const explicit = generateWorld(spec, `default-${family}`, {
        tenantId: 'synthetic-evaluation-tenant',
        env: 'evaluation',
        scopeId: 'synthetic-evaluation-scope',
      });
      expect(implicit.worldId).toBe(explicit.worldId);
      expect(implicit.scope.scopeId).toBe(explicit.scope.scopeId);
      expect(implicit.scope.scopeId).toBe(DEFAULT_SCOPE_KEY.scopeId);
      expect(implicit).toEqual(explicit);
    }
    const sealed = generateSealedFixture(SPEC, SEED);
    expect(sealed).toEqual(generateSealedFixture(SPEC, SEED, { ...DEFAULT_SCOPE_KEY }));
    expect(sealed.manifest.trustedScope).toEqual(DEFAULT_SCOPE_KEY);
    expect(() => {
      (DEFAULT_SCOPE_KEY as ScopeKey).tenantId = 'mutated';
    }).toThrow();
  });

  it('preserves opaque identifiers unchanged: no trimming, case folding or normalization', () => {
    const base = { tenantId: 'Tenant-A', env: 'dev', scopeId: 'Scope-A' } as const;
    const variants: ScopeKey[] = [
      base,
      { ...base, tenantId: 'tenant-a' },
      { ...base, tenantId: ' Tenant-A' },
      { ...base, tenantId: 'Tenant-A ' },
      { ...base, scopeId: 'scope-a' },
      { ...base, scopeId: 'Scope‑A' },
      { ...base, tenantId: 'Tenant-Á' },
    ];
    const worlds = variants.map((binding) => generateWorld(SPEC, SEED, binding));
    expect(new Set(worlds.map((world) => world.worldId)).size).toBe(variants.length);
    worlds.forEach((world, index) => {
      expect(world.scope.tenantId).toBe(variants[index]!.tenantId);
      expect(world.scope.scopeId).toBe(variants[index]!.scopeId);
      expect(everyDocument(world).every((document) => document.tenantId === variants[index]!.tenantId)).toBe(
        true,
      );
    });
  });

  it('rejects an unusable trusted binding as a quarantine reason code rather than guessing', () => {
    const bad: unknown[] = [
      null,
      'tenant',
      42,
      {},
      { tenantId: '', env: 'dev', scopeId: 's' },
      { tenantId: 't', env: 'dev', scopeId: '' },
      { tenantId: 't', env: 'production', scopeId: 's' },
      { tenantId: 't', env: undefined, scopeId: 's' },
      { tenantId: 7, env: 'dev', scopeId: 's' },
      { tenantId: 't', env: 'dev', scopeId: ['s'] },
      { tenantId: 'x'.repeat(257), env: 'dev', scopeId: 's' },
    ];
    for (const binding of bad) {
      expect(() => generateWorld(SPEC, SEED, binding as ScopeKey)).toThrow(WorldSpecError);
      try {
        generateWorld(SPEC, SEED, binding as ScopeKey);
      } catch (error) {
        expect((error as WorldSpecError).reasonCodes).toEqual(['trusted_scope_binding']);
      }
    }
  });
});

describe('tenant, environment and scope isolation', () => {
  const tenantA: ScopeKey = { tenantId: 'tenant-a', env: 'evaluation', scopeId: 'shared-scope' };
  const tenantB: ScopeKey = { tenantId: 'tenant-b', env: 'evaluation', scopeId: 'shared-scope' };
  const envDev: ScopeKey = { tenantId: 'tenant-a', env: 'dev', scopeId: 'shared-scope' };
  const otherScope: ScopeKey = { tenantId: 'tenant-a', env: 'evaluation', scopeId: 'other-scope' };

  it('same seed under two tenants, two environments or two scopes yields different worlds', () => {
    const worlds = [tenantA, tenantB, envDev, otherScope].map((binding) =>
      generateWorld(SPEC, SEED, binding),
    );
    expect(new Set(worlds.map((world) => world.worldId)).size).toBe(4);
    for (const [index, binding] of [tenantA, tenantB, envDev, otherScope].entries()) {
      const world = worlds[index]!;
      expect(world.scope).toMatchObject(binding);
      for (const document of everyDocument(world)) {
        expect(document).toMatchObject({
          tenantId: binding.tenantId,
          env: binding.env,
          worldId: world.worldId,
        });
      }
    }
  });

  it('gives every world instance disjoint record _ids (Mongo _id uniqueness is collection-wide)', () => {
    const bindings = [tenantA, tenantB, envDev, otherScope, undefined];
    const worlds = bindings.map((binding) => generateWorld(SPEC, SEED, binding));
    const owner = new Map<string, number>();
    worlds.forEach((world, index) => {
      for (const collectionId of Object.keys(world.collections) as Array<keyof VisibleWorld['collections']>) {
        for (const document of world.collections[collectionId]) {
          const key = `${collectionId}/${document._id}`;
          expect(owner.has(key), `${key} reused by world ${index}`).toBe(false);
          owner.set(key, index);
        }
      }
    });
    // Identity bindings are translated through the same instance mapping, so values never match across worlds.
    const subjects = worlds.map((world) => {
      const root = world.collections.customers.find((document) => document._id === world.subjectHandle)!;
      return (root.data.identity as { id: string; email: string }).id;
    });
    expect(new Set(subjects).size).toBe(worlds.length);
  });

  it('reproduces identical _ids and documents when the same (spec, seed, scope) is reset', () => {
    const first = generateWorld(SPEC, SEED, tenantA);
    const second = generateWorld(SPEC, SEED, { ...tenantA });
    expect(second).toEqual(first);
    expect(addressesOf(second)).toEqual(addressesOf(first));
    expect(generateSealedFixture(SPEC, SEED, tenantA)).toEqual(generateSealedFixture(SPEC, SEED, tenantA));
  });

  it('keeps one structural recipe across instances: documents differ only through a consistent translation', () => {
    const left = generateWorld(SPEC, SEED, tenantA);
    const right = generateWorld(SPEC, SEED, tenantB);
    const pairs = differingStrings(left, right);
    const forward = new Map<string, string>();
    const backward = new Map<string, string>();
    for (const [from, to] of pairs) {
      // A given identifier always translates to one counterpart, and no two identifiers share one.
      expect(forward.get(from) ?? to).toBe(to);
      expect(backward.get(to) ?? from).toBe(from);
      forward.set(from, to);
      backward.set(to, from);
    }
    const translated = JSON.parse(
      JSON.stringify(left).replace(/"[^"]*"/g, (quoted) =>
        JSON.stringify(forward.get(JSON.parse(quoted)) ?? JSON.parse(quoted)),
      ),
    );
    expect(translated).toEqual(right);
    // Every translated string is an instance identifier, never business content.
    for (const [from] of pairs) {
      expect(from).toMatch(/^(world_|syn_|synthetic-|tenant-|scope_)/);
    }
  });

  it("a world A address never resolves in world B under A's binding, and A's filter matches no B document", () => {
    for (const [a, b] of [
      [tenantA, tenantB],
      [tenantA, envDev],
      [tenantA, otherScope],
    ] as const) {
      const worldA = generateWorld(SPEC, SEED, a);
      const worldB = generateWorld(SPEC, SEED, b);
      const matchesA = (document: { tenantId: string; env: string; worldId: string }) =>
        document.tenantId === a.tenantId && document.env === a.env && document.worldId === worldA.worldId;
      expect(everyDocument(worldA).every(matchesA)).toBe(true);
      expect(everyDocument(worldB).some(matchesA)).toBe(false);
      const inB = addressesOf(worldB);
      for (const address of addressesOf(worldA)) expect(inB.has(address)).toBe(false);
      expect(worldA.subjectHandle).not.toBe(worldB.subjectHandle);
      expect(worldB.collections.customers.some((document) => document._id === worldA.subjectHandle)).toBe(
        false,
      );
    }
  });

  it('resolves every reference, identity edge and manifest entry to a real document of its own world', () => {
    for (const family of FAMILIES) {
      const seed = `resolve-${family}`;
      const fixture = generateSealedFixture(createWorldSpec({ family, seed }), seed, tenantB);
      const { world, manifest } = fixture;
      const known = addressesOf(world);
      const byKey = new Map<string, VisibleWorld['collections']['customers'][number]>(
        Object.entries(world.collections).flatMap(([collectionId, documents]) =>
          documents.map(
            (document) => [`${collectionId}/${document._id}`, document] as [string, typeof document],
          ),
        ),
      );
      // Every declared reference value points at a document of this very world, except the one standalone
      // bystander reference each wildcard reference array carries (the unrelated element to be preserved).
      const ids = new Set([...known].map((key) => key.split('/')[1]!));
      const referenceFields = world.scope.fields.filter((field) =>
        field.fieldId.endsWith('.record_reference'),
      );
      expect(referenceFields).toHaveLength(6);
      for (const field of referenceFields) {
        for (const document of world.collections[field.collectionId as keyof VisibleWorld['collections']]) {
          const values = valuesAtPath(document, field.path).map((entry) => entry.value);
          expect(values.length).toBeGreaterThan(0);
          const unresolved = values.filter((value) => value !== null && !ids.has(value as string));
          expect(unresolved, `${family} ${field.fieldId}`).toHaveLength(field.isArray ? 1 : 0);
        }
      }
      // Every private manifest entry names a real document and a real, correctly hashed path in this world.
      expect(manifest.effects).toHaveLength(6);
      for (const effect of manifest.effects) {
        expect(known.has(addressKey(effect.address)), `${family} target ${effect.address.recordId}`).toBe(
          true,
        );
        expect(effect.address.recordIdBsonType).toBe('string');
      }
      expect(manifest.subjectHandle).toBe(
        manifest.effects.find((e) => e.address.collectionId === 'customers')!.address.recordId,
      );
      for (const entry of manifest.untouchedHashes) expect(known.has(addressKey(entry.address))).toBe(true);
      for (const entry of manifest.preservationHashes) {
        const document = byKey.get(addressKey(entry.address));
        expect(document).toBeDefined();
        expect(valuesAtPath(document, entry.path)).toHaveLength(1);
      }
      for (const [collectionId, documents] of Object.entries(manifest.expectedState)) {
        for (const document of documents) {
          expect(known.has(addressKey({ collectionId: collectionId as never, recordId: document._id }))).toBe(
            true,
          );
          expect(document).toMatchObject({
            tenantId: tenantB.tenantId,
            env: tenantB.env,
            worldId: world.worldId,
          });
        }
      }
    }
  });
});

describe('deriveWorldScopeKey', () => {
  it('gives each world instance its own ScopeKey and is usable as the explicit binding', () => {
    const other = createWorldSpec({ family: 'direct_nested', seed: 'derive-other' });
    const a = deriveWorldScopeKey(SPEC, SEED);
    const b = deriveWorldScopeKey(other, 'derive-other');
    expect(a.scopeId).not.toBe(b.scopeId);
    expect(a).toMatchObject({ tenantId: DEFAULT_SCOPE_KEY.tenantId, env: DEFAULT_SCOPE_KEY.env });
    expect(deriveWorldScopeKey(SPEC, SEED)).toEqual(a);
    const world = generateWorld(SPEC, SEED, a);
    expect(world.scope.scopeId).toBe(a.scopeId);
    expect(world.scope).toMatchObject({ tenantId: a.tenantId, env: a.env });
    // A base with extra keys is reduced to tenant and environment; the scopeId of the base is replaced.
    const fromActor = deriveWorldScopeKey(SPEC, SEED, {
      actorId: 'x',
      tenantId: 'tenant-z',
      env: 'demo',
      scopeId: 'ignored',
      authorizationRevision: 3,
    } as ScopeKey);
    expect(fromActor).toEqual({
      tenantId: 'tenant-z',
      env: 'demo',
      scopeId: expect.stringMatching(/^scope_[0-9a-f]{24}$/),
    });
    expect(deriveWorldScopeKey(SPEC, SEED, { tenantId: 'tenant-z', env: 'demo', scopeId: 'other' })).toEqual(
      fromActor,
    );
  });
});
