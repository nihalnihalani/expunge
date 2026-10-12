import type { ScopeKey } from '@expunge/contracts';
import { GuardExportRepository, SubjectTokenRepository, type MongoService } from '@expunge/mongo';
import { jobTelemetryUserId } from '@expunge/observability';
import { PrivacyError } from './errors.js';
import { exportGuardFile, type GuardExportPort } from './export-guard.js';
import type { SubjectTokenStore } from './ports.js';
import { registerSubjectTokens } from './registry.js';

/** The provider whose opaque ids a cleanup job's episode carries. */
export const JOB_SUBJECT_PROVIDER = 'raindrop';
const MAX_TOKENS = 100;
const RACE_RETRIES = 3;

/** Where the leak guard is re-exported when a registration leaves the latest export behind the subject set. */
export type JobSubjectGuard = { path: string; providerOrganizationId: string };

/** The guard-export port plus the one coverage read (`GuardExportRepository.status`). */
export interface GuardCoveragePort extends GuardExportPort {
  status(scope: ScopeKey, providerOrganizationId: string): Promise<{ covered: boolean }>;
}

export type JobSubjectRegistration = {
  /** `created` when this call wrote a new token generation, `exists` when the job's token was already registered. */
  registered: 'created' | 'exists';
  /** The guard export generation this call wrote, or null when the latest export already covered the subject set. */
  guardGeneration: number | null;
};

/**
 * Registers a submitted cleanup job's subject in the privacy registry: the subject handle (the literal the leak guard
 * forbids, held only in `subject_tokens`) mapped to the job's opaque Raindrop telemetry id, the same id the worker stamps
 * on the job's episode. Idempotent: a job whose token is already in the subject's latest generation changes nothing.
 * Another job for the same subject adds its token as the next generation (the union of the previous tokens and the new
 * one), so `tokensFor` keeps returning every job's id. Registering bumps the scope's subject-set generation in the same
 * transaction; when a guard target is given and the latest guard export no longer covers the subject set, the guard is
 * re-exported so the observer does not HOLD on it. Run as the privacy_controller principal. Nothing here logs or returns
 * the handle.
 */
export async function registerJobSubject(
  deps: { tokens: SubjectTokenStore; exports?: GuardCoveragePort; now?: () => Date },
  scope: ScopeKey,
  input: { jobId: string; subjectHandle: string; projectId: string },
  guard?: JobSubjectGuard,
): Promise<JobSubjectRegistration> {
  if (!input.projectId.trim() || !input.jobId.trim()) throw new PrivacyError('InvalidSubjectToken');
  const token = jobTelemetryUserId(input.projectId, scope, input.jobId);
  let registered: JobSubjectRegistration['registered'] | null = null;
  for (let attempt = 1; registered === null; attempt++) {
    const latest = (await deps.tokens.list(scope))
      .filter((e) => e.subjectHandle === input.subjectHandle && e.provider === JOB_SUBJECT_PROVIDER)
      .reduce<{ tokenGeneration: number; tokens: string[] } | null>(
        (best, e) => (best && best.tokenGeneration >= e.tokenGeneration ? best : e),
        null,
      );
    if (latest?.tokens.includes(token)) {
      registered = 'exists';
      break;
    }
    const tokens = [...(latest?.tokens ?? []), token];
    if (tokens.length > MAX_TOKENS) throw new PrivacyError('InvalidSubjectToken', 'too many jobs');
    // Assigned inside the store wrapper; the cast keeps TypeScript from narrowing it to the initial value.
    let outcome = 'exists' as 'created' | 'exists';
    await registerSubjectTokens(
      {
        tokens: {
          put: async (s, entry) => (outcome = await deps.tokens.put(s, entry)),
          list: (s, limit) => deps.tokens.list(s, limit),
          tokensFor: (s, handle, provider) => deps.tokens.tokensFor(s, handle, provider),
        },
        ...(deps.now ? { now: deps.now } : {}),
      },
      scope,
      {
        subjectHandle: input.subjectHandle,
        provider: JOB_SUBJECT_PROVIDER,
        tokenGeneration: (latest?.tokenGeneration ?? 0) + 1,
        tokens,
      },
    );
    if (outcome === 'created') registered = 'created';
    // `exists` here means a concurrent registration took that generation first: read again and add the token on top.
    else if (attempt >= RACE_RETRIES) throw new PrivacyError('SubjectRegistrationRaced');
  }
  let guardGeneration: number | null = null;
  if (guard && deps.exports)
    for (let attempt = 1; ; attempt++) {
      if ((await deps.exports.status(scope, guard.providerOrganizationId)).covered) break;
      try {
        guardGeneration = (
          await exportGuardFile({ tokens: deps.tokens, exports: deps.exports }, scope, guard.path, {
            providerOrganizationId: guard.providerOrganizationId,
          })
        ).generation;
        break;
      } catch (error) {
        // A concurrent registration exported the same generation first (GuardExportConflict on the row id, or
        // GuardExportRaced on the latest check). Read coverage again: that export usually covers this subject too.
        if (!isExportRace(error) || attempt >= RACE_RETRIES) throw error;
      }
    }
  return { registered, guardGeneration };
}

const isExportRace = (error: unknown): boolean =>
  error instanceof Error && /GuardExport(Conflict|Raced)/.test(error.message);

/**
 * The submit-time registrar the domain service is given (`DomainServiceDeps.registerSubject`). `service` must be a
 * privacy_controller principal: the domain_executor principal that submits jobs holds no privilege on `subject_tokens`,
 * `subject_set_generations` or `guard_exports`, and is deliberately not widened to.
 */
export function privacySubjectRegistrar(
  service: MongoService,
  options: { projectId: string; guard?: JobSubjectGuard },
): (scope: ScopeKey, input: { jobId: string; subjectHandle: string }) => Promise<JobSubjectRegistration> {
  const deps = { tokens: new SubjectTokenRepository(service), exports: new GuardExportRepository(service) };
  return (scope, input) =>
    registerJobSubject(deps, scope, { ...input, projectId: options.projectId }, options.guard);
}
