import type { SubjectIdType } from '../../../shared/expunge';

/**
 * Exact identity only: the subject is a typed identifier, never a name to search for
 * (CONTRACTS: semantic similarity is not identity evidence). Validation is local and fixed
 * vocabulary; the backend still validates and resolves authoritatively.
 */
export const ID_TYPES: Array<{
  value: SubjectIdType;
  label: string;
  hint: string;
}> = [
  {
    value: 'objectId',
    label: 'ObjectId',
    hint: '24 hexadecimal characters, for example 0123456789abcdef01234567.',
  },
  {
    value: 'string',
    label: 'String',
    hint: 'The exact stored string, up to 128 characters. Spaces are significant.',
  },
  {
    value: 'int',
    label: '32-bit integer',
    hint: 'Whole number from -2147483648 to 2147483647.',
  },
  {
    value: 'long',
    label: '64-bit integer',
    hint: 'Whole number up to 19 digits.',
  },
];

export interface SubjectValidation {
  ok: boolean;
  message: string | null;
}

const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export function validateSubject(
  idType: SubjectIdType,
  value: string,
): SubjectValidation {
  if (value.length === 0)
    return { ok: false, message: 'Enter the exact identifier.' };
  switch (idType) {
    case 'objectId':
      return /^[0-9a-fA-F]{24}$/.test(value)
        ? { ok: true, message: null }
        : {
            ok: false,
            message: 'An ObjectId is exactly 24 hexadecimal characters.',
          };
    case 'string':
      if (value.length > 128)
        return {
          ok: false,
          message: 'A string identifier is at most 128 characters.',
        };
      // eslint-disable-next-line no-control-regex -- control characters are not valid identifiers
      if (/[\u0000-\u001f\u007f]/.test(value))
        return {
          ok: false,
          message: 'The identifier contains a control character.',
        };
      return { ok: true, message: null };
    case 'int':
    case 'long': {
      if (!/^-?\d{1,19}$/.test(value))
        return { ok: false, message: 'Enter a whole number.' };
      const number = BigInt(value);
      const [min, max] =
        idType === 'int' ? [INT32_MIN, INT32_MAX] : [INT64_MIN, INT64_MAX];
      return number >= min && number <= max
        ? { ok: true, message: null }
        : {
            ok: false,
            message: `The number is outside the ${idType === 'int' ? '32-bit' : '64-bit'} range.`,
          };
    }
  }
}

/**
 * The value that is sent. The domain addresses an ObjectId only by its lowercase hexadecimal
 * spelling (packages/mongo hashes.ts CANONICAL_OBJECT_ID) and hashes the raw string for the
 * subject identity, so ABC... and abc... would be two identities for one record. An ObjectId is
 * lowercased; every other type is sent exactly as typed (DA-7 X1).
 */
export function normalizeSubjectValue(idType: SubjectIdType, value: string) {
  return idType === 'objectId' ? value.toLowerCase() : value;
}

/** A new random key for one submit; reused only for retries of that same submit. */
export function newRequestKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
