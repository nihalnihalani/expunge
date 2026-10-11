import { otelMiddleware } from '@tanstack/ai/middlewares/otel';
import type { Interaction, SubagentRun } from 'raindrop-ai';
import type { ToolDefinition } from '@expunge/vendor-openmuse';
import {
  DEFAULT_SANITIZATION,
  sanitizeFreeText,
  sanitizeProperty,
  type SanitizationPolicy,
} from './sanitize.js';
import { instrumentTool } from './tools.js';
import type { RaindropTracing } from './tracing.js';

/**
 * The only task descriptions that reach Raindrop verbatim. Anything else is free text and goes through the fail-closed
 * sanitizer, which redacts it unless the policy carries a literal list. The input is therefore never a place a subject
 * name can travel by accident.
 */
export const EPISODE_INPUT_LABELS = [
  'cleanup job',
  'improver campaign',
  'observer scan',
  'grader run',
  'dispatch',
  'smoke test',
] as const;
export type EpisodeInputLabel = (typeof EPISODE_INPUT_LABELS)[number];

export function episodeInput(input: string, policy: SanitizationPolicy): string {
  return (EPISODE_INPUT_LABELS as readonly string[]).includes(input)
    ? input
    : sanitizeFreeText(input, policy);
}

/** Opaque, namespaced telemetry identity: a short lower-case namespace and a hex digest. A handle or a name does not fit. */
const TELEMETRY_USER_ID = /^[a-z]{1,8}_[a-f0-9]{16,64}$/;
export const isTelemetryUserId = (id: string): boolean => TELEMETRY_USER_ID.test(id);
export class InvalidTelemetryUserId extends Error {
  constructor() {
    super('InvalidTelemetryUserId');
    this.name = 'InvalidTelemetryUserId';
  }
}
export function assertTelemetryUserId(id: string): string {
  if (!TELEMETRY_USER_ID.test(id)) throw new InvalidTelemetryUserId();
  return id;
}

export type EpisodeRole = 'worker' | 'improver' | 'hider' | 'observer';

export type EpisodeContext = {
  role: EpisodeRole;
  jobId: string;
  runId: string;
  attempt: number;
  harnessHash: string;
  workerProfileHash?: string;
  worldId?: string;
  completionPolicy?: string;
  /** Opaque, namespaced telemetry identity (see subject_tokens). Never a subject handle or a name. */
  telemetryUserId: string;
  evidenceArm?: string;
  /** A label from EPISODE_INPUT_LABELS; any other text is redacted unless the policy has a forbidden-literal list. */
  input: string;
};

/** Committed-state facts only. The model's narrative is deliberately not representable here. */
export type EpisodeSummary = {
  status: 'succeeded' | 'failed' | 'cancelled' | 'yielded' | 'aborted';
  endedBy: string;
  errorCode?: string;
  receiptId?: string;
  toolCalls: number;
  phases: number;
  elapsedMs: number;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrousd?: number;
  unpricedCalls?: number;
};

export function episodeEventId(ctx: Pick<EpisodeContext, 'role' | 'jobId' | 'runId' | 'attempt'>): string {
  return `expunge:${ctx.role}:${ctx.jobId}:${ctx.runId}:${ctx.attempt}`;
}

/**
 * One worker or improver episode as one Raindrop interaction. Correlation identities (run, job, harness, profile,
 * world) are stamped as event PROPERTIES because the Query API filters on properties, not on feature flags.
 */
export class Episode {
  readonly eventId: string;
  readonly interaction: Interaction;
  private finished = false;

  private constructor(
    readonly tracing: RaindropTracing,
    readonly context: EpisodeContext,
    readonly policy: SanitizationPolicy,
    interaction: Interaction,
    eventId: string,
  ) {
    this.interaction = interaction;
    this.eventId = eventId;
  }

  static begin(
    tracing: RaindropTracing,
    context: EpisodeContext,
    options: { policy?: SanitizationPolicy; linked?: SubagentRun } = {},
  ): Episode {
    const policy = options.policy ?? DEFAULT_SANITIZATION;
    assertTelemetryUserId(context.telemetryUserId);
    const eventId = options.linked?.eventId ?? episodeEventId(context);
    const interaction =
      options.linked?.interaction ??
      tracing.client.begin({
        eventId,
        event: `expunge.${context.role}`,
        userId: context.telemetryUserId,
        convoId: context.jobId,
        input: episodeInput(context.input, policy),
        properties: properties(context, policy),
        featureFlags: {
          harness_version: context.harnessHash,
          ...(context.evidenceArm ? { evidence_arm: context.evidenceArm } : {}),
        },
      });
    return new Episode(tracing, context, policy, interaction, eventId);
  }

  /** Runs `fn` inside the interaction's span so every child span (tools, model calls) carries its association. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.interaction.withSpan(
      { name: 'expunge.episode', properties: properties(this.context, this.policy) },
      fn,
    );
  }

  /** Tools with sanitized input/output/error spans. The offered set is exactly what is passed in. */
  instrumentTools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.map((tool) => instrumentTool(this, tool));
  }

  /**
   * TanStack AI middleware that emits GenAI spans (chat, one span per provider model call, tool spans) through the
   * Raindrop SDK's tracer provider. Content capture is off; identities are added as attributes.
   */
  chatMiddleware() {
    const attributes = {
      'expunge.run_id': this.context.runId,
      'expunge.job_id': this.context.jobId,
      'expunge.harness_hash': this.context.harnessHash,
      'expunge.role': this.context.role,
    };
    return otelMiddleware({
      tracer: this.tracing.tracer,
      captureContent: false,
      attributeEnricher: () => attributes,
    });
  }

  /** Terminal event from committed facts. `await` proves only that the terminal ingestion attempt returned. */
  async complete(summary: EpisodeSummary): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.interaction.finish({
      output: JSON.stringify(summary),
      properties: {
        outcome: summary.status,
        ended_by: summary.endedBy,
        ...(summary.errorCode ? { error_code: summary.errorCode } : {}),
      },
    });
  }
}

function properties(context: EpisodeContext, policy: SanitizationPolicy): Record<string, string> {
  const safe = (value: string) => sanitizeProperty(value, policy);
  return {
    role: context.role,
    run_id: safe(context.runId),
    job_id: safe(context.jobId),
    attempt: String(context.attempt),
    harness_hash: safe(context.harnessHash),
    ...(context.workerProfileHash ? { worker_profile_hash: safe(context.workerProfileHash) } : {}),
    ...(context.worldId ? { world_id: safe(context.worldId) } : {}),
    ...(context.completionPolicy ? { completion_policy: safe(context.completionPolicy) } : {}),
    ...(context.evidenceArm ? { evidence_arm: safe(context.evidenceArm) } : {}),
  };
}
