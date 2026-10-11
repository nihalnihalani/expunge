// One proposal, end to end: ask the model, validate its shape, check its citations against the packet it was shown,
// rebuild the child from the parent so nothing but the patches can differ, compile it, and replay it. Every outcome,
// including abstentions and rejections, is a record: losing candidates are kept with reason codes.
import {
  contentHash,
  type Candidate,
  type EvidenceReference,
  type HarnessBundle,
  type MutationClass,
  type ScopeKey,
  type TypedPatch,
} from '@expunge/contracts';
import {
  applyPatches,
  compileHarness,
  parsePatchPath,
  readUnit,
  type CompileContext,
  type CompiledArtifact,
  type DecisionLedgerRow,
  type EvidenceCatalog,
  type Rejection,
} from '@expunge/harness-compiler';
import type { EvidencePacket } from './evidence.js';
import { proposalSchema, toTypedPatch, type EvolverModel } from './model.js';
import { replayCandidate, type ReplayReport } from './replay.js';

export function evidenceLevelOf(replay: ReplayReport | undefined): EvidenceLevel {
  if (!replay) return 'no_replay_signal';
  if (replay.heldOutFixes.length > 0 && replay.regressions.length === 0) return 'out_of_sample_fix';
  return replay.inSampleFixes.length > 0 ? 'in_sample_only' : 'no_replay_signal';
}
/**
 * A compiled proposal good enough to stop the search on: it fixed recorded harm out of sample, regressed nothing, and
 * where it edited guardrails at least one flip is attributable to the evidence it cites.
 */
export function isGoodCandidate(record: ProposalRecord): boolean {
  const replay = record.replay;
  return (
    record.status === 'compiled' &&
    replay !== undefined &&
    evidenceLevelOf(replay) === 'out_of_sample_fix' &&
    (!replay.attribution.applicable || replay.attribution.attributedFlips > 0)
  );
}

/** What the proposer may write: a candidate without the gate's verdict (`computedClass`, lifecycle `state`). */
export type CandidateProposal = Omit<Candidate, 'computedClass' | 'state'>;

export type ProposalStatus =
  'abstained' | 'schema_rejected' | 'citation_rejected' | 'compile_rejected' | 'replay_rejected' | 'compiled';

/**
 * What the replay shows, at most. Only `out_of_sample_fix` is a fix: it repaired recorded harm on runs other than the
 * incident the proposal was mined from. `in_sample_only` repaired the incident's own rows and `no_replay_signal` has
 * nothing to show (no ledger, or edits replay cannot see); both are merely a "candidate for gate".
 */
export type EvidenceLevel = 'out_of_sample_fix' | 'in_sample_only' | 'no_replay_signal';

export interface ProposalRecord {
  proposalId: string;
  arm: EvidencePacket['arm'];
  branchIndex: number;
  modelId: string;
  modelKind: 'fake' | 'provider';
  status: ProposalStatus;
  reasonCodes: string[];
  /** Why the model abstained (its own words, bounded), if it did. */
  abstainReason?: string;
  /** The proposer's own claim and hypothesis, kept even when the candidate is rejected. */
  claimedClass?: MutationClass;
  hypothesis?: string;
  patches?: TypedPatch[];
  child?: HarnessBundle;
  proposal?: CandidateProposal;
  /** Set only when compilation succeeded: the compiler's authoritative class. */
  computedClass?: MutationClass | null;
  artifact?: CompiledArtifact;
  rejection?: Rejection;
  replay?: ReplayReport;
  /** Set whenever a replay ran. Absent for proposals that never reached one. */
  evidenceLevel?: EvidenceLevel;
}

export interface ProposeInput {
  model: EvolverModel;
  packet: EvidencePacket;
  branchIndex: number;
  parent: HarnessBundle;
  actor: ScopeKey;
  /** Compile context WITHOUT evidence and corpus: the evolver supplies those from the packet and ledger. */
  context: Omit<CompileContext, 'evidence' | 'replayCorpus'>;
  catalog: EvidenceCatalog;
  corpus?: readonly DecisionLedgerRow[];
  maxEdits?: number;
}

const DEFAULT_MAX_EDITS = 3;

function record(
  base: Pick<ProposalRecord, 'arm' | 'branchIndex' | 'modelId' | 'modelKind'>,
  status: ProposalStatus,
  reasonCodes: string[],
  extra: Partial<ProposalRecord> = {},
): ProposalRecord {
  return {
    proposalId: contentHash(
      { ...base, status, reasonCodes, extra: extra.child ? contentHash(extra.child) : null },
      'evolution-proposal',
    ),
    ...base,
    status,
    reasonCodes,
    ...extra,
  };
}

function evidenceReferences(packet: EvidencePacket, ids: ReadonlySet<string>): EvidenceReference[] {
  const wanted = packet.references.filter((reference) =>
    [
      reference.externalEventId,
      reference.externalTraceId,
      ...reference.externalSignalIds,
      ...reference.localSourceIds,
    ].some((id) => id !== undefined && ids.has(id)),
  );
  return [...new Map(wanted.map((reference) => [reference.contentHash, reference])).values()];
}

