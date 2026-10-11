import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { BSON, type Document } from 'mongodb';
import type { FieldDescriptor, ScopeKey } from '@expunge/contracts';
import {
  EffectRepository,
  JobRepository,
  ScopeRepository,
  WorldRepository,
  bsonPreimageHash,
  isWorldKey,
  typedAddress,
  type MongoService,
} from '../src/index.js';
import {
  COLLECTION_IDS,
  createWorldSpec,
  deriveWorldScopeKey,
  generateWorld,
  valuesAtPath,
  type CollectionId,
  type FixtureFamily,
  type VisibleWorld,
} from '../../fixtures/src/index.js';
import {
  HASH,
  actor,
  describeLive,
  intent,
  openEnvironment,
  recordDecisionFor,
  type LiveEnvironment,
} from './support.js';

/**
 * fixture -> registry -> scope insert -> read match -> targeted write, end to end on a real replica set, with
 * mixed arrays: the subject's element changes and every other element keeps its original bytes.
 * The fixture package is imported by relative path; only its visible world is used (never a manifest).
 */
const REDACTED = '[redacted]';
type Doc = Record<string, unknown> & { _id: string; _rev: number; data: Record<string, unknown> };

function customersPrimary(world: VisibleWorld): Doc {
  return world.collections.customers.find((doc) => doc._id === world.subjectHandle) as unknown as Doc;
}
/** Every identity token the subject appears under, read from the visible primary customer record. */
function subjectTokens(world: VisibleWorld): string[] {
  const primary = customersPrimary(world);
  const identity = (primary.data.identity as { id: string }).id;
  return [identity, ...(primary.data.aliases as string[])];
}
const clone = <T>(value: T): T => structuredClone(value);
/** Reference model of one targeted redaction: set every element at a concrete matched path. */
function modelRedact(doc: Doc, field: FieldDescriptor, token: string): boolean {
  let changed = false;
  for (const found of valuesAtPath(doc, field.path)) {
    if (found.value !== token) continue;
    let cursor: Record<string, unknown> | unknown[] = doc;
    for (const part of found.path.slice(0, -1))
      cursor = (cursor as Record<string, unknown>)[part] as typeof cursor;
    (cursor as Record<string, unknown>)[found.path.at(-1)!] = REDACTED;
    changed = true;
  }
  if (changed) doc._rev += 1;
  return changed;
}
const bytes = (value: unknown) => Buffer.from(BSON.serialize(value as Document));

