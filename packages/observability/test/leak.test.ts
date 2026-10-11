import { describe, expect, it } from 'vitest';
import { privateIdHash } from '@expunge/contracts';
import {
  LeakError,
  assertNoLeak,
  decodedVariants,
  detectLeak,
  isHeldOutKey,
  keyTokens,
  requireGuard,
  sanitizeFreeText,
  sanitizeValue,
  DEFAULT_SANITIZATION,
} from '../src/index.js';

const LITERAL = 'syn_subject_maria_rossi';
const guard = { forbiddenLiterals: [LITERAL] };
const refuse = (value: unknown, code: string, g = guard) => {
  const finding = detectLeak(value, g);
  expect(finding, JSON.stringify(value)).toBeInstanceOf(LeakError);
  expect(finding?.code).toBe(code);
};

describe('O1: held-out keys are matched on normalised tokens, not exact names', () => {
  it.each([
    'expectedState',
    'expected_poststate',
    'expectedPostState',
    'manifestHash',
    'manifest',
    'seeds',
    'seedCommitment',
    'held_out',
    'heldOut',
    'holdout',
    'oracle_targets',
    'groundTruthIds',
    'ground-truth',
    'answerKey',
    'preservationHash',
    'EXPECTED',
    'ехpected', // Cyrillic look-alikes inside the key
  ])('refuses the key %s', (key) => {
    expect(isHeldOutKey(key)).toBe(true);
    refuse({ nested: [{ [key]: 1 }] }, 'HeldOutLeak');
  });

  it.each(['unexpected', 'unexpectedError', 'reseed', 'status', 'toolId', 'harnessHash'])(
    'does not refuse the unrelated key %s',
    (key) => {
      expect(isHeldOutKey(key)).toBe(false);
      expect(detectLeak({ [key]: 1 }, guard)).toBeNull();
    },
  );

  it('tokenises camelCase, separators and acronyms', () => {
    expect(keyTokens('expectedPostState')).toEqual(['expected', 'post', 'state']);
    expect(keyTokens('SQLManifestHash')).toEqual(['sql', 'manifest', 'hash']);
    expect(keyTokens('held_out-targets.v2')).toEqual(['held', 'out', 'targets', 'v2']);
  });
});

describe('O1: subject literals in keys, encodings, splits and look-alikes', () => {
  it('refuses a literal used as an object KEY, at any depth', () => {
    refuse({ witness: { [LITERAL]: true } }, 'SubjectLiteral');
    refuse({ [`prefix ${LITERAL.toUpperCase()}`]: 1 }, 'SubjectLiteral');
  });

  it('refuses base64, hex, URL-encoded and double-encoded forms of the literal', () => {
    const b64 = Buffer.from(`note: ${LITERAL}`).toString('base64');
    const b64url = Buffer.from(LITERAL).toString('base64url');
    const hex = Buffer.from(LITERAL).toString('hex');
    const url = encodeURIComponent(`Maria Rossi: ${LITERAL}`);
    const doubleB64 = Buffer.from(Buffer.from(LITERAL).toString('base64')).toString('base64');
    for (const form of [b64, b64url, hex, url, doubleB64]) {
      refuse({ detail: form }, 'SubjectLiteral');
      refuse({ detail: `evidence ${form} end` }, 'SubjectLiteral');
    }
  });

  it('refuses a literal split across adjacent array elements, with separators, spacing or zero-width characters', () => {
    refuse({ parts: ['syn_subj', 'ect_maria', '_rossi'] }, 'SubjectLiteral');
    refuse({ text: 'syn subject  maria-rossi' }, 'SubjectLiteral');
    refuse({ text: 'syn_subj​ect_maria_ro⁠ssi' }, 'SubjectLiteral');
    refuse({ text: 'ｓｙｎ＿ｓｕｂｊｅｃｔ＿ｍａｒｉａ＿ｒｏｓｓｉ' }, 'SubjectLiteral'); // fullwidth
    refuse({ text: 'syn_subjеct_maria_rossi' }, 'SubjectLiteral'); // Cyrillic е
  });

  it('passes ordinary content that merely resembles the literal', () => {
    expect(
      detectLeak({ text: 'syn_subject_other', parts: ['syn', 'thetic'], hex: 'deadbeefdeadbeef' }, guard),
    ).toBeNull();
  });

  it('decodes only printable text and bounds the depth', () => {
    expect(decodedVariants('plain text only')).toEqual(['plain text only']);
    const nested = Buffer.from(
      Buffer.from(Buffer.from('level3-secret').toString('base64')).toString('base64'),
    ).toString('base64');
    expect(decodedVariants(nested, 2).some((variant) => variant.includes('level3-secret'))).toBe(false);
    expect(decodedVariants(nested, 3).some((variant) => variant.includes('level3-secret'))).toBe(true);
  });
});

