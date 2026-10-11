import type { ClientSession } from 'mongodb';
import { contentHash, type ScopeKey } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

export type GuardExport = {
  providerOrganizationId: string;
  generation: number;
  /** The subject-set generation read BEFORE the exported subject list was read. The guard covers at least that set. */
  subjectSetGeneration: number;
  count: number;
  /** Digest of the exported guard file contents; the observer compares it with the file it holds. */
  digest: string;
  exportedAt: Date;
};
export type StoredGuardExport = ScopeKey & GuardExport & { _id: string; createdAt: Date };
const HASH = /^[a-f0-9]{64}$/;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const subjectSetId = (scope: ScopeKey): string => contentHash(scopeFilter(scope), 'subject-set-generation');

/**
 * Bumps the scope's subject-set generation. Called ONLY inside the transaction that registers (or purges) subject tokens, so
 * the bump and the registration commit together or not at all.
 */
export async function bumpSubjectSetGeneration(
  service: MongoService,
  scope: ScopeKey,
  session: ClientSession,
): Promise<number> {
  const row = await service.control
    .collection<{ _id: string; generation: number }>('subject_set_generations')
    .findOneAndUpdate(
      { _id: subjectSetId(scope) },
      {
        $inc: { generation: 1 },
        $set: { updatedAt: new Date() },
        $setOnInsert: { ...scopeFilter(scope) },
      } as never,
      { upsert: true, returnDocument: 'after', session, includeResultMetadata: false },
    );
  return row!.generation;
}

/**
 * The leak guard's export generation, written by the privacy controller each time it exports the guard, so the observer can
 * HOLD on a guard file that is older than the latest export OR does not cover the current subject set. Insert-only;
 * generations only rise.
 *
 * Freshness has two parts. The file's own generation must be the latest (a stale file). And the latest export must cover the
 * CURRENT subject set: an export records the subject-set generation it read before it read the subject list, and registering a
 * subject bumps that generation in the registering transaction, so a subject registered after the export leaves the current
 * generation ahead of the recorded one (`status().covered === false`).
 */
export class GuardExportRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<StoredGuardExport>('guard_exports');
  }
  private get sets() {
    return this.service.control.collection<{ _id: string; generation: number }>('subject_set_generations');
  }

  /** The scope's current subject-set generation (0 when no subject was ever registered). */
  async subjectSetGeneration(scope: ScopeKey, session?: ClientSession): Promise<number> {
    requirePrincipal(this.service, ['privacy_controller', 'observer', 'setup']);
    const row = await this.sets.findOne({ _id: subjectSetId(scope) }, { session });
    return row?.generation ?? 0;
  }

  /**
   * Records one export. `expectedLatestGeneration` is the generation of the latest export the caller saw (null when there was
   * none) BEFORE it read the subject-set generation and the subject list; the record is refused with `GuardExportRaced` when
   * another export got in since, so an older subject snapshot can never become the latest. The recorded subject-set
   * generation can neither run ahead of the current one nor fall behind the previous export's.
   */
  async record(
    scope: ScopeKey,
    input: GuardExport,
    expectedLatestGeneration?: number | null,
  ): Promise<StoredGuardExport> {
    requirePrincipal(this.service, ['privacy_controller']);
    // Optional only in the type, so a caller written against the older two-argument port still compiles; at run time an
    // unconditional record is refused, because it is exactly what lets an older subject snapshot become the latest.
    if (expectedLatestGeneration === undefined) fail('GuardExportNotConditional');
    if (
      !input.providerOrganizationId ||
      input.providerOrganizationId.length > 256 ||
      !isCount(input.generation) ||
      input.generation < 1 ||
      typeof input.subjectSetGeneration !== 'number' ||
      !isCount(input.subjectSetGeneration) ||
      !isCount(input.count) ||
      !HASH.test(input.digest) ||
      !(input.exportedAt instanceof Date) ||
      Number.isNaN(input.exportedAt.getTime()) ||
      (expectedLatestGeneration !== null && !isCount(expectedLatestGeneration))
    )
      fail('InvalidGuardExport');
    const _id = contentHash(
      { ...scopeFilter(scope), org: input.providerOrganizationId, generation: input.generation },
      'guard-export-row',
    );
    const same = (stored: StoredGuardExport): boolean =>
      stored.count === input.count &&
      stored.digest === input.digest &&
      stored.subjectSetGeneration === input.subjectSetGeneration &&
      stored.exportedAt.getTime() === input.exportedAt.getTime();
    return this.service.transaction(async (session) => {
      const existing = await this.rows.findOne({ _id }, { session });
      if (existing) return same(existing) ? existing : fail('GuardExportConflict');
      const newest = await this.rows.findOne(
        { ...scopeFilter(scope), providerOrganizationId: input.providerOrganizationId },
        { sort: { generation: -1 }, session },
      );
      if ((newest?.generation ?? null) !== expectedLatestGeneration) fail('GuardExportRaced');
      if (newest && newest.generation > input.generation) fail('GuardGenerationRegression');
      if (newest && newest.subjectSetGeneration > input.subjectSetGeneration)
        fail('GuardGenerationRegression');
      const current = (await this.sets.findOne({ _id: subjectSetId(scope) }, { session }))?.generation ?? 0;
      if (input.subjectSetGeneration > current) fail('InvalidGuardExport');
      const row: StoredGuardExport = { _id, ...scopeFilter(scope), ...input, createdAt: new Date() };
      await this.rows.insertOne(row as never, { session });
      return row;
    });
  }

  /** The newest export for an organization by generation, or null when the guard was never exported. */
  async latest(scope: ScopeKey, providerOrganizationId: string): Promise<StoredGuardExport | null> {
    requirePrincipal(this.service, ['privacy_controller', 'observer', 'setup']);
    return this.rows.findOne({ ...scopeFilter(scope), providerOrganizationId }, { sort: { generation: -1 } });
  }

  /**
   * What the observer needs in one read: the latest export, the current subject-set generation, and whether the latest export
   * covers it. `covered` is false when there is no export or a subject was registered after the one it read.
   */
  async status(
    scope: ScopeKey,
    providerOrganizationId: string,
  ): Promise<{ latest: StoredGuardExport | null; subjectSetGeneration: number; covered: boolean }> {
    requirePrincipal(this.service, ['privacy_controller', 'observer', 'setup']);
    const latest = await this.latest(scope, providerOrganizationId);
    const subjectSetGeneration = await this.subjectSetGeneration(scope);
    return {
      latest,
      subjectSetGeneration,
      covered: latest !== null && latest.subjectSetGeneration >= subjectSetGeneration,
    };
  }
}
