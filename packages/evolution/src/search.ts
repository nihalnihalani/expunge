// Bounded search over proposals for one incident and one evidence arm: branch (up to a proposal budget), prune rules
// without standing and retry, back off from rejected candidates, rank the compiled survivors, and keep every loser
// with its reason codes. Candidates never leave this module as "better": replay is diagnostic, fresh trials decide.
import { contentHash, type TypedPatch } from '@expunge/contracts';
import {
  compileAndReplay,
  evidenceLevelOf,
  isGoodCandidate,
  proposeCandidate,
  type ProposalRecord,
  type ProposeInput,
} from './propose.js';

const CLASS_RANK = { tightening: 0, behavioral: 1, authority_expansion: 2 } as const;

export interface SearchBudget {
  /** Hard cap on model proposals per arm: the equal budget the control arms share. */
  maxProposals: number;
  /** Stop as soon as a compiled candidate fixes recorded harm OUT OF SAMPLE and regresses nothing. */
  stopOnGood: boolean;
}
export const DEFAULT_BUDGET: SearchBudget = { maxProposals: 3, stopOnGood: true };

export interface LoserRecord {
  record: ProposalRecord;
  reasonCodes: string[];
}
export interface RoundResult {
  arm: ProposalRecord['arm'];
  budget: SearchBudget;
  proposalsUsed: number;
  records: ProposalRecord[];
  selected: ProposalRecord | null;
  losers: LoserRecord[];
  stopped: 'good_candidate' | 'budget';
  /**
   * What the selection rests on. `held_out`: the selected candidate fixed harm on runs other than its incident's.
   * `in_sample_only`: the best it shows is repairing the incident's own rows (or nothing), so it is only a
   * "candidate for gate". `none`: nothing compiled.
   */
  selectionBasis: 'held_out' | 'in_sample_only' | 'none';
}

// Ranking uses OUT-OF-SAMPLE evidence only: fixes on runs other than the incident's, minus twice the regressions
// anywhere. The incident's own rows decide nothing here. They break a tie only through attribution (below), and a
// selection resting on them is flagged `in_sample_only`.
const score = (record: ProposalRecord): number =>
  record.replay ? record.replay.heldOutFixes.length - 2 * record.replay.regressions.length : 0;
const attributed = (record: ProposalRecord): number => record.replay?.attribution.attributedFlips ?? 0;
function better(left: ProposalRecord, right: ProposalRecord): boolean {
  if (score(left) !== score(right)) return score(left) > score(right);
  if (attributed(left) !== attributed(right)) return attributed(left) > attributed(right);
  if ((left.patches?.length ?? 99) !== (right.patches?.length ?? 99))
    return (left.patches?.length ?? 99) < (right.patches?.length ?? 99);
  const classes = [left, right].map((entry) => CLASS_RANK[entry.computedClass ?? 'authority_expansion']);
  if (classes[0] !== classes[1]) return classes[0]! < classes[1]!;
  return left.branchIndex < right.branchIndex;
}

/** Patches whose guardrail rule had no standing are dropped; null when nothing meaningful is left. */
function withoutNoOps(record: ProposalRecord): TypedPatch[] | null {
  const noOps = new Set(
    (record.rejection?.issues ?? [])
      .filter((entry) => entry.code === 'no_op_rule')
      .map((entry) => entry.path),
  );
  if (!noOps.size || !record.patches) return null;
  const kept = record.patches.filter((patch) => !noOps.has(patch.path));
  return kept.length && kept.length < record.patches.length ? kept : null;
}

export async function runEvolutionRound(
  input: Omit<ProposeInput, 'branchIndex'>,
  budget: SearchBudget = DEFAULT_BUDGET,
): Promise<RoundResult> {
  const records: ProposalRecord[] = [];
  const losers: LoserRecord[] = [];
  let stopped: RoundResult['stopped'] = 'budget';
  let proposalsUsed = 0;
  for (let branchIndex = 0; branchIndex < budget.maxProposals; branchIndex++) {
    proposalsUsed++;
    let record = await proposeCandidate({ ...input, branchIndex });
    records.push(record);
    // Prune: a no-op rule in an otherwise useful batch is dropped and the rest is retried once; the original stays a loser.
    const remaining = record.status === 'compile_rejected' ? withoutNoOps(record) : null;
    if (remaining) {
      losers.push({ record, reasonCodes: ['pruned_no_op_rule', ...record.reasonCodes] });
      record = compileAndReplay(
        { ...input, branchIndex },
        { arm: record.arm, branchIndex, modelId: record.modelId, modelKind: record.modelKind },
        remaining,
        record.claimedClass ?? 'behavioral',
        record.hypothesis ??
          'Pruned: the rules without standing were removed and the remaining edits retried.',
      );
      records.push(record);
    }
    if (isGoodCandidate(record) && budget.stopOnGood) {
      stopped = 'good_candidate';
      break;
    }
  }
  const compiled = records.filter((entry) => entry.status === 'compiled');
  let selected: ProposalRecord | null = null;
  for (const entry of compiled) if (!selected || better(entry, selected)) selected = entry;
  for (const entry of records) {
    if (entry === selected) continue;
    if (entry.status === 'compiled') losers.push({ record: entry, reasonCodes: ['outranked'] });
    else if (!losers.some((loser) => loser.record === entry))
      losers.push({ record: entry, reasonCodes: [...entry.reasonCodes] });
  }
  const selectionBasis: RoundResult['selectionBasis'] = !selected
    ? 'none'
    : evidenceLevelOf(selected.replay) === 'out_of_sample_fix'
      ? 'held_out'
      : 'in_sample_only';
  return { arm: input.packet.arm, budget, proposalsUsed, records, selected, losers, stopped, selectionBasis };
}

/**
 * The same incident under the trace-informed arm and both controls, with an identical budget and packet size
 * allowance, so any difference in what they propose comes from the evidence content alone. Each result stores its arm.
 */
export async function runControlledRounds(
  base: Omit<ProposeInput, 'branchIndex' | 'packet'>,
  packets: Record<'trace_informed' | 'score_only' | 'wrong_incident', ProposeInput['packet']>,
  budget: SearchBudget = DEFAULT_BUDGET,
): Promise<Record<'trace_informed' | 'score_only' | 'wrong_incident', RoundResult>> {
  const out = {} as Record<'trace_informed' | 'score_only' | 'wrong_incident', RoundResult>;
  for (const arm of ['trace_informed', 'score_only', 'wrong_incident'] as const) {
    out[arm] = await runEvolutionRound({ ...base, packet: packets[arm] }, budget);
  }
  return out;
}

export const ROUND_DIGEST = (result: RoundResult): string =>
  contentHash(
    result.records.map((entry) => [entry.arm, entry.branchIndex, entry.status, entry.reasonCodes]),
    'evolution-round',
  );
