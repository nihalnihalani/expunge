import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { BSON, type Document } from 'mongodb';
import type { DomainAddress, FieldDescriptor, ScopeRegistry } from '@expunge/contracts';
import { ScopeRepository, WorldRepository, type MongoService, type WorldKey } from '../src/index.js';
import { actor, describeLive, openEnvironment, registryOf, type LiveEnvironment } from './support.js';

/**
 * ScopeRepository.applyEffect: one owner-policy effect per record as a single conditional update, so `_rev` moves
 * exactly once and the elements the effect does not name keep their bytes.
 */
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const field = (fieldId: string, path: string[]): FieldDescriptor => ({
  fieldId,
  collectionId: 'customers',
  path,
  bsonTypes: ['string'],
  isArray: path.includes('*'),
  sanitized: true,
});
const fields = [
  field('customers.identity', ['data', 'identity', 'id']),
  field('customers.aliases', ['data', 'aliases', '*']),
  field('customers.parties', ['data', 'parties', '*', 'principal']),
  field('customers.payload', ['data', 'payload']),
];
const bytes = (value: unknown) => Buffer.from(BSON.serialize(value as Document));
const address = (recordId: string): DomainAddress => ({
  collectionId: 'customers',
  recordId,
  recordIdBsonType: 'string',
});
const original = () => ({
  data: {
    identity: { id: 'subject-1', email: 'keep@example.invalid' },
    aliases: ['subject-1', 'other-alias', 'alias-2'],
    parties: [
      { principal: 'subject-1', role: 'sender' },
      { principal: 'someone-else', role: 'receiver' },
    ],
    payload: 'private text',
    business: { balance: 7 },
  },
  eligibility: { effect: 'redact', policyId: 'p' },
  access: 'open',
  lifecycle: 'active',
});

