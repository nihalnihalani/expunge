import type { ClientSession, Document } from 'mongodb';
import { scopeIdentity, type ActorContext, type AuthorityRevision, type ScopeKey } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

type AuthorityRow = AuthorityRevision & { _id: string };
type TouchRow = ScopeKey & { _id: string; authorizationRevision: number; touches: number; updatedAt: Date };
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The owner's live authorization state for a scope.
 *
 * `authority_revisions` is the authoritative row. Only setup and the approval issuer write it. Effects, completion,
 * promotion and rollback read it and then conditionally increment a touch counter in `authority_touches`, under
 * the revision they expect. Bumping the authority also rewrites the touch row in the same transaction, so a
 * transaction that read the old revision conflicts with the bump and aborts; a stale snapshot cannot commit.
 */
export class AuthorityRepository {
  constructor(readonly service: MongoService) {}

  private get rows() {
    return this.service.control.collection<AuthorityRow & Document>('authority_revisions');
  }
  private get touches() {
    return this.service.control.collection<TouchRow & Document>('authority_touches');
  }

  /** Creates the scope's authority row. Idempotent for identical input; different input is a conflict. */
  async install(key: ScopeKey, floorHash: string, authorizationRevision = 1): Promise<AuthorityRevision> {
    requirePrincipal(this.service, ['setup']);
    if (
      !HASH_PATTERN.test(floorHash) ||
      !Number.isSafeInteger(authorizationRevision) ||
      authorizationRevision < 1
    )
      fail('InvalidAuthority');
    const _id = scopeIdentity(key);
    const row: AuthorityRevision = {
      ...scopeFilter(key),
      authorizationRevision,
      floorHash,
      updatedAt: new Date(),
    };
    try {
      await this.service.transaction(async (session) => {
        await this.rows.insertOne({ _id, ...row }, { session });
        await this.touches.insertOne(
          { _id, ...scopeFilter(key), authorizationRevision, touches: 0, updatedAt: row.updatedAt },
          { session },
        );
      });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
      const stored = await this.read(key);
      if (stored.authorizationRevision !== authorizationRevision || stored.floorHash !== floorHash)
        fail('AuthorityConflict');
      return stored;
    }
    return row;
  }

  /**
   * Revokes every run pinned to the current revision: increments the stored revision (and optionally replaces the
   * floor hash) and rewrites the touch row in the same transaction. Returns the new row.
   */
  async bump(key: ScopeKey, floorHash?: string): Promise<AuthorityRevision> {
    requirePrincipal(this.service, ['approval_issuer', 'setup']);
    if (floorHash !== undefined && !HASH_PATTERN.test(floorHash)) fail('InvalidAuthority');
    const _id = scopeIdentity(key);
    return this.service.transaction(async (session) => {
      const next = await this.rows.findOneAndUpdate(
        { _id },
        {
          $inc: { authorizationRevision: 1 },
          $set: { updatedAt: new Date(), ...(floorHash === undefined ? {} : { floorHash }) },
        },
        { session, returnDocument: 'after', includeResultMetadata: false },
      );
      if (!next) fail('AuthorityMissing');
      await this.touches.updateOne(
        { _id },
        {
          $set: { authorizationRevision: next.authorizationRevision },
          $inc: { touches: 1 },
          $currentDate: { updatedAt: true },
        },
        { session },
      );
      const { _id: _ignored, ...row } = next;
      return row;
    });
  }

  async read(key: ScopeKey, session?: ClientSession): Promise<AuthorityRevision> {
    const row = await this.rows.findOne({ _id: scopeIdentity(key), ...scopeFilter(key) }, { session });
    // No stored authority means nobody has authorized this scope: fail closed.
    if (!row) fail('AuthorityMissing');
    const { _id: _ignored, ...authority } = row;
    return authority;
  }

  /**
   * Reads the authoritative row and conditionally writes the touch counter under `expectedRevision`. Throws
   * `AuthorityRevisionStale` when the stored revision differs, or when it changes before this transaction commits.
   */
  async fence(key: ScopeKey, expectedRevision: number, session: ClientSession): Promise<AuthorityRevision> {
    const authority = await this.read(key, session);
    if (authority.authorizationRevision !== expectedRevision) fail('AuthorityRevisionStale');
    const touched = await this.touches.updateOne(
      { _id: scopeIdentity(key), ...scopeFilter(key), authorizationRevision: expectedRevision },
      { $inc: { touches: 1 } },
      { session },
    );
    if (touched.matchedCount !== 1) fail('AuthorityRevisionStale');
    return authority;
  }

  /**
   * A `validateAuthority` callback for promotion and rollback that reads the stored authority row and fences it
   * under the actor's revision. It adds no check of its own beyond what `promote` already enforces; passing it
   * keeps callers honest about where the authority comes from.
   */
  validator(actor: ActorContext): (session: ClientSession) => Promise<void> {
    return async (session) => {
      await this.fence(actor, actor.authorizationRevision, session);
    };
  }
}
