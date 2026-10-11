import { describe, expect, it } from 'vitest';
import { Long, ObjectId } from 'mongodb';
import type { FieldDescriptor } from '@expunge/contracts';
import {
  assertDeclaredArrayShape,
  assertStoredShape,
  compileFieldPath,
  compileReadFilter,
  compileReadPath,
  compileWritePlan,
} from '../src/index.js';
import { FAMILIES, createWorldSpec, deriveWorldScopeKey, generateWorld } from '../../fixtures/src/index.js';

const field = (path: unknown, overrides: Partial<FieldDescriptor> = {}): FieldDescriptor =>
  ({
    fieldId: 'customers.f',
    collectionId: 'customers',
    path,
    bsonTypes: ['string'],
    isArray: Array.isArray(path) && path.includes('*'),
    sanitized: true,
    ...overrides,
  }) as FieldDescriptor;

describe('read path compilation', () => {
  it('drops the wildcard because a dotted path already traverses arrays', () => {
    expect(compileReadPath(field(['data', 'participants', '*', 'subject']))).toBe(
      'data.participants.subject',
    );
    expect(compileReadPath(field(['data', 'aliases', '*']))).toBe('data.aliases');
    expect(compileReadPath(field(['data', 'identity', 'id']))).toBe('data.identity.id');
  });

  it('reads the record key but never lets a business-field compile address it', () => {
    expect(compileReadPath(field(['_id']))).toBe('_id');
    expect(() => compileFieldPath(field(['_id']))).toThrow('UnsafeFieldPath');
    expect(compileFieldPath(field(['data', 'x']))).toBe('data.x');
  });

  it('rejects leading wildcards, repeated wildcards, non-string segments and operator-looking segments', () => {
    const bad: unknown[] = [
      ['*', 'data'],
      ['data', '*', 'a', '*'],
      ['data', '*', '*'],
      [],
      ['data', 1],
      ['data', null],
      ['data', undefined],
      ['data', { $ne: 1 }],
      ['data', '$where'],
      ['data', 'a.b'],
      ['data', 'a$'],
      'data.participants',
      null,
    ];
    for (const path of bad)
      expect(() => compileReadPath(field(path)), JSON.stringify(path)).toThrow('UnsafeFieldPath');
  });

  it('refuses envelope fields and anything outside the data subtree', () => {
    for (const root of [
      'tenantId',
      'env',
      'worldId',
      'scopeId',
      '_rev',
      'eligibility',
      'access',
      'lifecycle',
      'payload',
    ])
      expect(() => compileReadPath(field([root, 'x'])), root).toThrow('UnsafeFieldPath');
    expect(() => compileReadPath(field(['data']))).toThrow('UnsafeFieldPath');
  });

  it('builds equality filters only from scalar values', () => {
    const f = field(['data', 'participants', '*', 'subject']);
    expect(compileReadFilter(f, 'syn_subject_1')).toEqual({ 'data.participants.subject': 'syn_subject_1' });
    const id = new ObjectId('507f1f77bcf86cd799439011');
    expect(compileReadFilter(f, id)).toEqual({ 'data.participants.subject': id });
    for (const injected of [{ $ne: null }, ['a'], null, undefined, Number.NaN, 'x'.repeat(5000)])
      expect(() => compileReadFilter(f, injected as never), String(injected)).toThrow('UnsafeMatchValue');
  });
});

