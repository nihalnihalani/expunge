import type { ActorContext, Job, RunBinding } from '@expunge/contracts';
import { DeploymentRepository, JobRepository, fail, scopeFilter, type MongoService } from '@expunge/mongo';

export type PinnedJobRequest = {
  actor: ActorContext;
  jobId?: string;
  /** Everything of the run binding except the harness: that is read from the deployment pointer, never accepted. */
  binding: Omit<RunBinding, 'jobId' | 'harnessHash'>;
};

/**
 * Creates a cleanup job pinned to the harness the scope has deployed NOW. The pin is the active pointer's hash at this
 * moment; the request has no field to name another one. A promotion or a rollback afterwards does not change the job:
 * its binding is stored, and a run that already started keeps the bundle it started with (spec: existing runs stay
 * version-pinned; live revocation still applies). `JobRepository.create` independently refuses a cleanup whose pin is not
 * the deployed hash (`HarnessNotDeployed`), and the worker checks the pin again when it claims a queued job.
 */
export async function createPinnedCleanupJob(service: MongoService, request: PinnedJobRequest): Promise<Job> {
  const key = { ...scopeFilter(request.actor), target: 'worker' as const };
  const pointer = await new DeploymentRepository(service).read(key);
  if (!pointer) fail('DeploymentMissing');
  return new JobRepository(service).create(request.actor, {
    ...(request.jobId ? { jobId: request.jobId } : {}),
    kind: 'cleanup',
    binding: { ...request.binding, harnessHash: pointer.activeHash },
  });
}
