import type { Job } from '@expunge/contracts';
import {
  ArtifactRepository,
  JobRepository,
  createPrincipalService,
  mongoConfigFromEnv,
  type MongoService,
} from '@expunge/mongo';
import { EnvModelResolver, errorCode, type ArtifactReader } from '@expunge/runtime';
import type { DispatchJobs, JobResolver } from './dispatch.js';
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
 * PARTIAL: a wake carries only {jobId, commandId}, so the actor is unknown until the job is read. Uses
 * `JobRepository.resolveForDispatch` when mongodb-authority lands it; until then the dispatcher principal reads
 * its own `jobs` collection directly. The row is only used to obtain the actor for `claim`; `claim` and every
 * later call re-check access through the repository.
 */
export class MongoJobResolver implements JobResolver {
  constructor(private readonly jobs: JobRepository) {}
  async resolve(jobId: string): Promise<Job | null> {
    const repository = this.jobs as JobRepository & { resolveForDispatch?: (id: string) => Promise<Job> };
    if (typeof repository.resolveForDispatch === 'function') {
      try {
        return await repository.resolveForDispatch(jobId);
      } catch (error) {
        if (errorCode(error) === 'JobNotFound') return null;
        throw error;
      }
    }
    return this.jobs.collection.findOne({ _id: jobId });
  }
}

export type MongoWiring = {
  service: MongoService;
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
    jobs: asDispatchJobs(jobs),
    resolver: new MongoJobResolver(jobs),
    artifacts: asArtifactReader(new ArtifactRepository(service)),
    receipts: new MongoCompletionReceiptReader(service),
    models: new EnvModelResolver(env),
  };
}
