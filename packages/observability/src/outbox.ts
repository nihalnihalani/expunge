import { contentHash, type JsonValue, type ScopeKey } from '@expunge/contracts';
import type { OutboxRepository } from '@expunge/mongo';
import type { ClientSession } from 'mongodb';
import { z } from 'zod';
import { sanitizeProperty } from './sanitize.js';

/**
 * Application origins we may WRITE to Raindrop. `raindrop_classifier` is vendor-produced and is never written by us;
 * `agent_self_report` goes through the SDK's diagnostics tool, not this path.
 */
export const WRITABLE_ORIGINS = [
  'verifier_feedback',
  'human_feedback',
  'experiment_result',
  'admission_service',
] as const;
export type WritableOrigin = (typeof WRITABLE_ORIGINS)[number];

const id = z.string().min(1).max(256);
const flat = z
  .record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()]))
  .refine((record) => Object.keys(record).length <= 32, 'too many properties');

/** The only payloads the dispatcher will transmit or read back. Unknown fields are rejected (poison -> dead letter). */
export const telemetryPayloadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('signal'),
      eventId: id,
      signalName: id,
      origin: z.enum(WRITABLE_ORIGINS),
      signalType: z.enum(['default', 'feedback', 'edit', 'standard']).default('default'),
      sentiment: z.enum(['POSITIVE', 'NEGATIVE']).optional(),
      properties: flat.default({}),
    })
    .strict(),
  z
    .object({
      type: z.literal('event'),
      eventId: id,
      event: id,
      userId: id,
      origin: z.enum(WRITABLE_ORIGINS),
      output: z.string().min(1).max(8192),
      input: z.string().max(8192).optional(),
      model: z.string().max(128).optional(),
      convoId: id.optional(),
      properties: flat.default({}),
    })
    .strict(),
  // The event itself is produced live by the SDK in another process; this row only tracks its remote read-back.
  z
    .object({
      type: z.literal('sdk_event'),
      eventId: id,
      role: z.enum(['worker', 'improver', 'hider', 'observer']),
    })
    .strict(),
]);
export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;

export type TelemetryIntent = {
  kind: TelemetryPayload['type'];
  jobId: string;
  /** Distinguishes intents of the same kind for the same job (e.g. the terminal revision). */
  discriminator: string;
  payload: TelemetryPayload;
  /** Remote fields that must be present before the evidence is ready (e.g. tool_calls, signals). */
  evidenceRequired: string[];
};

export function operationIdFor(intent: Pick<TelemetryIntent, 'kind' | 'jobId' | 'discriminator'>): string {
  return contentHash(
    { kind: intent.kind, jobId: intent.jobId, discriminator: intent.discriminator },
    'telemetry-op',
  );
}

/** Verifier feedback on a run: a feedback signal with an explicit application origin and the eval identity. */
export function verifierSignalIntent(input: {
  jobId: string;
  eventId: string;
  passed: boolean;
  evaluationId: string;
  harnessHash: string;
}): TelemetryIntent {
  return {
    kind: 'signal',
    jobId: input.jobId,
    discriminator: `verifier:${input.evaluationId}`,
    evidenceRequired: ['signals'],
    payload: {
      type: 'signal',
      eventId: input.eventId,
      signalName: input.passed ? 'cleanup_verified' : 'cleanup_not_verified',
      origin: 'verifier_feedback',
      signalType: 'feedback',
      sentiment: input.passed ? 'POSITIVE' : 'NEGATIVE',
      properties: {
        origin: 'verifier_feedback',
        evaluation_id: sanitizeProperty(input.evaluationId),
        harness_hash: sanitizeProperty(input.harnessHash),
      },
    },
  };
}

/** Our own accept/reject decision, never Raindrop's verdict. */
export function admissionSignalIntent(input: {
  jobId: string;
  eventId: string;
  accepted: boolean;
  proposalId: string;
  gateReportId: string;
}): TelemetryIntent {
  return {
    kind: 'signal',
    jobId: input.jobId,
    discriminator: `admission:${input.proposalId}:${input.gateReportId}`,
    evidenceRequired: ['signals'],
    payload: {
      type: 'signal',
      eventId: input.eventId,
      signalName: input.accepted ? 'candidate_admitted' : 'candidate_rejected',
      origin: 'admission_service',
      signalType: 'default',
      sentiment: input.accepted ? 'POSITIVE' : 'NEGATIVE',
      properties: {
        origin: 'admission_service',
        proposal_id: sanitizeProperty(input.proposalId),
        gate_report_id: sanitizeProperty(input.gateReportId),
      },
    },
  };
}

/** Read-back tracking for an episode the worker produced live through the SDK. */
export function sdkEpisodeIntent(input: {
  jobId: string;
  eventId: string;
  role: 'worker' | 'improver' | 'hider' | 'observer';
  attempt: number;
  evidenceRequired?: string[];
}): TelemetryIntent {
  return {
    kind: 'sdk_event',
    jobId: input.jobId,
    discriminator: `episode:${input.eventId}:${input.attempt}`,
    evidenceRequired: input.evidenceRequired ?? ['assistant_output', 'tool_calls'],
    payload: { type: 'sdk_event', eventId: input.eventId, role: input.role },
  };
}

/**
 * Commits an outbox intent. Call it with the SAME `session` as the domain outcome it describes, so the intent and the
 * outcome commit or abort together; dispatch happens later, outside any transaction. Idempotent outside a transaction: the
 * operation id is derived from the intent and a duplicate-key insert returns `inserted: false`. Inside a transaction a
 * duplicate throws `TelemetryIntentConflict`, because the server has already aborted that transaction.
 */
export async function enqueueTelemetry(
  outbox: OutboxRepository,
  scope: ScopeKey,
  intent: TelemetryIntent,
  session?: ClientSession,
): Promise<{ operationId: string; inserted: boolean }> {
  const payload = telemetryPayloadSchema.parse(intent.payload);
  const operationId = operationIdFor(intent);
  try {
    await outbox.enqueue(
      scope,
      {
        operationId,
        kind: intent.kind,
        dedupeKey: operationId,
        jobId: intent.jobId,
        payload: payload as unknown as JsonValue,
        evidenceRequired: intent.evidenceRequired,
      },
      session,
    );
    return { operationId, inserted: true };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      // A duplicate key aborts a multi-document transaction on the server; carrying on inside it would leave the caller
      // retrying a dead transaction. Inside a transaction the conflict is surfaced so the whole outcome rolls back.
      if (session) throw new TelemetryIntentConflict(operationId);
      return { operationId, inserted: false };
    }
    throw error;
  }
}

export class TelemetryIntentConflict extends Error {
  constructor(readonly operationId: string) {
    super(`TelemetryIntentConflict:${operationId}`);
    this.name = 'TelemetryIntentConflict';
  }
}