describe('write plan compilation', () => {
  const replace = (value: string) => ({ kind: 'replace' as const, replacement: value });
  const notArray = { $not: { $type: 'array' } };

  it('plain path: $set or $unset of the dotted path, guarded against arrays', () => {
    const f = field(['data', 'identity', 'id']);
    expect(compileWritePlan(f, { match: 'a', mutation: replace('[redacted]') })).toEqual({
      filter: { 'data.identity.id': { $eq: 'a', ...notArray } },
      update: { $set: { 'data.identity.id': '[redacted]' }, $inc: { _rev: 1 } },
      wildcardIndex: null,
    });
    expect(compileWritePlan(f, { match: 'a', mutation: { kind: 'remove' } }).update).toEqual({
      $unset: { 'data.identity.id': '' },
      $inc: { _rev: 1 },
    });
  });

  it('wildcard with a tail: filtered positional $set on the exact element field', () => {
    const f = field(['data', 'participants', '*', 'subject']);
    expect(compileWritePlan(f, { match: 'a', mutation: replace('[redacted]'), expectedRev: 3 })).toEqual({
      filter: { 'data.participants.subject': 'a', _rev: 3 },
      update: { $set: { 'data.participants.$[target].subject': '[redacted]' }, $inc: { _rev: 1 } },
      arrayFilters: [{ 'target.subject': { $eq: 'a', ...notArray } }],
      wildcardIndex: 2,
    });
  });

  it('wildcard at the leaf: filtered positional $set on scalar elements', () => {
    const plan = compileWritePlan(field(['data', 'aliases', '*']), { match: 'a', mutation: replace('x') });
    expect(plan.update).toEqual({ $set: { 'data.aliases.$[target]': 'x' }, $inc: { _rev: 1 } });
    expect(plan.arrayFilters).toEqual([{ target: { $eq: 'a', ...notArray } }]);
  });

  it('wildcard remove: $pull of the matching element only, with a condition', () => {
    const tail = compileWritePlan(field(['data', 'participants', '*', 'subject']), {
      match: 'a',
      mutation: { kind: 'remove' },
    });
    expect(tail.update).toEqual({
      $pull: { 'data.participants': { subject: { $eq: 'a', ...notArray } } },
      $inc: { _rev: 1 },
    });
    const leaf = compileWritePlan(field(['data', 'aliases', '*']), {
      match: 'a',
      mutation: { kind: 'remove' },
    });
    expect(leaf.update).toEqual({ $pull: { 'data.aliases': { $eq: 'a', ...notArray } }, $inc: { _rev: 1 } });
  });

  it('never replaces, unsets or removes a whole array when the path has a wildcard', () => {
    const plans = FAMILIES.flatMap((family) => {
      const spec = createWorldSpec({ family, seed: `seed-${family}` });
      const world = generateWorld(spec, `seed-${family}`, deriveWorldScopeKey(spec, `seed-${family}`));
      return world.scope.fields.filter((f) => f.path.includes('*')).map((f) => ({ family, f }));
    });
    expect(plans.length).toBeGreaterThan(10);
    for (const { family, f } of plans) {
      const wildcard = f.path.indexOf('*');
      const bareArray = f.path.slice(0, wildcard).join('.');
      for (const mutation of [replace('[redacted]'), { kind: 'remove' as const }]) {
        const plan = compileWritePlan(f, { match: 'subject', mutation });
        const set = Object.keys((plan.update.$set as object) ?? {});
        const unset = Object.keys((plan.update.$unset as object) ?? {});
        const label = `${family} ${f.fieldId} ${mutation.kind}`;
        expect(set, label).not.toContain(bareArray);
        expect(unset, label).toEqual([]);
        if (mutation.kind === 'replace') {
          expect(
            set.every((path) => path.startsWith(`${bareArray}.$[target]`)),
            label,
          ).toBe(true);
          expect(plan.arrayFilters?.length, label).toBe(1);
        } else {
          expect(Object.keys(plan.update.$pull as object), label).toEqual([bareArray]);
          expect(Object.values(plan.update.$pull as object)[0], label).not.toBe(undefined);
        }
      }
    }
  });

  it('rejects the record key, unsanitized fields, bad mutations and bad revisions', () => {
    const ok = field(['data', 'x']);
    expect(() => compileWritePlan(field(['_id']), { match: 'a', mutation: replace('b') })).toThrow(
      'UnsafeFieldPath',
    );
    expect(() =>
      compileWritePlan(field(['data', 'x'], { sanitized: false }), { match: 'a', mutation: replace('b') }),
    ).toThrow('UnregisteredField');
    expect(() => compileWritePlan(ok, { match: 'a', mutation: { kind: 'drop' } as never })).toThrow(
      'UnsafeMutation',
    );
    expect(() => compileWritePlan(ok, { match: 'a', mutation: replace('b'), expectedRev: -1 })).toThrow(
      'InvalidExpectedRevision',
    );
    expect(() =>
      compileWritePlan(ok, { match: 'a', mutation: { kind: 'replace', replacement: { $set: 1 } as never } }),
    ).toThrow('UnsafeMatchValue');
  });

  it('refuses leading wildcards, repeated wildcards and non-string segments for writes too', () => {
    for (const path of [['*', 'a'], ['data', '*', '*'], ['data', 1], []])
      expect(
        () => compileWritePlan(field(path), { match: 'a', mutation: replace('b') }),
        JSON.stringify(path),
      ).toThrow('UnsafeFieldPath');
  });

  it('accepts BSON identity types as match values but writes null for tombstones', () => {
    const f = field(['data', 'x']);
    for (const value of [new ObjectId(), Long.fromString('9007199254740993'), new Date(0), 7, true])
      expect(() => compileWritePlan(f, { match: value, mutation: replace('b') })).not.toThrow();
    expect(
      compileWritePlan(f, { match: 'a', mutation: { kind: 'replace', replacement: null } }).update.$set,
    ).toEqual({
      'data.x': null,
    });
  });
});

describe('declared array shape', () => {
  it('requires isArray exactly when the path carries a wildcard', () => {
    expect(() => assertDeclaredArrayShape(field(['data', 'a', '*']))).not.toThrow();
    expect(() => assertDeclaredArrayShape(field(['data', 'a']))).not.toThrow();
    expect(() => assertDeclaredArrayShape(field(['data', 'a'], { isArray: true }))).toThrow(
      'InvalidFieldRegistry',
    );
    expect(() => assertDeclaredArrayShape(field(['data', 'a', '*'], { isArray: false }))).toThrow(
      'InvalidFieldRegistry',
    );
    expect(() => assertDeclaredArrayShape(field(['data', 'a'], { isArray: 'yes' as never }))).toThrow(
      'InvalidFieldRegistry',
    );
  });

  it('checks a stored document against the declared shape', () => {
    const plain = field(['data', 'a']);
    expect(() => assertStoredShape({ data: { a: 'x' } }, plain)).not.toThrow();
    expect(() => assertStoredShape({ data: {} }, plain)).not.toThrow();
    expect(() => assertStoredShape({ data: { a: ['x'] } }, plain)).toThrow('ScalarWriteOnArray');
    expect(() => assertStoredShape({ data: [{ a: 'x' }] }, plain)).toThrow('UndeclaredArrayTraversal');

    const wild = field(['data', 'rows', '*', 'k']);
    expect(() => assertStoredShape({ data: { rows: [{ k: 'x' }, { k: 'y' }] } }, wild)).not.toThrow();
    expect(() => assertStoredShape({ data: {} }, wild)).not.toThrow();
    expect(() => assertStoredShape({ data: { rows: 'text' } }, wild)).toThrow('ExpectedArray');
    expect(() => assertStoredShape({ data: { rows: [{ k: ['x'] }] } }, wild)).toThrow('ScalarWriteOnArray');
  });
});