describeLive('ScopeRepository.applyEffect (real replica set)', () => {
  let env: LiveEnvironment;
  let executor: MongoService;
  let scopes: ScopeRepository;
  let registry: ScopeRegistry;
  let world: WorldKey;

  beforeAll(async () => {
    env = await openEnvironment('record-effects');
    executor = await env.as('domain_executor');
    scopes = new ScopeRepository(executor);
  }, 30000);
  beforeEach(async () => {
    await env.reset();
    registry = registryOf({ fields });
    const worlds = new WorldRepository(env.service);
    await worlds.create(scope, 'w', 1);
    world = await worlds.bind(scope, 'w');
    await env.service.world.collection<Document>('customers').insertMany([
      { _id: 'a' as never, ...scope, worldId: 'w', _rev: 1, ...original() },
      { _id: 'b' as never, ...scope, worldId: 'w', _rev: 1, ...original() },
    ]);
  });
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  const stored = async (id: string) =>
    (await env.service.world.collection<Document>('customers').findOne({ _id: id as never }))!;

  it('redacts exact values and the payload in one update, advancing _rev once and keeping other bytes', async () => {
    const before = await stored('a');
    const result = await scopes.applyEffect(world, registry, address('a'), {
      kind: 'redact',
      expectedRev: 1,
      replacement: '[redacted]',
      writes: [
        { fieldId: 'customers.identity', match: 'subject-1' },
        { fieldId: 'customers.aliases', match: 'subject-1' },
        { fieldId: 'customers.parties', match: 'subject-1' },
        { fieldId: 'customers.payload', match: 'private text' },
      ],
    });
    expect(result).toEqual({ matched: 1, modified: 1 });
    const after = await stored('a');
    expect(after._rev).toBe(2);
    expect(after.data.identity).toEqual({ id: '[redacted]', email: 'keep@example.invalid' });
    expect(after.data.aliases).toEqual(['[redacted]', 'other-alias', 'alias-2']);
    expect(after.data.parties).toEqual([
      { principal: '[redacted]', role: 'sender' },
      { principal: 'someone-else', role: 'receiver' },
    ]);
    expect(after.data.payload).toBe('[redacted]');
    // The sibling elements and untouched fields are byte-identical.
    expect(bytes(after.data.parties[1]).equals(bytes(before.data.parties[1]))).toBe(true);
    expect(bytes(after.data.business).equals(bytes(before.data.business))).toBe(true);
    expect(after.access).toBe('open');
    expect(after.lifecycle).toBe('active');
  });

  it('tombstones with null and the lifecycle marker, and restricts by access only', async () => {
    await scopes.applyEffect(world, registry, address('a'), {
      kind: 'tombstone',
      expectedRev: 1,
      replacement: null,
      writes: [
        { fieldId: 'customers.aliases', match: 'subject-1' },
        { fieldId: 'customers.payload', match: 'private text' },
      ],
    });
    const tomb = await stored('a');
    expect(tomb).toMatchObject({ _rev: 2, lifecycle: 'tombstoned' });
    expect(tomb.data.aliases).toEqual([null, 'other-alias', 'alias-2']);
    expect(tomb.data.payload).toBeNull();

    const beforeRestrict = await stored('b');
    await scopes.applyEffect(world, registry, address('b'), { kind: 'restrict', expectedRev: 1 });
    const restricted = await stored('b');
    expect(restricted).toMatchObject({ _rev: 2, access: 'restricted' });
    expect(bytes(restricted.data).equals(bytes(beforeRestrict.data))).toBe(true);
  });

  it('deletes only the named record', async () => {
    await scopes.applyEffect(world, registry, address('a'), { kind: 'delete', expectedRev: 1 });
    expect(await env.service.world.collection('customers').countDocuments()).toBe(1);
    expect(await stored('b')).toMatchObject({ _rev: 1 });
  });

  it('refuses a stale target without writing', async () => {
    await env.service.world
      .collection<Document>('customers')
      .updateOne({ _id: 'a' as never }, { $inc: { _rev: 1 } });
    for (const effect of [
      { kind: 'delete' as const, expectedRev: 1 },
      { kind: 'restrict' as const, expectedRev: 1 },
      { kind: 'redact' as const, expectedRev: 1, replacement: 'x', writes: [] },
    ])
      await expect(scopes.applyEffect(world, registry, address('a'), effect), effect.kind).rejects.toThrow(
        'StaleTarget',
      );
    expect(await stored('a')).toMatchObject({ _rev: 2, access: 'open' });
    expect(await env.service.world.collection('customers').countDocuments()).toBe(2);
  });

  it('refuses a record of another world, a wrong replacement type and conflicting writes', async () => {
    const worlds = new WorldRepository(env.service);
    await worlds.create(scope, 'other', 1);
    const other = await worlds.bind(scope, 'other');
    await expect(
      scopes.applyEffect(other, registry, address('a'), { kind: 'delete', expectedRev: 1 }),
    ).rejects.toThrow('StaleTarget');
    await expect(
      scopes.applyEffect(world, registry, address('a'), {
        kind: 'redact',
        expectedRev: 1,
        replacement: null,
        writes: [],
      }),
    ).rejects.toThrow('InvalidReplacement');
    await expect(
      scopes.applyEffect(world, registry, address('a'), {
        kind: 'tombstone',
        expectedRev: 1,
        replacement: 'x',
        writes: [],
      }),
    ).rejects.toThrow('InvalidReplacement');
    await expect(
      scopes.applyEffect(world, registry, address('a'), {
        kind: 'redact',
        expectedRev: 1,
        replacement: 'x',
        writes: [
          { fieldId: 'customers.payload', match: 'private text' },
          { fieldId: 'customers.payload', match: 'private text' },
        ],
      }),
    ).rejects.toThrow('ConflictingWrites');
    await expect(
      scopes.applyEffect(world, registry, address('a'), {
        kind: 'redact',
        expectedRev: 1,
        replacement: 'x',
        writes: [{ fieldId: 'customers.not_registered', match: 'x' }],
      }),
    ).rejects.toThrow('UnknownFieldId');
    expect(await stored('a')).toMatchObject({ _rev: 1 });
  });

  it('refuses an effect through a key the repository did not issue and a principal without write rights', async () => {
    await expect(
      scopes.applyEffect({ ...world } as never, registry, address('a'), { kind: 'delete', expectedRev: 1 }),
    ).rejects.toThrow('InvalidWorldKey');
    const observer = new ScopeRepository(await env.as('observer'));
    await expect(
      observer.applyEffect(world, registry, address('a'), { kind: 'delete', expectedRev: 1 }),
    ).rejects.toThrow('PrincipalBoundary');
    await expect(observer.scan(world, registry, 'customers')).rejects.toThrow('PrincipalBoundary');
  });

  it('scans a registered collection in id order with bounded pages and reads one record', async () => {
    const first = await scopes.scan(world, registry, 'customers', { limit: 1 });
    expect(first.map((row) => row.address.recordId)).toEqual(['a']);
    const second = await scopes.scan(world, registry, 'customers', {
      afterId: first[0]!.document._id,
      limit: 5,
    });
    expect(second.map((row) => row.address.recordId)).toEqual(['b']);
    expect((await scopes.readRecord(world, registry, address('b')))?._rev).toBe(1);
    expect(await scopes.readRecord(world, registry, address('zzz'))).toBeNull();
    await expect(scopes.scan(world, registry, 'archives')).rejects.toThrow('UnauthorizedCollection');
    await expect(scopes.scan(world, registry, 'customers', { limit: 501 })).rejects.toThrow(
      'InvalidScanLimit',
    );
  });
});
