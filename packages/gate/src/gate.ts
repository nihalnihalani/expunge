import { readFileSync } from 'node:fs';
import {
  contentHash,
  type CostSummary,
  type GateReport,
  type HarnessBundle,
  type ResourceLimits,
  type ScopeKey,
} from '@expunge/contracts';
import { EVALUATOR_HASH } from '@expunge/grader';
import { FIXTURE_GENERATOR_HASH } from '@expunge/fixtures';
import { verifyGatePlanView, type GatePlanView } from '@expunge/fixtures/sealed';
import { COMPILER_HASH, classifyMutation } from '@expunge/harness-compiler';
import {
  ArtifactRepository,
  ProvenanceRepository,
  fail,
  requirePrincipal,
  type MongoService,
} from '@expunge/mongo';
import {
  ADMISSION_RULE_HASH,
  PLANNED_PAIRS,
  REASON_CODES,
  evaluateAdmission,
  evaluateIntegrity,
  summarize,
  type AdmissionDecision,
  type AdmissionInput,
} from './admission.js';
import { assertPlanShape, runCampaign, type CampaignRun } from './campaign.js';
import { ClaimStore, candidateKeyOf, childProjectionOf, reportIdOf, type ClaimTicket } from './claims.js';
import { FreezeStore, budgetHashOf, profileHashOf, type CampaignFreeze } from './freeze.js';
import { CampaignKeyStore, campaignCrypto } from './keys.js';
import { PublicTrialRows } from './public-rows.js';
import { buildGateReport, type AdmittedUnder, type ControlRow, type GateControls } from './report.js';
import { GateStore } from './store.js';
import type { EpisodePort, TrialRow } from './types.js';

/** The bytes of the gate's own decision code: recorded in every report so a change to the rule is visible. */
export const GATE_HASH = contentHash(
  {
    sources: ['admission.ts', 'campaign.ts', 'trials.ts', 'report.ts', 'claims.ts', 'gate.ts']
      .sort()
      .map((moduleId) => ({ moduleId, source: readFileSync(new URL(moduleId, import.meta.url), 'utf8') })),
  },
  'gate-source',
);

export type GateConfig = {
  /** The grader principal: reads the freeze, key and artifacts; inserts claims and reports. */
  grader: MongoService;
  campaignId: string;
  candidateId: string;
  parentHash: string;
  childHash: string;
  /** The split plan as the fixture builder sealed it for the gate: no final-split entry in full (D8-1). */
  view: GatePlanView;
  port: EpisodePort;
  /** The owner ceiling both arms run under; its hash must equal the freeze's. */
  budget: ResourceLimits;
  baseScope: Pick<ScopeKey, 'tenantId' | 'env'>;
  concurrency?: number;
  graceMs?: number;
  signal?: AbortSignal;
  /** Causal-control rows measured elsewhere in the campaign; recorded in the report as supplied. */
  controls?: ControlRow[];
  /** The production scope the candidate would be promoted into: its stored source eligibility is read there. */
  sourceScope: ScopeKey;
  /** An additional veto on the child's sources. It can only add ineligibility; it can never replace the built-in checks. */
  sourcesIneligible?: (child: HarnessBundle) => Promise<boolean>;
  /** TEST HOOK, forwarded to the claim: runs between taking an attempt and inserting the claim. */
  betweenAttemptAndInsert?: () => Promise<void>;
};

export type GateOutcome = {
  verdict: 'admit' | 'reject' | 'hold';
  reasonCodes: string[];
  decision: AdmissionDecision;
  /** Present for admit and reject: the stored document and its digest. Absent for a hold, which is not a record. */
  report: GateReport | null;
  digest: string | null;
  reportId: string;
  rows: TrialRow[];
  ticket: ClaimTicket;
  /** How many public training rows were written; -1 when writing them failed after the decision was stored. */
  publicRows?: number;
};

const HEX64 = /^[a-f0-9]{64}$/;
/** The bundle's own labels: a floor only. The stored eligibility below is what decides. */
const evidenceLabelsIneligible = (bundle: HarnessBundle): boolean =>
  bundle.evidence.some(
    (reference) => reference.permittedUse !== 'training' && reference.permittedUse !== 'gate_only',
  );

/**
 * Ineligible when ANY of: a self-declared label is not training or gate-only; a stored eligibility row (or an
 * ancestor's) for the child or one of its evidence hashes is not permitted in the target scope; or the caller's extra
 * veto says so. The hook is OR-ed in: returning false from it changes nothing.
 */
async function sourcesIneligibleFor(config: GateConfig, child: HarnessBundle): Promise<boolean> {
  if (evidenceLabelsIneligible(child)) return true;
  const hashes = [
    ...new Set([config.childHash, ...child.evidence.map((reference) => reference.contentHash)]),
  ];
  const tainted = await new ProvenanceRepository(config.grader).tainted(config.sourceScope, hashes);
  if (tainted.size > 0) return true;
  return (await config.sourcesIneligible?.(child)) === true;
}

