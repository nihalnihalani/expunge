import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Double, Long, ObjectId, type Document } from 'mongodb';
import type { ActionIntent, DomainAddress, FieldDescriptor } from '@expunge/contracts';
import {
  ArtifactRepository,
  CandidateRepository,
  EffectRepository,
  JobRepository,
  ScopeRepository,
  WorldRepository,
  compileWritePlan,
  deriveArgsDigest,
  deriveEffectKey,
  typedAddress,
  type MongoService,
} from '../src/index.js';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import {
  HASH,
  actor,
  completionReceipt,
  createJob,
  describeLive,
  insertRegistry,
  intent,
  openEnvironment,
  proposalOf,
  recordDecisionFor,
  registryOf,
  type LiveEnvironment,
} from './support.js';

/**
 * One regression test (or more) per finding of the devils-advocate live repro, run against the real local
 * replica set. Each names the finding it closes. See also hardening.test.ts for the checks that need no database.
 */
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const string = (collectionId: string, recordId: string): DomainAddress => ({
  collectionId,
  recordId,
  recordIdBsonType: 'string',
});
const field = (
  fieldId: string,
  path: string[],
  overrides: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({
  fieldId,
  collectionId: 'customers',
  path,
  bsonTypes: ['string'],
  isArray: path.includes('*'),
  sanitized: true,
  ...overrides,
});

describeLive('hardening regressions (real replica set)', () => {
  let env: LiveEnvironment;
  let executor: MongoService;
  let jobs: JobRepository;
  let effects: EffectRepository;
  let scopes: ScopeRepository;

  beforeAll(async () => {
    env = await openEnvironment('hardening');
    executor = await env.as('domain_executor');
    jobs = new JobRepository(executor);
    effects = new EffectRepository(executor);
    scopes = new ScopeRepository(executor);
  }, 30000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  const jobDoc = async (id: string) =>
    (await jobs.readAuthorized(actor, id)) as Awaited<ReturnType<typeof jobs.readAuthorized>>;
  const customers = () => env.service.world.collection<Document>('customers');
  /** Inside an effect transaction the session belongs to the executor's client, so its collections must too. */
  const txCustomers = () => executor.world.collection<Document>('customers');
  const claim = async (id: string, owner = 'worker', ms = 10000) => {
    const job = (await jobs.claim(actor, id, owner, ms))!;
    return { jobId: id, ownerId: owner, fence: job.lease.fence };
  };
  async function seedWorld(worldId: string, docs: Document[]) {
    await customers().deleteMany({});
    await customers().insertMany(docs.map((doc) => ({ ...scope, worldId, _rev: 1, ...doc })) as never[]);
  }

  describe('L1: a cleanup job succeeds only through a committed completion receipt, by its own principal', () => {
    it('refuses finish(succeeded) with no completion receipt, however outputRefs is filled in', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await expect(jobs.finish(actor, lease, 'succeeded', ['fabricated'])).rejects.toThrow(
        'CompletionReceiptRequired',
      );
      await expect(jobs.finish(actor, lease, 'succeeded', [])).rejects.toThrow('CompletionReceiptRequired');
      // A receipt row that is not bound to this job, or not complete, does not count.
      const other = completionReceipt('some-other-job', { receiptId: 'foreign' });
      await env.service.control
        .collection<Document>('completion_receipts')
        .insertOne({ _id: 'foreign', ...other, actor, createdAt: new Date() } as never);
      await env.service.control.collection<Document>('completion_receipts').insertOne({
        _id: 'partial',
        ...completionReceipt(id, { receiptId: 'partial', domainStatus: 'incomplete' }),
        actor,
        createdAt: new Date(),
      } as never);
      await expect(jobs.finish(actor, lease, 'succeeded', ['foreign', 'partial'])).rejects.toThrow(
        'CompletionReceiptRequired',
      );
      expect((await jobDoc(id)).status).toBe('running');
    });

    it('succeeds through EffectRepository.complete, which writes the receipt and the state together', async () => {
      const id = await createJob(env.service);
      await insertRegistry(env.service);
      const lease = await claim(id);
      const receipt = completionReceipt(id);
      expect(await effects.complete(actor, lease, receipt)).toEqual(receipt);
      expect(await jobDoc(id)).toMatchObject({ status: 'succeeded', outputRefs: [receipt.receiptId] });
      // The same receipt can be replayed after the fact without a lease.
      expect(await effects.complete(actor, { ...lease, fence: 0 }, receipt)).toEqual(receipt);
    });

    it('lets a failed or cancelled end state through without a receipt', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await jobs.finish(actor, lease, 'failed', []);
      expect((await jobDoc(id)).status).toBe('failed');
    });

    it('refuses a principal that is not a worker for the job kind, even holding the owner and fence', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      for (const principal of [
        'grader',
        'observer',
        'promoter',
        'privacy_controller',
        'fixture_builder',
      ] as const) {
        const other = new JobRepository(await env.as(principal));
        await expect(other.claim(actor, id, 'intruder', 10000), `${principal} claim`).rejects.toThrow(
          'PrincipalBoundary',
        );
        await expect(other.renew(actor, lease), `${principal} renew`).rejects.toThrow('PrincipalBoundary');
        await expect(other.checkpoint(actor, lease, { x: 1 }), `${principal} checkpoint`).rejects.toThrow(
          'PrincipalBoundary',
        );
        await expect(other.finish(actor, lease, 'succeeded', []), `${principal} finish`).rejects.toThrow(
          'PrincipalBoundary',
        );
        await expect(other.recordContextInputs(actor, lease, ['x']), `${principal} context`).rejects.toThrow(
          'PrincipalBoundary',
        );
      }
      expect((await jobDoc(id)).status).toBe('running');
    });

    it('gives each kind its own worker principal', async () => {
      await new WorldRepository(env.service).create(scope, 'w', 1);
      const observe = await new JobRepository(env.service).create(actor, {
        kind: 'observe',
        binding: { runId: 'r', worldId: 'w', harnessHash: HASH, scopeRevision: 1, workerProfileHash: HASH },
      });
      const observer = new JobRepository(await env.as('observer'));
      expect((await observer.claim(actor, observe._id, 'obs', 10000))?.status).toBe('running');
      await expect(jobs.claim(actor, observe._id, 'wrong', 10000)).rejects.toThrow('PrincipalBoundary');
    });
  });

  describe('L2: a completion receipt must cover exactly what the bound registry declares', () => {
    const fields = [
      field('customers.handle', ['data', 'handle']),
      field('customers.aliases', ['data', 'aliases', '*']),
    ];
    const covering = {
      inspectedCollectionIds: ['customers'],
      discoveredFieldIds: ['customers.handle', 'customers.aliases'],
    };
    async function attempt(overrides: Parameters<typeof completionReceipt>[1]) {
      const id = await createJob(env.service);
      const lease = await claim(id);
      return { id, run: () => effects.complete(actor, lease, completionReceipt(id, overrides)) };
    }
    beforeEach(async () => {
      await insertRegistry(env.service, { fields });
    });

    it('rejects empty coverage, partial coverage and coverage of things the registry does not declare', async () => {
      const bad: Array<[string, Parameters<typeof completionReceipt>[1]]> = [
        ['empty', { inspectedCollectionIds: [], discoveredFieldIds: [] }],
        ['collections only', { ...covering, discoveredFieldIds: [] }],
        ['missing a field', { ...covering, discoveredFieldIds: ['customers.handle'] }],
        [
          'unregistered field',
          { ...covering, discoveredFieldIds: [...covering.discoveredFieldIds, 'customers.ssn'] },
        ],
        ['unregistered collection', { ...covering, inspectedCollectionIds: ['customers', 'archives'] }],
        ['duplicate ids', { ...covering, discoveredFieldIds: ['customers.handle', 'customers.handle'] }],
        ['dropped limitation', { ...covering, limitations: [] }],
      ];
      for (const [label, overrides] of bad) {
        const { id, run } = await attempt(overrides);
        await expect(run(), label).rejects.toThrow('IncompleteReceipt');
        expect((await jobDoc(id)).status, label).toBe('running');
      }
      expect(await env.service.control.collection('completion_receipts').countDocuments()).toBe(0);
    });

    it('accepts exact coverage with the declared limitations', async () => {
      const { id, run } = await attempt(covering);
      await run();
      expect((await jobDoc(id)).status).toBe('succeeded');
    });

    it('requires limitations for a registry that declares partial discovery', async () => {
      await env.service.world
        .collection('schema_registry')
        .updateOne(
          { revision: 1 },
          { $set: { 'discoveryCompleteness.kind': 'partial', 'discoveryCompleteness.limitations': [] } },
        );
      const { run } = await attempt({ ...covering, limitations: [] });
      await expect(run()).rejects.toThrow('IncompleteReceipt');
    });

    it('fails closed when the bound registry revision does not exist', async () => {
      await env.service.world.collection('schema_registry').deleteMany({});
      const { run } = await attempt(covering);
      await expect(run()).rejects.toThrow('ScopeNotFound');
    });
  });

  describe('L3: cancellation reaches a terminal state for jobs nobody is running', () => {
    const jobStatus = async (id: string) => (await jobDoc(id)).status;
    it('cancels a queued job and refuses to claim it', async () => {
      const id = await createJob(env.service);
      await jobs.cancel(actor, id);
      expect(await jobStatus(id)).toBe('cancelled');
      expect(await jobs.claim(actor, id, 'late', 10000)).toBeNull();
    });

    it('cancels a running job whose lease expired and fences out the old holder', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id, 'worker', 150);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await jobs.cancel(actor, id);
      const after = await jobDoc(id);
      expect(after.status).toBe('cancelled');
      expect(after.lease.fence).toBe(lease.fence + 1);
      await expect(jobs.renew(actor, lease)).rejects.toThrow('LostLease');
      await expect(jobs.finish(actor, lease, 'failed', [])).rejects.toThrow('LostLease');
      expect(await jobs.claim(actor, id, 'late', 10000)).toBeNull();
    });

    it('leaves a live lease to its owner, who observes the flag and ends the job', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await jobs.cancel(actor, id);
      expect(await jobDoc(id)).toMatchObject({ status: 'running', cancellationRequested: true });
      await jobs.finish(actor, lease, 'cancelled', []);
      expect(await jobStatus(id)).toBe('cancelled');
    });

    it('cancels a job that yielded to a dependency', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await jobs.yield(actor, lease, 'waiting_approval');
      await jobs.cancel(actor, id);
      expect(await jobStatus(id)).toBe('cancelled');
    });

    it('settles a flagged job with an expired lease the next time anyone tries to claim it', async () => {
      const id = await createJob(env.service);
      await claim(id, 'worker', 150);
      await env.service.control
        .collection<Document>('jobs')
        .updateOne({ _id: id as never }, { $set: { cancellationRequested: true } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await jobs.claim(actor, id, 'other', 10000)).toBeNull();
      expect(await jobStatus(id)).toBe('cancelled');
    });

    it('never rewrites a terminal job', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await jobs.finish(actor, lease, 'failed', []);
      await jobs.cancel(actor, id);
      expect(await jobDoc(id)).toMatchObject({ status: 'failed', cancellationRequested: false });
    });
  });

  describe('L6: an effect may only touch the targets its intent names', () => {
    const A = string('customers', 'A');
    const B = string('customers', 'B');
    async function run(options: {
      targets: DomainAddress[];
      apply: NonNullable<Parameters<EffectRepository['commitEffect']>[0]>['apply'];
      tamper?: (intent: ActionIntent) => ActionIntent;
    }) {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await seedWorld(`world-${id}`, [{ _id: 'A' }, { _id: 'B' }]);
      const base = intent(id, { targets: options.targets });
      await recordDecisionFor(env.service, base);
      return effects.commitEffect({
        actor,
        lease,
        intent: options.tamper ? options.tamper(base) : base,
        apply: options.apply,
      });
    }
    const deleted = (address: DomainAddress) => ({
      address,
      kind: 'delete' as const,
      preHash: HASH,
      postHash: null,
      preVersion: 1,
      postVersion: null,
    });

    it('rejects and rolls back an effect on a record outside the targets', async () => {
      await expect(
        run({
          targets: [A],
          apply: async (session) => {
            await txCustomers().deleteOne({ _id: 'B' as never }, { session });
            return [deleted(B)];
          },
        }),
      ).rejects.toThrow('EffectOutsideTargets');
      expect(await customers().countDocuments({ _id: { $in: ['A', 'B'] } as never })).toBe(2);
      expect(await env.service.control.collection('effects').countDocuments()).toBe(0);
    });

    it('rejects a wrong effect kind and a repeated address', async () => {
      await expect(
        run({ targets: [A], apply: async () => [{ ...deleted(A), kind: 'redact' as const }] }),
      ).rejects.toThrow('EffectOutsideTargets');
      await expect(run({ targets: [A, B], apply: async () => [deleted(A), deleted(A)] })).rejects.toThrow(
        'EffectOutsideTargets',
      );
    });

    it('rejects an intent whose target hash does not describe its target list', async () => {
      await expect(
        run({ targets: [A], apply: async () => [], tamper: (i) => ({ ...i, targetHash: HASH }) }),
      ).rejects.toThrow('TargetHashMismatch');
    });

    it('commits an effect on exactly the named target', async () => {
      const receipt = await run({
        targets: [A],
        apply: async (session) => {
          await txCustomers().deleteOne({ _id: 'A' as never }, { session });
          return [deleted(A)];
        },
      });
      expect(receipt.appliedEffects).toHaveLength(1);
      expect(await customers().countDocuments({ _id: 'A' as never })).toBe(0);
      expect(await customers().countDocuments({ _id: 'B' as never })).toBe(1);
    });
  });

  describe('L7: the logical effect identity is derived, not supplied', () => {
    const C = string('customers', 'C');
    const D = string('customers', 'D');
    it('rejects an effect key or argument digest the caller made up', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      const honest = intent(id, { targets: [C] });
      await recordDecisionFor(env.service, honest);
      await expect(
        effects.commitEffect({
          actor,
          lease,
          intent: { ...honest, effectKey: `${id}:toolcall-1` },
          apply: async () => [],
        }),
      ).rejects.toThrow('EffectKeyMismatch');
      await expect(
        effects.commitEffect({
          actor,
          lease,
          intent: { ...honest, argsDigest: HASH },
          apply: async () => [],
        }),
      ).rejects.toThrow('EffectKeyMismatch');
      expect(await env.service.control.collection('effects').countDocuments()).toBe(0);
    });

    it('commits one batch once, however many tool calls and world revisions retry it', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await seedWorld(`world-${id}`, [{ _id: 'C', applied: 0 }]);
      let applied = 0;
      const apply = async (
        session: Parameters<NonNullable<Parameters<EffectRepository['commitEffect']>[0]['apply']>>[0],
      ) => {
        applied += 1;
        await txCustomers().updateOne({ _id: 'C' as never }, { $inc: { applied: 1 } }, { session });
        return [];
      };
      const firstIntent = intent(id, { targets: [C], toolCallId: 'call-1' });
      const retryIntent = intent(id, { targets: [C], toolCallId: 'call-2', worldRevision: 1 });
      await recordDecisionFor(env.service, firstIntent);
      await recordDecisionFor(env.service, retryIntent);
      const first = await effects.commitEffect({ actor, lease, intent: firstIntent, apply });
      const retry = await effects.commitEffect({ actor, lease, intent: retryIntent, apply });
      expect(retry).toEqual(first);
      expect(applied).toBe(1);
      expect(await customers().findOne({ _id: 'C' as never })).toHaveProperty('applied', 1);
    });

    it('treats a different batch ordinal as a different effect and a different target set as a conflict', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      const first = intent(id, { targets: [C], batchOrdinal: 0 });
      const second = intent(id, { targets: [C], batchOrdinal: 1, worldRevision: 1 });
      expect(deriveEffectKey(first)).not.toBe(deriveEffectKey(second));
      await recordDecisionFor(env.service, first);
      await recordDecisionFor(env.service, second);
      await effects.commitEffect({ actor, lease, intent: first, apply: async () => [] });
      await effects.commitEffect({ actor, lease, intent: second, apply: async () => [] });
      const conflicting = intent(id, { targets: [D], batchOrdinal: 0, worldRevision: 2 });
      expect(deriveEffectKey(conflicting)).toBe(deriveEffectKey(first));
      expect(deriveArgsDigest(conflicting)).not.toBe(deriveArgsDigest(first));
      await recordDecisionFor(env.service, conflicting);
      await expect(
        effects.commitEffect({ actor, lease, intent: conflicting, apply: async () => [] }),
      ).rejects.toThrow('IdempotencyConflict');
    });
  });

  describe('L8: record identities keep their BSON type through reads', () => {
    const handle = field('customers.handle', ['data', 'handle']);
    const registry = () => registryOf({ fields: [handle] });
    const cases: Array<[string, unknown, DomainAddress['recordIdBsonType'], unknown]> = [
      ['string', 'record-1', 'string', 'record-1'],
      ['int32', 424242, 'int', 424242],
      ['negative int32', -17, 'int', -17],
      ['integral double', new Double(7), 'int', 7],
      ['int64', Long.fromString('9007199254740993'), 'long', '9007199254740993'],
      ['ObjectId', new ObjectId('507f1f77bcf86cd799439011'), 'objectId', '507f1f77bcf86cd799439011'],
    ];
    it.each(cases)('finds and writes a record with a %s _id', async (_label, id, type, expected) => {
      const worldId = 'world-ids';
      await customers().insertOne({ _id: id, ...scope, worldId, _rev: 1, data: { handle: 'h' } } as never);
      const found = await scopes.findByField(actor, worldId, registry(), 'customers.handle', 'h');
      expect(found).toEqual([{ collectionId: 'customers', recordId: expected, recordIdBsonType: type }]);
      const result = await scopes.writeField(actor, worldId, registry(), found[0]!, 'customers.handle', {
        match: 'h',
        mutation: { kind: 'replace', replacement: '[redacted]' },
      });
      expect(result).toEqual({ matched: 1, modified: 1 });
      expect((await customers().findOne({ _id: id } as never))?.data.handle).toBe('[redacted]');
    });
    it('never mistakes a stored double that is not an int32 for an address', () => {
      expect(() => typedAddress('customers', new Double(1.5))).toThrow('UnsupportedAddressType');
      expect(() => typedAddress('customers', new Double(2 ** 40))).toThrow('UnsupportedAddressType');
    });
  });

  describe('L9: a write never replaces an array through a path that does not declare it', () => {
    const worldId = 'world-arrays';
    const record = string('customers', 'arr');
    const write = (target: FieldDescriptor, match: string, kind: 'replace' | 'remove' = 'replace') =>
      scopes.writeField(actor, worldId, registryOf({ fields: [target] }), record, target.fieldId, {
        match,
        mutation: kind === 'replace' ? { kind, replacement: '[redacted]' } : { kind },
      });

    it('rejects a field whose isArray flag disagrees with its wildcard', async () => {
      for (const bad of [
        field('customers.flat', ['data', 'aliases'], { isArray: true }),
        field('customers.wild', ['data', 'aliases', '*'], { isArray: false }),
      ]) {
        await expect(insertRegistry(env.service, { fields: [bad] }), bad.fieldId).rejects.toThrow(
          'InvalidFieldRegistry',
        );
        expect(() => compileWritePlan(bad, { match: 'x', mutation: { kind: 'remove' } })).toThrow(
          'InvalidFieldRegistry',
        );
      }
    });

    it('refuses a scalar write when the stored value at a plain path is an array, leaving the array intact', async () => {
      await seedWorld(worldId, [{ _id: 'arr', data: { aliases: ['subject-alias', 'unrelated-alias'] } }]);
      const plain = field('customers.flat', ['data', 'aliases']);
      await expect(write(plain, 'subject-alias')).rejects.toThrow('ScalarWriteOnArray');
      await expect(write(plain, 'subject-alias', 'remove')).rejects.toThrow('ScalarWriteOnArray');
      expect((await customers().findOne({ _id: 'arr' as never }))?.data.aliases).toEqual([
        'subject-alias',
        'unrelated-alias',
      ]);
    });

    it('also refuses at the database: the generated filter cannot match an array even if the check were skipped', async () => {
      await seedWorld(worldId, [{ _id: 'arr', data: { aliases: ['subject-alias', 'unrelated-alias'] } }]);
      const plan = compileWritePlan(field('customers.flat', ['data', 'aliases']), {
        match: 'subject-alias',
        mutation: { kind: 'replace', replacement: '[redacted]' },
      });
      const result = await customers().updateOne({ _id: 'arr' as never, ...plan.filter }, plan.update);
      expect(result.matchedCount).toBe(0);
    });

    it('refuses undeclared array traversal, a non-array at a wildcard, and an array at a wildcard leaf', async () => {
      await seedWorld(worldId, [
        {
          _id: 'arr',
          data: {
            parties: [{ principal: 'p' }],
            scalar: 'not-an-array',
            nested: [{ tags: ['t1', 't2'] }],
          },
        },
      ]);
      await expect(write(field('customers.cross', ['data', 'parties', 'principal']), 'p')).rejects.toThrow(
        'UndeclaredArrayTraversal',
      );
      await expect(write(field('customers.scalar', ['data', 'scalar', '*']), 'x')).rejects.toThrow(
        'ExpectedArray',
      );
      await expect(write(field('customers.tags', ['data', 'nested', '*', 'tags']), 't1')).rejects.toThrow(
        'ScalarWriteOnArray',
      );
    });
  });

  describe('L10: envelope fields can never be registered or written', () => {
    const envelope = ['tenantId', 'env', 'worldId', 'scopeId', '_rev', 'eligibility', 'access', 'lifecycle'];
    it('refuses every envelope path at registry insert, for the fixture builder and the setup principal', async () => {
      for (const root of envelope) {
        for (const path of [[root], [root, 'x']]) {
          await expect(
            insertRegistry(env.service, { fields: [field('customers.bad', path)] }),
            path.join('.'),
          ).rejects.toThrow('UnsafeFieldPath');
        }
      }
      expect(await env.service.world.collection('schema_registry').countDocuments()).toBe(0);
    });

    it('refuses registry inserts from the worker principal altogether', async () => {
      await expect(scopes.insert(registryOf())).rejects.toThrow('PrincipalBoundary');
    });

    it('never moves a record to another tenant', async () => {
      const worldId = 'world-tenant';
      await seedWorld(worldId, [{ _id: 'ten', data: {} }]);
      const hostile = field('customers.owner', ['tenantId']);
      expect(() =>
        compileWritePlan(hostile, {
          match: actor.tenantId,
          mutation: { kind: 'replace', replacement: 'tenant-victim' },
        }),
      ).toThrow('UnsafeFieldPath');
      await expect(
        scopes.writeField(
          actor,
          worldId,
          registryOf({ fields: [hostile] }),
          string('customers', 'ten'),
          'customers.owner',
          {
            match: actor.tenantId,
            mutation: { kind: 'replace', replacement: 'tenant-victim' },
          },
        ),
      ).rejects.toThrow('UnsafeFieldPath');
      expect(await customers().findOne({ _id: 'ten' as never })).toHaveProperty('tenantId', actor.tenantId);
    });

    it('registers the record key as a read-only descriptor', async () => {
      const key = field('customers.record_id', ['_id']);
      await insertRegistry(env.service, { fields: [key] });
      const worldId = 'world-key';
      await seedWorld(worldId, [{ _id: 'k1', data: {} }]);
      const found = await scopes.findByField(
        actor,
        worldId,
        registryOf({ fields: [key] }),
        'customers.record_id',
        'k1',
      );
      expect(found).toEqual([string('customers', 'k1')]);
      await expect(
        scopes.writeField(actor, worldId, registryOf({ fields: [key] }), found[0]!, 'customers.record_id', {
          match: 'k1',
          mutation: { kind: 'replace', replacement: 'k2' },
        }),
      ).rejects.toThrow('UnsafeFieldPath');
    });
  });

  describe('L11: proposers cannot supply a class', () => {
    it('rejects a candidate row that carries computedClass, at the database', async () => {
      const proposer = await env.as('proposer');
      const row = {
        _id: 'self',
        ...proposalOf({ candidateId: 'self', parentHash: HASH, childHash: HASH }),
        state: 'eligible',
      };
      await expect(
        proposer.control
          .collection<Document>('candidates')
          .insertOne({ ...row, computedClass: 'tightening' } as never),
      ).rejects.toMatchObject({ code: 121 });
      // A forged lifecycle state is harmless: promotion never reads the candidate row for authorization.
      await proposer.control.collection<Document>('candidates').insertOne(row as never);
    });

    it('refuses a proposal object that carries a class or an advanced state', async () => {
      const repository = new CandidateRepository(await env.as('proposer'));
      const proposal = proposalOf({ candidateId: 'c', parentHash: HASH, childHash: HASH });
      await expect(repository.propose({ ...proposal, computedClass: 'tightening' } as never)).rejects.toThrow(
        'ProposerCannotClassify',
      );
      await expect(repository.propose({ ...proposal, state: 'eligible' } as never)).rejects.toThrow(
        'ProposerCannotClassify',
      );
      expect(await repository.propose(proposal)).toMatchObject({ state: 'proposed' });
      expect(await repository.read(scope, 'c')).not.toHaveProperty('computedClass');
    });

    it('lets only the proposer principal propose', async () => {
      await expect(
        new CandidateRepository(executor).propose(
          proposalOf({ candidateId: 'c', parentHash: HASH, childHash: HASH }),
        ),
      ).rejects.toThrow('PrincipalBoundary');
    });
  });
  describe('guardrail appliesTo is accepted by the strict database validator', () => {
    const rule = {
      ruleId: 'r',
      predicate: { op: 'receipt_valid' as const, bindingId: 'b' },
      result: 'deny' as const,
      sourceEvidenceIds: [],
    };
    it('stores a rule with a bounded appliesTo and rejects an oversized or mistyped one', async () => {
      const artifacts = new ArtifactRepository(env.service);
      const bundle = validBundle();
      const stored = await artifacts.insert({
        ...bundle,
        guardrails: [
          { ...rule, appliesTo: ['apply_cleanup_batch'] },
          { ...rule, ruleId: 'r2' },
        ],
      });
      expect((await artifacts.read(stored._id)).payload.guardrails[0]).toHaveProperty('appliesTo', [
        'apply_cleanup_batch',
      ]);
      const raw = (guardrails: unknown) =>
        env.service.control.collection<Document>('artifacts').insertOne({
          _id: 'c'.repeat(64) as never,
          payload: { ...bundle, guardrails } as never,
          createdAt: new Date(),
          sourceBlobIds: [],
        });
      await expect(
        raw([{ ...rule, appliesTo: Array.from({ length: 17 }, (_, i) => `t${i}`) }]),
      ).rejects.toMatchObject({
        code: 121,
      });
      await expect(raw([{ ...rule, appliesTo: [1] }])).rejects.toMatchObject({ code: 121 });
    });
  });
});
