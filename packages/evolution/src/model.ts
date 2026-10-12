// The proposer role. A structured-output call returns one bounded proposal (or an abstention); nothing the model
// says is trusted: the evolver re-derives `before`, the child bundle and the class, and the compiler decides.
// The call carries NO tool-choice parameter: the model is asked for a schema-shaped answer, not made to call a tool.
import { DISCLOSED_PRIMITIVES } from '@expunge/baselines';
import type { HarnessBundle, JsonValue, MutationClass, TypedPatch } from '@expunge/contracts';
import { z } from 'zod';
import type { ModelAttestation, ModelPricing, UsageSummary } from '@expunge/runtime';
import type { EvidenceArm, EvidencePacket } from './evidence.js';

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(jsonValue)]),
);
const patchSchema = z
  .object({
    surface: z.enum(['context', 'workflow', 'guardrails', 'tool_policy', 'plugin']),
    path: z.string().min(1).max(128),
    after: jsonValue,
    hypothesis: z.string().min(10).max(1000),
    sourceEvidenceIds: z.array(z.string().min(1).max(256)).min(1).max(8),
  })
  .strict();
export const proposalSchema = z
  .object({
    abstain: z.boolean(),
    reason: z.string().max(500).optional(),
    hypothesis: z.string().max(1000),
    claimedClass: z.enum(['tightening', 'behavioral', 'authority_expansion']),
    patches: z.array(patchSchema).max(3),
  })
  .strict()
  .refine((value) => (value.abstain ? value.patches.length === 0 : value.patches.length >= 1), {
    message: 'a proposal has between one and three patches; an abstention has none',
  });
export type ModelProposal = z.infer<typeof proposalSchema>;
export type ProposedPatch = ModelProposal['patches'][number];

/** The JSON Schema handed to a provider's structured-output mode. Mirrors `proposalSchema`. */
export const PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['abstain', 'hypothesis', 'claimedClass', 'patches'],
  properties: {
    abstain: { type: 'boolean' },
    reason: { type: 'string', maxLength: 500 },
    hypothesis: { type: 'string', maxLength: 1000 },
    claimedClass: { enum: ['tightening', 'behavioral', 'authority_expansion'] },
    patches: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['surface', 'path', 'after', 'hypothesis', 'sourceEvidenceIds'],
        properties: {
          surface: { enum: ['context', 'workflow', 'guardrails', 'tool_policy', 'plugin'] },
          path: { type: 'string', maxLength: 128 },
          after: {},
          hypothesis: { type: 'string', minLength: 10, maxLength: 1000 },
          sourceEvidenceIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export interface ProposalRequest {
  arm: EvidenceArm;
  branchIndex: number;
  maxEdits: number;
  parent: HarnessBundle;
  evidence: EvidencePacket;
}
export interface EvolverModel {
  id: string;
  /** 'fake' is a deterministic test double; 'provider' is a real model behind `createStructuredEvolverModel`. */
  kind: 'fake' | 'provider';
  propose(request: ProposalRequest): Promise<unknown>;
  /** A provider model's stamp (attestation, prices, cumulative metered usage); recorded on every proposal it writes. */
  stamp?(): EvolverModelStamp;
}

/** What a proposal records about the model that wrote it. Never carries a credential, URL or prompt text. */
export interface EvolverModelStamp {
  attestation: ModelAttestation;
  pricing: ModelPricing;
  /** Cumulative usage of this model instance when the stamp was taken (the proposer's own meter). */
  usage: UsageSummary;
}

/** A provider adapter supplies this; there is intentionally no tool-choice field. */
export interface StructuredClient {
  generateStructured(call: {
    system: string;
    user: string;
    schemaName: string;
    jsonSchema: object;
  }): Promise<unknown>;
}
export function buildProposalPrompt(request: ProposalRequest): { system: string; user: string } {
  const system = [
    'You propose one bounded change to a data-cleanup agent harness.',
    `Make at most ${request.maxEdits} edits. Each edit replaces one unit named by a disclosed patch path and states its own hypothesis.`,
    'Cite only identifiers listed in evidence.citableIds. Do not mention any subject, record, name or value from the evidence.',
    'Use only the disclosed vocabulary: tools, facts, bindings, comparators and patch paths listed below.',
    'Your claimed class is advisory: the compiler computes the real class. Abstain if the evidence does not support an edit.',
  ].join('\n');
  const user = JSON.stringify({
    vocabulary: DISCLOSED_PRIMITIVES,
    parent: request.parent,
    evidence: request.evidence,
    branchIndex: request.branchIndex,
  });
  return { system, user };
}
/** A real model behind a structured-output client. Output still passes `proposalSchema` before anything uses it. */
export function createStructuredEvolverModel(id: string, client: StructuredClient): EvolverModel {
  return {
    id,
    kind: 'provider',
    propose: (request) => {
      const { system, user } = buildProposalPrompt(request);
      return client.generateStructured({
        system,
        user,
        schemaName: 'harness_proposal',
        jsonSchema: PROPOSAL_JSON_SCHEMA,
      });
    },
  };
}

export function toTypedPatch(proposed: ProposedPatch, before: JsonValue): TypedPatch {
  return {
    surface: proposed.surface,
    path: proposed.path,
    before,
    after: proposed.after,
    sourceEvidenceIds: proposed.sourceEvidenceIds,
    hypothesis: proposed.hypothesis,
  };
}
export type { MutationClass };
