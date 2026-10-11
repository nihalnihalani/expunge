import { type GateReport, type HarnessBundle, type MutationClass, type ScopeKey } from '@expunge/contracts';
import { EVALUATOR_HASH } from '@expunge/grader';
import { FIXTURE_GENERATOR_HASH } from '@expunge/fixtures';
import {
  ADMISSION_RULE_HASH,
  GateStore,
  childProjectionOf,
  reportIdOf,
  authorityFlipsOf,
  type AdmittedUnder,
} from '@expunge/gate';
import { COMPILER_HASH, classifyMutation } from '@expunge/harness-compiler';
import { fixturesAllowed } from './fixture-flag.js';
import { ArtifactRepository, ProvenanceRepository, fail, type MongoService } from '@expunge/mongo';

/** The label a test fixture's report carries. A loader refuses such a report unless the caller opts in. */
export const TEST_FIXTURE_LABEL = 'LABELED TEST FIXTURE: not produced by a gate run';
/** Labels of reports no real campaign wrote: a fixture, or a gate run over the SCRIPTED/FAKE port. */
const TEST_LABELS = ['LABELED TEST FIXTURE', 'SCRIPTED/FAKE'];

export type AdmittedReport = {
  report: GateReport;
  /** The hash of the stored body, recomputed here. */
  digest: string;
  parent: HarnessBundle;
  child: HarnessBundle;
  computedClass: MutationClass;
  flips: string[];
  admittedUnder: AdmittedUnder;
};

/**
 * Reads a gate report and refuses it unless EVERY precondition for acting on it holds. Nothing about the report is
 * taken from the request that names it: the id, the class, the digest, the child bytes and the current hashes are all
 * recomputed from stored rows and the modules that are running now.
 *
 * - the id is the one derived from (parent, executable projection of the STORED child);
 * - `report.childHash` is exactly the promoted hash, not merely a sibling with the same projection (DA-11 N-2), and
 *   that hash and its evidence are still eligible in the target scope;
 * - verdict `admit`, and a class that equals the class recomputed from the two stored bundles;
 * - a caller-supplied digest equals the recomputed one;
 * - the evaluator, fixture generator, compiler and admission rule it was decided under are the ones running now
 *   (DA-8 D8-11): a report from an older evaluator does not promote;
 * - it was decided on real evidence: a worker port and a provider model; a report labeled as a fixture or written by
 *   the SCRIPTED/FAKE port is refused (only the tests can lift that, through a module the package does not export).
 */
export async function loadAdmittedReport(
  service: MongoService,
  request: {
    reportId: string;
    parentHash: string;
    childHash: string;
    /** The scope the child would be promoted into. */
    scope: ScopeKey;
    expectedDigest?: string;
  },
): Promise<AdmittedReport> {
  const artifacts = new ArtifactRepository(service);
  const parent = (await artifacts.read(request.parentHash)).payload;
  const child = (await artifacts.read(request.childHash)).payload;
  if (child.parentHash !== request.parentHash) fail('GateReportParentMismatch');
  // The id is derived from what is stored, never from the request's word.
  if (request.reportId !== reportIdOf(request.parentHash, childProjectionOf(child)))
    fail('GateReportIdMismatch');
  const { report, digest } = await new GateStore(service).readReport(request.reportId);
  if (report.reportId !== request.reportId) fail('GateReportIdMismatch');
  if (report.parentHash !== request.parentHash) fail('GateReportParentMismatch');
  if (report.childHash !== request.childHash) fail('GateReportChildMismatch');
  if (report.verdict !== 'admit') fail('GateReportNotAdmitted');
  if (request.expectedDigest !== undefined && request.expectedDigest !== digest)
    fail('GateReportDigestMismatch');
  const computedClass = classifyMutation(parent, child).mutationClass;
  if (!computedClass || report.computedClass !== computedClass) fail('GateReportClassMismatch');
  if (
    JSON.stringify([...report.knownAuthorityFlips].sort()) !== JSON.stringify(authorityFlipsOf(parent, child))
  )
    fail('GateReportFlipsMismatch');

  if (report.evaluatorHash !== EVALUATOR_HASH) fail('GateReportEvaluatorStale');
  if (report.fixtureGeneratorHash !== FIXTURE_GENERATOR_HASH) fail('GateReportGeneratorStale');
  const controls = report.causalControls as { admittedUnder?: AdmittedUnder } | null;
  const under = controls?.admittedUnder;
  if (!under) fail('GateReportEvidenceMissing');
  if (under.compilerHash !== COMPILER_HASH || child.compilerHash !== COMPILER_HASH)
    fail('GateReportCompilerStale');
  if (under.ruleHash !== ADMISSION_RULE_HASH) fail('GateReportRuleStale');
  if (TEST_LABELS.some((label) => under.evidence.portLabel.startsWith(label)) && !fixturesAllowed())
    fail('GateReportFixture');
  if (under.evidence.portKind !== 'worker' || under.evidence.modelKind !== 'provider')
    fail('GateReportEvidenceNotReal');

  // The promoted bytes and their sources are still eligible now, not only when the gate ran.
  const hashes = [
    ...new Set([request.childHash, ...child.evidence.map((reference) => reference.contentHash)]),
  ];
  const tainted = await new ProvenanceRepository(service).tainted(request.scope, hashes);
  if (tainted.size > 0) fail('GateReportSourceIneligible');
  if (child.evidence.some((e) => e.permittedUse !== 'training' && e.permittedUse !== 'gate_only'))
    fail('GateReportSourceIneligible');

  return {
    report,
    digest,
    parent,
    child,
    computedClass,
    flips: authorityFlipsOf(parent, child),
    admittedUnder: under,
  };
}
