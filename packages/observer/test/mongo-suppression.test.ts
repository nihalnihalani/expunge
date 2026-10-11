/**
 * The observer's Mongo export-suppression source against a FAKE service (no database): key mapping, raw-id lookups, the
 * principal boundary, and the bounded read that HOLDS instead of answering from a partial list. The real collection is
 * covered by packages/privacy/test/adapters.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { MongoService } from '@expunge/mongo';
import { createMongoExportSuppression, suppressionUserKey } from '../src/mongo-suppression.js';

/** FAKE service: `erasure_suppressions` holds the given keys; honors the pipeline's $limit and records it. */
function fakeService(principal: string, keys: string[]) {
  const asked: number[] = [];
  const service = {
    principal,
    control: {
      collection: () => ({
        aggregate: (pipeline: Array<Record<string, unknown>>) => {
          const limit = (pipeline.find((stage) => '$limit' in stage) as { $limit: number }).$limit;
          asked.push(limit);
          return { toArray: async () => keys.slice(0, limit).map((userKey) => ({ _id: userKey })) };
        },
      }),
    },
  } as unknown as MongoService;
  return { service, asked };
}

describe('FAKE-service observer export suppression', () => {
  it('hashes EVERY id: stable, distinct per id, and a literal sha256:<hex> id never collides with the id that hashes to that hex', () => {
    const odd = 'user with spaces & ünïcode';
    for (const id of ['u_a', odd, 'x'.repeat(300)])
      expect(suppressionUserKey(id)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(suppressionUserKey(odd)).toBe(suppressionUserKey(odd));
    expect(suppressionUserKey(odd)).not.toBe(suppressionUserKey(`${odd}x`));
    expect(suppressionUserKey('u_a')).not.toBe('u_a');
    // The collision the earlier identity-for-valid-ids mapping allowed.
    const hex = suppressionUserKey(odd).slice('sha256:'.length);
    const lookalike = `sha256:${hex}`; // a different user whose RAW id is the key string of `odd`
    expect(suppressionUserKey(lookalike)).not.toBe(suppressionUserKey(odd));
  });

  it('answers for RAW user ids through the mapped keys', async () => {
    const odd = 'user with spaces';
    const { service } = fakeService('observer', [suppressionUserKey('u_a'), suppressionUserKey(odd)]);
    const ids = await createMongoExportSuppression(service).suppressedUserIds('org-1');
    expect(ids.has('u_a')).toBe(true);
    expect(ids.has(odd)).toBe(true);
    expect(ids.has('u_b')).toBe(false);
    // The lookalike user (raw id = odd's key string) is NOT suppressed by odd's row.
    expect(ids.has(suppressionUserKey(odd))).toBe(false);
  });

  it('a list that reaches its bound is partial and throws (the dispatcher HOLDS); one under the bound answers', async () => {
    const { service, asked } = fakeService('observer', ['k1', 'k2', 'k3'].map(suppressionUserKey));
    await expect(
      createMongoExportSuppression(service, { limit: 2 }).suppressedUserIds('org-1'),
    ).rejects.toThrow('SuppressionListTruncated');
    expect(asked).toEqual([4]); // the repository asks for one more than the (bound + 1) it was given
    const exact = await createMongoExportSuppression(service, { limit: 3 }).suppressedUserIds('org-1');
    expect(exact.has('k3')).toBe(true);
  });

  it('refuses a principal that is not allowed to read the list', async () => {
    const { service } = fakeService('promoter', ['u_a']);
    await expect(createMongoExportSuppression(service).suppressedUserIds('org-1')).rejects.toThrow(
      'PrincipalBoundary',
    );
  });
});
