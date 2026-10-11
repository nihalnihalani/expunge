import {
  bundlesDisjoint,
  canonicalJson,
  selectWrongIncident,
  type CostSummary,
  type EvidenceBundle,
  type EvidenceReference,
  type JsonValue,
  type PolicyDecision,
  type RunBinding,
  type ScopeKey,
  type SourceOrigin,
} from '@expunge/contracts';
import {
  DEFAULT_SANITIZATION,
  LeakError,
  detectLeak,
  requireGuard,
  sanitizeFreeText,
  type LeakGuard,
} from '@expunge/observability';
import type { EvidenceObservation } from './evidence.js';

export { bundlesDisjoint, selectWrongIncident };

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
  /** The remote observation this bundle is built from (sanitized hashes and structure only). */
  observation: EvidenceObservation;
  /** Sanitized tool facts from OUR trusted ledger and read-back spans, with the gateway's policy decision. */
  tools: Array<{ toolId: string; input: JsonValue; output: JsonValue; decision: PolicyDecision }>;
  /** Agent self-reports. Kept only for the training split, and only with an `agent_self_report` source. */
  diagnostics: JsonValue[];
  failureWitnesses: JsonValue[];
  /** The model narrative is never stored as text; only its hash is. */
  modelOutputSha256?: string;
  cost: CostSummary;
  confidence: number;
  sources: EvidenceReference[];
  /**
   * REQUIRED. Subject literals (and optionally the grader's salted private-id set) that must not appear anywhere in
   * the bundle. A bundle built without a literal or an id set is a construction error, never a silent pass.
   */
  guard: LeakGuard;
};

export type BundleErrorCode =
  | LeakError['code']
  | 'InvalidSource'
  | 'RevokedEvidence'
  | 'InvalidConfidence'
  | 'EmptySources'
  | 'ControlOverBudget'
  | 'QuarantinedObservation'
  | 'SplitMismatch';

export class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    readonly path?: string,
  ) {
    super(path ? `${code}:${path}` : code);
    this.name = 'BundleError';
  }
}

function asBundleError(error: unknown): never {
  if (error instanceof LeakError) throw new BundleError(error.code, error.path);
  throw error;
}

/** Refuses a bundle that names held-out truth, carries a subject literal (any key, value, encoding) or a private id. */
export function assertNoLeak(bundle: unknown, guard: LeakGuard): void {
  try {
    requireGuard(guard);
  } catch (error) {
    asBundleError(error);
  }
  const finding = detectLeak(bundle, guard);
  if (finding) throw new BundleError(finding.code, finding.path);
}

/**
 * Assembles the sanitized EvidenceBundle the evolver may cite. Held-out manifests are absent by construction and by
 * check; the split is recorded; raw failure witnesses and tool values exist ONLY for the training split; diagnostics
 * (agent self-reports) only for the training split and only beside an `agent_self_report` source; origin labels pass
 * through unchanged and are validated; a revoked source or a quarantined observation refuses the whole bundle.
 * `withheld` says what was deliberately left out, so absence is never read as emptiness.
 */
export function assembleEvidenceBundle(input: BundleInput): EvidenceBundle {
  try {
    requireGuard(input.guard);
  } catch (error) {
    asBundleError(error);
  }
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw new BundleError('InvalidConfidence');
  if (input.sources.length === 0) throw new BundleError('EmptySources');
  if (input.observation.quarantined)
    throw new BundleError('QuarantinedObservation', input.observation.quarantined);
  for (const source of input.sources) {
    if (!ORIGINS.includes(source.origin)) throw new BundleError('InvalidSource', source.origin);
    if (source.permittedUse === 'revoked') throw new BundleError('RevokedEvidence', source.contentHash);
    // A vendor classification must cite the signal it came from; it is never inferred from the signal merely existing.
    if (source.origin === 'raindrop_classifier' && source.externalSignalIds.length === 0)
      throw new BundleError('InvalidSource', 'raindrop_classifier without a signal id');
  }
  const train = input.split === 'train';
  if (train && input.diagnostics.length > 0 && !input.sources.some((s) => s.origin === 'agent_self_report'))
    throw new BundleError('InvalidSource', 'diagnostics without an agent_self_report source');

  // Free text inside diagnostics fails closed: with no literal list it is reduced to a hash, and with one it is kept
  // only when it carries none of the literals. The bundle says when anything was withheld.
  const policy = { ...DEFAULT_SANITIZATION, forbiddenLiterals: input.guard.forbiddenLiterals };
  let freeTextWithheld = false;
  const reduce = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      const safe = sanitizeFreeText(value, policy);
      if (safe !== value) freeTextWithheld = true;
      return safe;
    }
    if (Array.isArray(value)) return value.map(reduce);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, reduce(child as JsonValue)]),
      );
    return value;
  };
  const diagnostics = train ? input.diagnostics.map(reduce) : [];
  const dropped = !train && input.diagnostics.length > 0;

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
    diagnostics,
    modelOutput: input.modelOutputSha256 ? `untrusted-model-output:sha256:${input.modelOutputSha256}` : '',
    sources: input.sources,
    cost: input.cost,
    confidence: input.confidence,
    split: input.split,
    withheld: {
      freeText: freeTextWithheld || dropped,
      values: !train && (input.tools.length > 0 || input.failureWitnesses.length > 0),
    },
  };
  assertNoLeak(bundle, input.guard);
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
    withheld: { freeText: false, values: true },
  };
  if (control.sources.length === 0) throw new BundleError('EmptySources');
  return control;
}

/**
 * Wrong-incident control: trace-derived evidence from an UNRELATED incident under this incident's identity, split and
 * cost, cut to this bundle's budget. If the proposer improves with it as well, the evidence content did not matter.
 *
 * Unrelated means disjoint by job, by world AND by every source identifier (a different run of the same job, or
 * another attempt of the same incident, does not qualify). The control never exceeds the treatment arm's budget: sources
 * and the model-output placeholder are trimmed along with tools, diagnostics and witnesses, and if it still does not fit
 * it throws `ControlOverBudget`.
 *
 * Replay note: a ledger row from the control's own run is held out. In-sample rows are the target incident's run, for
 * every arm, and attribution is by the cited evidence's run, so never read the control's run as the target.
 */
export function wrongIncidentControl(bundle: EvidenceBundle, other: EvidenceBundle): EvidenceBundle {
  if (!bundlesDisjoint(bundle, other))
    throw new BundleError('InvalidSource', 'wrong-incident control must be unrelated');
  const budget = bundleBudget(bundle);
  const control: EvidenceBundle = {
    ...bundle,
    evidenceId: `${bundle.evidenceId}:wrong_incident`,
    tools: [...other.tools],
    failureWitnesses: bundle.split === 'train' ? [...other.failureWitnesses] : [],
    diagnostics: bundle.split === 'train' ? [...other.diagnostics] : [],
    modelOutput: other.modelOutput,
    sources: [...other.sources],
    withheld: { ...(other.withheld ?? { freeText: false, values: false }) },
  };
  // Trim the largest contributors first, one element at a time, until it fits.
  while (bundleBudget(control) > budget) {
    if (control.tools.length) control.tools.pop();
    else if (control.diagnostics.length) control.diagnostics.pop();
    else if (control.failureWitnesses.length) control.failureWitnesses.pop();
    else if (control.sources.length > 1) control.sources.pop();
    else if (control.modelOutput) control.modelOutput = '';
    else throw new BundleError('ControlOverBudget');
  }
  return control;
}
