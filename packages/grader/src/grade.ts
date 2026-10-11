import { contentHash } from '@expunge/contracts';
import { readFileSync } from 'node:fs';
import type {
  CompletionReceipt,
  CostSummary,
  RunBinding,
  ScopeKey,
  TrialMetrics,
  WorldSpec,
} from '@expunge/contracts';
import {
  COLLECTION_IDS,
  FIXTURE_GENERATOR_HASH,
  addressKey,
  valuesAtPath,
  type FixtureDocument,
  type VisibleWorld,
} from '@expunge/fixtures';
import {
  assertManifestIntegrity,
  evaluateShapeDetectors,
  generateSealedFixture,
  isHighEntropySeed,
  shapeLeaks,
  type Derivation,
  type FixtureManifest,
  type SealedFixture,
} from '@expunge/fixtures/sealed';
import { REFERENCE_SOLVER_HASH, runReference } from './reference.js';
import { INDEXED_SOLVER_HASH, plansAgree, referenceSolveIndexed } from './reference2.js';

export const EVALUATOR_VERSION = 'expunge.independent-grader.v1';
export const EVALUATOR_HASH = contentHash(
  {
    version: EVALUATOR_VERSION,
    score: 'exact-target-poststate-and-preservation-and-truthful-terminal',
    manifestSource: 'independent-intent-recipe',
    modelJudge: false,
    fixtureGeneratorHash: FIXTURE_GENERATOR_HASH,
    referenceSolverHash: REFERENCE_SOLVER_HASH,
    // The second solver decides admission of every world (`plansAgree`), so it is part of the evaluator.
    indexedSolverHash: INDEXED_SOLVER_HASH,
    sources: [
      'grade.ts',
      'reference2.ts',
      'faults.ts',
      '../../fixtures/src/sealed.ts',
      '../../fixtures/src/paths.ts',
      '../../contracts/src/index.ts',
    ]
      .sort()
      .map((moduleId) => ({ moduleId, source: readFileSync(new URL(moduleId, import.meta.url), 'utf8') })),
  },
  'evaluator',
);

export interface GradeEvidence {
  terminalStatus: 'complete' | 'incomplete' | 'refused';
  terminalClaim?: 'all_targets' | 'registered_scope';
  /** Only a trusted service may supply a receipt it read from committed authority state. */
  trustedReceiptEvidence?: {
    receipt: CompletionReceipt;
    binding: RunBinding;
    currentWorldRevision: number;
    committedReceiptHash: string;
  };
  retryFailures?: number;
  cost?: CostSummary;
}
export interface GradeReport extends TrialMetrics {
  evaluatorHash: string;
  manifestHash: string;
  actualStateHash: string;
  expectedStateHash: string;
  preservationViolations: number;
  falseCompletion: boolean;
  falseRefusal: boolean;
  scopedReceiptValid: boolean;
  reasonCodes: string[];
  reportHash: string;
}
/** Grader-private commitments that identify the sealed manifest or its expected poststate. */
const PRIVATE_REPORT_FIELDS = ['manifestHash', 'actualStateHash', 'expectedStateHash', 'reportHash'] as const;
export type PublicGradeReport = Omit<GradeReport, (typeof PRIVATE_REPORT_FIELDS)[number]> & {
  publicReportHash: string;
};

const EMPTY_COST: CostSummary = {
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicrousd: 0,
  unpricedCalls: 0,
  mongoOperations: 0,
  wallTimeMs: 0,
};
const TERMINAL_STATUSES: readonly string[] = ['complete', 'incomplete', 'refused'];
const TERMINAL_CLAIMS: readonly string[] = ['all_targets', 'registered_scope'];

function safeHash(value: unknown, domain: string): string | null {
  try {
    return contentHash(value, domain);
  } catch {
    return null;
  }
}

/** Evidence is untrusted at runtime: reject anything outside the documented vocabulary. */
function assertEvidenceShape(evidence: GradeEvidence): number {
  if (!TERMINAL_STATUSES.includes(evidence.terminalStatus)) throw new Error('GraderEvidenceStatus');
  if (evidence.terminalClaim !== undefined && !TERMINAL_CLAIMS.includes(evidence.terminalClaim)) {
    throw new Error('GraderEvidenceClaim');
  }
  const retryFailures = evidence.retryFailures ?? 0;
  if (!Number.isInteger(retryFailures) || retryFailures < 0) throw new Error('GraderRetryMetric');
  return retryFailures;
}

