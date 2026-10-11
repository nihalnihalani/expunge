// What the evolver may read. Only sanitized, training-split, training-permitted evidence ever reaches a proposer;
// held-out manifests are not representable here. The two control arms use the same packet shape and the same
// size budget as the trace-informed arm, so any difference in what they propose comes from the content.
import {
  canonicalJson,
  type EvidenceBundle,
  type EvidenceReference,
  type JsonValue,
} from '@expunge/contracts';

export type EvidenceArm = 'trace_informed' | 'score_only' | 'wrong_incident';
export const EVIDENCE_ARMS: readonly EvidenceArm[] = ['trace_informed', 'score_only', 'wrong_incident'];

export interface EvidenceItem {
  evidenceId: string;
  view: JsonValue;
}
export interface EvidencePacket {
  arm: EvidenceArm;
  /** Evidence IDs of the incident the proposer is meant to address. */
  incidentIds: string[];
  /**
   * The job and run of that incident, whichever arm this is. Replay rows from these runs are IN-SAMPLE for every
   * arm: they are the evidence the proposal was mined from (or, for a control, meant to address) and cannot be used
   * to select it.
   */
  incidentRuns: Array<{ jobId: string; runId: string }>;
  items: EvidenceItem[];
  /** Every identifier a patch may cite; anything else is rejected before compilation. */
  citableIds: string[];
  /** References to append to a child bundle's `evidence` when it cites an identifier of this packet. */
  references: EvidenceReference[];
  chars: number;
  budgetChars: number;
  truncated: boolean;
}

export class EvidenceNotPermitted extends Error {
  constructor(public readonly evidenceId: string) {
    super('EvidenceNotPermitted');
  }
}
const permitted = (bundle: EvidenceBundle): boolean =>
  bundle.split === 'train' &&
  bundle.sources.length > 0 &&
  bundle.sources.every((source) => source.permittedUse === 'training');

function identifiers(bundle: EvidenceBundle): string[] {
  const ids = new Set([bundle.evidenceId]);
  for (const source of bundle.sources) {
    for (const id of [
      source.externalEventId,
      source.externalTraceId,
      ...source.externalSignalIds,
      ...source.localSourceIds,
    ]) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}
const sourceIds = (bundle: EvidenceBundle): JsonValue =>
  bundle.sources.map((source) => ({
    origin: source.origin,
    eventId: source.externalEventId ?? null,
    traceId: source.externalTraceId ?? null,
    signalIds: source.externalSignalIds,
  }));

function traceView(bundle: EvidenceBundle): JsonValue {
  return {
    evidenceId: bundle.evidenceId,
    runId: bundle.binding.runId,
    harnessHash: bundle.binding.harnessHash,
    tools: bundle.tools.map((tool) => ({
      toolId: tool.toolId,
      input: tool.input,
      output: tool.output,
      decision: tool.decision.result,
    })),
    failureWitnesses: bundle.failureWitnesses,
    diagnostics: bundle.diagnostics,
    modelOutput: bundle.modelOutput,
    cost: { ...bundle.cost },
    confidence: bundle.confidence,
    sources: sourceIds(bundle),
  };
}
/** The score the grader permits and nothing else: no tool trace, witness, diagnostic or model text. */
function scoreOnlyView(bundle: EvidenceBundle): JsonValue {
  return {
    evidenceId: bundle.evidenceId,
    runId: bundle.binding.runId,
    harnessHash: bundle.binding.harnessHash,
    outcome: 'incident_recorded',
    cost: { ...bundle.cost },
    confidence: bundle.confidence,
    sources: sourceIds(bundle),
  };
}

/** Deterministic truncation: drop trace entries from the end, then cut the longest strings, until it fits. */
function fit(items: EvidenceItem[], budgetChars: number): { items: EvidenceItem[]; truncated: boolean } {
  const size = (list: EvidenceItem[]) => canonicalJson(list).length;
  const current = structuredClone(items);
  let truncated = false;
  while (size(current) > budgetChars) {
    truncated = true;
    const victim = current.find((item) => {
      const view = item.view as Record<string, unknown>;
      return Array.isArray(view.tools) && view.tools.length > 0;
    });
    if (victim) {
      ((victim.view as Record<string, unknown>).tools as unknown[]).pop();
      continue;
    }
    const longest = current.find(
      (item) =>
        typeof (item.view as Record<string, unknown>).modelOutput === 'string' &&
        ((item.view as Record<string, unknown>).modelOutput as string).length > 40,
    );
    if (!longest) break;
    const view = longest.view as Record<string, unknown>;
    view.modelOutput = (view.modelOutput as string).slice(
      0,
      Math.floor((view.modelOutput as string).length / 2),
    );
  }
  return { items: current, truncated };
}

export function buildEvidencePacket(input: {
  arm: EvidenceArm;
  incident: readonly EvidenceBundle[];
  /** Other permitted incidents; the wrong-incident arm draws its unrelated trace from here. */
  pool?: readonly EvidenceBundle[];
  budgetChars: number;
}): EvidencePacket {
  for (const bundle of [...input.incident, ...(input.pool ?? [])]) {
    if (!permitted(bundle)) throw new EvidenceNotPermitted(bundle.evidenceId);
  }
  const incidentIds = input.incident.map((bundle) => bundle.evidenceId);
  let shown: EvidenceBundle[];
  let items: EvidenceItem[];
  if (input.arm === 'trace_informed') {
    shown = [...input.incident];
    items = shown.map((bundle) => ({ evidenceId: bundle.evidenceId, view: traceView(bundle) }));
  } else if (input.arm === 'score_only') {
    shown = [...input.incident];
    items = shown.map((bundle) => ({ evidenceId: bundle.evidenceId, view: scoreOnlyView(bundle) }));
  } else {
    // Unrelated incident, same schema and budget: the first pool bundle (by ID) that is not the real incident.
    const unrelated = [...(input.pool ?? [])]
      .filter((bundle) => !incidentIds.includes(bundle.evidenceId))
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))[0];
    if (!unrelated) throw new Error('NoUnrelatedIncident');
    shown = [unrelated];
    items = [{ evidenceId: unrelated.evidenceId, view: traceView(unrelated) }];
  }
  const fitted = fit(items, input.budgetChars);
  return {
    arm: input.arm,
    incidentIds,
    incidentRuns: input.incident.map((bundle) => ({
      jobId: bundle.binding.jobId,
      runId: bundle.binding.runId,
    })),
    items: fitted.items,
    citableIds: [...new Set(shown.flatMap(identifiers))],
    references: shown.flatMap((bundle) => bundle.sources),
    chars: canonicalJson(fitted.items).length,
    budgetChars: input.budgetChars,
    truncated: fitted.truncated,
  };
}
