import type { HarnessBundle, ResourceLimits, ScopeKey } from '@expunge/contracts';
import type { GatePlanEntry, GatePlanView } from '@expunge/fixtures/sealed';
import type { GradeReport } from '@expunge/grader';
import { ADMISSION_RULE } from './admission.js';
import type { Derivation } from '@expunge/fixtures/sealed';
import type { Labeler } from './labels.js';
import { faultPlanKey, runArm, type ArmTask } from './trials.js';
import {
  GATE_SPLITS,
  type ArmName,
  type EpisodePort,
  type TrialArm,
  type TrialRow,
  type WorkerProfile,
} from './types.js';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_GRACE_MS = 15_000;

export type PairPlan = {
  pairId: string;
  split: (typeof GATE_SPLITS)[number];
  fixtureLabel: string;
  repeat: number;
  entry: GatePlanEntry;
};

/** The pairs a plan calls for, in a fixed order. Labels are HMACs: they name no fixture, split or repeat. */
export function planPairs(view: GatePlanView, campaignId: string, label: Labeler): PairPlan[] {
  const pairs: PairPlan[] = [];
  for (const split of GATE_SPLITS) {
    const entries = view.entries
      .filter((entry) => entry.split === split)
      .sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : 1));
    for (const entry of entries)
      for (let repeat = 1; repeat <= ADMISSION_RULE.shape[split].repeats; repeat++)
        pairs.push({
          pairId: `pair_${label('pair', { campaignId, fixtureId: entry.fixtureId, repeat }, 24)}`,
          split,
          fixtureLabel: `fx_${label('fixture', { campaignId, fixtureId: entry.fixtureId }, 16)}`,
          repeat,
          entry,
        });
  }
  return pairs;
}

/** A plan must call for exactly the frozen shape; anything else is a configuration error, not a verdict. */
export function assertPlanShape(view: GatePlanView): void {
  for (const split of GATE_SPLITS) {
    const have = view.entries.filter((entry) => entry.split === split).length;
    if (have !== ADMISSION_RULE.shape[split].fixtures) throw new Error(`PlanShapeMismatch:${split}`);
  }
}

export type CampaignRun = {
  rows: TrialRow[];
  /** The graded reports of the training pairs only, for the public rows. Never returned for a withheld split. */
  trainGrades: Array<{ pairId: string; repeat: number; arm: ArmName; grade: GradeReport; family: string }>;
};

export type CampaignArgs = {
  campaignId: string;
  resume: number;
  view: GatePlanView;
  parent: { hash: string; bundle: HarnessBundle };
  child: { hash: string; bundle: HarnessBundle };
  port: EpisodePort;
  derivation: Derivation;
  label: Labeler;
  budget: ResourceLimits;
  profile: WorkerProfile;
  baseScope: Pick<ScopeKey, 'tenantId' | 'env'>;
  concurrency?: number;
  graceMs?: number;
  signal?: AbortSignal;
};

/** A bounded pool. Order of results follows the order of tasks; the work itself overlaps up to `limit`. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Runs every pair of the plan: the exact tested parent and the exact tested child, each in a world instance of its
 * own, with equal profile, budget and fault plan. Every planned arm yields a row, whatever happened to it.
 */
export async function runCampaign(args: CampaignArgs): Promise<CampaignRun> {
  const pairs = planPairs(args.view, args.campaignId, args.label);
  const signal = args.signal ?? new AbortController().signal;
  const tasks = pairs.flatMap((pair) => (['parent', 'candidate'] as const).map((arm) => ({ pair, arm })));
  const base = { campaignId: args.campaignId, resume: args.resume };
  const done = await pool(tasks, args.concurrency ?? DEFAULT_CONCURRENCY, async ({ pair, arm }) => {
    const bundle = arm === 'parent' ? args.parent : args.child;
    const task: ArmTask = {
      ...base,
      pairLabel: pair.pairId,
      repeat: pair.repeat,
      arm,
      entry: pair.entry,
      bundle: bundle.bundle,
      bundleHash: bundle.hash,
      budget: args.budget,
      profile: args.profile,
      graceMs: args.graceMs ?? DEFAULT_GRACE_MS,
    };
    const out = await runArm(
      { port: args.port, derivation: args.derivation, label: args.label, signal, baseScope: args.baseScope },
      task,
    );
    return { pair, arm, out };
  });
  const rows: TrialRow[] = [];
  const trainGrades: CampaignRun['trainGrades'] = [];
  for (const pair of pairs) {
    const find = (arm: ArmName): TrialArm =>
      done.find((item) => item.pair === pair && item.arm === arm)!.out.arm;
    rows.push({
      pairId: pair.pairId,
      split: pair.split,
      fixtureLabel: pair.fixtureLabel,
      repeat: pair.repeat,
      family: pair.entry.spec.family,
      seedCommitment: pair.entry.spec.seedCommitment,
      faultPlanHash: faultPlanKey(pair.entry.spec.faults),
      parent: find('parent'),
      candidate: find('candidate'),
    });
    if (pair.split === 'train')
      for (const arm of ['parent', 'candidate'] as const) {
        const grade = done.find((item) => item.pair === pair && item.arm === arm)!.out.grade;
        if (grade)
          trainGrades.push({
            pairId: pair.pairId,
            repeat: pair.repeat,
            arm,
            grade,
            family: pair.entry.spec.family,
          });
      }
  }
  return { rows, trainGrades };
}