/**
 * Fresh paired admission. The exact tested parent and child run on separately reset campaign worlds under equal
 * profile, budget and faults; failed, cancelled and timed-out arms stay in the denominator; the frozen rule decides.
 *
 * Everything "frozen" is read from the stored freeze row; everything "observed" comes from the modules that ran and
 * from the workers' own per-run attestations; nothing is a parameter of this call. A candidate gets one gate run per
 * (parent, executable child): the claim is inserted before the first episode. A hold decides nothing and its executed
 * trials are kept; the pair may be taken over by a later campaign. Only a decision is a stored report.
 */
export async function runGate(config: GateConfig): Promise<GateOutcome> {
  const { grader } = config;
  requirePrincipal(grader, ['grader']);
  if (!HEX64.test(config.parentHash) || !HEX64.test(config.childHash)) fail('InvalidGateRequest');

  // --- everything that can be refused before a claim is taken: nothing is consumed ------------------------------
  const freeze = await new FreezeStore(grader).read(config.campaignId);
  const stored = await new CampaignKeyStore(grader).read(config.campaignId);
  const crypto = campaignCrypto(stored);
  const artifacts = new ArtifactRepository(grader);
  const parent = (await artifacts.read(config.parentHash)).payload;
  const child = (await artifacts.read(config.childHash)).payload;
  if (child.parentHash !== config.parentHash) fail('CandidateParentMismatch');
  assertPlanShape(config.view);
  // A forged, swapped, final-split-bearing or foreign (self-consistent but not the frozen) view throws here, before the
  // claim: nothing is consumed and no seed is read.
  const observedCommitment = verifyGatePlanView(config.view, freeze.splitManifestCommitment);

  const childProjectionHash = childProjectionOf(child);
  const reportId = reportIdOf(config.parentHash, childProjectionHash);
  const mutation = classifyMutation(parent, child).mutationClass;
  const sourcesIneligible = await sourcesIneligibleFor(config, child);
  const base: Omit<AdmissionInput, 'rows' | 'planned' | 'evidence'> = {
    frozen: freeze,
    observed: {
      evaluatorHash: EVALUATOR_HASH,
      fixtureGeneratorHash: FIXTURE_GENERATOR_HASH,
      compilerHash: COMPILER_HASH,
      workerProfileHash: profileHashOf(config.port.profile),
      budgetHash: budgetHashOf(config.budget),
      splitManifestCommitment: observedCommitment,
    },
    budget: config.budget,
    parent,
    child,
    mutationClass: mutation,
    sourcesIneligible,
  };

  // --- the claim, before any episode ----------------------------------------------------------------------------
  const claims = new ClaimStore(grader);
  const ticket = await claims.claim({
    campaignId: config.campaignId,
    parentHash: config.parentHash,
    childProjectionHash,
    maxAttemptsPerParent: freeze.maxAttemptsPerParent,
    ...(config.betweenAttemptAndInsert ? { betweenAttemptAndInsert: config.betweenAttemptAndInsert } : {}),
  });
  const held = await claims.heldRunsOf(ticket.claimKey);
  const heldRuns: GateControls['heldRuns'] = held.map((row) => ({
    attempt: row.attempt,
    campaignId: row.campaignId,
    freezeHash: row.freezeHash,
    reasonCodes: row.reasonCodes,
    trials: row.trials.length,
  }));
  const heldCost = held.flatMap((row) =>
    row.trials.flatMap((trial) => {
      const cost = (trial as { cost?: CostSummary }).cost;
      return cost ? [cost] : [];
    }),
  );
  const admittedUnder: AdmittedUnder = {
    ruleHash: ADMISSION_RULE_HASH,
    gateHash: GATE_HASH,
    freezeHash: freeze.freezeHash,
    campaignId: config.campaignId,
    compilerHash: freeze.compilerHash,
    parentCompilerHash: parent.compilerHash,
    childCompilerHash: child.compilerHash,
    attempt: { ordinal: ticket.ordinal, parentAttempts: ticket.parentAttempts },
    resumes: ticket.resumeCount,
    evidence: {
      portKind: config.port.kind,
      portLabel: config.port.label,
      modelKind: config.port.profile.modelKind,
      profileId: config.port.profile.profileId,
    },
  };

  let run: CampaignRun | null = null;
  try {
    // Integrity first: a candidate that cannot be admitted for a reason that needs no episode is rejected without one.
    const pre = evaluateIntegrity(base);
    if (pre.size) {
      const integrity: AdmissionDecision = {
        verdict: 'reject',
        reasonCodes: REASON_CODES.filter((code) => pre.has(code)),
        summary: summarize([]),
        attestedRuntimeHash: null,
      };
      return await finish(config, freeze, ticket, claims, {
        parent,
        child,
        decision: integrity,
        rows: [],
        run: { rows: [], trainGrades: [] },
        reportId,
        heldRuns,
        heldCost,
        admittedUnder,
      });
    }

    run = await runCampaign({
      campaignId: config.campaignId,
      resume: ticket.resumeCount,
      view: config.view,
      parent: { hash: config.parentHash, bundle: parent },
      child: { hash: config.childHash, bundle: child },
      port: config.port,
      derivation: crypto.derivation,
      label: crypto.label,
      budget: config.budget,
      profile: config.port.profile,
      baseScope: config.baseScope,
      ...(config.concurrency ? { concurrency: config.concurrency } : {}),
      ...(config.graceMs ? { graceMs: config.graceMs } : {}),
      ...(config.signal ? { signal: config.signal } : {}),
    });
    const decision = evaluateAdmission({
      ...base,
      rows: run.rows,
      planned: PLANNED_PAIRS,
      cancelled: config.signal?.aborted === true,
      evidence: { portKind: config.port.kind, modelKind: config.port.profile.modelKind },
    });
    return await finish(config, freeze, ticket, claims, {
      parent,
      child,
      decision,
      rows: run.rows,
      run,
      reportId,
      heldRuns,
      heldCost,
      admittedUnder,
    });
  } catch (error) {
    // An unexpected failure is not a decision about the candidate. Keep what ran and put the pair back on hold.
    if (!(error instanceof Error && error.message === 'DecisionAlreadyRecorded'))
      await settleAfterCrash(claims, ticket, freeze, run?.rows ?? []).catch(() => undefined);
    throw error;
  }
}

