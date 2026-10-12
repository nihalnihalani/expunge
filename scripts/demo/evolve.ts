/**
 * DEMO STEP: ONE MODEL-GENERATED PROPOSAL from the REAL provider model through the evolver's proposer port, compiled by the
 * REAL harness-compiler. PILOT ONLY, NOT ADMISSION: nothing here is a gate decision.
 *
 *   node --import tsx --env-file-if-exists=.env scripts/demo/evolve.ts --pilot DIR/pilot.json --parent FILE.bundle.json
 *        [--out DIR] [--mongo-uri URI] [--family alias_two_hop]
 *
 * Evidence: the failed episodes of `--family` in a finished pilot report (scripts/demo/pilot.ts). For each one the script
 * reads the STORED job row (binding, meter) and its `tool_decided` projection events from that pilot's local databases, and
 * joins the grader's reason codes and residual count from the report. It builds one EvidenceBundle per episode: ids, tool
 * ids, decisions, rule ids, target counts and grader codes only (tool summaries, model text and record values withheld).
 * OPERATOR LABEL: the split is set to `train` here because the pilot worlds are fresh seeds of TRAINING families; no stored
 * split row exists in a pilot database (the observer would mark such a bundle gate-only).
 *
 * Parent: the improved child (`scripts/demo/candidate.ts` output). The proposer is the real model selected by
 * EXPUNGE_MODEL_PROVIDER / EXPUNGE_MODEL_ID with EXPUNGE_MODEL_PRICE_*; it fails closed without them. Writes evolve.json
 * (the proposal record, the model stamp and the metered spend) and, when it compiled, evolved.bundle.json for the pilot.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  contentHash,
  type EvidenceBundle,
  type HarnessBundle,
  type ProjectionEvent,
} from '@expunge/contracts';
import {
  buildEvidencePacket,
  createProviderEvolverModel,
  proposeCandidate,
  type ProposalRecord,
} from '@expunge/evolution';
import { ELIGIBILITY_POLICY_HASH, createWorldSpec } from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { buildEvidenceCatalog, parsePatchPath, readUnit } from '@expunge/harness-compiler';
import { createPrincipalService } from '@expunge/mongo';

const LABEL = 'MODEL-GENERATED PROPOSAL, PILOT ONLY, NOT ADMISSION';
const { values } = parseArgs({
  options: {
    pilot: { type: 'string' },
    parent: { type: 'string' },
    out: { type: 'string', default: '.expunge/demo/evolve' },
    family: { type: 'string', default: 'alias_two_hop' },
    'mongo-uri': {
      type: 'string',
      default: 'mongodb://127.0.0.1:27218/?replicaSet=expunge-local&directConnection=true',
    },
  },
});
const fail = (message: string): never => {
  console.error(`${LABEL}: ${message}`);
  process.exit(2);
};
const pilotPath = values.pilot ?? fail('--pilot DIR/pilot.json (a finished pilot report) is required');
const parentPath = values.parent ?? fail('--parent FILE.bundle.json (the improved child) is required');
const uri = values['mongo-uri']!;
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(uri).hostname))
  fail('reads only a loopback replica set');

type PilotRow = {
  pair: number;
  arm: 'parent' | 'candidate';
  bundleHash: string;
  scopeId: string;
  jobId: string | null;
  outcome: string;
  failureCode: string | null;
  terminalStatus: string;
  usefulCompletion: boolean;
  reasonCodes: string[];
  targetedResiduals: number | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  unpricedCalls: number;
  wallTimeMs: number;
};
type PilotReport = {
  databases: { worldDatabase: string; controlDatabase: string; privateDatabase: string };
  families?: string[];
  pairs: number;
  rows: PilotRow[];
};
const report = JSON.parse(readFileSync(pilotPath, 'utf8')) as PilotReport;
const parent = JSON.parse(readFileSync(parentPath, 'utf8')) as HarnessBundle;
const family = values.family!;
// Pairs map to families round-robin, exactly as the pilot assigned them.
const families = report.families ?? ['direct_nested', 'alias_two_hop'];
const familyOf = (pair: number) => families[pair % families.length];
const failed = report.rows.filter(
  (row) => familyOf(row.pair) === family && !row.usefulCompletion && row.jobId !== null,
);
if (!failed.length) fail(`no failed ${family} episode with a job in the report`);

async function main(): Promise<void> {
  const service = createPrincipalService(
    { uris: { setup: uri }, ...report.databases, appName: 'expunge-evolve' },
    'setup',
  );
  await service.client.connect();
  const bundles: EvidenceBundle[] = [];
  try {
    for (const row of failed) {
      const scope = { tenantId: 'pilot', env: 'evaluation' as const, scopeId: row.scopeId };
      const job = await service.control
        .collection<{ _id: string; binding: EvidenceBundle['binding']; status: string }>('jobs')
        .findOne({ _id: row.jobId, 'actor.scopeId': row.scopeId } as never);
      if (!job) fail(`stored job row missing for an episode of pair ${row.pair}`);
      const events = await service.control
        .collection<ProjectionEvent>('projection_events')
        .find({ ...scope, jobId: row.jobId, kind: 'tool_decided' } as never, {
          sort: { sequence: 1 },
          limit: 60,
        })
        .toArray();
      const tools = events.map((event) => {
        const p = event.payload as unknown as {
          toolId: string;
          decision: 'allow' | 'ask' | 'deny';
          ruleIds?: string[];
          targetCount?: number;
        };
        return {
          toolId: p.toolId,
          input: { targetCount: p.targetCount ?? 0 },
          output: { summary: '(withheld)' },
          decision: { result: p.decision, ruleIds: p.ruleIds ?? [], authorizationRevision: 1 },
        };
      });
      const ids = { jobId: row.jobId!, runId: job!.binding.runId };
      bundles.push({
        evidenceId: `evb_pilot_${row.jobId}`,
        actor: scope,
        binding: job!.binding,
        tools,
        failureWitnesses: [
          {
            source: 'grader',
            family,
            arm: row.arm === 'parent' ? 'parent' : 'improved_child',
            outcome: row.outcome,
            failureCode: row.failureCode,
            terminalStatus: row.terminalStatus,
            jobStatus: job!.status,
            reasonCodes: row.reasonCodes,
            targetedResiduals: row.targetedResiduals,
          },
        ],
        diagnostics: [{ toolDecisions: tools.length, modelCalls: row.modelCalls }],
        modelOutput: '(withheld)',
        sources: [
          {
            provider: 'expunge-local-pilot',
            externalEventId: ids.jobId,
            externalSignalIds: [],
            localSourceIds: [ids.runId],
            origin: 'verifier_feedback',
            redactionPolicy: 'ids-codes-counts-only',
            retrievedAt: new Date().toISOString(),
            contentHash: contentHash(
              { ...ids, reasonCodes: row.reasonCodes, tools },
              'pilot-episode-evidence',
            ),
            permittedUse: 'training',
          },
        ],
        cost: {
          modelCalls: row.modelCalls,
          toolCalls: tools.length,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costMicrousd: row.costMicrousd,
          unpricedCalls: row.unpricedCalls,
          mongoOperations: 0,
          wallTimeMs: row.wallTimeMs,
        },
        confidence: 1,
        split: 'train',
        withheld: { freeText: true, values: true },
        truncated: events.length >= 60,
      });
    }
  } finally {
    await service.close().catch(() => undefined);
  }

  const packet = buildEvidencePacket({ arm: 'trace_informed', incident: bundles, budgetChars: 16_000 });
  // The public registry of a world of this family: what any proposer may know about the scope.
  const REGISTRY_SEED = 'demo-evolve-registry';
  const world = generateSealedFixture(
    createWorldSpec({ family: family as 'alias_two_hop', seed: REGISTRY_SEED }),
    REGISTRY_SEED,
  ).world;
  const registry = {
    collectionIds: world.scope.collectionIds,
    fieldIds: world.scope.fields.map((field) => field.fieldId),
  };
  const model = createProviderEvolverModel({
    env: process.env,
    // The proposer's own ceiling: 80k tokens, 2 cents.
    budget: { totalTokens: 80_000, maxCostMicrousd: 20_000 },
  });
  const started = Date.now();
  const record: ProposalRecord = await proposeCandidate({
    model,
    packet,
    branchIndex: 0,
    parent,
    actor: { tenantId: 'pilot', env: 'evaluation', scopeId: 'evolve' },
    context: {
      expected: {
        runtimeAdapterHash: parent.runtimeAdapterHash,
        eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
        sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
      },
      floor: DEFAULT_AUTHORITY_FLOOR as never,
      registry,
      forbidden: { subject: [], task: [] },
    },
    catalog: buildEvidenceCatalog(bundles),
  });
  const diff = (record.patches ?? []).map((patch) => {
    const target = parsePatchPath(patch.path);
    return {
      unit: patch.path,
      before: patch.before,
      after: record.child && target ? readUnit(record.child, target) : patch.after,
      hypothesis: patch.hypothesis,
      cited: patch.sourceEvidenceIds,
    };
  });
  const summary = {
    label: LABEL,
    model: record.modelId,
    modelKind: record.modelKind,
    modelStamp: record.modelStamp,
    wallTimeMs: Date.now() - started,
    evidence: {
      family,
      episodes: failed.map((row) => ({
        pair: row.pair,
        arm: row.arm,
        jobId: row.jobId,
        failureCode: row.failureCode,
        targetedResiduals: row.targetedResiduals,
        reasonCodes: row.reasonCodes,
      })),
      packetChars: packet.chars,
      truncated: packet.truncated,
      citableIds: packet.citableIds,
      splitLabel:
        'train (operator label: fresh seeds of a training family; no stored split row in a pilot database)',
    },
    parentHash: contentHash(parent),
    status: record.status,
    reasonCodes: record.reasonCodes,
    abstainReason: record.abstainReason,
    claimedClass: record.claimedClass,
    computedClass: record.computedClass,
    hypothesis: record.hypothesis,
    diff,
    rejection: record.rejection,
    childHash: record.artifact?.bundleHash,
    diagnostics: record.artifact?.diagnostics,
  };
  console.log(JSON.stringify(summary, null, 2));
  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, 'evolve.json'), `${JSON.stringify({ ...summary, record }, null, 2)}\n`);
  if (record.status === 'compiled' && record.child) {
    writeFileSync(join(values.out!, 'evolved.bundle.json'), `${JSON.stringify(record.child, null, 2)}\n`);
    console.log(
      JSON.stringify({ wrote: join(values.out!, 'evolved.bundle.json'), childHash: summary.childHash }),
    );
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      label: LABEL,
      error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown',
    }),
  );
  process.exitCode = 1;
});
