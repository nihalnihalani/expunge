import { expect, it } from 'vitest';
import {
  normalizeSubjectValue,
  validateSubject,
} from '../src/client/expunge/lib/subject.js';

// Typed identifier grammar/normalization only. No customer or source records are constructed.
it('canonicalizes valid ObjectIds without changing their BSON identity', () => {
  const upper = 'ABCDEF0123456789ABCDEF01';
  const canonical = 'abcdef0123456789abcdef01';
  expect(validateSubject('objectId', upper).ok).toBe(true);
  expect(normalizeSubjectValue('objectId', upper)).toBe(canonical);
  expect(normalizeSubjectValue('objectId', canonical)).toBe(canonical);
  expect(validateSubject('objectId', canonical).ok).toBe(true);
});

it.each([
  '',
  'abcdef',
  'g'.repeat(24),
  'a'.repeat(23),
  'a'.repeat(25),
  ' ' + 'a'.repeat(24),
  'a'.repeat(24) + '\n',
])('refuses invalid ObjectId grammar', (value) =>
  expect(validateSubject('objectId', value).ok).toBe(false),
);

it('preserves exact string and numeric spellings while enforcing their grammar', () => {
  for (const value of [
    ' Exact identifier ',
    'ABCDEF0123456789ABCDEF01',
    'e\u0301',
  ]) {
    expect(validateSubject('string', value).ok).toBe(true);
    expect(normalizeSubjectValue('string', value)).toBe(value);
  }
  for (const [kind, value] of [
    ['int', '-2147483648'],
    ['long', '9223372036854775807'],
  ] as const) {
    expect(validateSubject(kind, value).ok).toBe(true);
    expect(normalizeSubjectValue(kind, value)).toBe(value);
  }
  expect(validateSubject('string', 'identifier\0tail').ok).toBe(false);
  expect(validateSubject('long', '9223372036854775808').ok).toBe(false);
});