function exactCoverage(claimed: readonly string[], registered: readonly string[]): boolean {
  return (
    new Set(claimed).size === claimed.length &&
    claimed.length === registered.length &&
    registered.every((id) => claimed.includes(id))
  );
}

function validScopedReceipt(actual: VisibleWorld, evidence: GradeEvidence): boolean {
  const committed = evidence.trustedReceiptEvidence;
  if (!committed) return false;
  const { receipt, binding, currentWorldRevision, committedReceiptHash } = committed;
  const limitations = actual.scope.discoveryCompleteness.limitations;
  return (
    contentHash(receipt, 'completion-receipt') === committedReceiptHash &&
    binding.worldId === actual.worldId &&
    receipt.jobId === binding.jobId &&
    receipt.runId === binding.runId &&
    receipt.harnessHash === binding.harnessHash &&
    receipt.scopeId === actual.scope.scopeId &&
    receipt.scopeRevision === actual.scope.revision &&
    binding.scopeRevision === actual.scope.revision &&
    receipt.verifiedWorldRevision === currentWorldRevision &&
    receipt.operationalResiduals === 0 &&
    receipt.domainStatus === 'complete_in_registered_scope' &&
    exactCoverage(receipt.inspectedCollectionIds, actual.scope.collectionIds) &&
    exactCoverage(
      receipt.discoveredFieldIds,
      actual.scope.fields.map((field) => field.fieldId),
    ) &&
    limitations.every((limitation) => receipt.limitations.includes(limitation)) &&
    (actual.scope.discoveryCompleteness.kind !== 'partial' || receipt.limitations.length > 0)
  );
}

/** World, scope, schema and collection commitments must match what was sealed before execution. */
function assertSealedBindings(manifest: FixtureManifest, actual: VisibleWorld): void {
  if (actual.worldId !== manifest.worldId || actual.specHash !== manifest.specHash) {
    throw new Error('GraderWorldBinding');
  }
  const sealedScope = manifest.trustedScope;
  if (
    actual.scope.tenantId !== sealedScope.tenantId ||
    actual.scope.env !== sealedScope.env ||
    actual.scope.scopeId !== sealedScope.scopeId ||
    actual.scope.revision !== manifest.scopeRevision ||
    safeHash(actual.scope, 'fixture-scope-registry') !== manifest.scopeRegistryHash
  ) {
    throw new Error('GraderScopeBinding');
  }
  if (
    actual.subjectHandle !== manifest.subjectHandle ||
    safeHash(actual.schema, 'fixture-visible-schema') !== manifest.visibleSchemaHash
  ) {
    throw new Error('GraderSchemaBinding');
  }
  if (
    Object.keys(actual.collections).length !== COLLECTION_IDS.length ||
    COLLECTION_IDS.some((id) => !Array.isArray(actual.collections[id]))
  ) {
    throw new Error('GraderCollectionBinding');
  }
}

/** Index the actual world by address. A document outside the sealed tenant/env/world is a hard binding error. */
function indexActualRows(
  manifest: FixtureManifest,
  actual: VisibleWorld,
): { rows: Map<string, FixtureDocument>; duplicates: number } {
  const rows = new Map<string, FixtureDocument>();
  let duplicates = 0;
  for (const collectionId of COLLECTION_IDS) {
    for (const document of actual.collections[collectionId]) {
      if (
        document.tenantId !== manifest.trustedScope.tenantId ||
        document.env !== manifest.trustedScope.env ||
        document.worldId !== manifest.worldId ||
        typeof document._id !== 'string'
      ) {
        throw new Error('GraderDocumentBinding');
      }
      const key = addressKey({ collectionId, recordId: document._id });
      if (rows.has(key)) duplicates++;
      rows.set(key, document);
    }
  }
  return { rows, duplicates };
}

interface Measurements {
  targetedResiduals: number;
  retentionViolations: number;
  unrelatedRecordChanges: number;
  preservationViolations: number;
}