describeLive('registry-driven targeted writes on mixed arrays (real replica set)', () => {
  let env: LiveEnvironment;
  let executor: MongoService;
  let builder: MongoService;

  beforeAll(async () => {
    env = await openEnvironment('scope');
    executor = await env.as('domain_executor');
    builder = await env.as('fixture_builder');
  }, 30000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  async function seed(family: FixtureFamily) {
    const seedValue = `scope-e2e-${family}`;
    const spec = createWorldSpec({ family, seed: seedValue });
    const binding = deriveWorldScopeKey(spec, seedValue);
    const world = generateWorld(spec, seedValue, binding);
    await installAuthorityFor(binding);
    await new ScopeRepository(builder).insert(world.scope);
    await new WorldRepository(builder).create(binding, world.worldId, world.scope.revision);
    for (const id of COLLECTION_IDS)
      await env.service.world.collection(id).insertMany(clone(world.collections[id]) as never[]);
    const key = await new WorldRepository(builder).bind(binding, world.worldId);
    return { world, binding, key };
  }
  async function installAuthorityFor(binding: ScopeKey) {
    await env.service.control.collection('authority_revisions').deleteMany({});
    await env.service.control.collection('authority_touches').deleteMany({});
    const { AuthorityRepository } = await import('../src/index.js');
    await new AuthorityRepository(env.service).install(binding, HASH);
  }
  const stored = async (id: CollectionId) =>
    (await env.service.world.collection<Doc>(id).find({}).toArray()) as unknown as Doc[];

  for (const family of ['composed_holdout', 'direct_nested', 'shared_array'] as const) {
    it(`${family}: finds exactly the records that hold a subject token, in every registered collection`, async () => {
      const { world, key } = await seed(family);
      const scopes = new ScopeRepository(executor);
      const identityFields = world.scope.fields.filter((f) => f.fieldId.endsWith('.identity_binding'));
      expect(identityFields).toHaveLength(COLLECTION_IDS.length);
      let matches = 0;
      for (const field of identityFields) {
        for (const token of subjectTokens(world)) {
          const found = await scopes.findByField(key, world.scope, field.fieldId, token);
          const expected = (world.collections[field.collectionId as CollectionId] as unknown as Doc[])
            .filter((doc) => valuesAtPath(doc, field.path).some((hit) => hit.value === token))
            .map((doc) => doc._id)
            .sort();
          expect(found.map((a) => a.recordId).sort(), `${field.fieldId} ${token}`).toEqual(expected);
          expect(found.every((a) => a.recordIdBsonType === 'string')).toBe(true);
          matches += found.length;
        }
      }
      expect(matches).toBeGreaterThan(0);
    });

    it(`${family}: a targeted redaction changes only the subject's elements and preserves every other byte`, async () => {
      const { world, key } = await seed(family);
      const scopes = new ScopeRepository(executor);
      const model = new Map<string, Doc>(
        COLLECTION_IDS.flatMap((id) =>
          (world.collections[id] as unknown as Doc[]).map((doc) => [`${id}/${doc._id}`, clone(doc)] as const),
        ),
      );
      const before = new Map<string, Buffer>();
      for (const id of COLLECTION_IDS)
        for (const doc of await stored(id)) before.set(`${id}/${doc._id}`, bytes(doc));

      let writes = 0;
      let mixed = 0;
      for (const field of world.scope.fields.filter((f) => f.fieldId.endsWith('.identity_binding'))) {
        for (const token of subjectTokens(world)) {
          for (const address of await scopes.findByField(key, world.scope, field.fieldId, token)) {
            const recordKey = `${address.collectionId}/${address.recordId}`;
            const doc = model.get(recordKey)!;
            const siblings = valuesAtPath(doc, field.path).filter((hit) => hit.value !== token);
            if (field.path.includes('*') && siblings.length > 0) mixed += 1;
            const result = await scopes.service.transaction(async (session) =>
              scopes.writeField(
                key,
                world.scope,
                address,
                field.fieldId,
                {
                  match: token,
                  mutation: { kind: 'replace', replacement: REDACTED },
                },
                session,
              ),
            );
            expect(modelRedact(doc, field, token), recordKey).toBe(true);
            expect(result).toEqual({ matched: 1, modified: 1 });
            writes += 1;
          }
        }
      }
      expect(writes).toBeGreaterThan(0);
      if (family !== 'direct_nested') expect(mixed, 'a mixed array was exercised').toBeGreaterThan(0);

      for (const id of COLLECTION_IDS) {
        for (const doc of await stored(id)) {
          const recordKey = `${id}/${doc._id}`;
          const expected = model.get(recordKey)!;
          expect(doc, recordKey).toEqual(expected);
          if (expected._rev === 1)
            expect(bytes(doc).equals(before.get(recordKey)!), `${recordKey} untouched bytes`).toBe(true);
        }
      }
      // After the cleanup no identity field finds the subject any more.
      for (const field of world.scope.fields.filter((f) => f.fieldId.endsWith('.identity_binding')))
        for (const token of subjectTokens(world))
          expect(await scopes.findByField(key, world.scope, field.fieldId, token)).toEqual([]);
    });
  }

  it('removes only the matching element of a mixed array and keeps its siblings in order', async () => {
    const { world, key } = await seed('composed_holdout');
    const scopes = new ScopeRepository(executor);
    const aliases = world.scope.fields.find((f) => f.fieldId === 'customers.aliases')!;
    const primary = customersPrimary(world);
    const original = [...(primary.data.aliases as string[])];
    const removed = original[1]!;
    const address = typedAddress('customers', primary._id);
    const result = await scopes.service.transaction(async (session) =>
      scopes.writeField(
        key,
        world.scope,
        address,
        aliases.fieldId,
        {
          match: removed,
          mutation: { kind: 'remove' },
        },
        session,
      ),
    );
    expect(result).toEqual({ matched: 1, modified: 1 });
    const after = (await env.service.world
      .collection<Doc>('customers')
      .findOne({ _id: primary._id as never }))!;
    expect(after.data.aliases).toEqual(original.filter((alias) => alias !== removed));
    expect(Array.isArray(after.data.aliases)).toBe(true);
    // Everything outside the array is byte-identical.
    const { aliases: _a, ...restAfter } = after.data;
    const { aliases: _b, ...restBefore } = primary.data;
    expect(bytes(restAfter).equals(bytes(restBefore))).toBe(true);
    expect(after._rev).toBe(primary._rev + 1);
  });

  it('writes through the effect protocol: fenced job, recorded decision, hashes of the actual preimages', async () => {
    const { world, binding, key } = await seed('composed_holdout');
    const scopes = new ScopeRepository(executor);
    const effects = new EffectRepository(executor);
    const worker = { ...actor, ...binding };
    const jobs = new JobRepository(executor);
    const job = await new JobRepository(env.service).create(worker, {
      jobId: 'e2e-job',
      kind: 'cleanup',
      binding: {
        runId: 'run-e2e-job',
        worldId: world.worldId,
        harnessHash: HASH,
        scopeRevision: world.scope.revision,
        workerProfileHash: HASH,
      },
    });
    const claimed = (await jobs.claim(worker, job._id, 'worker', 10000))!;
    const lease = { jobId: job._id, ownerId: 'worker', fence: claimed.lease.fence };
    const field = world.scope.fields.find((f) => f.fieldId === 'messages.identity_binding')!;
    const token = subjectTokens(world).find((candidate) =>
      valuesAtPath(world.collections.messages, ['*', ...field.path]).some((hit) => hit.value === candidate),
    )!;
    expect(token).toBeTruthy();
    const found = await scopes.findByField(key, world.scope, field.fieldId, token);
    expect(found.length).toBeGreaterThan(0);
    const action = intent(job._id, { targets: found, effectKind: 'redact', stepId: 'apply' });
    const bound = { ...action, policyDecision: { ...action.policyDecision } };
    await recordDecisionFor(executor, bound, worker);
    const receipt = await effects.commitEffect({
      actor: worker,
      lease,
      intent: bound,
      apply: async (session) => {
        const applied = [];
        for (const address of found) {
          const preHash = await scopes.preimageHash(key, world.scope, address, session);
          await scopes.writeField(
            key,
            world.scope,
            address,
            field.fieldId,
            {
              match: token,
              mutation: { kind: 'replace', replacement: REDACTED },
            },
            session,
          );
          const postHash = await scopes.preimageHash(key, world.scope, address, session);
          expect(postHash).not.toBe(preHash);
          applied.push({
            address,
            kind: 'redact' as const,
            preHash,
            postHash,
            preVersion: 1,
            postVersion: 2,
          });
        }
        return applied;
      },
    });
    expect(receipt.appliedEffects).toHaveLength(found.length);
    for (const effect of receipt.appliedEffects) {
      const doc = await env.service.world
        .collection<Doc>('messages')
        .findOne({ _id: effect.address.recordId as never }, { promoteValues: false, promoteLongs: false });
      expect(bsonPreimageHash(doc)).toBe(effect.postHash);
    }
    expect(
      await env.service.world.collection('world_revisions').findOne({ _id: world.worldId as never }),
    ).toHaveProperty('revision', 1);
  });

  it('refuses another scope, an unregistered field, another world and any key the repository did not issue', async () => {
    const { world, binding, key } = await seed('direct_nested');
    const scopes = new ScopeRepository(executor);
    const field = world.scope.fields.find((f) => f.fieldId === 'messages.identity_binding')!;
    const token = subjectTokens(world)[0]!;
    // A world of another tenant, with a perfectly valid key, cannot be used with this scope's registry.
    const otherScope = { ...binding, tenantId: 'other-tenant' };
    await new WorldRepository(builder).create(otherScope, 'foreign-world', 1);
    const foreign = await new WorldRepository(builder).bind(otherScope, 'foreign-world');
    await expect(scopes.findByField(foreign, world.scope, field.fieldId, token)).rejects.toThrow(
      'UnauthorizedCollection',
    );
    await expect(scopes.findByField(key, world.scope, 'messages.not_registered', token)).rejects.toThrow(
      'UnknownFieldId',
    );
    // Another world in the same scope sees none of this world's records.
    await new WorldRepository(builder).create(binding, 'sibling-world', world.scope.revision);
    const sibling = await new WorldRepository(builder).bind(binding, 'sibling-world');
    expect(await scopes.findByField(sibling, world.scope, field.fieldId, token)).toEqual([]);
    // A bare string, a hand-built object and a copy of a real key with another world id are refused outright.
    for (const forged of [
      'world-x',
      { ...binding, worldId: world.worldId, scopeRevision: 1, jobId: null },
      { ...key, worldId: 'sibling-world' },
    ])
      await expect(scopes.findByField(forged as never, world.scope, field.fieldId, token)).rejects.toThrow(
        'InvalidWorldKey',
      );
    await expect(
      scopes.service.transaction(async (session) =>
        scopes.writeField(
          { ...key } as never,
          world.scope,
          { collectionId: 'messages', recordId: 'x', recordIdBsonType: 'string' },
          field.fieldId,
          { match: token, mutation: { kind: 'remove' } },
          session,
        ),
      ),
    ).rejects.toThrow('InvalidWorldKey');
  });

  it('refuses to bind a world that does not exist under the scope', async () => {
    const { binding } = await seed('direct_nested');
    const worlds = new WorldRepository(builder);
    await expect(worlds.bind(binding, 'nowhere')).rejects.toThrow('UnknownWorld');
    await expect(worlds.bind({ ...binding, scopeId: 'other-scope' }, 'nowhere')).rejects.toThrow(
      'UnknownWorld',
    );
  });

  it('derives a key from a stored job, so the world comes from the run binding', async () => {
    const { world, binding } = await seed('direct_nested');
    const worker = { ...actor, ...binding };
    const created = await new JobRepository(env.service).create(worker, {
      jobId: 'keyed-job',
      kind: 'cleanup',
      binding: {
        runId: 'run-keyed-job',
        worldId: world.worldId,
        harnessHash: HASH,
        scopeRevision: world.scope.revision,
        workerProfileHash: HASH,
      },
    });
    const jobs = new JobRepository(env.service);
    const derived = await jobs.worldKey(worker, created._id);
    expect(derived).toMatchObject({
      worldId: world.worldId,
      scopeRevision: world.scope.revision,
      jobId: 'keyed-job',
      ...binding,
    });
    expect(isWorldKey(derived)).toBe(true);
    expect(isWorldKey({ ...derived })).toBe(false);
    // The capability comes from the stored row: another scope's actor cannot mint it, and an unknown job has none.
    await expect(jobs.worldKey({ ...worker, scopeId: 'someone-else' }, created._id)).rejects.toThrow();
    await expect(jobs.worldKey(worker, 'no-such-job')).rejects.toThrow('JobNotFound');
  });
});
