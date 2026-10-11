import type { ScopeKey } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

export type WorldSplit = 'train' | 'protected' | 'validation' | 'final';
const HEX64 = /^[a-f0-9]{64}$/;
const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

/**
 * Which split a world belongs to, as one insert-only row written when the fixture builder seeds the world. Readers get
 * the committed assignment of a job's world and nothing else: the plan commitment, not the plan.
 */
export class WorldSplitRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<{ _id: string; split: WorldSplit; planCommitment: string }>(
      'world_splits',
    );
  }

  /** Assigns a split once. A second assignment of the same world is refused, never replaced. */
  async assign(scope: ScopeKey, worldId: string, split: WorldSplit, planCommitment: string): Promise<void> {
    requirePrincipal(this.service, ['fixture_builder', 'setup']);
    if (!worldId || !HEX64.test(planCommitment)) fail('InvalidWorldSplit');
    try {
      await this.rows.insertOne({
        _id: worldId,
        ...scopeFilter(scope),
        worldId,
        split,
        planCommitment,
        createdAt: new Date(),
      } as never);
    } catch (error) {
      if (isDuplicate(error)) fail('WorldSplitAlreadyAssigned');
      throw error;
    }
  }

  /** The committed split of the world a job is bound to, or null when the world has no assignment. */
  async splitOfJob(
    scope: ScopeKey,
    jobId: string,
  ): Promise<{ split: WorldSplit; planCommitment: string } | null> {
    requirePrincipal(this.service, ['observer', 'grader', 'fixture_builder', 'setup']);
    const job = await this.service.control.collection<{ binding: { worldId: string } }>('jobs').findOne(
      {
        _id: jobId as never,
        'actor.tenantId': scope.tenantId,
        'actor.env': scope.env,
        'actor.scopeId': scope.scopeId,
      },
      { projection: { 'binding.worldId': 1 } },
    );
    if (!job) fail('JobNotFound');
    const row = await this.rows.findOne({ _id: job.binding.worldId, ...scopeFilter(scope) });
    return row ? { split: row.split, planCommitment: row.planCommitment } : null;
  }
}
