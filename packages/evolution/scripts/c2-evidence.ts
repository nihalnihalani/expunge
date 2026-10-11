// Prints the C2 evidence: one generated candidate per surface against W0 with its computed class and replay report,
// the three evidence arms on one incident, and the rejection log (one unsafe candidate per rejection category).
// Everything here uses labelled fakes and fixture ledger rows; it proves no model behaviour and no Raindrop/Mongo data.
// IN-SAMPLE means rows from the incident run the proposal was mined from (W0_LEDGER, run_a01); OUT-OF-SAMPLE (held-out)
// rows come from a different run (VALIDATION_LEDGER, run_v01). Only out-of-sample fixes are called fixes and only they
// can stop or steer the search; a candidate that repairs just its own incident is a "candidate for gate".
// The fake's arm separation is constructed by keyword rules over the packet text, so it demonstrates the plumbing, not
// that a real model would separate the arms: that transfer is untested until credentials exist.
// Run: npx tsx packages/evolution/scripts/c2-evidence.ts
import { REJECTION_CODES } from '@expunge/harness-compiler';
import { REJECTION_CATALOG } from '../../harness-compiler/test/rejection-catalog.js';
import {
  EVIDENCE_ARMS,
  buildEvidencePacket,
  createLabeledFakeEvolverModel,
  proposeCandidate,
  runControlledRounds,
  type ProposalRecord,
} from '../src/index.js';
import {
  ACTOR,
  CATALOG,
  FULL_LEDGER,
  INCIDENT_A,
  INCIDENT_B,
  INCIDENT_C,
  W0_LEDGER,
  compileContext,
  w0,
} from '../test/helpers.js';

const budgetChars = 6000;
const packet = (incident = INCIDENT_A, arm: (typeof EVIDENCE_ARMS)[number] = 'trace_informed') =>
  buildEvidencePacket({ arm, incident: [incident], pool: [INCIDENT_A, INCIDENT_B, INCIDENT_C], budgetChars });
const base = {
  model: createLabeledFakeEvolverModel('honest'),
  parent: w0(),
  actor: ACTOR,
  context: compileContext(),
  catalog: CATALOG,
  corpus: FULL_LEDGER,
};

const summary = (surface: string, record: ProposalRecord) => ({
  surface,
  status: record.status,
  arm: record.arm,
  patches: record.patches?.map((patch) => patch.path),
  claimedClass: record.claimedClass,
  computedClass: record.computedClass,
  citedIds: [...new Set(record.patches?.flatMap((patch) => patch.sourceEvidenceIds))],
  childHash: record.proposal?.childHash.slice(0, 16),
  evidenceLevel: record.evidenceLevel,
  replay: record.replay && {
    label: record.replay.label,
    rows: record.replay.rows,
    flips: record.replay.flips.map((flip) => `${flip.decisionId}:${flip.from}->${flip.to} [${flip.sample}]`),
    inSample: record.replay.inSample,
    outOfSample: record.replay.heldOut,
    regressions: record.replay.regressions.length,
    attribution: record.replay.attribution,
    knownAuthorityFlips: record.replay.knownAuthorityFlips.length,
    futureFactsDropped: record.replay.futureFactsDropped,
    behavioralProof: record.replay.behavioralProof,
  },
});

const out = (title: string, value: unknown) =>
  console.log(`\n== ${title}\n${JSON.stringify(value, null, 1)}`);

const cases: Array<[string, Parameters<typeof packet>[0], number]> = [
  ['context', INCIDENT_A, 0],
  ['guardrails', INCIDENT_A, 1],
  ['workflow', INCIDENT_C, 0],
  ['tool_policy', INCIDENT_B, 0],
];
const perSurface = [];
for (const [surface, incident, branchIndex] of cases) {
  perSurface.push(
    summary(surface, await proposeCandidate({ ...base, packet: packet(incident), branchIndex })),
  );
}
// The same guardrail candidate against the incident's own run only: its fixes are in-sample, so it is a candidate for gate.
perSurface.push(
  summary(
    'guardrails (incident run only: in-sample, a candidate for gate)',
    await proposeCandidate({ ...base, corpus: W0_LEDGER, packet: packet(INCIDENT_A), branchIndex: 1 }),
  ),
);
out('one generated candidate per surface against W0 (labelled FAKE model, fixture ledger)', perSurface);

const packets = Object.fromEntries(EVIDENCE_ARMS.map((arm) => [arm, packet(INCIDENT_A, arm)])) as Record<
  (typeof EVIDENCE_ARMS)[number],
  ReturnType<typeof packet>
>;
const rounds = await runControlledRounds(base, packets);
out(
  'evidence arms on one incident (equal budget)',
  EVIDENCE_ARMS.map((arm) => ({
    arm,
    packetChars: packets[arm].chars,
    budgetChars: packets[arm].budgetChars,
    proposalsUsed: rounds[arm].proposalsUsed,
    stopped: rounds[arm].stopped,
    selectionBasis: rounds[arm].selectionBasis,
    selected: rounds[arm].selected && summary(arm, rounds[arm].selected!),
    losers: rounds[arm].losers.map((loser) => ({
      branch: loser.record.branchIndex,
      reasons: loser.reasonCodes,
    })),
  })),
);

// Each category must be rejected with ITS OWN code, as in the catalog test, not merely rejected for some reason.
const rejectionLog = REJECTION_CODES.map((code) => {
  const result = REJECTION_CATALOG[code]();
  if (result.ok) return { code, rejected: false, rejectedWithExpectedCode: false };
  const expected = result.rejection.issues.find((issue) => issue.code === code);
  const first = expected ?? result.rejection.issues[0]!;
  return {
    code,
    rejected: true,
    rejectedWithExpectedCode: result.rejection.codes.includes(code),
    phase: result.rejection.phase,
    path: first.path,
    message: first.message,
  };
});
const exact = rejectionLog.filter((row) => row.rejectedWithExpectedCode).length;
out(
  `rejection log: ${exact}/${REJECTION_CODES.length} categories rejected with the expected code`,
  rejectionLog,
);
if (exact !== REJECTION_CODES.length) process.exit(1);
