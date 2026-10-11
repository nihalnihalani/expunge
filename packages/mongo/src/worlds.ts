import type { ClientSession, Document } from 'mongodb';
import type { ScopeKey, WorldRevision, WorldScopeBinding } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

type WorldCounter = ScopeKey & {
  _id: string;
  worldId: string;
  revision: number;
  updatedAt: Date;
  verificationSeq?: number;
};
type WorldBinding = WorldScopeBinding & { _id: string };

/**
 * A world is two rows with different owners.
 *
 * - `world_revisions` is a counter. Every controlled writer advances it in the same transaction as its writes,
 *   so the worker principal holds UPDATE on it.
 * - `world_scope_bindings` records which scope revision the world is bound to and whether it is in maintenance.
 *   Only setup and the fixture builder write it, so the worker cannot widen its own scope or lift maintenance.
 *
 * Changing a binding also advances the counter inside the same transaction. An effect in flight holds a write on
 * that counter, so it conflicts with the change instead of committing against a stale read of the binding.
 */
export class WorldRepository {
  constructor(readonly service: MongoService) {}

  private get counters() {
    return this.service.world.collection<WorldCounter & Document>('world_revisions');
  }
  private get bindings() {
    return this.service.world.collection<WorldBinding & Document>('world_scope_bindings');
  }

  /** Creates a world at revision 0 bound to `scopeRevision`. */
  async create(
    key: ScopeKey,
    worldId: string,
    scopeRevision: number,
    options: { maintenanceMode?: boolean } = {},
  ): Promise<void> {
    requirePrincipal(this.service, ['fixture_builder', 'setup']);
    if (!worldId || !Number.isSafeInteger(scopeRevision) || scopeRevision < 1) fail('InvalidWorld');
    const now = new Date();
    await this.service.transaction(async (session) => {
      await this.counters.insertOne(
        { _id: worldId, ...scopeFilter(key), worldId, revision: 0, updatedAt: now },
        { session },
      );
      await this.bindings.insertOne(
        {
          _id: worldId,
          ...scopeFilter(key),
          worldId,
          scopeRevision,
          maintenanceMode: options.maintenanceMode ?? false,
          updatedAt: now,
        },
        { session },
      );
    });
  }

  /** Binds the world to another scope revision and/or toggles maintenance, advancing the counter with it. */
  async rebind(
    key: ScopeKey,
    worldId: string,
    change: { scopeRevision?: number; maintenanceMode?: boolean },
  ): Promise<WorldRevision> {
    requirePrincipal(this.service, ['fixture_builder', 'setup']);
    if (
      change.scopeRevision !== undefined &&
      (!Number.isSafeInteger(change.scopeRevision) || change.scopeRevision < 1)
    )
      fail('InvalidWorld');
    const set: Document = { updatedAt: new Date() };
    if (change.scopeRevision !== undefined) set.scopeRevision = change.scopeRevision;
    if (change.maintenanceMode !== undefined) set.maintenanceMode = change.maintenanceMode;
    await this.service.transaction(async (session) => {
      const bound = await this.bindings.updateOne(
        { _id: worldId, ...scopeFilter(key) },
        { $set: set },
        { session },
      );
      if (bound.matchedCount !== 1) fail('UnknownWorld');
      const advanced = await this.counters.updateOne(
        { _id: worldId, ...scopeFilter(key) },
        { $inc: { revision: 1 }, $currentDate: { updatedAt: true } },
        { session },
      );
      if (advanced.matchedCount !== 1) fail('UnknownWorld');
    });
    return this.read(key, worldId);
  }

  /** The logical world revision: the counter joined with its trusted binding. */
  async read(key: ScopeKey, worldId: string, session?: ClientSession): Promise<WorldRevision> {
    const counter = await this.counters.findOne({ _id: worldId, ...scopeFilter(key) }, { session });
    const binding = await this.bindings.findOne({ _id: worldId, ...scopeFilter(key) }, { session });
    if (!counter || !binding) fail('UnknownWorld');
    return {
      ...scopeFilter(key),
      worldId,
      revision: counter.revision,
      scopeRevision: binding.scopeRevision,
      maintenanceMode: binding.maintenanceMode,
      updatedAt: counter.updatedAt,
    };
  }

  /**
   * Confirms the world exists under this scope, is bound to `scopeRevision` and is not in maintenance. A run or
   * an effect is bound to a world through this check, not through a free string.
   */
  async assertRunnable(
    key: ScopeKey,
    worldId: string,
    scopeRevision: number,
    session?: ClientSession,
  ): Promise<WorldRevision> {
    const world = await this.read(key, worldId, session);
    if (world.maintenanceMode) fail('WorldInMaintenance');
    if (world.scopeRevision !== scopeRevision) fail('StaleWorldBinding');
    return world;
  }

  /** Conditionally advances the counter from `expectedRevision`. A zero match means someone else wrote first. */
  async advance(
    key: ScopeKey,
    worldId: string,
    expectedRevision: number,
    session: ClientSession,
  ): Promise<number> {
    const next = await this.counters.findOneAndUpdate(
      { _id: worldId, ...scopeFilter(key), revision: expectedRevision },
      { $inc: { revision: 1 }, $currentDate: { updatedAt: true } },
      { session, returnDocument: 'after', includeResultMetadata: false },
    );
    if (!next) fail('StaleWorldRevision');
    return next.revision;
  }

  /** Conditionally records that a verification sweep ran at exactly `verifiedRevision`. */
  async markVerified(
    key: ScopeKey,
    worldId: string,
    verifiedRevision: number,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.counters.updateOne(
      { _id: worldId, ...scopeFilter(key), revision: verifiedRevision },
      { $inc: { verificationSeq: 1 }, $currentDate: { updatedAt: true } },
      { session },
    );
    if (result.modifiedCount !== 1) fail('StaleVerification');
  }
}
