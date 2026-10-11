// Prints the C2 evidence: one generated candidate per surface against W0 with its computed class and replay report,
// the three evidence arms on one incident, and the rejection log (one unsafe candidate per rejection category).
// Everything here uses labelled fakes and fixture ledger rows; it proves no model behaviour and no Raindrop/Mongo data.
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
  corpus: W0_LEDGER,
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
  replay: record.replay && {
    label: record.replay.label,
    rows: record.replay.rows,
    flips: record.replay.flips.map((flip) => `${flip.decisionId}:${flip.from}->${flip.to}`),
    fixes: record.replay.fixes.length,
    regressions: record.replay.regressions.length,
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
    selected: rounds[arm].selected && summary(arm, rounds[arm].selected!),
    losers: rounds[arm].losers.map((loser) => ({
      branch: loser.record.branchIndex,
      reasons: loser.reasonCodes,
    })),
  })),
);

const rejectionLog = REJECTION_CODES.map((code) => {
  const result = REJECTION_CATALOG[code]();
  if (result.ok) return { code, rejected: false };
  const first = result.rejection.issues.find((issue) => issue.code === code) ?? result.rejection.issues[0]!;
  return { code, rejected: true, phase: result.rejection.phase, path: first.path, message: first.message };
});
out(
  `rejection log: ${rejectionLog.filter((row) => row.rejected).length}/${REJECTION_CODES.length} categories rejected`,
  rejectionLog,
);
if (rejectionLog.some((row) => !row.rejected)) process.exit(1);
