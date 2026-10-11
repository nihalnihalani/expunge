import {
  canonicalJson,
  type CostSummary,
  type EvidenceBundle,
  type EvidenceReference,
  type JsonValue,
  type PolicyDecision,
  type RunBinding,
  type ScopeKey,
  type SourceOrigin,
} from '@expunge/contracts';
import type { EvidenceObservation } from './evidence.js';

/** Keys that name hidden truth. A bundle containing one is refused outright. */
export const HELD_OUT_KEYS = [
  'expected',
  'expectedoutcome',
  'expectedpoststate',
  'manifest',
  'privatemanifest',
  'seed',
  'seedcommitment',
  'heldout',
  'answer',
  'answers',
  'preservationhash',
  'oracle',
  'groundtruth',
] as const;

const ORIGINS: readonly SourceOrigin[] = [
  'agent_self_report',
  'verifier_feedback',
  'human_feedback',
  'raindrop_classifier',
  'experiment_result',
  'admission_service',
];

export type BundleSplit = EvidenceBundle['split'];

export type BundleInput = {
  evidenceId: string;
  actor: ScopeKey;
  binding: RunBinding;
  split: BundleSplit;
  /** The remote observation this bundle is built from (hashes and structure only). */
  observation: EvidenceObservation;
  /** Sanitized tool facts from OUR trusted ledger and read-back spans, with the gateway's policy decision. */
  tools: Array<{ toolId: string; input: JsonValue; output: JsonValue; decision: PolicyDecision }>;
  diagnostics: JsonValue[];
  failureWitnesses: JsonValue[];
  /** The model narrative is never stored as text; only its hash is. */
  modelOutputSha256?: string;
  cost: CostSummary;
  confidence: number;
  sources: EvidenceReference[];
  /** Subject literals that must not appear anywhere in the bundle. */
  forbiddenLiterals?: readonly string[];
};

export class BundleError extends Error {
  constructor(
    readonly code:
      | 'HeldOutLeak'
      | 'InvalidSource'
      | 'RevokedEvidence'
      | 'InvalidConfidence'
      | 'EmptySources'
      | 'SubjectLiteral',
    readonly path?: string,
  ) {
    super(path ? `${code}:${path}` : code);
    this.name = 'BundleError';
  }
}

function walk(
  value: unknown,
  path: string,
  visit: (key: string | null, value: unknown, path: string) => void,
): void {
  visit(null, value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      visit(key, child, `${path}.${key}`);
      walk(child, `${path}.${key}`, visit);
    }
}

/** Refuses a bundle that names held-out truth or contains a forbidden subject literal anywhere. */
export function assertNoLeak(bundle: unknown, forbiddenLiterals: readonly string[] = []): void {
  const forbidden = forbiddenLiterals.map((literal) => literal.toLowerCase()).filter(Boolean);
  walk(bundle, '$', (key, value, path) => {
    if (key && (HELD_OUT_KEYS as readonly string[]).includes(key.toLowerCase()))
      throw new BundleError('HeldOutLeak', path);
    if (typeof value === 'string' && forbidden.some((literal) => value.toLowerCase().includes(literal)))
      throw new BundleError('SubjectLiteral', path);
  });
}

/**
 * Assembles the sanitized EvidenceBundle the evolver may cite. Held-out manifests are absent by construction and by
 * check; the split is recorded; raw failure witnesses and tool values exist ONLY for the training split; origin labels
 * pass through unchanged and are validated; a revoked source refuses the whole bundle.
 */
export function assembleEvidenceBundle(input: BundleInput): EvidenceBundle {
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw new BundleError('InvalidConfidence');
  if (input.sources.length === 0) throw new BundleError('EmptySources');
  for (const source of input.sources) {
    if (!ORIGINS.includes(source.origin)) throw new BundleError('InvalidSource', source.origin);
    if (source.permittedUse === 'revoked') throw new BundleError('RevokedEvidence', source.contentHash);
    // A vendor classification must cite the signal it came from; it is never inferred from the signal merely existing.
    if (source.origin === 'raindrop_classifier' && source.externalSignalIds.length === 0)
      throw new BundleError('InvalidSource', 'raindrop_classifier without a signal id');
  }
  const train = input.split === 'train';
  const bundle: EvidenceBundle = {
    evidenceId: input.evidenceId,
    actor: input.actor,
    binding: input.binding,
    tools: input.tools.map((tool) =>
      train
        ? tool
        : {
            ...tool,
            input: { withheld: true, split: input.split },
            output: { withheld: true, split: input.split },
          },
    ),
    failureWitnesses: train ? input.failureWitnesses : [],
    diagnostics: input.diagnostics,
    modelOutput: input.modelOutputSha256 ? `untrusted-model-output:sha256:${input.modelOutputSha256}` : '',
    sources: input.sources,
    cost: input.cost,
    confidence: input.confidence,
    split: input.split,
  };
  assertNoLeak(bundle, input.forbiddenLiterals);
  assertNoLeak(input.observation.event.properties, input.forbiddenLiterals);
  return bundle;
}

/** The evidence-bearing size of a bundle: what a proposer would be given to read. Same measure for every arm. */
export function bundleBudget(bundle: EvidenceBundle): number {
  return Buffer.byteLength(
    canonicalJson({
      tools: bundle.tools,
      diagnostics: bundle.diagnostics,
      failureWitnesses: bundle.failureWitnesses,
      modelOutput: bundle.modelOutput,
      sources: bundle.sources,
    }),
  );
}

const withinBudget = (bundle: EvidenceBundle, budget: number) => bundleBudget(bundle) <= budget;

/**
 * Score-only control: the same schema and run identity, with the verifier/admission SCORE sources kept and every
 * trace-derived field emptied. Its budget never exceeds the trace-informed bundle's.
 */
export function scoreOnlyControl(bundle: EvidenceBundle): EvidenceBundle {
  const control: EvidenceBundle = {
    ...bundle,
    evidenceId: `${bundle.evidenceId}:score_only`,
    tools: [],
    failureWitnesses: [],
    diagnostics: [],
    modelOutput: '',
    sources: bundle.sources.filter(
      (source) => source.origin === 'verifier_feedback' || source.origin === 'admission_service',
    ),
  };
  if (control.sources.length === 0) throw new BundleError('EmptySources');
  return control;
}

/**
 * Wrong-incident control: trace-derived evidence from a DIFFERENT incident under this incident's identity, split and
 * cost, cut to this bundle's budget. If the proposer improves with it as well, the evidence content did not matter.
 */
export function wrongIncidentControl(bundle: EvidenceBundle, other: EvidenceBundle): EvidenceBundle {
  if (other.binding.runId === bundle.binding.runId)
    throw new BundleError('InvalidSource', 'wrong-incident control needs a different run');
  const budget = bundleBudget(bundle);
  const control: EvidenceBundle = {
    ...bundle,
    evidenceId: `${bundle.evidenceId}:wrong_incident`,
    tools: [...other.tools],
    failureWitnesses: bundle.split === 'train' ? [...other.failureWitnesses] : [],
    diagnostics: [...other.diagnostics],
    modelOutput: other.modelOutput,
    sources: [...other.sources],
  };
  while (
    !withinBudget(control, budget) &&
    (control.tools.length || control.diagnostics.length || control.failureWitnesses.length)
  ) {
    if (control.tools.length) control.tools.pop();
    else if (control.diagnostics.length) control.diagnostics.pop();
    else control.failureWitnesses.pop();
  }
  return control;
}
