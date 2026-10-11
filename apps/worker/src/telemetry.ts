import { createHash } from 'node:crypto';
import type { Job, ScopeKey } from '@expunge/contracts';
import type { OutboxRepository } from '@expunge/mongo';
import {
  Episode,
  carrierIsComplete,
  enqueueTelemetry,
  episodeEventId,
  raindropWriteConfigFromEnv,
  runAsSubagent,
  sdkEpisodeIntent,
  type CarrierHeaders,
  type EpisodeContext,
  type EpisodeSummary,
  type RaindropTracing,
  type TelemetryIntent,
} from '@expunge/observability';
import type { RunStats, ToolProvider } from '@expunge/runtime';
import type { ChatMiddleware } from '@expunge/vendor-openmuse';
import type { ClientSession } from 'mongodb';
import type { JobOutcome, LogEntry } from './dispatch.js';

/**
 * The worker's view of Raindrop. Everything here is best effort by design: telemetry can fail, be disabled or be slow
 * without changing what a job does or how it ends. The dispatcher never reads a telemetry result to decide a job state.
 */
export interface EpisodeHandle {
  readonly eventId: string;
  /** The job's tools with a sanitized span around every call. Falls back to the plain tools if wrapping fails. */
  tools(provider: ToolProvider): ToolProvider;
  /** TanStack chat middleware that emits real GenAI model spans. The runtime guards it against throwing. */
  chatMiddleware(): ChatMiddleware[];
  /** Runs the model loop inside the episode's span context. `fn` runs exactly once, even if the SDK fails. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** The read-back tracking intent for this episode, derived from committed facts. */
  intent(facts: OutcomeFacts): TelemetryIntent;
  /** Writes the terminal event from committed facts only. Never throws. */
  complete(facts: OutcomeFacts): Promise<void>;
}

export interface Telemetry {
  /**
   * Runs `body` as one worker episode, linked to the dispatching context when an authenticated, complete carrier came
   * with the wake. `body` receives undefined when no episode could be started; it always runs exactly once.
   */
  episode<T>(
    job: Job,
    carrier: CarrierHeaders | null,
    body: (episode: EpisodeHandle | undefined) => Promise<T>,
  ): Promise<T>;
  /** Idempotent outside a transaction; with a session a duplicate throws TelemetryIntentConflict. */
  enqueue(scope: ScopeKey, intent: TelemetryIntent, session?: ClientSession): Promise<void>;
  /** Present when the intent can commit in the same transaction as a job transition. */
  atomically?<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
}

/** Committed-state facts of a finished (or abandoned) run; the model's narrative is not representable here. */
export type OutcomeFacts = { outcome: JobOutcome; stats?: RunStats; reason?: string; receiptId?: string };

const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export function episodeStatus(outcome: JobOutcome): EpisodeSummary['status'] {
  switch (outcome) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'yielded':
      return 'yielded';
    default:
      return 'aborted';
  }
}

export function episodeSummary(facts: OutcomeFacts): EpisodeSummary {
  const { stats } = facts;
  const code = stats?.errorCode ?? (facts.outcome === 'failed' ? facts.reason : undefined);
  const metered = stats?.metered;
  return {
    status: episodeStatus(facts.outcome),
    endedBy: stats?.endedBy ?? 'error',
    ...(code && ERROR_CODE.test(code) ? { errorCode: code } : {}),
    ...(facts.receiptId ? { receiptId: facts.receiptId } : {}),
    toolCalls: stats?.toolCalls ?? 0,
    phases: stats?.phases ?? 0,
    elapsedMs: stats?.elapsedMs ?? 0,
    ...(stats?.provenance?.provider ? { provider: stats.provenance.provider } : {}),
    ...(stats?.provenance?.model ? { model: stats.provenance.model } : {}),
    ...(metered
      ? {
          inputTokens: metered.inputTokens,
          outputTokens: metered.outputTokens,
          costMicrousd: metered.costMicrousd,
          unpricedCalls: metered.unpricedCalls,
        }
      : {}),
  };
}

/**
 * Opaque telemetry identity of a job's episode. Raindrop's "user" is a hash of non-secret scope and job identifiers:
 * it names no data subject and no person. Deletion requests by user id are therefore job-granular.
 */
export function telemetryUserId(projectId: string, scope: ScopeKey, jobId: string): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'expunge-telemetry-user',
        1,
        projectId,
        scope.tenantId,
        scope.env,
        scope.scopeId,
        jobId,
      ]),
    )
    .digest('hex');
  return `u_${digest.slice(0, 32)}`;
}

