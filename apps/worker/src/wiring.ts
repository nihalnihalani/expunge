import type { Job } from '@expunge/contracts';
import {
  ArtifactRepository,
  JobRepository,
  ProjectionRepository,
  WakeCommandRepository,
  createPrincipalService,
  mongoConfigFromEnv,
  type MongoService,
} from '@expunge/mongo';
import { EnvModelResolver, errorCode, type ArtifactReader } from '@expunge/runtime';
import type { DispatchJobs, JobResolver, ProjectionSink } from './dispatch.js';
import type { WakeCommand, WakeCommandStore, WakeDecision } from './wake.js';
import { MongoCompletionReceiptReader } from './receipts.js';

/**
 * Compile-time conformance: the real repositories must satisfy the ports the dispatcher and runtime use.
 * If a signature in packages/mongo drifts, `npm run typecheck` fails here.
 */
export function asDispatchJobs(repository: JobRepository): DispatchJobs {
  return repository;
}
export function asArtifactReader(repository: ArtifactRepository): ArtifactReader {
  return repository;
}

/**
 * A wake carries only {jobId, commandId}, so the actor is unknown until the job is read. This is
 * `JobRepository.resolveForDispatch` (principal-gated, returns the stored row). The row is only used to obtain the
 * actor for `claim`; `claim` and every later call re-check access through the repository.
 */
export class MongoJobResolver implements JobResolver {
  constructor(private readonly jobs: JobRepository) {}
  async resolve(jobId: string): Promise<Job | null> {
    try {
      return await this.jobs.resolveForDispatch(jobId);
    } catch (error) {
      if (errorCode(error) === 'JobNotFound') return null;
      throw error;
    }
  }
}

/** Durable wake-command dedupe: one insert-only row per commandId in `wake_commands` (unique `_id`). */
export class MongoWakeCommandStore implements WakeCommandStore {
  constructor(private readonly repository: WakeCommandRepository) {}
  async accept(command: WakeCommand): Promise<WakeDecision> {
    const result = await this.repository.accept(command);
    return result.accepted ? 'accepted' : 'duplicate';
  }
  /** The worker principal has INSERT only on wake_commands; an accepted id cannot be withdrawn (the recovery poll covers it). */
  async release(): Promise<void> {}
}

export function asProjectionSink(repository: ProjectionRepository): ProjectionSink {
  return repository;
}

export type MongoWiring = {
  service: MongoService;
  wakeStore: MongoWakeCommandStore;
  projection: ProjectionSink;
  jobs: DispatchJobs;
  resolver: JobResolver;
  artifacts: ArtifactReader;
  receipts: MongoCompletionReceiptReader;
  models: EnvModelResolver;
};

/** The worker's ONLY database identity is the domain_executor principal; there is no fallback to another URI. */
export function createMongoWiring(env: NodeJS.ProcessEnv): MongoWiring {
  const service = createPrincipalService(mongoConfigFromEnv(env), 'domain_executor');
  const jobs = new JobRepository(service);
  return {
    service,
    wakeStore: new MongoWakeCommandStore(new WakeCommandRepository(service)),
    projection: asProjectionSink(new ProjectionRepository(service)),
    jobs: asDispatchJobs(jobs),
    resolver: new MongoJobResolver(jobs),
    artifacts: asArtifactReader(new ArtifactRepository(service)),
    receipts: new MongoCompletionReceiptReader(service),
    models: new EnvModelResolver(env),
  };
}
