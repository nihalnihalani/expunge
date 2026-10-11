/**
 * DEMO STEP 1: the OPERATOR-AUTHORED child of the W0 baseline, compiled by the REAL harness-compiler.
 *
 *   node --import tsx scripts/demo/candidate.ts [--out .expunge/demo/candidate.json] [--runtime-hash <hex>]
 *
 * LABEL: this child is written by a person, NOT proposed by the evolver. No provider model is wired, so there is no real
 * evolver call; the compiler judges the bundle exactly as it would judge an evolver's. The three patches aim at the
 * baseline's miss on direct_nested (W0 deleted the customer record only and left the rest): W0 shows selected fields
 * only (identity fields on messages and notes are invisible to discovery), ignores nested arrays and follows references
 * one hop. The child shows every registered field, reads nested arrays and raises the traversal bound to five hops, the
 * depth the owner floor already allows (the reference depth stays at its default; it may not exceed the traversal bound).
 *
 * Evidence: the baseline run's committed record ids are cited as the patches' sourceEvidenceIds. The compiler refuses a
 * citation that is not in an evidence catalog, and this checkout cannot read the observer's real bundles, so the script
 * builds one catalog entry from an operator TRANSCRIPTION of those ids (ids only; trace body withheld, marked truncated).
 * That is provenance, not verified evidence, and the output says so. Ids default to the abbreviated ones in the brief;
 * pass --baseline-job/--baseline-receipt/--baseline-effect for the full ones.
 *
 * Writes the compiled child bundle (a plain HarnessBundle plus the compile verdict) for the pilot run. Pure and offline:
 * no database, no network.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildW0Bundle } from '@expunge/baselines';
import { contentHash, type EvidenceBundle, type HarnessBundle, type TypedPatch } from '@expunge/contracts';
import { ELIGIBILITY_POLICY_HASH, createWorldSpec } from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import {
  COMPILER_HASH,
  VOCABULARY_HASH,
  applyPatches,
  buildEvidenceCatalog,
  compileHarness,
  readUnit,
  parsePatchPath,
} from '@expunge/harness-compiler';
import { runtimeHash } from '@expunge/runtime';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.expunge/demo/candidate.json' },
    'runtime-hash': { type: 'string' },
    'baseline-job': { type: 'string', default: 'job_eea9d347' },
    'baseline-receipt': { type: 'string', default: 'receipt_a685d993' },
    'baseline-effect': { type: 'string', default: 'effect_5d0815f2' },
  },
});
const RUNTIME = values['runtime-hash'] ?? runtimeHash();

// The baseline run's committed records (from the lead's brief). Provenance labels only; see the header.
const BASELINE_JOB = values['baseline-job']!;
const BASELINE_EVIDENCE = [BASELINE_JOB, values['baseline-receipt']!, values['baseline-effect']!];

const infra = {
  runtimeAdapterHash: RUNTIME,
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
const parent: HarnessBundle = buildW0Bundle(infra);
const parentHash = contentHash(parent);

const hypothesisOf = (what: string) =>
  `OPERATOR-AUTHORED: ${what}. W0 deleted the customer record only and left the nested copies of the subject's data.`;
const patches: TypedPatch[] = [
  {
    surface: 'context',
    path: 'contextPolicy.includeNestedArrays',
    before: false,
    after: true,
    sourceEvidenceIds: [...BASELINE_EVIDENCE],
    hypothesis: hypothesisOf(
      'Read arrays nested inside documents so the subject entries in them are discovered',
    ),
  },
  {
    surface: 'context',
    path: 'contextPolicy.schemaMode',
    before: 'selected_fields',
    after: 'all_registered_fields',
    sourceEvidenceIds: [...BASELINE_EVIDENCE],
    hypothesis: hypothesisOf(
      'Show every registered field, so identity fields such as subjectKey on messages and notes are visible to discovery',
    ),
  },
  {
    surface: 'tool_policy',
    path: 'limits.traversalDepth',
    before: 1,
    after: 5,
    sourceEvidenceIds: [...BASELINE_EVIDENCE],
    hypothesis: hypothesisOf('Raise the traversal bound to the same five hops, inside the owner floor'),
  },
];

const child = applyPatches(parent, patches);
child.parentHash = parentHash;

// The public registry of a direct_nested world: what any proposer may know about the scope.
const REGISTRY_SEED = 'demo-candidate-registry';
const world = generateSealedFixture(
  createWorldSpec({ family: 'direct_nested', seed: REGISTRY_SEED }),
  REGISTRY_SEED,
).world;
const registry = {
  collectionIds: world.scope.collectionIds,
  fieldIds: world.scope.fields.map((field) => field.fieldId),
};

// An operator TRANSCRIPTION of the baseline run's committed record ids as one evidence bundle. It carries ids only: the
// trace body, tool inputs and failure witnesses are not transcribed (marked withheld and truncated), and the ids are
// the abbreviated ones from the brief unless full ids are passed. The compiler needs a catalog to accept a citation.
const transcription: EvidenceBundle = {
  evidenceId: 'evb_baseline_transcribed',
  actor: { tenantId: 'baseline', env: 'evaluation', scopeId: 'baseline' },
  binding: {
    jobId: BASELINE_JOB,
    runId: 'unknown',
    worldId: 'unknown',
    harnessHash: parentHash,
    scopeRevision: 1,
    workerProfileHash: '0'.repeat(64),
  },
  tools: [],
  failureWitnesses: [],
  diagnostics: [],
  modelOutput: '(not transcribed)',
  sources: [
    {
      provider: 'operator-transcription',
      externalEventId: BASELINE_EVIDENCE[0]!,
      externalSignalIds: BASELINE_EVIDENCE.slice(1),
      localSourceIds: [],
      origin: 'verifier_feedback',
      redactionPolicy: 'ids-only',
      retrievedAt: '2026-10-11T00:00:00.000Z',
      contentHash: contentHash({ ids: BASELINE_EVIDENCE }, 'baseline-evidence-ids'),
      permittedUse: 'training',
    },
  ],
  cost: {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    unpricedCalls: 0,
    mongoOperations: 0,
    wallTimeMs: 0,
  },
  confidence: 0.5,
  split: 'train',
  withheld: { freeText: true, values: true },
  truncated: true,
};
child.evidence = [...parent.evidence, ...transcription.sources];

const result = compileHarness(
  { candidate: child, parent, patches, claimedClass: 'behavioral' },
  {
    expected: {
      runtimeAdapterHash: RUNTIME,
      eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
      sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
    },
    floor: DEFAULT_AUTHORITY_FLOOR as never,
    registry,
    forbidden: { subject: [], task: [] },
    evidence: buildEvidenceCatalog([transcription]),
  },
);

if (!result.ok) {
  console.log(
    JSON.stringify({ label: 'OPERATOR-AUTHORED', compiled: false, rejection: result.rejection }, null, 2),
  );
  process.exit(1);
}
const { artifact } = result;
const diff = patches.map((patch) => {
  const target = parsePatchPath(patch.path);
  return {
    unit: patch.path,
    before: target ? readUnit(parent, target) : null,
    after: target ? readUnit(child, target) : null,
  };
});
const summary = {
  label: 'OPERATOR-AUTHORED CANDIDATE (not an evolver proposal; no provider model is wired)',
  evidence:
    'The patches cite the baseline run record ids through an operator TRANSCRIPTION (ids only, trace body withheld, marked truncated). The ids are as given; this script cannot verify them against the observer.',
  citedRecordIds: BASELINE_EVIDENCE,
  runtimeHash: RUNTIME,
  parentHash,
  childHash: artifact.bundleHash,
  executableDiff: diff,
  computedClass: artifact.mutationClass,
  claimedClass: artifact.claimedClass,
  requiresGrant: artifact.requiresGrant,
  editedUnits: artifact.editedUnits,
  classComponents: artifact.classComponents,
  diagnostics: artifact.diagnostics,
  compilerHash: artifact.compilerHash,
};
console.log(JSON.stringify(summary, null, 2));

mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(
  values.out!,
  JSON.stringify({ ...summary, parentBundle: parent, bundle: child, patches }, null, 2) + '\n',
);
// The bare compiled child bundle, exactly the HarnessBundle object, for the pilot (no wrapper).
const bundleOut = values.out!.replace(/\.json$/, '') + '.bundle.json';
writeFileSync(bundleOut, JSON.stringify(child, null, 2) + '\n');
console.log(JSON.stringify({ wrote: values.out, bundleFile: bundleOut, childHash: artifact.bundleHash }));