describe('O1: a guard without any literal is a construction error', () => {
  it('requires forbiddenLiterals (missing, empty, or only blank literals)', () => {
    expect(() => requireGuard(undefined)).toThrowError(/MissingForbiddenLiterals/);
    expect(() => requireGuard({ forbiddenLiterals: [] })).toThrowError(/MissingForbiddenLiterals/);
    expect(() => requireGuard({ forbiddenLiterals: ['  ..  '] })).toThrowError(/InvalidLiteral/);
    expect(() => assertNoLeak({ ok: 1 }, { forbiddenLiterals: [] })).toThrowError(/MissingForbiddenLiterals/);
  });

  it('accepts an empty literal list only together with a non-empty private-id set', () => {
    const privateIds = { salt: 's', hashes: [privateIdHash('s', 'cust-1')] };
    expect(() => requireGuard({ forbiddenLiterals: [], privateIds })).not.toThrow();
    expect(() => requireGuard({ forbiddenLiterals: [], privateIds: { salt: 's', hashes: [] } })).toThrow();
  });
});

describe('O1: private ids through the salted-hash set (the observer never holds a raw id)', () => {
  const SALT = 'salt-world-1';
  const ids = {
    salt: SALT,
    hashes: ['cust-0042', 'acct_77f3a9c1e0b24d6a'].map((id) => privateIdHash(SALT, id)),
  };
  const g = { forbiddenLiterals: [LITERAL], privateIds: ids };

  it('test vector shared with the grader: hex(sha256("expunge-private-id:v1" NUL salt NUL NFKC(id)))', () => {
    expect(privateIdHash('salt-world-1', 'cust-0042')).toBe(
      'a30814d6ac27eae743f8e779f8f159c9da44845082a774d374153952ef671db7',
    );
    expect(privateIdHash('salt-world-1', 'ｃust-0042')).toBe(privateIdHash('salt-world-1', 'cust-0042')); // NFKC
    expect(privateIdHash('other-salt', 'cust-0042')).not.toBe(privateIdHash('salt-world-1', 'cust-0042'));
  });

  it('refuses a private id whatever key it sits under, inside longer text, and after decoding', () => {
    refuse({ anything: 'cust-0042' }, 'PrivateIdLeak', g);
    refuse({ note: 'the record cust-0042 was removed.' }, 'PrivateIdLeak', g);
    refuse({ rows: ['acct_77f3a9c1e0b24d6a'] }, 'PrivateIdLeak', g);
    refuse({ blob: Buffer.from('cust-0042').toString('base64') }, 'PrivateIdLeak', g);
    refuse({ 'cust-0042': 1 }, 'PrivateIdLeak', g);
  });

  it('passes ids that are not in the set', () => {
    expect(detectLeak({ anything: 'cust-9999', n: 3 }, g)).toBeNull();
  });
});

describe('O7: free text fails closed', () => {
  it('without a literal list every free-text value is reduced to a hash, never kept readable', () => {
    expect(sanitizeFreeText('the archive for Jane Doe is missing')).toMatch(/^\[redacted:[a-f0-9]{16}\]$/);
    expect(sanitizeFreeText('totally harmless words', DEFAULT_SANITIZATION)).toMatch(/^\[redacted:/);
  });

  it('with a literal list it keeps text that carries none of them (in any folded or encoded form) and redacts the rest', () => {
    const policy = { ...DEFAULT_SANITIZATION, forbiddenLiterals: ['jane doe'] };
    expect(sanitizeFreeText('archive is missing', policy)).toBe('archive is missing');
    expect(sanitizeFreeText('for J.a.n.e   D-o-e', policy)).toMatch(/^\[redacted:/);
    expect(sanitizeFreeText(`blob ${Buffer.from('Jane Doe').toString('base64')}`, policy)).toMatch(
      /^\[redacted:/,
    );
  });

  it('sanitizeValue renames a held-out key and hides everything under it', () => {
    const out = sanitizeValue({ status: 'ok', expectedPostState: { rows: ['a', 'b'] } }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out).some((key) => key.startsWith('key_'))).toBe(true);
    expect(JSON.stringify(out)).not.toContain('expectedPostState');
    expect(JSON.stringify(out)).not.toContain('"a"');
  });
});