async function finish(
  config: GateConfig,
  freeze: CampaignFreeze,
  ticket: ClaimTicket,
  claims: ClaimStore,
  context: {
    parent: HarnessBundle;
    child: HarnessBundle;
    decision: AdmissionDecision;
    rows: TrialRow[];
    run: CampaignRun;
    reportId: string;
    heldRuns: GateControls['heldRuns'];
    heldCost: CostSummary[];
    admittedUnder: AdmittedUnder;
  },
): Promise<GateOutcome> {
  const { decision, rows } = context;
  const report = buildGateReport({
    reportId: context.reportId,
    candidateId: config.candidateId,
    parentHash: config.parentHash,
    childHash: config.childHash,
    parent: context.parent,
    child: context.child,
    freeze,
    observed: { evaluatorHash: EVALUATOR_HASH, fixtureGeneratorHash: FIXTURE_GENERATOR_HASH },
    decision,
    rows,
    planned: rows.length ? PLANNED_PAIRS : 0,
    heldRuns: context.heldRuns,
    heldCost: context.heldCost,
    admittedUnder: context.admittedUnder,
    controls: config.controls ?? [],
  });
  if (decision.verdict === 'hold') {
    await claims.saveHeld(ticket, {
      freezeHash: freeze.freezeHash,
      reasonCodes: [...decision.reasonCodes],
      excluded: 'superseded_by_resume',
      trials: rows.flatMap((row) =>
        (['parent', 'candidate'] as const).map((armName) => ({
          pairId: row.pairId,
          arm: armName,
          outcome: row[armName].outcome,
          failureCode: row[armName].failureCode,
          usefulCompletion: row[armName].metrics.usefulCompletion,
          cost: row[armName].metrics.cost,
        })),
      ),
    });
    await claims.settle(ticket, 'held');
    return {
      verdict: 'hold',
      reasonCodes: decision.reasonCodes,
      decision,
      report: null,
      digest: null,
      reportId: context.reportId,
      rows,
      ticket,
    };
  }
  let digest: string;
  try {
    ({ digest } = await new GateStore(config.grader).saveReport(report));
  } catch (error) {
    // Only the grader can insert a report, and its _id belongs to this (parent, child) pair alone, so an existing one is
    // a decision this claim already recorded before a crash. Finish settling it instead of deciding a second time.
    if (error instanceof Error && error.message === 'GateReportExists') {
      await claims.settle(ticket, 'decided');
      return fail('DecisionAlreadyRecorded');
    }
    throw error;
  }
  await claims.settle(ticket, 'decided');
  // The public training rows are derivative of the stored decision; failing to write them does not undo it.
  const publicRows = await new PublicTrialRows(config.grader)
    .write(config.campaignId, context.run.trainGrades)
    .catch(() => -1);
  return {
    publicRows,
    verdict: decision.verdict,
    reasonCodes: decision.reasonCodes,
    decision,
    report,
    digest,
    reportId: context.reportId,
    rows,
    ticket,
  };
}

async function settleAfterCrash(
  claims: ClaimStore,
  ticket: ClaimTicket,
  freeze: CampaignFreeze,
  rows: TrialRow[],
): Promise<void> {
  await claims.saveHeld(ticket, {
    freezeHash: freeze.freezeHash,
    reasonCodes: ['gate_crashed'],
    excluded: 'superseded_by_resume',
    trials: rows.flatMap((row) =>
      (['parent', 'candidate'] as const).map((armName) => ({
        pairId: row.pairId,
        arm: armName,
        outcome: row[armName].outcome,
        cost: row[armName].metrics.cost,
      })),
    ),
  });
  await claims.settle(ticket, 'held');
}

export { candidateKeyOf, summarize };