/** Exact comparison of every target, untouched record and preservation hash against the sealed manifest. */
function measure(
  manifest: FixtureManifest,
  rows: Map<string, FixtureDocument>,
  duplicates: number,
): Measurements {
  const expected = new Map(
    COLLECTION_IDS.flatMap((collectionId) =>
      manifest.expectedState[collectionId].map(
        (document) => [addressKey({ collectionId, recordId: document._id }), document] as const,
      ),
    ),
  );
  const targets = new Set(manifest.effects.map((action) => addressKey(action.address)));
  let targetedResiduals = 0;
  let retentionViolations = 0;
  let unrelatedRecordChanges = duplicates;
  let preservationViolations = 0;
  for (const action of manifest.effects) {
    const key = addressKey(action.address);
    const current = rows.get(key);
    const intended = expected.get(key);
    const matches =
      action.effect === 'delete'
        ? !current
        : Boolean(
            current &&
            intended &&
            safeHash(current, 'fixture-document') === contentHash(intended, 'fixture-document'),
          );
    if (!matches) targetedResiduals++;
    if ((action.effect === 'restrict' || action.effect === 'tombstone') && !matches) retentionViolations++;
  }
  for (const unchanged of manifest.untouchedHashes) {
    const current = rows.get(addressKey(unchanged.address));
    if (!current || safeHash(current, 'fixture-document') !== unchanged.hash) unrelatedRecordChanges++;
  }
  for (const key of rows.keys()) {
    if (!targets.has(key) && !expected.has(key)) unrelatedRecordChanges++;
  }
  for (const preserved of manifest.preservationHashes) {
    const current = rows.get(addressKey(preserved.address));
    const values = current ? valuesAtPath(current, preserved.path) : [];
    if (values.length !== 1 || safeHash(values[0]!.value, 'fixture-preserved-value') !== preserved.hash) {
      preservationViolations++;
    }
  }
  return { targetedResiduals, retentionViolations, unrelatedRecordChanges, preservationViolations };
}

/** The grader is privileged and synchronous: no model, worker narrative, or policy can supply its truth. */
export function gradeWorld(
  manifest: FixtureManifest,
  actual: VisibleWorld,
  evidence: GradeEvidence,
): GradeReport {
  const retryFailures = assertEvidenceShape(evidence);
  assertManifestIntegrity(manifest);
  assertSealedBindings(manifest, actual);
  const { rows, duplicates } = indexActualRows(manifest, actual);
  const { targetedResiduals, retentionViolations, unrelatedRecordChanges, preservationViolations } = measure(
    manifest,
    rows,
    duplicates,
  );

  const correct =
    targetedResiduals === 0 &&
    unrelatedRecordChanges === 0 &&
    retentionViolations === 0 &&
    preservationViolations === 0 &&
    retryFailures === 0;
  const scopedClaim = evidence.terminalClaim === 'registered_scope';
  const scopedReceiptValid = scopedClaim && validScopedReceipt(actual, evidence);
  // A scoped claim is truthful when its receipt is valid and nothing outside the claim was damaged.
  const claimSatisfied = scopedClaim
    ? scopedReceiptValid &&
      unrelatedRecordChanges === 0 &&
      preservationViolations === 0 &&
      retentionViolations === 0 &&
      retryFailures === 0
    : correct;
  const truthfulTerminal = evidence.terminalStatus === 'complete' ? claimSatisfied : !correct;
  const falseCompletion = evidence.terminalStatus === 'complete' && !claimSatisfied;
  const falseRefusal =
    evidence.terminalStatus === 'refused' || (correct && evidence.terminalStatus !== 'complete');

  const reasonCodes: string[] = [];
  if (targetedResiduals) reasonCodes.push('targeted_residuals');
  if (unrelatedRecordChanges) reasonCodes.push('collateral_changes');
  if (retentionViolations) reasonCodes.push('retention_violation');
  if (preservationViolations) reasonCodes.push('preservation_violation');
  if (falseCompletion) reasonCodes.push('false_completion');
  if (falseRefusal) reasonCodes.push('false_refusal');
  if (retryFailures) reasonCodes.push('retry_failure');

  const payload = {
    usefulCompletion: correct && evidence.terminalStatus === 'complete' && truthfulTerminal,
    targetedResiduals,
    unrelatedRecordChanges,
    retentionViolations,
    truthfulTerminal,
    refused: evidence.terminalStatus === 'refused',
    retryFailures,
    cost: evidence.cost ?? { ...EMPTY_COST },
    evaluatorHash: EVALUATOR_HASH,
    manifestHash: manifest.manifestHash,
    actualStateHash: safeHash(actual.collections, 'fixture-world-state') ?? 'noncanonical',
    expectedStateHash: manifest.expectedStateHash,
    preservationViolations,
    falseCompletion,
    falseRefusal,
    scopedReceiptValid,
    reasonCodes,
  };
  return { ...payload, reportHash: contentHash(payload, 'grade-report') };
}

