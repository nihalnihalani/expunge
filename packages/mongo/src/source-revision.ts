import type { ChangeStream, Document } from 'mongodb';
import { contentHash } from '@expunge/contracts';
import { fail, requirePrincipal, type MongoService } from './client.js';
import type { NativeSourceAdapter } from './native-adapter.js';
import type { SourceScope } from './owner-source.js';

/**
 * The revision of a source nobody controls. A synthetic world has a counter its one writer advances in the same
 * transaction as its writes. A native owner database is written by the owner's applications at any time, so the
 * only honest revision is what has been OBSERVED: the number of change-stream events consumed so far, plus an
 * `epoch` that changes whenever the stream's history is lost (the resume token fell off the oplog, a collection was
 * dropped or renamed), after which nothing derived earlier can be trusted.
 *
 * A plan records `{observedSeq, epoch}` when it reads. It is advisory for derived state (an ownership closure, a
 * candidate list): if the pair moved, the derived state may be stale and the caller re-reads. It does not guard a
 * write; every write is guarded by its own document's preimage (see `NativeSourceAdapter.applyEffect`).
 */
export type SourceState = SourceScope & {
  _id: string;
  sourceId: string;
  observedSeq: number;
  epoch: number;
  /** Resume token per physical database the source's namespaces live in. */
  resumeTokens: Record<string, Document>;
  updatedAt: Date;
};
export type SourceRevision = { observedSeq: number; epoch: number };

const scopeOf = (scope: SourceScope) => ({
  tenantId: scope.tenantId,
  env: scope.env,
  scopeId: scope.scopeId,
});
const HISTORY_LOST = new Set([280, 286]);
const stateId = (scope: SourceScope, sourceId: string) =>
  contentHash({ ...scopeOf(scope), sourceId }, 'owner-source-state');
const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

export class SourceRevisionRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.world.collection<SourceState & Document>('owner_source_state');
  }

  async current(scope: SourceScope, sourceId: string): Promise<SourceRevision & { resumable: boolean }> {
    const row = await this.rows.findOne({ _id: stateId(scope, sourceId), ...scopeOf(scope) });
    if (!row) return fail('SourceNotObserved');
    return {
      observedSeq: row.observedSeq,
      epoch: row.epoch,
      resumable: Object.keys(row.resumeTokens).length > 0,
    };
  }

  private async ensure(scope: SourceScope, sourceId: string): Promise<SourceState> {
    const _id = stateId(scope, sourceId);
    const found = await this.rows.findOne({ _id, ...scopeOf(scope) });
    if (found) return found;
    try {
      await this.rows.insertOne({
        _id,
        ...scopeOf(scope),
        sourceId,
        observedSeq: 0,
        epoch: 1,
        resumeTokens: {},
        updatedAt: new Date(),
      } as never);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
    const row = await this.rows.findOne({ _id, ...scopeOf(scope) });
    return row ?? fail('SourceNotObserved');
  }

  /**
   * Consumes every change event the source has right now (bounded) and advances the stored revision by compare and
   * set. The first call has no resume token and starts at "now": anything before it was never observed, so a plan
   * must call `observe` before it reads. Returns the revision after the drain.
   */
  async observe(
    scope: SourceScope,
    adapter: NativeSourceAdapter,
    options: { maxEvents?: number; quietMs?: number } = {},
  ): Promise<SourceRevision & { consumed: number; historyLost: boolean }> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    const maxEvents = options.maxEvents ?? 5000;
    const quietMs = options.quietMs ?? 250;
    const sourceId = adapter.registration.sourceId;
    // One $match clause per physical collection: a document event counts only when the document belongs to the namespace's
    // tenant. A delete carries no document (only its key), and a drop/rename concerns the whole collection, so those count
    // unconditionally: the revision is advisory, and over-counting is the safe direction.
    const byDatabase = new Map<string, Document[]>();
    for (const { database, collection, tenant } of adapter.physicalNamespaces())
      byDatabase.set(database, [
        ...(byDatabase.get(database) ?? []),
        {
          'ns.coll': collection,
          $or: [
            { operationType: { $in: ['delete', 'drop', 'rename', 'dropDatabase', 'invalidate'] } },
            { [`fullDocument.${tenant.path}`]: tenant.value },
          ],
        },
      ]);
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.ensure(scope, sourceId);
      let consumed = 0;
      let lost = false;
      const tokens: Record<string, Document> = { ...state.resumeTokens };
      for (const [database, clauses] of byDatabase) {
        let stream: ChangeStream | null = null;
        try {
          stream = adapter.dbOf(database).watch([{ $match: { $or: clauses } }], {
            fullDocument: 'updateLookup',
            maxAwaitTimeMS: quietMs,
            ...(tokens[database] ? { resumeAfter: tokens[database] } : {}),
          });
          while (consumed < maxEvents) {
            const change = await stream.tryNext();
            if (change === null) break;
            // Dropping, renaming or invalidating a collection makes everything derived earlier untrustworthy.
            if (['drop', 'rename', 'dropDatabase', 'invalidate'].includes(change.operationType)) lost = true;
            consumed++;
          }
          const token = stream.resumeToken as Document | undefined;
          if (token) tokens[database] = token;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : 0;
          if (!HISTORY_LOST.has(code)) throw error;
          lost = true;
          delete tokens[database];
        } finally {
          if (stream) await stream.close().catch(() => undefined);
        }
      }
      const moved = await this.rows.findOneAndUpdate(
        { _id: state._id, observedSeq: state.observedSeq, epoch: state.epoch },
        {
          $inc: { observedSeq: consumed, epoch: lost ? 1 : 0 },
          $set: { resumeTokens: lost ? {} : tokens, updatedAt: new Date() },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      // Another worker advanced the same row first: discard this batch (its events are re-read from the stored token).
      if (!moved) continue;
      return { observedSeq: moved.observedSeq, epoch: moved.epoch, consumed, historyLost: lost };
    }
    return fail('SourceRevisionContention');
  }

  /** True when the source may have changed (or its history was lost) since `planned` was read. */
  async moved(scope: SourceScope, sourceId: string, planned: SourceRevision): Promise<boolean> {
    const now = await this.current(scope, sourceId);
    return now.epoch !== planned.epoch || now.observedSeq !== planned.observedSeq;
  }
}