export function episodeContext(job: Job, projectId: string): EpisodeContext {
  return {
    role: 'worker',
    jobId: job._id,
    runId: job.binding.runId,
    attempt: job.attempt,
    harnessHash: job.binding.harnessHash,
    workerProfileHash: job.binding.workerProfileHash,
    worldId: job.binding.worldId,
    telemetryUserId: telemetryUserId(
      projectId,
      { tenantId: job.actor.tenantId, env: job.actor.env, scopeId: job.actor.scopeId },
      job._id,
    ),
    input: 'cleanup job',
  };
}

type Linked = NonNullable<NonNullable<Parameters<typeof Episode.begin>[2]>['linked']>;

class SdkEpisodeHandle implements EpisodeHandle {
  constructor(
    private readonly episode: Episode,
    private readonly log: (entry: LogEntry) => void,
  ) {}
  get eventId(): string {
    return this.episode.eventId;
  }
  private warn(message: string, error: unknown): void {
    this.log({
      level: 'warn',
      message,
      jobId: this.episode.context.jobId,
      code: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  tools(provider: ToolProvider): ToolProvider {
    return {
      create: async (context) => {
        const tools = await provider.create(context);
        try {
          return this.episode.instrumentTools(tools);
        } catch (error) {
          this.warn('tool instrumentation failed; tools run uninstrumented', error);
          return tools;
        }
      },
    };
  }
  chatMiddleware(): ChatMiddleware[] {
    try {
      return [this.episode.chatMiddleware() as ChatMiddleware];
    } catch (error) {
      this.warn('model span middleware unavailable', error);
      return [];
    }
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let started = false;
    try {
      return await this.episode.run(() => {
        started = true;
        return fn();
      });
    } catch (error) {
      if (started) throw error; // the loop's own failure, not the SDK's
      this.warn('episode span context unavailable; run continues without it', error);
      return fn();
    }
  }
  intent(facts: OutcomeFacts): TelemetryIntent {
    const toolCalls = facts.stats?.toolCalls ?? 0;
    return sdkEpisodeIntent({
      jobId: this.episode.context.jobId,
      eventId: this.episode.eventId,
      role: 'worker',
      attempt: this.episode.context.attempt,
      evidenceRequired: toolCalls > 0 ? ['assistant_output', 'tool_calls'] : ['assistant_output'],
    });
  }
  async complete(facts: OutcomeFacts): Promise<void> {
    try {
      await this.episode.complete(episodeSummary(facts));
    } catch (error) {
      this.warn('episode terminal event failed', error);
    }
  }
}

export type TelemetryOptions = {
  tracing: RaindropTracing;
  outbox: Pick<OutboxRepository, 'enqueue'>;
  transaction?: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
  log?: (entry: LogEntry) => void;
};

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const { tracing } = options;
  const log = options.log ?? (() => undefined);
  const projectId = tracing.config.projectId;
  const begin = (context: EpisodeContext, linked?: Linked): EpisodeHandle | undefined => {
    try {
      return new SdkEpisodeHandle(Episode.begin(tracing, context, linked ? { linked } : {}), log);
    } catch (error) {
      log({
        level: 'warn',
        message: 'episode could not be started; job runs without telemetry',
        jobId: context.jobId,
        code: error instanceof Error ? error.name : 'UnknownError',
      });
      return undefined;
    }
  };
  return {
    async episode(job, carrier, body) {
      const context = episodeContext(job, projectId);
      if (carrier && carrierIsComplete(carrier)) {
        let started = false;
        try {
          return await runAsSubagent(
            tracing,
            carrier,
            {
              name: 'expunge.worker',
              eventId: episodeEventId(context),
              userId: context.telemetryUserId,
              convoId: context.jobId,
            },
            (linked) => {
              started = true;
              return body(begin(context, linked));
            },
          );
        } catch (error) {
          if (started) throw error;
          log({
            level: 'warn',
            message: 'carrier could not be linked; episode runs unlinked',
            jobId: job._id,
            code: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
      return body(begin(context));
    },
    async enqueue(scope, intent, session) {
      await enqueueTelemetry(options.outbox as OutboxRepository, scope, intent, session);
    },
    ...(options.transaction ? { atomically: options.transaction } : {}),
  };
}

export type TelemetryWiring =
  { enabled: true; telemetry: Telemetry; close(): Promise<void> } | { enabled: false; missing: string[] };

/** Reads only variable NAMES when something is missing; no value is ever reported. */
export function telemetryStatus(env: Readonly<Record<string, string | undefined>>): {
  enabled: boolean;
  missing: string[];
} {
  const config = raindropWriteConfigFromEnv(env);
  return config.ok ? { enabled: true, missing: [] } : { enabled: false, missing: config.missing };
}