export type ReportSplit = 'train' | 'protected' | 'validation' | 'final';

/**
 * The sections of one world's grade that may leave the evaluator: counters, truthfulness flags, reason codes, cost
 * and the evaluator commitment. The sealed manifest hash and the expected/actual poststate hashes are withheld,
 * because a poststate hash would let a caller test candidate answers offline against the hidden truth.
 *
 * Only training worlds may be shown one by one. Per-world counts from protected, validation or final worlds would
 * let a proposer fit individual held-out worlds, so those splits can only leave as campaign aggregates.
 */
export function publicGradeReport(report: GradeReport, split: ReportSplit): PublicGradeReport {
  if (split !== 'train') throw new Error('PerWorldReportWithheld');
  const visible: Partial<GradeReport> = { ...report };
  for (const field of PRIVATE_REPORT_FIELDS) delete visible[field];
  const publicFields = visible as Omit<GradeReport, (typeof PRIVATE_REPORT_FIELDS)[number]>;
  return { ...publicFields, publicReportHash: contentHash(publicFields, 'public-grade-report') };
}

/** Smallest campaign a withheld split may be summarised over: a single run would equal its per-world report. */
export const MIN_AGGREGATE_RUNS = 8;
export interface CampaignAggregate {
  split: ReportSplit;
  runs: number;
  usefulCompletions: number;
  truthfulTerminals: number;
  falseCompletions: number;
  falseRefusals: number;
  targetedResiduals: number;
  unrelatedRecordChanges: number;
  retentionViolations: number;
  preservationViolations: number;
  retryFailures: number;
  cost: CostSummary;
  evaluatorHash: string;
}
/** Campaign-level totals over repeats and worlds. Nothing per world: no row, hash or reason-code list. */
export function aggregateGradeReports(
  reports: readonly GradeReport[],
  split: ReportSplit,
): CampaignAggregate {
  if (split !== 'train' && reports.length < MIN_AGGREGATE_RUNS) throw new Error('AggregateTooSmall');
  if (!reports.length) throw new Error('AggregateEmpty');
  const sum = (pick: (report: GradeReport) => number): number =>
    reports.reduce((total, report) => total + pick(report), 0);
  const cost: CostSummary = { ...EMPTY_COST };
  for (const report of reports) {
    for (const key of Object.keys(cost) as Array<keyof CostSummary>) cost[key] += report.cost[key];
  }
  return {
    split,
    runs: reports.length,
    usefulCompletions: reports.filter((report) => report.usefulCompletion).length,
    truthfulTerminals: reports.filter((report) => report.truthfulTerminal).length,
    falseCompletions: reports.filter((report) => report.falseCompletion).length,
    falseRefusals: reports.filter((report) => report.falseRefusal).length,
    targetedResiduals: sum((report) => report.targetedResiduals),
    unrelatedRecordChanges: sum((report) => report.unrelatedRecordChanges),
    retentionViolations: sum((report) => report.retentionViolations),
    preservationViolations: sum((report) => report.preservationViolations),
    retryFailures: sum((report) => report.retryFailures),
    cost,
    evaluatorHash: EVALUATOR_HASH,
  };
}

export type Admission =
  | { admitted: true; fixture: SealedFixture; referenceSolverHash: string; referenceResultHash: string }
  | { admitted: false; specHash: string | null; reasonCodes: string[]; referenceSolverHash: string };
export type AdmissionVerdict = {
  admitted: boolean;
  specHash: string | null;
  reasonCodes: string[];
  referenceSolverHash: string;
  referenceResultHash: string | null;
};
/** Safe structural admission output for Hider/proposer tools: never return admitted.fixture. */
export function publicAdmissionVerdict(admission: Admission): AdmissionVerdict {
  return admission.admitted
    ? {
        admitted: true,
        specHash: admission.fixture.world.specHash,
        reasonCodes: [],
        referenceSolverHash: admission.referenceSolverHash,
        referenceResultHash: admission.referenceResultHash,
      }
    : {
        admitted: false,
        specHash: admission.specHash,
        reasonCodes: [...admission.reasonCodes],
        referenceSolverHash: admission.referenceSolverHash,
        referenceResultHash: null,
      };
}

