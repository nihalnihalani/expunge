import { z } from 'zod';
import { contentHash, type ActorContext, type ScopeKey } from '@expunge/contracts';
import { DeploymentRepository, ProtocolError } from '@expunge/mongo';
import type { DomainEnv } from '../env.js';
import type { ServiceConfig } from './config.js';
import { ServiceRefusal } from './errors.js';
import { operatorPreview, subjectRequestSchema } from './preview.js';

export const submitRequestSchema = z
  .object({
    requestKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    worldId: z.string().min(1).max(128),
    previewId: z.string().regex(/^[a-f0-9]{64}$/),
    subject: subjectRequestSchema,
  })
  .strict();
export type SubmitRequest = z.infer<typeof submitRequestSchema>;

export const cancelRequestSchema = z.object({ reason: z.string().max(200).optional() }).strict();

const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

/** Sends a wake command to the worker. The job is already queued, so a failure here only delays pickup. */
export type WakeSender = (jobId: string) => Promise<boolean>;

/**
 * Registers a submitted job's subject in the privacy registry, idempotently. Supplied by the composition root on a
 * privacy_controller principal: the owner actor that submits jobs (domain_executor) cannot write the registry.
 */
export type SubjectRegistrar = (
  scope: ScopeKey,
  input: { jobId: string; subjectHandle: string },
) => Promise<unknown>;

export function httpWakeSender(
  wake: { origin: string; token: string },
  transport: typeof fetch = fetch,
): WakeSender {
  return async (jobId) => {
    try {
      const response = await transport(new URL('/internal/wake', wake.origin), {
        method: 'POST',
        headers: { Authorization: `Bearer ${wake.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, commandId: `wake:${jobId}` }),
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

/** The actor every write is made as: the configured owner, at the scope's stored authorization revision. */
async function ownerActor(env: DomainEnv, config: ServiceConfig): Promise<ActorContext> {
  const stored = await env.authority.read(config.owner.scope).catch((error: unknown) => {
    if (error instanceof ProtocolError && error.code === 'AuthorityMissing')
      throw new ServiceRefusal(503, 'scope_not_authorized');
    throw error;
  });
  return {
    ...config.owner.scope,
    actorId: config.owner.ownerId,
    authorizationRevision: stored.authorizationRevision,
  };
}

/**
 * Queues a cleanup job from a preview the owner saw. The preview is recomputed first and its id must still match, so
 * a world that changed since is refused (409). The job is pinned to the scope's active worker harness and to the
 * configured frozen worker profile; neither comes from the request. The submission is idempotent on `requestKey`.
 * The job starts with no plan: the worker's own `preview_cleanup` makes the only plan that can be applied.
 */
export async function submitCleanup(
  env: DomainEnv,
  config: ServiceConfig,
  deployments: DeploymentRepository,
  wake: WakeSender | null,
  request: SubmitRequest,
  registerSubject: SubjectRegistrar | null = null,
): Promise<{ jobId: string; status: string }> {
  if (!config.workerProfileHash) throw new ServiceRefusal(501, 'unsupported');
  const preview = await operatorPreview(env, config, {
    worldId: request.worldId,
    subject: request.subject,
  });
  if (preview.previewId !== request.previewId) throw new ServiceRefusal(409, 'conflict');
  const scope = config.owner.scope;
  const deployment = await deployments.read({ ...scope, target: 'worker' });
  if (!deployment) throw new ServiceRefusal(409, 'no_active_harness');
  const actor = await ownerActor(env, config);
  const jobId = `job_${contentHash({ ...scope, requestKey: request.requestKey }, 'job-request').slice(0, 40)}`;
  try {
    // The subject is stored first: a job without one cannot resolve anything, and the same request finds it again.
    await env.store.putSubject(actor, jobId, request.subject);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === 'SubjectConflict')
      throw new ServiceRefusal(409, 'conflict');
    throw error;
  }
  try {
    await env.jobs.create(actor, {
      jobId,
      kind: 'cleanup',
      binding: {
        runId: `run_${jobId.slice(4)}`,
        worldId: request.worldId,
        harnessHash: deployment.activeHash,
        scopeRevision: preview.scopeRevision,
        workerProfileHash: config.workerProfileHash,
      },
    });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const existing = await env.jobs.readAuthorized(actor, jobId);
    // A resubmission registers again (a no-op when it is there), which also heals a crash between create and register.
    await register(registerSubject, scope, jobId, request.subject.value);
    return { jobId, status: existing.status };
  }
  // Registered before the wake, so the job's evidence finds its subject in the registry and the guard covering it.
  await register(registerSubject, scope, jobId, request.subject.value);
  if (wake) await wake(jobId);
  return { jobId, status: 'queued' };
}

/**
 * The job is already queued when this runs; a failure answers 503 with a closed code (never the cause, which could name
 * the subject), and the same request key retried registers it.
 */
async function register(
  registerSubject: SubjectRegistrar | null,
  scope: ScopeKey,
  jobId: string,
  subjectHandle: string,
): Promise<void> {
  if (!registerSubject) return;
  try {
    await registerSubject(scope, { jobId, subjectHandle });
  } catch {
    throw new ServiceRefusal(503, 'subject_registry_unavailable');
  }
}

/** Records the owner's cancellation request. A job nobody is running is cancelled at once; a running one stops at its next tool call. */
export async function cancelJob(
  env: DomainEnv,
  config: ServiceConfig,
  jobId: string,
): Promise<{ accepted: boolean; sequence: number | null }> {
  const actor = await ownerActor(env, config);
  let job;
  try {
    job = await env.jobs.readAuthorized(actor, jobId);
  } catch (error) {
    if (error instanceof ProtocolError || (error instanceof Error && error.message === 'UnauthorizedJob'))
      throw new ServiceRefusal(404, 'not_found');
    throw error;
  }
  await env.jobs.cancel(actor, jobId);
  const event = await env.projections.append(config.owner.scope, {
    eventId: `${jobId}:cancel_requested`,
    jobId,
    runId: job.binding.runId,
    artifactIds: [],
    kind: 'cancel_requested',
    payload: { requestedAt: new Date().toISOString(), by: 'owner' },
  });
  return { accepted: true, sequence: event.sequence };
}
