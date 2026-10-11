// How record IDs and identity tokens are derived from (seed, collection, role, instance).
//
// UNKEYED derivation hashes those inputs with the public canonical hash. Anyone who learns the seed, or who can
// guess a weak one, can recompute every ID from the visible world ID. KEYED derivation computes an HMAC under a
// per-campaign private key that is stored only in `expunge_private` and readable only by the fixture builder and
// the grader: a worker holding the visible world, the world ID and the public seed commitment cannot recompute a
// target ID even if the seed leaks. The campaign runner always passes a keyed derivation; unkeyed exists for
// unit tests and for worlds that never reach a worker.
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson, contentHash } from '@expunge/contracts';

export interface Derivation {
  /** Null for the unkeyed (public) derivation; otherwise the stored key's identifier (never the key). */
  keyId: string | null;
  /** 24 hex characters, opaque. */
  recordDigest(seed: string, collection: string, role: string, instance: string): string;
  /** 20 hex characters, opaque. */
  tokenDigest(seed: string, ordinal: number, instance: string): string;
}

export const UNKEYED_DERIVATION: Derivation = {
  keyId: null,
  recordDigest: (seed, collection, role, instance) =>
    contentHash({ seed, collection, role, instance }, 'fixture-record').slice(0, 24),
  tokenDigest: (seed, ordinal, instance) =>
    contentHash({ seed, subjectOrdinal: ordinal, instance }, 'synthetic-identity').slice(0, 20),
};

const MIN_KEY_BYTES = 32;
export class DerivationKeyError extends Error {
  constructor() {
    super('InvalidDerivationKey');
  }
}

/** A per-campaign secret: at least 256 bits, and not a degenerate repeat of one byte. */
export function assertDerivationKey(key: unknown): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.length < MIN_KEY_BYTES) throw new DerivationKeyError();
  if (new Set(key).size < 8) throw new DerivationKeyError();
}
export function mintDerivationKey(): { keyId: string; key: Uint8Array } {
  const key = randomBytes(32);
  return { keyId: `key_${randomBytes(8).toString('hex')}`, key: new Uint8Array(key) };
}

export function keyedDerivation(key: Uint8Array, keyId: string): Derivation {
  assertDerivationKey(key);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new DerivationKeyError();
  const mac = (domain: string, value: unknown): string =>
    createHmac('sha256', key)
      .update(`expunge:fixture:1:${domain}\n`)
      .update(canonicalJson(value))
      .digest('hex');
  return {
    keyId,
    recordDigest: (seed, collection, role, instance) =>
      mac('record', { seed, collection, role, instance }).slice(0, 24),
    tokenDigest: (seed, ordinal, instance) => mac('identity', { seed, ordinal, instance }).slice(0, 20),
  };
}
