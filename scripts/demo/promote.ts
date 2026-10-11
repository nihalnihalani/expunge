/**
 * DEMO STEP 2: report -> approval -> atomic promotion -> pinned job under the promoted child -> rollback.
 *
 *   node --import tsx --env-file-if-exists=.env scripts/demo/promote.ts [--uri <local mongo uri>] [--no-model]
 *
 * ============================================================================================================
 *  TEST-FIXTURE ADMIT, NOT A REAL ADMISSION.
 *  The gate report below is inserted by the test-only fixture path (packages/deployment/test/admitted-report.ts).
 *  No gate run produced it: a real admit needs a provider-model gate campaign (76 episodes), which this demo does not
 *  run. Everything AFTER the report is real: descriptor from stored rows, the human-grant flow, the atomic promotion
 *  transaction, job pinning, the worker, the domain gateway and the rollback.
 * ============================================================================================================
 *
 * Runs on a THROWAWAY local replica set (default mongodb://127.0.0.1:27218, databases named expunge_demo_*; the .env
 * Atlas URIs are never used). The model is whatever EXPUNGE_MODEL_PROVIDER/EXPUNGE_MODEL_ID name, with the credential
 * from the environment; no credential is printed. --no-model skips the job and prints the rest.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildW0Bundle } from '@expunge/baselines';
import { contentHash, type ActorContext, type HarnessBundle } from '@expunge/contracts';
import { createDomainEnv } from '@expunge/domain';
import {
  COLLECTION_IDS,
  ELIGIBILITY_POLICY_HASH,
  createWorldSpec,
  deriveWorldScopeKey,
  type VisibleWorld,
} from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { gradeWorld } from '@expunge/grader';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import {
  ArtifactRepository,
  AttestationRepository,
  AuthorityPolicyRepository,
  AuthorityRepository,
  DeploymentRepository,
  JobRepository,
  ProjectionRepository,
  ScopeRepository,
  WorldRepository,
  createPrincipalService,
  setupMongo,
  type MongoService,
  type Principal,
} from '@expunge/mongo';
import { EnvModelResolver, runtimeHash } from '@expunge/runtime';
import {
  Dispatcher,
  FencedProjectionSink,
  MongoCommittedReader,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  asArtifactReader,
  asDispatchJobs,
  createDomainToolWiring,
  workerConfigFromEnv,
} from '../../apps/worker/src/index.js';
import { insertLabeledAdmitReport } from '../../packages/deployment/test/admitted-report.js';
import {
  answerApproval,
  createPinnedCleanupJob,
  issueRollbackGrant,
  promoteAdmitted,
  renderDescriptor,
  rollbackDeployment,
} from '../../packages/deployment/test/api.js';

const { values } = parseArgs({
  options: {
    uri: {
      type: 'string',
      default: 'mongodb://127.0.0.1:27218/?replicaSet=expunge-local&directConnection=true',
    },
    candidate: { type: 'string', default: '.expunge/demo/candidate.bundle.json' },
    'no-model': { type: 'boolean', default: false },
  },
});
const say = (step: string, data: Record<string, unknown>) => console.log(JSON.stringify({ step, ...data }));
const OPTS = { allowTestFixtures: true };

say('banner', {
  label: 'TEST-FIXTURE ADMIT, NOT A REAL ADMISSION',
  real: [
    'descriptor',
    'approval grant',
    'atomic promotion',
    'job pinning',
    'worker + domain gateway',
    'rollback',
  ],
  fixture: ['gate report'],
});

// --- databases (throwaway) ---------------------------------------------------------------------------------------
const prefix = `expunge_demo_${Date.now().toString(36)}`;
const names = {
  worldDatabase: `${prefix}_world`,
  controlDatabase: `${prefix}_control`,
  privateDatabase: `${prefix}_private`,
};
const open = async (principal: Principal): Promise<MongoService> => {
  const service = createPrincipalService({ uris: { [principal]: values.uri! }, ...names }, principal);
  await service.client.connect();
  return service;
};
const setup = await open('setup');
await setupMongo(setup);
const [builder, grader, promoter, issuer, executor, proposer] = await Promise.all(
  (['fixture_builder', 'grader', 'promoter', 'approval_issuer', 'domain_executor', 'proposer'] as const).map(
    open,
  ),
);
say('databases', { prefix, uri: values.uri!.replace(/\/\?.*$/, '') });

try {
  // --- the two harnesses: W0 built on THIS checkout, and the compiled operator-authored child -----------------------
  const infra = {
    runtimeAdapterHash: runtimeHash(),
    compilerHash: COMPILER_HASH,
    vocabularyHash: VOCABULARY_HASH,
    authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
    eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
    sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  };
  const parent: HarnessBundle = buildW0Bundle(infra);
  const parentHash = contentHash(parent);
  const child = JSON.parse(readFileSync(values.candidate!, 'utf8')) as HarnessBundle;
  if (child.parentHash !== parentHash)
    throw new Error(
      `candidate was compiled for another W0 (${child.parentHash} vs ${parentHash}): re-run scripts/demo/candidate.ts`,
    );
  const childHash = contentHash(child);
  say('harnesses', { parentHash, childHash, runtimeHash: infra.runtimeAdapterHash });

  const seed = `demo-${Date.now().toString(36)}`;
  const spec = createWorldSpec({ family: 'direct_nested', seed });

  /**
   * One identically seeded world (same family, same seed, so the same records) in a scope of its own, with W0 deployed
   * as the scope's harness and the owner's eligibility rows in place. `tag` only separates the two scopes.
   */
  const seedArm = async (tag: string) => {
    const binding = deriveWorldScopeKey(spec, seed, {
      tenantId: `demo-${tag}`,
      env: 'evaluation',
      scopeId: 'base',
    });
    const fixture = generateSealedFixture(spec, seed, binding);
    const world: VisibleWorld = fixture.world;
    const actor: ActorContext = { ...binding, actorId: 'owner', authorizationRevision: 1 };
    await new AuthorityRepository(setup).install(binding, DEFAULT_AUTHORITY_FLOOR.hash, 1);
    await new ScopeRepository(builder).insert(world.scope);
    await new WorldRepository(builder).create(binding, world.worldId, world.scope.revision);
    for (const id of COLLECTION_IDS)
      if (world.collections[id].length)
        await setup.world.collection(id).insertMany(structuredClone(world.collections[id]) as never[]);
    // The owner's eligibility rows for the harnesses and for every source a harness cites (the proposer and observer
    // pipelines' job in a real deployment); a run places both in its context, so both must be permitted.
    const eligible = new Set<string>();
    for (const bundle of [parent, child]) {
      eligible.add((await new ArtifactRepository(proposer).insert(bundle))._id);
      for (const reference of bundle.evidence) eligible.add(reference.contentHash);
    }
    for (const hash of eligible) {
      await setup.control.collection('artifact_eligibility').insertOne({
        ...binding,
        artifactHash: hash,
        state: 'permitted',
        policyHash: ELIGIBILITY_POLICY_HASH,
        reasonCode: 'source_retracted',
        sourceIds: [],
        updatedAt: new Date(),
      } as never);
    }
    await new DeploymentRepository(setup).initialize(actor, 'worker', parentHash, world.scope.revision);
    await new AuthorityPolicyRepository(setup).install({ ...binding, target: 'worker' }, true);
    return { binding, fixture, world, actor };
  };

  const domain = createDomainEnv(executor, { floors: [DEFAULT_AUTHORITY_FLOOR] });
  const modelConfigured = Boolean(
    process.env.EXPUNGE_MODEL_PROVIDER?.trim() && process.env.EXPUNGE_MODEL_ID?.trim(),
  );
  const withModel = !values['no-model'] && modelConfigured;
  type Arm = Awaited<ReturnType<typeof seedArm>>;

  /** Creates the pinned job (the pin is the scope's pointer now), runs it with the real worker, and measures it. */
  const runJob = async (label: string, arm: Arm, expectHash: string) => {
    const { actor, world, fixture } = arm;
    const tag = Date.now().toString(36);
    const pinned = await createPinnedCleanupJob(executor, {
      actor,
      jobId: `demo-job-${label}-${tag}`,
      binding: {
        runId: `demo-run-${label}-${tag}`,
        worldId: world.worldId,
        scopeRevision: world.scope.revision,
        workerProfileHash: '0'.repeat(64),
      },
    });
    say('pinned_job', {
      arm: label,
      jobId: pinned._id,
      pinnedHarness: pinned.binding.harnessHash,
      isExpected: pinned.binding.harnessHash === expectHash,
    });
    await domain.store.putSubject(actor, pinned._id, { idType: 'string', value: world.subjectHandle });
    if (!withModel) {
      say('job', {
        arm: label,
        skipped: true,
        reason: values['no-model'] ? '--no-model' : 'EXPUNGE_MODEL_PROVIDER/EXPUNGE_MODEL_ID not set',
      });
      return null;
    }
    const jobs = new JobRepository(executor);
    const dispatcher = new Dispatcher({
      jobs: asDispatchJobs(jobs),
      resolver: new MongoJobResolver(jobs),
      artifacts: asArtifactReader(new ArtifactRepository(executor)),
      tools: createDomainToolWiring(executor).provider,
      models: new EnvModelResolver(process.env),
      receipts: new MongoCompletionReceiptReader(executor),
      committed: new MongoCommittedReader(executor),
      projection: new FencedProjectionSink(executor, jobs, new ProjectionRepository(executor)),
      attestations: new AttestationRepository(executor),
      runtimeHash: runtimeHash(),
      env: process.env,
      config: workerConfigFromEnv({
        EXPUNGE_WORKER_ID: `demo-worker-${label}`,
        EXPUNGE_WORKER_LEASE_MS: '60000',
        EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '90000',
      }),
    });
    const result = await dispatcher.runJob(pinned._id);
    const row = await jobs.readAuthorized(actor, pinned._id);
    const receipt = await setup.control.collection('completion_receipts').findOne({ jobId: pinned._id });
    const decisions = await setup.control.collection('decisions').find({ jobId: pinned._id }).toArray();
    const stamps = await new AttestationRepository(executor).list(actor, pinned._id);
    const steps = await setup.control
      .collection('domain_steps')
      .find({ jobId: pinned._id, kind: 'call' })
      .sort({ ordinal: 1 })
      .toArray();
    const meter = ((row.checkpoint as { meter?: Record<string, number> } | null)?.meter ?? {}) as Record<
      string,
      number
    >;
    const after = { ...world, collections: {} as VisibleWorld['collections'] };
    for (const id of COLLECTION_IDS)
      after.collections[id] = (await setup.world
        .collection(id)
        .find({ worldId: world.worldId })
        .sort({ _id: 1 })
        .toArray()) as never;
    const grade = gradeWorld(fixture.manifest, after, {
      terminalStatus: row.status === 'succeeded' ? 'complete' : 'incomplete',
      terminalClaim: 'all_targets',
    });
    // Which planted records the run did not reach, by collection and by what is left of them.
    const residuals = fixture.manifest.effects.flatMap((effect) => {
      const id = effect.address.collectionId;
      const expected = fixture.manifest.expectedState[id].find((d) => d._id === effect.address.recordId);
      const actual = after.collections[id].find((d) => d._id === effect.address.recordId);
      const done =
        effect.effect === 'delete'
          ? !actual
          : Boolean(
              actual &&
              expected &&
              contentHash(actual, 'fixture-document') === contentHash(expected, 'fixture-document'),
            );
      return done
        ? []
        : [{ collection: id, effect: effect.effect, found: actual ? 'record still present' : 'record gone' }];
    });
    const summary = {
      arm: label,
      harness: pinned.binding.harnessHash.slice(0, 12),
      outcome: result.outcome,
      reason: result.reason,
      status: row.status,
      receiptId: receipt?._id ?? null,
      receiptStatus: (receipt as { domainStatus?: string } | null)?.domainStatus ?? null,
      decisions: decisions.length,
      allDecisionsUnderPinned:
        decisions.length > 0 && decisions.every((d) => d.harnessHash === pinned.binding.harnessHash),
      model: stamps.map((s) => ({
        fence: s.fence,
        source: s.source,
        provider: s.provider,
        modelId: s.modelId,
      })),
      toolCalls: steps.map((s) => (s.payload as { toolId: string }).toolId),
      meter: {
        modelCalls: meter.modelCalls ?? null,
        toolCalls: meter.toolCalls ?? null,
        inputTokens: meter.inputTokens ?? null,
        outputTokens: meter.outputTokens ?? null,
        costMicrousd: meter.costMicrousd ?? null,
        unpricedCalls: meter.unpricedCalls ?? null,
        wallTimeMs: meter.wallTimeMs ?? null,
      },
      grade: {
        usefulCompletion: grade.usefulCompletion,
        targetedResiduals: grade.targetedResiduals,
        unrelatedRecordChanges: grade.unrelatedRecordChanges,
        retentionViolations: grade.retentionViolations,
        preservationViolations: grade.preservationViolations,
      },
      residuals,
    };
    say('job', summary);
    return summary;
  };

  // --- arm A: W0 on an identically seeded fresh world (the baseline, no promotion) -----------------------------
  const w0Arm = await seedArm('w0');
  say('world', {
    arm: 'w0',
    worldId: w0Arm.world.worldId,
    scopeId: w0Arm.binding.scopeId,
    deployed: parentHash.slice(0, 12),
  });
  const w0Result = await runJob('w0', w0Arm, parentHash);

  // --- arm B: promote parent -> child through the (fixture) report, then run under the child -------------------
  const arm = await seedArm('child');
  const { actor, world } = arm;
  say('world', {
    arm: 'child',
    worldId: world.worldId,
    scopeId: arm.binding.scopeId,
    deployed: parentHash.slice(0, 12),
    policy: 'behavioral changes need a grant',
  });
  const stored = await insertLabeledAdmitReport(grader, {
    candidateId: 'demo-operator-authored',
    parentHash,
    childHash,
    parent,
    child,
  });
  say('gate_report', {
    label: 'TEST-FIXTURE ADMIT, NOT A REAL ADMISSION',
    reportId: stored.report.reportId,
    digest: stored.digest,
    computedClass: stored.report.computedClass,
  });
  const request = {
    actor,
    target: 'worker' as const,
    reportId: stored.report.reportId,
    parentHash,
    childHash,
  };
  const { descriptor } = await renderDescriptor(issuer, request, OPTS);
  say('descriptor', {
    descriptorDigest: descriptor.descriptorDigest,
    class: descriptor.computedClass,
    expectedParentRevision: descriptor.expectedParentRevision,
    changes: descriptor.changes.map((c) => ({ unit: c.unit, before: c.before, after: c.after })),
    consequences: descriptor.consequences,
  });
  const approval = await answerApproval(
    issuer,
    { ...request, answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'approve' } },
    OPTS,
  );
  if (approval.state !== 'approved') throw new Error('not approved');
  say('approval', { grantId: approval.grantId, reused: approval.reused });
  const promotion = await promoteAdmitted(
    promoter,
    { ...request, grantId: approval.grantId, reason: 'demo promotion' },
    OPTS,
  );
  say('promotion', {
    promotionId: promotion.promotionId,
    from: promotion.fromHash,
    to: promotion.toHash,
    revision: `${promotion.fromRevision} -> ${promotion.toRevision}`,
    consumedGrantId: promotion.consumedGrantId,
  });
  const childResult = await runJob('child', arm, childHash);

  // --- side by side --------------------------------------------------------------------------------------------
  say('side_by_side', {
    note: 'one run each on identically seeded fresh worlds, same model; an anecdote, not a result',
    w0: w0Result && {
      residuals: w0Result.grade.targetedResiduals,
      receipt: w0Result.receiptStatus,
      modelCalls: w0Result.meter.modelCalls,
      costMicrousd: w0Result.meter.costMicrousd,
      tokens: (w0Result.meter.inputTokens ?? 0) + (w0Result.meter.outputTokens ?? 0),
    },
    child: childResult && {
      residuals: childResult.grade.targetedResiduals,
      receipt: childResult.receiptStatus,
      modelCalls: childResult.meter.modelCalls,
      costMicrousd: childResult.meter.costMicrousd,
      tokens: (childResult.meter.inputTokens ?? 0) + (childResult.meter.outputTokens ?? 0),
    },
  });

  // --- rollback: a new audited pointer move, with its own grant (the reverse change is behavioural too) ----------
  const back = await issueRollbackGrant(issuer, { actor, target: 'worker', toHash: parentHash });
  const rolled = await rollbackDeployment(promoter, {
    actor,
    target: 'worker',
    toHash: parentHash,
    reason: 'demo rollback',
    grantId: back.grantId,
  });
  say('rollback', {
    promotionId: rolled.promotionId,
    from: rolled.fromHash,
    to: rolled.toHash,
    revision: `${rolled.fromRevision} -> ${rolled.toRevision}`,
    gateReportId: rolled.gateReportId,
    consumedGrantId: rolled.consumedGrantId,
  });
  say('done', { label: 'TEST-FIXTURE ADMIT, NOT A REAL ADMISSION', databases: prefix });
} finally {
  await Promise.all([setup, builder, grader, promoter, issuer, executor, proposer].map((s) => s.close()));
}
