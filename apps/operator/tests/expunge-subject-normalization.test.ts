import { expect, it } from 'vitest';
import {
  DEFAULT_ID_TYPE,
  normalizeSubjectValue,
  validateSubject,
} from '../src/client/expunge/lib/subject.js';
import {
  NO_MATCH_MESSAGE,
  previewHasNoMatch,
} from '../src/client/expunge/lib/preview.js';

it('starts the form on String, which accepts synthetic world subject keys', () => {
  const key = 'syn_d203706c7d0e73329c9b54b4';
  expect(DEFAULT_ID_TYPE).toBe('string');
  expect(validateSubject(DEFAULT_ID_TYPE, key).ok).toBe(true);
  // The same key is not an ObjectId, which is why ObjectId is not the default.
  expect(validateSubject('objectId', key).ok).toBe(false);
});

it('detects a preview that matched no record, so Submit is withheld with a clear message', () => {
  const row = (exactIdentityMatches: number) => ({
    collectionId: 'customers',
    exactIdentityMatches,
    eligibleEffects: {},
    retained: 0,
    notInspected: false,
  });
  expect(previewHasNoMatch({ perCollection: [row(1), row(0)] })).toBe(false);
  expect(previewHasNoMatch({ perCollection: [row(0), row(0)] })).toBe(true);
  expect(previewHasNoMatch({ perCollection: [] })).toBe(true);
  expect(NO_MATCH_MESSAGE).toBe(
    'No record in this world matches this identifier. Check the identifier type and value.',
  );
});

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