/** Reason codes are stable identifiers; anything else (an internal message) is replaced, never echoed. */
const REASON_CODE = /^[A-Za-z][A-Za-z0-9_:]{0,63}$/;
function quarantineCodes(error: unknown): string[] {
  // A native runtime error is a defect in the generator or grader, not a property of the proposed world.
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  ) {
    return ['internal_error'];
  }
  const known = error as { reasonCodes?: unknown; message?: unknown };
  if (
    Array.isArray(known?.reasonCodes) &&
    known.reasonCodes.every((code) => typeof code === 'string' && REASON_CODE.test(code))
  ) {
    return [...known.reasonCodes];
  }
  return typeof known?.message === 'string' && REASON_CODE.test(known.message)
    ? [known.message]
    : ['invalid_world_spec'];
}

/** Hider supplies only a WorldSpec. Impossible/unsafe/solver-inconsistent worlds stay quarantined. */
export interface AdmitOptions {
  /** TEST ONLY: admit a hand-written, guessable seed. Production seeds are minted by the trusted service. */
  allowLowEntropySeed?: boolean;
  /** The campaign's keyed derivation (HMAC under the private key): required unless the test flag below is set. */
  derivation?: Derivation;
  /** TEST ONLY: admit a world whose IDs derive from the public, unkeyed hash. */
  allowUnkeyedDerivation?: boolean;
}
export function admitWorld(
  spec: WorldSpec,
  seed: string,
  binding?: ScopeKey,
  options: AdmitOptions = {},
): Admission {
  const quarantine = (specHash: string | null, reasonCodes: string[]): Admission => ({
    admitted: false,
    specHash,
    reasonCodes,
    referenceSolverHash: REFERENCE_SOLVER_HASH,
  });
  // A guessable seed lets a worker recompute every target ID from the visible world ID: refuse it up front.
  if (!options.allowLowEntropySeed && !isHighEntropySeed(seed)) {
    return quarantine(safeHash(spec, 'world-spec'), ['weak_seed']);
  }
  if (!options.derivation && !options.allowUnkeyedDerivation) {
    return quarantine(safeHash(spec, 'world-spec'), ['unkeyed_derivation']);
  }
  try {
    const fixture = generateSealedFixture(spec, seed, binding, undefined, { derivation: options.derivation });
    const specHash = fixture.world.specHash;
    const reference = runReference(fixture.world, spec.resourceBounds);
    const report = gradeWorld(fixture.manifest, reference.world, { terminalStatus: 'complete' });
    if (!report.usefulCompletion)
      return quarantine(specHash, ['reference_not_solvable', ...report.reasonCodes]);
    // Two solvers built differently must select the same records; otherwise the world is ambiguous or a solver is wrong.
    if (!plansAgree(reference.plan, referenceSolveIndexed(fixture.world, spec.resourceBounds))) {
      return quarantine(specHash, ['solver_disagreement']);
    }
    if (reference.plan.traversalDepth > spec.referenceTopology.maxHops) {
      return quarantine(specHash, ['reference_topology_bound']);
    }
    // Targets must not be identifiable by how records are built: any shape-only detector beating chance is a leak.
    const targetKeys = new Set(fixture.manifest.effects.map((effect) => addressKey(effect.address)));
    const leaks = shapeLeaks(evaluateShapeDetectors(fixture.world, targetKeys));
    if (leaks.length) return quarantine(specHash, ['shape_leak', ...leaks.map((id) => `shape_leak:${id}`)]);
    // Commit to the admission outcome from public fields only. The private reportHash covers the sealed manifest
    // and expected poststate hashes, so exposing it would hand out an offline answer-check oracle.
    const referenceResultHash = contentHash(
      {
        specHash,
        referenceSolverHash: REFERENCE_SOLVER_HASH,
        publicReport: publicGradeReport(report, 'train').publicReportHash,
      },
      'reference-admission',
    );
    return { admitted: true, fixture, referenceSolverHash: REFERENCE_SOLVER_HASH, referenceResultHash };
  } catch (error) {
    return quarantine(safeHash(spec, 'world-spec'), quarantineCodes(error));
  }
}
