import {
  contentHash,
  type ActorContext,
  type DecisionInputsRecord,
  type DecisionRecord,
  type JsonValue,
} from '@expunge/contracts';
import type { DecisionRepository } from '@expunge/mongo';
import type { DecisionInput } from '@expunge/harness-compiler';
import type { Verdict } from './evaluator.js';

/** Identity of one decided call. For an effect it is the intent's own step, ordinal and argument digest. */
export type DecidedCall = {
  jobId: string;
  runId: string;
  harnessHash: string;
  toolId: string;
  stepId: string;
  batchOrdinal: number;
  argsDigest: string;
};

/** Digest of a tool call's arguments, so a ledger row names exactly what was asked. */
export function toolArgsDigest(toolId: string, args: unknown): string {
  return contentHash({ toolId, args: args ?? null }, 'tool-args');
}

function jsonRecord(source: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      value === null || value === undefined
        ? null
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'
          ? value
          : null;
  }
  return out;
}
/** The recorded form of the decision inputs: only numbers, booleans, strings and nulls. */
export function inputsRecord(input: DecisionInput, observedAt: Date): DecisionInputsRecord {
  const stamp = observedAt.toISOString();
  const observed: Record<string, string> = {};
  for (const key of Object.keys(input.facts)) observed[`facts.${key}`] = stamp;
  for (const key of Object.keys(input.bindings)) observed[`bindings.${key}`] = stamp;
  for (const key of Object.keys(input.prior)) observed[`prior.${key}`] = stamp;
  return {
    facts: jsonRecord(input.facts),
    bindings: jsonRecord(input.bindings),
    prior: jsonRecord(input.prior),
    observedAt: observed,
  };
}

/**
 * The decision ledger as the gateway uses it: one row per decided tool call, written BEFORE the action, carrying
 * the inputs the guardrails saw so replay can reconstruct the call as of the decision.
 */
export class DecisionLedger {
  constructor(
    private readonly repository: DecisionRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(actor: ActorContext, call: DecidedCall, verdict: Verdict): Promise<DecisionRecord> {
    return this.repository.record(
      actor,
      {
        jobId: call.jobId,
        runId: call.runId,
        harnessHash: call.harnessHash,
        stepId: call.stepId,
        batchOrdinal: call.batchOrdinal,
        argsDigest: call.argsDigest,
      },
      verdict.decision,
      { toolId: call.toolId, inputs: inputsRecord(verdict.input, this.clock()) },
    );
  }

  /** The job's recorded decisions in time order. */
  list(actor: ActorContext, jobId: string, limit?: number): Promise<DecisionRecord[]> {
    return this.repository.list(actor, jobId, limit);
  }
}
