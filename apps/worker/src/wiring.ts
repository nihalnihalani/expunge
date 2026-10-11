import type { ActorContext, Job, ScopeKey } from '@expunge/contracts';
import {
  ArtifactRepository,
  AttestationRepository,
  JobRepository,
  OutboxRepository,
  ProjectionRepository,
  WakeCommandRepository,
  createPrincipalService,
  mongoConfigFromEnv,
  type MongoService,
} from '@expunge/mongo';
import { closeTracing, initTracing, raindropWriteConfigFromEnv } from '@expunge/observability';
import { EnvModelResolver, errorCode, type ArtifactReader } from '@expunge/runtime';
import type { DispatchJobs, JobResolver, LogEntry, ProjectionSink, TerminalSweep } from './dispatch.js';
import type { LeaseBinding } from '@expunge/runtime';
import { ProtocolError } from '@expunge/mongo';
import { createTelemetry, type TelemetryWiring } from './telemetry.js';
import type { WakeCommand, WakeCommandStore, WakeDecision } from './wake.js';
import { MongoCommittedReader } from './committed.js';
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

const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
const isTerminalStatus = (value: unknown): boolean =>
  typeof value === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(value);

/** The job status a transition event reports having reached, or null for an ordinary progress event. */
function transitionTarget(event: Parameters<ProjectionRepository['append']>[1]): string | null {
  if (event.kind === 'job_failed') return 'failed';
  if (event.kind === 'job_status_changed') {
    const to = (event.payload as { to?: unknown }).to;
    return typeof to === 'string' ? to : null;
  }
  return null;
}

/**
 * Projection sink with the two guarantees the plain repository lacks:
 *  - `appendFenced`: inside ONE transaction the job row is updated only if it still names this owner and fence AND is
 *    in the state the event needs, and then the event is inserted. A progress event needs a RUNNING job whose lease is
 *    unexpired by database time; a transition event (`job_failed`, `job_status_changed`) needs the job to already be in
 *    the state it reports, because the holder appends it after its own transition. A resumed zombie therefore gets
 *    `StaleFence` for anything, and cannot add progress after the job finished, expired or moved. The update `$inc`s a
 *    dedicated counter (`eventSeq`), so it is always a real write and always conflicts with a concurrent claim. A
 *    second, different terminal event for a job is refused (`TerminalExists`); the same event id is idempotent.
 *  - `hasTerminal`: whether a job's stream already holds a terminal event, by a direct query on the terminal kinds (the
 *    stream's length does not matter).
 */
export class FencedProjectionSink implements ProjectionSink {
  constructor(
    private readonly service: MongoService,
    private readonly jobs: JobRepository,
    private readonly projections: ProjectionRepository,
  ) {}
  append(...args: Parameters<ProjectionRepository['append']>) {
    return this.projections.append(...args);
  }
  appendFenced(
    key: ScopeKey,
    event: Parameters<ProjectionRepository['append']>[1],
    holder: { actor: ActorContext; lease: LeaseBinding },
  ) {
    const { actor, lease } = holder;
    const target = transitionTarget(event);
    return this.service.transaction(async (session) => {
      await this.jobs.workerJob(actor, lease.jobId, session); // principal and scope authorization, as for every worker write
      const held = await this.service.control.collection<{ _id: string }>('jobs').updateOne(
        {
          _id: lease.jobId,
          'lease.ownerId': lease.ownerId,
          'lease.fence': lease.fence,
          ...(target ? { status: target } : { status: 'running', $expr: { $gt: ['$lease.until', '$$NOW'] } }),
        } as never,
        { $inc: { eventSeq: 1 } },
        { session },
      );
      if (!held.matchedCount) throw new ProtocolError('StaleFence');
      if (isTerminalStatus(target)) {
        const existing = await this.latestTerminal(key, lease.jobId, session);
        if (existing && existing.eventId !== event.eventId) throw new ProtocolError('TerminalExists');
      }
      return this.projections.append(key, event, session);
    });
  }
  async hasTerminal(key: ScopeKey, jobId: string): Promise<boolean> {
    return (await this.latestTerminal(key, jobId)) !== null;
  }
  private async latestTerminal(
    key: ScopeKey,
    jobId: string,
    session?: import('mongodb').ClientSession,
  ): Promise<{ eventId: string } | null> {
    return this.service.control.collection<{ eventId: string }>('projection_events').findOne(
      {
        tenantId: key.tenantId,
        env: key.env,
        scopeId: key.scopeId,
        jobId,
        $or: [
          { kind: 'job_failed' },
          { kind: 'job_status_changed', 'payload.to': { $in: [...TERMINAL_STATUSES] } },
        ],
      } as never,
      { projection: { eventId: 1 }, sort: { sequence: -1 }, ...(session ? { session } : {}) },
    );
  }
}