export async function proposeCandidate(input: ProposeInput): Promise<ProposalRecord> {
  const { model, packet, parent } = input;
  const base = {
    arm: packet.arm,
    branchIndex: input.branchIndex,
    modelId: model.id,
    modelKind: model.kind,
  } as const;
  const maxEdits = input.maxEdits ?? DEFAULT_MAX_EDITS;

  const raw = await model.propose({
    arm: packet.arm,
    branchIndex: input.branchIndex,
    maxEdits,
    parent,
    evidence: packet,
  });
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) return record(base, 'schema_rejected', ['model_output_invalid']);
  const proposal = parsed.data;
  if (proposal.abstain)
    return record(base, 'abstained', ['abstained'], { abstainReason: proposal.reason?.slice(0, 500) });

  // Citations are checked against the packet the model was actually shown, before anything is compiled.
  const citable = new Set(packet.citableIds);
  const cited = new Set(proposal.patches.flatMap((patch) => patch.sourceEvidenceIds));
  const ruleCited = proposal.patches.flatMap((patch) => {
    const after = patch.after as { sourceEvidenceIds?: unknown } | null;
    return after && Array.isArray(after.sourceEvidenceIds) ? (after.sourceEvidenceIds as string[]) : [];
  });
  if ([...cited, ...ruleCited].some((id) => !citable.has(id)))
    return record(base, 'citation_rejected', ['evidence_not_in_packet']);
  if (proposal.patches.length > maxEdits) return record(base, 'compile_rejected', ['edit_budget_exceeded']);

  const patches: TypedPatch[] = [];
  for (const proposed of proposal.patches) {
    const target = parsePatchPath(proposed.path);
    if (!target) return record(base, 'compile_rejected', ['patch_path_invalid']);
    // `before` is read from the parent, never taken from the model.
    patches.push(toTypedPatch(proposed, readUnit(parent, target)));
  }
  return compileAndReplay(input, base, patches, proposal.claimedClass, proposal.hypothesis);
}

/**
 * Rebuild the child from the parent and exactly these patches, compile it and replay it. Shared by the first attempt
 * and by the pruner, which retries without the patches that had no standing.
 */
export function compileAndReplay(
  input: ProposeInput,
  base: Pick<ProposalRecord, 'arm' | 'branchIndex' | 'modelId' | 'modelKind'>,
  patches: TypedPatch[],
  claimedClass: MutationClass,
  hypothesis: string,
): ProposalRecord {
  const { packet, parent } = input;
  const cited = new Set(patches.flatMap((patch) => patch.sourceEvidenceIds));
  const child = applyPatches(parent, patches);
  child.parentHash = contentHash(parent);
  child.evidence = [...parent.evidence, ...evidenceReferences(packet, cited)];

  const result = compileHarness(
    { candidate: child, parent, patches, claimedClass },
    { ...input.context, evidence: input.catalog, replayCorpus: input.corpus },
  );
  if (!result.ok) {
    return record(base, 'compile_rejected', result.rejection.codes, {
      patches,
      child,
      rejection: result.rejection,
      claimedClass,
      hypothesis,
    });
  }
  const { artifact } = result;
  const proposalRow: CandidateProposal = {
    candidateId: contentHash(
      {
        parentHash: contentHash(parent),
        childHash: artifact.bundleHash,
        arm: packet.arm,
        branchIndex: input.branchIndex,
      },
      'candidate',
    ),
    actor: input.actor,
    target: parent.target,
    parentHash: contentHash(parent),
    childHash: artifact.bundleHash,
    patches,
    hypothesis,
    sourceEvidence: child.evidence.slice(parent.evidence.length),
    claimedClass,
    artifactHashes: [artifact.bundleHash],
  };
  const common = {
    patches,
    child,
    proposal: proposalRow,
    computedClass: artifact.mutationClass,
    artifact,
    claimedClass,
    hypothesis,
  };
  if (!input.corpus?.length) return record(base, 'compiled', [], common);

  const replay = replayCandidate({
    parentRules: parent.guardrails,
    childRules: child.guardrails,
    parentHash: contentHash(parent),
    childHash: artifact.bundleHash,
    corpus: input.corpus,
    scope: { incidentRuns: packet.incidentRuns, evidence: input.catalog, candidateCitations: [...cited] },
  });
  const evidenceLevel = evidenceLevelOf(replay);
  const withReplay = { ...common, replay, evidenceLevel };
  if (replay.regressions.length) return record(base, 'replay_rejected', ['replay_regression'], withReplay);
  // Permitting more than the record did is an authority expansion; a candidate not classified as one is inconsistent.
  if (replay.knownAuthorityFlips.length && artifact.mutationClass !== 'authority_expansion') {
    return record(base, 'replay_rejected', ['authority_flip_without_expansion_class'], withReplay);
  }
  // A trace-informed candidate was mined from an incident, so a guardrail edit must change a decision on that
  // incident's own evidence. Control arms are reported with their attribution counts instead of rejected, so the
  // wrong-incident comparison stays meaningful.
  if (
    packet.arm === 'trace_informed' &&
    replay.attribution.applicable &&
    replay.attribution.attributedFlips === 0
  )
    return record(base, 'replay_rejected', ['no_attributed_effect'], withReplay);
  return record(base, 'compiled', [], withReplay);
}
