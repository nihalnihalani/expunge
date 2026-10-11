/**
 * The export-suppression read never takes a bound above the repository's own maximum, so a complete list at the maximum
 * is still refused rather than trusted. FAKE service (no database): the repository honors the pipeline's $limit and, like
 * the real one, fails closed when more than its bound exist.
 */
import { describe, expect, it } from 'vitest';
import type { MongoService } from '@expunge/mongo';
import { createMongoExportSuppression, suppressionUserKey } from '../src/mongo-suppression.js';

function fakeService(count: number) {
  const keys = Array.from({ length: count }, (_, i) => suppressionUserKey(`u_${i}`));
  return {
    principal: 'observer',
    control: {
      collection: () => ({
        aggregate: (pipeline: Array<Record<string, unknown>>) => {
          const limit = (pipeline.find((stage) => '$limit' in stage) as { $limit: number }).$limit;
          return { toArray: async () => keys.slice(0, limit).map((_id) => ({ _id })) };
        },
      }),
    },
  } as unknown as MongoService;
}

describe('FAKE-service suppression read ceiling', () => {
  it('a caller bound above the repository maximum is clamped, so a list at the maximum HOLDS', async () => {
    // 50 000 keys is the repository's own maximum. A caller asking for 100 000 must not be able to read it as "complete".
    await expect(
      createMongoExportSuppression(fakeService(50_000), { limit: 100_000 }).suppressedUserIds('org'),
    ).rejects.toThrow();
  });

  it('a list under the ceiling is answered, including with a very large caller bound', async () => {
    const ids = await createMongoExportSuppression(fakeService(49_998), { limit: 100_000 }).suppressedUserIds(
      'org',
    );
    expect(ids.has('u_0')).toBe(true);
    expect(ids.has('u_49997')).toBe(true);
    expect(ids.has('u_49998')).toBe(false);
  });
});
