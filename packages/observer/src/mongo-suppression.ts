import { createHash } from 'node:crypto';
import { ErasureSuppressionRepository, type MongoService } from '@expunge/mongo';
import type { ExportSuppression } from './outbox-dispatcher.js';

/**
 * The key an erasure suppression row carries for a provider-side user id: `sha256:` plus the hex digest of the id, for EVERY
 * id. Hashing all of them keeps the mapping injective by construction (a user whose raw id happens to look like a key
 * cannot collide with another user's key, which would let releasing one lift the other's suppression), and it keeps
 * long or oddly shaped ids valid as row identifiers. The privacy controller writes with this function and the observer
 * reads with it, so both sides agree on which ids are suppressed.
 */
export function suppressionUserKey(userId: string): string {
  return `sha256:${createHash('sha256').update(userId, 'utf8').digest('hex')}`;
}

/** A set of suppression keys whose membership test accepts the raw provider user id. */
class KeyedUserIdSet extends Set<string> {
  override has(userId: string): boolean {
    return super.has(suppressionUserKey(userId));
  }
}

/**
 * The observer's export-suppression source: the `erasure_suppressions` rows of the provider organization (all scopes),
 * read through the narrow repository the observer principal is granted. An unreadable list throws, which the dispatcher
 * turns into a HELD row (never a send), and so does a list longer than `limit`.
 */
export function createMongoExportSuppression(
  service: MongoService,
  options: { limit?: number } = {},
): ExportSuppression {
  const repository = new ErasureSuppressionRepository(service);
  return {
    async suppressedUserIds(providerOrganizationId: string) {
      const cap = Math.min(options.limit ?? 10_000, 49_999);
      const keys = await repository.activeUserKeys(providerOrganizationId, cap + 1);
      // A list longer than the bound would be a PARTIAL list, and a partial suppression list is fail-open: hold instead.
      if (keys.length > cap) throw new Error('SuppressionListTruncated');
      return new KeyedUserIdSet(keys);
    },
  };
}
