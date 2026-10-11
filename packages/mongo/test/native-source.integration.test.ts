/**
 * Native owner-source protocol tests on a LOCAL replica set (MONGODB_TEST_URI).
 *
 * LABEL: every record below is inserted by this test to exercise the protocol (top-level documents, mixed `_id`
 * types, a shared collection with another tenant, conditional effects, external-writer conflicts). They are local protocol
 * evidence over made-up records. They are NOT authentic owner data and NOT evidence about Atlas, Atlas RBAC or any real owner
 * database. The registration is the contract's `NativeSourceRegistration` (packages/contracts/src/source.ts).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BSON, Int32, type Collection, type Db, type Document } from 'mongodb';
import {
  NativeSourceAdapter,
  NativeSourceError,
  OwnerSourceRepository,
  SourceRevisionRepository,
  bindingKey,
  compileOwnerSource,
  nativeAddress,
  nativeId,
  nativeNodeKey,
  type NativeAddress,
  type NativeBinding,
  type NativeSourceRegistration,
} from '../src/index.js';
import { describeLive, openEnvironment, type LiveEnvironment } from './support.js';
import { BIG, DEAL_1, HASH, PERSON_OID, SCOPE, registrationFor } from './native-fixtures.js';

describeLive('native owner source on a local replica set (protocol evidence, made-up records)', () => {
  let env: LiveEnvironment;
  let dbA: Db;
  let dbB: Db;
  let nameA: string;
  let nameB: string;
  let registration: NativeSourceRegistration;
  let adapter: NativeSourceAdapter;
  let revisioned: NativeSourceAdapter;
  const dbOf = (database: string): Db => (database === nameA ? dbA : dbB);
  const coll = (name: string): Collection<Document> => (name === 'deals' ? dbB : dbA).collection(name);

  beforeAll(async () => {
    env = await openEnvironment('native');
    const suffix = randomUUID().replaceAll('-', '');
    nameA = `acme_${suffix}`;
    nameB = `acme_${suffix}_b`;
    dbA = env.service.client.db(nameA);
    dbB = env.service.client.db(nameB);
    registration = registrationFor(nameA, nameB);
    adapter = new NativeSourceAdapter(compileOwnerSource(registration), dbOf);
    revisioned = new NativeSourceAdapter(
      compileOwnerSource(registrationFor(nameA, nameB, { consistency: 'native_revision' })),
      dbOf,
    );
  }, 30_000);
  afterAll(async () => {
    if (dbA) await dbA.dropDatabase();
    if (dbB) await dbB.dropDatabase();
    if (env) await env.dispose();
  }, 30_000);
  beforeEach(async () => {
    await env.reset();
    for (const db of [dbA, dbB])
      for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray())
        await db.collection(name).deleteMany({});
    const t = { tenant: 'acme', rev: new Int32(1) };
    await coll('crm_people').insertMany([
      {
        _id: 'p-1' as never,
        ...t,
        contact: { email: 'a@x.test' },
        aliases: ['ann', 'annie'],
        notesText: 'private note',
        plan: 'gold',
      },
      {
        _id: 'p-2' as never,
        ...t,
        contact: { email: 'b@x.test' },
        aliases: ['bob'],
        notesText: 'other note',
      },
      { _id: PERSON_OID as never, ...t, contact: { email: 'c@x.test' }, aliases: [], notesText: 'oid note' },
      // Another tenant's record in the same collection: it must be invisible, whatever its identity.
      {
        _id: 'p-other' as never,
        tenant: 'globex',
        rev: new Int32(1),
        contact: { email: 'a@x.test' },
        aliases: ['ann'],
      },
    ]);
    await coll('billing_accounts').insertMany([
      {
        _id: 101 as never,
        ...t,
        rev: new Int32(3),
        customerRef: 'p-1',
        orgRef: new Int32(7),
        ownerEmail: 'a@x.test',
        invoiceTotal: 125.5,
        legalHold: false,
      },
      {
        _id: BIG as never,
        ...t,
        customerRef: 'p-2',
        orgRef: new Int32(7),
        ownerEmail: 'b@x.test',
        invoiceTotal: 9.25,
        legalHold: false,
      },
      {
        _id: 102 as never,
        ...t,
        customerRef: 'p-1',
        orgRef: new Int32(7),
        ownerEmail: 'a@x.test',
        invoiceTotal: 50,
        legalHold: true,
      },
    ]);
    await coll('orgs').insertOne({ _id: 7 as never, ...t, name: 'Shared Org' });
    await coll('deals').insertOne({
      _id: DEAL_1 as never,
      ...t,
      parties: [
        { principal: 'a@x.test', role: 'buyer' },
        { principal: 'z@y.test', role: 'seller' },
        { principal: 'a@x.test', role: 'approver' },
      ],
      personRef: 'p-1',
      addressRef: 'addr-1',
    });
    await coll('addresses').insertMany([
      { _id: 'addr-1' as never, ...t, holder: 'a@x.test', line1: '1 Main St' },
      { _id: 'addr-2' as never, ...t, holder: 'z@y.test', line1: '2 Side St' },
    ]);
    await coll('shipments').insertMany([
      { _id: 's-1' as never, ...t, personHex: PERSON_OID.toHexString(), sku: 'k1' },
      { _id: 's-2' as never, ...t, personHex: 'ffffffffffffffffffffffff', sku: 'k2' },
    ]);
  });

  const raw = async (name: string, id: unknown) =>
    coll(name).findOne({ _id: id as never }, { promoteValues: false, promoteLongs: false });
  const bytes = (v: unknown) => Buffer.from(BSON.serialize({ v } as Document)).toString('hex');
  const addr = (collectionId: string, id: unknown): NativeAddress => nativeAddress(collectionId, id);
  const mapOf = (bindings: NativeBinding[]) => new Map(bindings.map((b) => [b.key, b]));

  it('stores the contract registration insert-only per revision, hashed, and refuses an edited row', async () => {
    const builder = await env.as('fixture_builder');
    const executor = await env.as('domain_executor');
    const repo = new OwnerSourceRepository(builder);
    const row1 = await repo.register(registration);
    const row2 = await repo.register(registrationFor(nameA, nameB, { revision: 2 }));
    expect([row1.revision, row2.revision]).toEqual([1, 2]);
    expect(row1.registrationHash).not.toBe(row2.registrationHash);
    await expect(repo.register(registration)).rejects.toThrow('OwnerSourceRevisionConflict');
    await expect(repo.register(registrationFor(nameA, nameB, { revision: 5 }))).rejects.toThrow(
      'OwnerSourceRevisionConflict',
    );
    await expect(new OwnerSourceRepository(executor).register(registration)).rejects.toThrow(
      'PrincipalBoundary',
    );
    const read = await new OwnerSourceRepository(executor).read(SCOPE, 'acme-crm');
    expect(read.row.revision).toBe(2);
    expect(read.compiled.namespaces.get('billing')!.collection).toBe('billing_accounts');
    // Someone edits the stored body behind the repository: the hash catches it.
    await env.service.world
      .collection('owner_sources')
      .updateOne({ _id: row2._id as never }, { $set: { 'registration.limits.maxChanged': 99 } });
    await expect(new OwnerSourceRepository(executor).read(SCOPE, 'acme-crm')).rejects.toThrow(
      'OwnerSourceTampered',
    );
    expect((await new OwnerSourceRepository(executor).read(SCOPE, 'acme-crm', 1)).row.revision).toBe(1);
    // A registration the strict validators refuse is never stored.
    const bad = JSON.parse(JSON.stringify(registrationFor(nameA, nameB, { revision: 3 })));
    bad.namespaces[0].database = 'expunge_world';
    await expect(repo.register(bad)).rejects.toThrow('InvalidOwnerSource');
  });

  it('keeps every native _id type through address, read, hash and node key (string, ObjectId, int, long, UUID)', async () => {
    const samples: Array<[string, string, unknown, string]> = [
      ['people', 'crm_people', 'p-1', 'string'],
      ['people', 'crm_people', PERSON_OID, 'objectId'],
      ['billing', 'billing_accounts', 101, 'int'],
      ['billing', 'billing_accounts', BIG, 'long'],
      ['deals', 'deals', DEAL_1, 'uuid'],
    ];
    for (const [namespaceId, collection, id, type] of samples) {
      const document = await raw(collection, id);
      const address = addr(namespaceId, document!._id);
      expect(address.recordIdBsonType).toBe(type);
      expect(bytes(nativeId(address))).toBe(bytes(id));
      expect(nativeNodeKey(address)).toBe(nativeNodeKey({ ...address }));
      expect(await adapter.read(address)).not.toBeNull();
    }
    expect(bindingKey(new Int32(7))).toBe(bindingKey(7));
    expect(bindingKey('7')).not.toBe(bindingKey(7));
    expect(() =>
      nativeId({
        collectionId: 'deals',
        recordId: DEAL_1.toHexString(true).toUpperCase(),
        recordIdBsonType: 'uuid',
      }),
    ).toThrow();
    expect(await adapter.undeclaredIdCount('people')).toBe(0);
    await coll('crm_people').insertOne({
      _id: 12.5 as never,
      tenant: 'acme',
      contact: { email: 'odd@x.test' },
    });
    expect(await adapter.undeclaredIdCount('people')).toBe(1);
  });

  it('pages a collection with mixed _id types without skipping or repeating a document, and never shows another tenant', async () => {
    await coll('crm_people').insertMany(
      ['p-3', 'p-4', 'p-5'].map((id) => ({
        _id: id as never,
        tenant: 'acme',
        rev: new Int32(1),
        contact: { email: `${id}@x.test` },
        aliases: [],
      })),
    );
    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof adapter.scanPage>>['next'];
    let pages = 0;
    do {
      const page = await adapter.scanPage('people', cursor, 2);
      seen.push(...page.records.map((r) => `${r.address.recordIdBsonType}:${r.address.recordId}`));
      cursor = page.next;
      pages++;
    } while (cursor);
    expect(seen.sort()).toEqual(
      [
        'objectId:507f1f77bcf86cd799439011',
        'string:p-1',
        'string:p-2',
        'string:p-3',
        'string:p-4',
        'string:p-5',
      ].sort(),
    );
    expect(pages).toBeGreaterThan(2);
    expect(await adapter.scanAll('billing')).toHaveLength(3);
    expect(await adapter.read(addr('people', 'p-other'))).toBeNull();
  });

  it('resolves the subject by one exact identity inside the tenant and refuses zero or several matches', async () => {
    const subject = await adapter.resolveSubject('people.email', 'a@x.test');
    expect(subject.address).toEqual({ collectionId: 'people', recordId: 'p-1', recordIdBsonType: 'string' });
    expect(subject.bindings.map((b) => b.key).sort()).toEqual(['s:a@x.test', 's:ann', 's:annie', 's:p-1']);
    await expect(adapter.resolveSubject('people.email', 'nobody@x.test')).rejects.toThrow('SubjectNotFound');
    await coll('crm_people').insertOne({
      _id: 'p-dup' as never,
      tenant: 'acme',
      contact: { email: 'a@x.test' },
      aliases: [],
    });
    await expect(adapter.resolveSubject('people.email', 'a@x.test')).rejects.toThrow('SubjectAmbiguous');
    await expect(adapter.resolveSubject('people.email', 'A@X.TEST')).rejects.toThrow('SubjectNotFound');
    await expect(adapter.resolveSubject('billing.ownerEmail', 'a@x.test')).rejects.toThrow(
      'NotAnIdentityField',
    );
  });

  it('DG1: discovery follows ownership only and never walks through a shared record to another subject', async () => {
    const closure = await adapter.ownedClosure(addr('people', 'p-1'), { maxDepth: 4 });
    const owned = closure.records.map((r) => `${r.address.collectionId}:${r.address.recordId}`).sort();
    expect(owned).toEqual(
      [
        'people:p-1',
        'billing:101',
        'billing:102',
        `deals:${DEAL_1.toHexString(true)}`,
        'addresses:addr-1',
      ].sort(),
    );
    expect(owned).not.toContain('orgs:7');
    expect(owned).not.toContain('billing:5000000000');
    expect(owned).not.toContain('addresses:addr-2');
    expect(closure.truncated).toBe(false);
    const viaHex = await adapter.ownedClosure(addr('people', PERSON_OID), { maxDepth: 2 });
    expect(viaHex.records.map((r) => r.address.recordId)).toContain('s-1');
    expect(viaHex.records.map((r) => r.address.recordId)).not.toContain('s-2');
    expect((await adapter.ownedClosure(addr('people', 'p-1'), { maxDepth: 1 })).truncated).toBe(true);
    expect(
      (await adapter.ownedClosure(addr('people', 'p-1'), { maxDepth: 4, maxRecords: 2 })).truncated,
    ).toBe(true);
  });

  it('redacts only the subject elements of a mixed array, in a second database, with an exact read-back', async () => {
    const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
    const address = addr('deals', DEAL_1);
    const before = (await adapter.preimage(address))!;
    const effect = adapter.planEffect('deals', before.document, 'redact', bindings);
    expect(effect.kind === 'redact' && effect.writes.map((w) => w.fieldId).sort()).toEqual([
      'deals.personRef',
      'deals.principal',
    ]);
    const applied = await adapter.applyEffect(address, effect, before.hash);
    expect(applied).toMatchObject({
      kind: 'redact',
      ruleId: 'deals-redact',
      readback: 'verified',
      replayed: false,
      consistency: 'conditional_preimage',
    });
    const after = (await raw('deals', DEAL_1))!;
    const parties = after.parties as Array<Record<string, unknown>>;
    expect(parties.map((p) => p.principal)).toEqual(['[redacted]', 'z@y.test', '[redacted]']);
    expect(parties.map((p) => p.role)).toEqual(['buyer', 'seller', 'approver']);
    expect(after.addressRef).toBe('addr-1');
    expect(after.personRef).toBe('[redacted]');
    expect(applied.postHash).toBe((await adapter.preimage(address))!.hash);
  });

  it('keeps retained fields, treats a legal-hold condition as retention, and the owner revision is guarded not bumped', async () => {
    const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
    const a101 = addr('billing', 101);
    const pre = (await adapter.preimage(a101))!;
    const applied = await revisioned.applyEffect(
      a101,
      revisioned.planEffect('billing', pre.document, 'redact', bindings),
      pre.hash,
    );
    expect(applied).toMatchObject({
      consistency: 'native_revision',
      preRevision: 'n:3',
      postRevision: 'n:3',
      readback: 'verified',
    });
    const after = (await raw('billing_accounts', 101))!;
    expect(after.customerRef).toBe('[redacted]');
    expect(after.ownerEmail).toBe('[redacted]');
    expect(bytes(after.invoiceTotal)).toBe(bytes(pre.document.invoiceTotal));
    expect(bytes(after.orgRef)).toBe(bytes(pre.document.orgRef));
    expect(after.rev).toEqual(new Int32(3));
    // No delete rule on billing at all.
    const a5 = addr('billing', BIG);
    const pre5 = (await adapter.preimage(a5))!;
    await expect(adapter.applyEffect(a5, { kind: 'delete' }, pre5.hash)).rejects.toMatchObject({
      code: 'EffectNotAllowed',
    });
    expect(await raw('billing_accounts', BIG)).not.toBeNull();
    // The legal-hold document is not selected by any rule: retained whatever effect is asked.
    const a102 = addr('billing', 102);
    const pre102 = (await adapter.preimage(a102))!;
    expect(adapter.assess('billing', pre102.document, 'redact')).toMatchObject({
      ok: false,
      reason: 'rule_conditions_unmet',
    });
    await expect(
      adapter.applyEffect(
        a102,
        { kind: 'redact', writes: [{ fieldId: 'billing.customerRef', match: 'p-1' }] },
        pre102.hash,
      ),
    ).rejects.toMatchObject({ code: 'RetentionHold' });
    expect(bytes(await raw('billing_accounts', 102))).toBe(bytes(pre102.document));
    // A hand-assembled write naming a retained field is outside the rule.
    await expect(
      adapter.applyEffect(
        a5,
        { kind: 'redact', writes: [{ fieldId: 'billing.invoiceTotal', match: 9.25 }] },
        pre5.hash,
      ),
    ).rejects.toMatchObject({ code: 'FieldNotInRule' });
  });

  it('tombstone nulls the exact values; restrict sets the rule field; delete removes and reads back absent', async () => {
    const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
    const p1 = addr('people', 'p-1');
    const pre = (await adapter.preimage(p1))!;
    await adapter.applyEffect(
      p1,
      adapter.planEffect('people', pre.document, 'tombstone', bindings),
      pre.hash,
    );
    const after = (await raw('crm_people', 'p-1'))!;
    expect((after.contact as Document).email).toBeNull();
    expect(after.aliases).toEqual([null, null]);
    expect(after.notesText).toBeNull();
    expect(after.plan).toBe('gold');
    const p2 = addr('people', 'p-2');
    const pre2 = (await adapter.preimage(p2))!;
    await adapter.applyEffect(p2, { kind: 'restrict' }, pre2.hash);
    expect((await raw('crm_people', 'p-2'))!.access).toBe('restricted');
    const ad = addr('addresses', 'addr-1');
    const preA = (await adapter.preimage(ad))!;
    expect(await adapter.applyEffect(ad, { kind: 'delete' }, preA.hash)).toMatchObject({
      postHash: null,
      readback: 'verified',
    });
    expect(await raw('addresses', 'addr-1')).toBeNull();
    expect(await raw('addresses', 'addr-2')).not.toBeNull();
  });

  it('never touches another tenant: the same _id or identity in globex is invisible to every operation', async () => {
    await coll('crm_people').insertOne({
      _id: 'p-9' as never,
      tenant: 'globex',
      rev: new Int32(1),
      contact: { email: 'g@x.test' },
      aliases: [],
    });
    expect(await adapter.read(addr('people', 'p-9'))).toBeNull();
    const pre = (await adapter.preimage(addr('people', 'p-other')).catch(() => null)) ?? null;
    expect(pre).toBeNull();
    await expect(
      adapter.applyEffect(addr('people', 'p-other'), { kind: 'delete' }, HASH),
    ).rejects.toMatchObject({ code: 'SourceConflict' });
    expect(await raw('crm_people', 'p-other')).not.toBeNull();
  });

  describe('external writer', () => {
    /** An adapter whose collection `name` runs `hook` (once) before its `method` call number `nth`. */
    function racing(
      name: string,
      method: 'findOne' | 'updateOne',
      nth: number,
      hook: () => Promise<void>,
    ): NativeSourceAdapter {
      let calls = 0;
      const wrap = (db: Db): Db =>
        new Proxy(db, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop !== 'collection') return typeof value === 'function' ? value.bind(target) : value;
            return (collectionName: string, options?: never) => {
              const real = target.collection(collectionName, options);
              if (collectionName !== name) return real;
              return new Proxy(real, {
                get(t, p) {
                  const v = Reflect.get(t, p, t);
                  if (p !== method) return typeof v === 'function' ? v.bind(t) : v;
                  return async (...args: unknown[]) => {
                    calls++;
                    if (calls === nth) await hook();
                    return (v as (...a: unknown[]) => unknown).apply(t, args);
                  };
                },
              });
            };
          },
        });
      return new NativeSourceAdapter(compileOwnerSource(registration), (database) => wrap(dbOf(database)));
    }

    it('a change between preview and apply refuses and re-previews; the external value survives', async () => {
      const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
      const address = addr('deals', DEAL_1);
      const preview = (await adapter.preimage(address))!;
      const effect = adapter.planEffect('deals', preview.document, 'redact', bindings);
      await coll('deals').updateOne({ _id: DEAL_1 as never }, {
        $push: { parties: { principal: 'a@x.test', role: 'observer' } },
      } as never);
      await expect(adapter.applyEffect(address, effect, preview.hash)).rejects.toMatchObject({
        code: 'SourceConflict',
        detail: { reason: 'preimage_changed' },
      });
      expect(((await raw('deals', DEAL_1))!.parties as unknown[]).length).toBe(4);
      expect(((await raw('deals', DEAL_1))!.parties as Array<Document>)[0]!.principal).toBe('a@x.test');
      const again = (await adapter.preimage(address))!;
      await adapter.applyEffect(
        address,
        adapter.planEffect('deals', again.document, 'redact', bindings),
        again.hash,
      );
      const parties = (await raw('deals', DEAL_1))!.parties as Array<Document>;
      expect(parties.filter((p) => p.principal === '[redacted]')).toHaveLength(3);
    });

    it('a change inside the read/write window is caught by the conditional filter and never overwritten', async () => {
      const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
      const address = addr('deals', DEAL_1);
      const preview = (await adapter.preimage(address))!;
      const effect = adapter.planEffect('deals', preview.document, 'redact', bindings);
      const racer = racing('deals', 'updateOne', 1, async () => {
        await coll('deals').updateOne({ _id: DEAL_1 as never }, { $set: { stage: 'external-edit' } });
      });
      await expect(racer.applyEffect(address, effect, preview.hash)).rejects.toMatchObject({
        code: 'SourceConflict',
        detail: { reason: 'changed_since_preview' },
      });
      const stored = (await raw('deals', DEAL_1))!;
      expect(stored.stage).toBe('external-edit');
      expect((stored.parties as Array<Document>)[0]!.principal).toBe('a@x.test');
    });

    it('an external delete is a conflict, not a silent success', async () => {
      const address = addr('addresses', 'addr-1');
      const pre = (await adapter.preimage(address))!;
      await coll('addresses').deleteOne({ _id: 'addr-1' as never });
      await expect(adapter.applyEffect(address, { kind: 'delete' }, pre.hash)).rejects.toMatchObject({
        code: 'SourceConflict',
        detail: { reason: 'absent' },
      });
    });

    it('native_revision: an owner write that moves the revision blocks the effect', async () => {
      const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
      const address = addr('billing', 101);
      const pre = (await revisioned.preimage(address))!;
      const effect = revisioned.planEffect('billing', pre.document, 'redact', bindings);
      await coll('billing_accounts').updateOne(
        { _id: 101 as never },
        { $set: { ownerEmail: 'a2@x.test' }, $inc: { rev: 1 } },
      );
      await expect(revisioned.applyEffect(address, effect, pre.hash)).rejects.toMatchObject({
        code: 'SourceConflict',
      });
      expect((await raw('billing_accounts', 101))!.ownerEmail).toBe('a2@x.test');
    });

    it('a write that landed inside the call returns replayed, not a second write', async () => {
      const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
      const address = addr('addresses', 'addr-1');
      const pre = (await adapter.preimage(address))!;
      const effect = adapter.planEffect('addresses', pre.document, 'redact', bindings);
      const racer = racing('addresses', 'updateOne', 1, async () => {
        await coll('addresses').updateOne({ _id: 'addr-1' as never }, { $set: { holder: '[redacted]' } });
      });
      const result = await racer.applyEffect(address, effect, pre.hash);
      expect(result.replayed).toBe(true);
      expect((await raw('addresses', 'addr-1'))!.holder).toBe('[redacted]');
    });

    it('a change between the write and the read-back is ReadbackMismatch with the diverged key named', async () => {
      const bindings = mapOf((await adapter.resolveSubject('people.email', 'a@x.test')).bindings);
      const address = addr('addresses', 'addr-1');
      const pre = (await adapter.preimage(address))!;
      const effect = adapter.planEffect('addresses', pre.document, 'redact', bindings);
      const racer = racing('addresses', 'findOne', 2, async () => {
        await coll('addresses').updateOne({ _id: 'addr-1' as never }, { $set: { line1: 'moved' } });
      });
      const error = await racer.applyEffect(address, effect, pre.hash).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NativeSourceError);
      expect(error).toMatchObject({
        code: 'ReadbackMismatch',
        detail: { reason: 'differs', divergedKeys: ['line1'] },
      });
    });
  });

  it('residuals: after the owned records are handled only the legal-hold holder remains, reported as retained', async () => {
    const subject = await adapter.resolveSubject('people.email', 'a@x.test');
    const bindings = mapOf(subject.bindings);
    const closure = await adapter.ownedClosure(subject.address, { maxDepth: 4 });
    expect((await adapter.residuals(bindings)).residuals.length).toBeGreaterThan(0);
    for (const record of closure.records) {
      if (record.address.collectionId === 'people') continue;
      const pre = (await adapter.preimage(record.address))!;
      if (!adapter.assess(record.address.collectionId, pre.document, 'redact').ok) continue;
      await adapter.applyEffect(
        record.address,
        adapter.planEffect(record.address.collectionId, pre.document, 'redact', bindings),
        pre.hash,
      );
    }
    const p1 = (await adapter.preimage(subject.address))!;
    await adapter.applyEffect(
      subject.address,
      adapter.planEffect('people', p1.document, 'redact', bindings),
      p1.hash,
    );
    const left = await adapter.residuals(bindings);
    expect(
      left.residuals.map((r) => `${r.address.collectionId}:${r.address.recordId}:${r.retained}`).sort(),
    ).toEqual(['billing:102:true', 'billing:102:true']);
    expect(left.truncated).toBe(false);
  });

  it('the observed revision follows the change streams of both databases: external writes advance it, nothing is consumed twice', async () => {
    const executor = await env.as('domain_executor');
    const revisions = new SourceRevisionRepository(executor);
    const watched = new NativeSourceAdapter(compileOwnerSource(registration), (database) =>
      executor.client.db(database),
    );
    const first = await revisions.observe(SCOPE, watched, { quietMs: 100 });
    expect(first).toMatchObject({ observedSeq: 0, epoch: 1, consumed: 0 });
    const planned = { observedSeq: first.observedSeq, epoch: first.epoch };
    expect(await revisions.moved(SCOPE, 'acme-crm', planned)).toBe(false);
    await coll('crm_people').insertOne({
      _id: 'p-9' as never,
      tenant: 'acme',
      contact: { email: 'n@x.test' },
      aliases: [],
    });
    await coll('crm_people').updateOne({ _id: 'p-9' as never }, { $set: { plan: 'free' } });
    await coll('deals').updateOne({ _id: DEAL_1 as never }, { $set: { stage: 'x' } });
    await dbA.collection('unregistered').insertOne({ x: 1 });
    // Another tenant's change in a shared registered collection is not part of this source's revision.
    await coll('crm_people').updateOne({ _id: 'p-other' as never }, { $set: { plan: 'x' } });
    const second = await revisions.observe(SCOPE, watched, { quietMs: 300 });
    expect(second.consumed).toBe(3);
    expect(second.observedSeq).toBe(3);
    expect(await revisions.moved(SCOPE, 'acme-crm', planned)).toBe(true);
    const third = await revisions.observe(SCOPE, watched, { quietMs: 100 });
    expect(third).toMatchObject({ consumed: 0, observedSeq: 3, epoch: 1 });
    await coll('shipments').drop();
    const fourth = await revisions.observe(SCOPE, watched, { quietMs: 300 });
    expect(fourth.historyLost).toBe(true);
    expect(fourth.epoch).toBe(2);
  });
});
