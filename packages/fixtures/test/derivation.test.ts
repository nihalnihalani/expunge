import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '@expunge/contracts';
import { COLLECTION_IDS, FAMILIES, createWorldSpec, generateWorld, valuesAtPath } from '../src/index.js';
import {
  DerivationKeyError,
  UNKEYED_DERIVATION,
  assertDerivationKey,
  evaluateShapeDetectors,
  generateSealedFixture,
  keyedDerivation,
  mintDerivationKey,
  shapeLeaks,
} from '../src/sealed.js';
import { addressKey } from '../src/index.js';

const keyA = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const keyB = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff));
const derivationA = keyedDerivation(keyA, 'key_campaign_a');
const derivationB = keyedDerivation(keyB, 'key_campaign_b');
const SEED = 'keyed-world-seed-0001';
const spec = () => createWorldSpec({ family: 'mixed_eligibility', seed: SEED });
const idsOf = (world: ReturnType<typeof generateWorld>) =>
  new Set(Object.values(world.collections).flatMap((rows) => rows.map((row) => row._id)));

describe('HMAC-keyed instance ids and identity tokens (DA-2 E2 residual)', () => {
  it('derives record ids and tokens as HMAC-SHA256 under the key, domain separated, canonical input', () => {
    const mac = (domain: string, value: unknown, length: number) =>
      createHmac('sha256', keyA)
        .update(`expunge:fixture:1:${domain}\n`)
        .update(canonicalJson(value))
        .digest('hex')
        .slice(0, length);
    expect(derivationA.recordDigest('s', 'accounts', 'primary', 'world_x')).toBe(
      mac('record', { seed: 's', collection: 'accounts', role: 'primary', instance: 'world_x' }, 24),
    );
    expect(derivationA.tokenDigest('s', 1, 'world_x')).toBe(
      mac('identity', { seed: 's', ordinal: 1, instance: 'world_x' }, 20),
    );
    // Different domain, different key, different input: all different.
    expect(derivationA.recordDigest('s', 'accounts', 'primary', 'world_x')).not.toBe(
      derivationB.recordDigest('s', 'accounts', 'primary', 'world_x'),
    );
    expect(derivationA.recordDigest('s', 'accounts', 'primary', 'world_x')).not.toBe(
      UNKEYED_DERIVATION.recordDigest('s', 'accounts', 'primary', 'world_x'),
    );
    expect(derivationA.keyId).toBe('key_campaign_a');
  });

  it('a campaign world is reproducible from (spec, seed, scope, key) and isolated across keys', () => {
    const first = generateWorld(spec(), SEED, undefined, { derivation: derivationA });
    expect(generateWorld(spec(), SEED, undefined, { derivation: derivationA })).toEqual(first);
    const other = generateWorld(spec(), SEED, undefined, { derivation: derivationB });
    const unkeyed = generateWorld(spec(), SEED);
    expect(new Set([first.worldId, other.worldId, unkeyed.worldId]).size).toBe(3);
    const [idsA, idsB, idsPlain] = [idsOf(first), idsOf(other), idsOf(unkeyed)];
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
      expect(idsPlain.has(id)).toBe(false);
    }
    // Identity tokens are keyed too, so bindings never match across campaigns either.
    const subject = (world: typeof first) =>
      (
        world.collections.customers.find((row) => row._id === world.subjectHandle)!.data.identity as {
          id: string;
        }
      ).id;
    expect(new Set([subject(first), subject(other), subject(unkeyed)]).size).toBe(3);
  });

  it('a worker holding the visible world and the seed cannot recompute a target id with the public derivation', () => {
    const fixture = generateSealedFixture(spec(), SEED, undefined, undefined, { derivation: derivationA });
    const worldId = fixture.world.worldId;
    const publicGuess = (collection: string) =>
      `syn_${contentHash({ seed: SEED, collection, role: 'primary', instance: worldId }, 'fixture-record').slice(0, 24)}`;
    const targets = new Set(fixture.manifest.effects.map((effect) => effect.address.recordId));
    for (const collection of COLLECTION_IDS)
      expect(targets.has(publicGuess(collection)), collection).toBe(false);
    // The same attack on an unkeyed world succeeds: this is exactly what the key closes.
    const plain = generateSealedFixture(spec(), SEED);
    const plainTargets = new Set(plain.manifest.effects.map((effect) => effect.address.recordId));
    const plainGuess = (collection: string) =>
      `syn_${contentHash({ seed: SEED, collection, role: 'primary', instance: plain.world.worldId }, 'fixture-record').slice(0, 24)}`;
    expect(COLLECTION_IDS.every((collection) => plainTargets.has(plainGuess(collection)))).toBe(true);
  });

  it('the independent oracle derives the same keyed ids: every manifest address resolves in the keyed world', () => {
    for (const family of FAMILIES) {
      const seed = `keyed-${family}`;
      const fixture = generateSealedFixture(createWorldSpec({ family, seed }), seed, undefined, undefined, {
        derivation: derivationA,
      });
      const known = new Set(
        COLLECTION_IDS.flatMap((collection) =>
          fixture.world.collections[collection].map((row) =>
            addressKey({ collectionId: collection, recordId: row._id }),
          ),
        ),
      );
      expect(fixture.manifest.effects).toHaveLength(6);
      for (const effect of fixture.manifest.effects)
        expect(known.has(addressKey(effect.address)), `${family} ${effect.address.recordId}`).toBe(true);
      for (const entry of fixture.manifest.preservationHashes) {
        const row = fixture.world.collections[entry.address.collectionId].find(
          (candidate) => candidate._id === entry.address.recordId,
        );
        expect(valuesAtPath(row, entry.path)).toHaveLength(1);
      }
    }
  });

  it('keyed worlds still keep targets indistinguishable by shape', () => {
    for (const family of FAMILIES) {
      const seed = `keyed-shape-${family}`;
      const fixture = generateSealedFixture(createWorldSpec({ family, seed }), seed, undefined, undefined, {
        derivation: derivationA,
      });
      const targets = new Set(fixture.manifest.effects.map((effect) => addressKey(effect.address)));
      expect(shapeLeaks(evaluateShapeDetectors(fixture.world, targets)), family).toEqual([]);
    }
  });

  it('keys must be at least 256 bits and not degenerate; key ids are bounded identifiers; keys never appear in output', () => {
    for (const bad of [
      new Uint8Array(31),
      new Uint8Array(32),
      new Uint8Array(32).fill(7),
      'a'.repeat(64),
      null,
      Buffer.alloc(0),
    ]) {
      expect(() => assertDerivationKey(bad as never), String(bad)).toThrow(DerivationKeyError);
      expect(() => keyedDerivation(bad as never, 'key_x')).toThrow(DerivationKeyError);
    }
    for (const badId of ['', 'has space', 'x'.repeat(65), 'semi;colon'])
      expect(() => keyedDerivation(keyA, badId)).toThrow(DerivationKeyError);
    const minted = mintDerivationKey();
    expect(minted.key).toHaveLength(32);
    expect(minted.keyId).toMatch(/^key_[0-9a-f]{16}$/);
    expect(() => keyedDerivation(minted.key, minted.keyId)).not.toThrow();
    expect(mintDerivationKey().keyId).not.toBe(minted.keyId);
    const fixture = generateSealedFixture(spec(), SEED, undefined, undefined, { derivation: derivationA });
    const text = JSON.stringify(fixture);
    for (const needle of [
      Buffer.from(keyA).toString('hex'),
      Buffer.from(keyA).toString('base64'),
      JSON.stringify(Array.from(keyA)),
    ])
      expect(text).not.toContain(needle);
    expect(text).not.toContain('key_campaign_a');
  });
});
