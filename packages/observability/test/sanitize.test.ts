import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANITIZATION,
  redact,
  sanitizeError,
  sanitizeFreeText,
  sanitizeProperty,
  sanitizeValue,
} from '../src/index.js';

const policy = { ...DEFAULT_SANITIZATION, forbiddenLiterals: ['jane doe', 'jdoe-77'] };

describe('structural sanitization', () => {
  it('keeps identifier-like values under allowed keys and hashes every other string', () => {
    const out = sanitizeValue(
      {
        collectionId: 'customers',
        toolId: 'inspect_scope',
        email: 'jane@example.com',
        note: 'Jane lives at 1 Main St',
        n: 3,
        ok: true,
      },
      policy,
    ) as Record<string, unknown>;
    expect(out.collectionId).toBe('customers');
    expect(out.toolId).toBe('inspect_scope');
    expect(out.n).toBe(3);
    expect(out.ok).toBe(true);
    expect(out.email).toMatchObject({ redacted: true, length: 16 });
    expect(JSON.stringify(out)).not.toContain('jane@example.com');
    expect(JSON.stringify(out)).not.toContain('Main St');
  });

  it('hashes an allowed-key value that contains a forbidden subject literal, or is free text', () => {
    const out = sanitizeValue(
      { name: 'jdoe-77', code: 'has spaces and words', status: 'ok' },
      policy,
    ) as Record<string, unknown>;
    expect(out.name).toMatchObject({ redacted: true });
    expect(out.code).toMatchObject({ redacted: true });
    expect(out.status).toBe('ok');
  });

  it('equal secrets hash equally (comparable) and different ones differ', () => {
    expect(redact('same')).toEqual(redact('same'));
    expect(redact('same').sha256).not.toBe(redact('other').sha256);
  });

  it('hashes keys that carry data, and bounds depth, width and arrays', () => {
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    const out = sanitizeValue(
      {
        'Jane Doe': 1,
        wide,
        deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
        list: Array.from({ length: 60 }, (_, i) => i),
      },
      policy,
    ) as any;
    expect(Object.keys(out).some((k) => k.startsWith('key_'))).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Jane Doe');
    expect(Object.keys(out.wide).length).toBeLessThanOrEqual(51);
    expect(out.wide._truncated).toBe(30);
    expect(JSON.stringify(out.deep)).toContain('"truncated":"depth"');
    expect(out.list.at(-1)).toEqual({ truncated: 'array', omitted: 10 });
  });

  it('drops functions, normalizes non-finite numbers, bigint and dates, never throws on odd values', () => {
    const out = sanitizeValue(
      {
        f: () => 1,
        n: Number.NaN,
        b: 10n,
        d: new Date('2026-01-01T00:00:00Z'),
        u: undefined,
        s: Symbol('x'),
      },
      policy,
    ) as any;
    expect(out).toEqual({ f: null, n: null, b: '10', d: '2026-01-01T00:00:00.000Z', u: null, s: null });
  });
});

describe('error and property sanitization', () => {
  it('keeps the code and a hashed message; stack traces and raw messages never leave', () => {
    const error = Object.assign(new Error('could not find Jane Doe at 1 Main St'), { code: 'E_LOOKUP' });
    const out = sanitizeError(error, policy);
    expect(out).toMatchObject({ name: 'Error', code: 'E_LOOKUP', message: { redacted: true } });
    expect(JSON.stringify(out)).not.toContain('Jane');
    expect(sanitizeError('Jane Doe', policy)).toMatchObject({
      name: 'NonError',
      message: { redacted: true },
    });
    expect(sanitizeError(new Error('LostLease'), policy).message).toBe('LostLease');
  });

  it('properties pass only as identifiers; free text and forbidden literals become a hash', () => {
    expect(sanitizeProperty('run-123', policy)).toBe('run-123');
    expect(sanitizeProperty('__raindrop_report', policy)).toBe('__raindrop_report');
    expect(sanitizeProperty('Jane Doe', policy)).toMatch(/^redacted:[a-f0-9]{16}$/);
    expect(sanitizeProperty('jdoe-77', policy)).toMatch(/^redacted:/);
  });

  it('free text is length capped and hashed when it contains a forbidden literal', () => {
    expect(sanitizeFreeText('cannot see the archive collection', policy)).toBe(
      'cannot see the archive collection',
    );
    expect(sanitizeFreeText('x'.repeat(300), policy).endsWith('...[truncated]')).toBe(true);
    expect(sanitizeFreeText('record for Jane Doe is missing', policy)).toMatch(/^\[redacted:[a-f0-9]{16}\]$/);
  });
});