/**
 * Reads the most recently finished jobs of one scope with the worker's own principal. Disclosed limits: it looks at a
 * bounded window of recent terminal jobs (ordered by `updatedAt`, which a fenced append no longer touches) and only in
 * the scope the worker is configured for; an older or out-of-scope job is repaired when a wake meets it.
 */
export class MongoTerminalSweep implements TerminalSweep {
  constructor(private readonly service: MongoService) {}
  async listRecentTerminal(key: ScopeKey, limit: number): Promise<Job[]> {
    return this.service.control
      .collection<Job>('jobs')
      .find({
        'actor.tenantId': key.tenantId,
        'actor.env': key.env,
        'actor.scopeId': key.scopeId,
        kind: 'cleanup',
        status: { $in: [...TERMINAL_STATUSES] },
      })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }
}

export type MongoWiring = {
  service: MongoService;
  wakeStore: MongoWakeCommandStore;
  projection: ProjectionSink;
  terminalSweep: TerminalSweep;
  jobs: DispatchJobs;
  resolver: JobResolver;
  artifacts: ArtifactReader;
  receipts: MongoCompletionReceiptReader;
  committed: MongoCommittedReader;
  models: EnvModelResolver;
  attestations: AttestationRepository;
};

/** The worker's ONLY database identity is the domain_executor principal; there is no fallback to another URI. */
export function createMongoWiring(env: NodeJS.ProcessEnv): MongoWiring {
  const service = createPrincipalService(mongoConfigFromEnv(env), 'domain_executor');
  const jobs = new JobRepository(service);
  return {
    service,
    wakeStore: new MongoWakeCommandStore(new WakeCommandRepository(service)),
    projection: new FencedProjectionSink(service, jobs, new ProjectionRepository(service)),
    terminalSweep: new MongoTerminalSweep(service),
    jobs: asDispatchJobs(jobs),
    resolver: new MongoJobResolver(jobs),
    artifacts: asArtifactReader(new ArtifactRepository(service)),
    receipts: new MongoCompletionReceiptReader(service),
    committed: new MongoCommittedReader(service),
    models: new EnvModelResolver(env),
    attestations: new AttestationRepository(service),
  };
}

/**
 * Raindrop episodes for this worker, when RAINDROP_API_KEY and RAINDROP_PROJECT_ID are present. The tracing SDK is
 * initialized once for the process. Missing configuration disables telemetry (reported by name); it never blocks the
 * worker. Intents are written with the worker's own domain_executor identity, which may INSERT into telemetry_outbox.
 */
export function createTelemetryWiring(
  env: NodeJS.ProcessEnv,
  service: MongoService,
  log?: (entry: LogEntry) => void,
): TelemetryWiring {
  const config = raindropWriteConfigFromEnv(env);
  if (!config.ok) return { enabled: false, missing: config.missing };
  const tracing = initTracing(config.config);
  return {
    enabled: true,
    telemetry: createTelemetry({
      tracing,
      outbox: new OutboxRepository(service),
      transaction: (work) => service.transaction(work),
      ...(log ? { log } : {}),
    }),
    close: () => closeTracing(),
  };
}
