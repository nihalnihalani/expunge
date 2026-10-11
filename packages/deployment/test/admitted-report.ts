import { contentHash, type GateReport, type HarnessBundle, type MutationClass } from '@expunge/contracts';
import { EVALUATOR_HASH } from '@expunge/grader';
import { FIXTURE_GENERATOR_HASH } from '@expunge/fixtures';
import {
  ADMISSION_RULE_HASH,
  GATE_CONTROLS_SCHEMA,
  GateStore,
  ZERO_COST,
  authorityFlipsOf,
  childProjectionOf,
  reportDigestOf,
  reportIdOf,
} from '@expunge/gate';
import { COMPILER_HASH, classifyMutation } from '@expunge/harness-compiler';
import type { MongoService } from '@expunge/mongo';
import { TEST_FIXTURE_LABEL } from '../src/report.js';

/**
 * TEST-ONLY. Stores an `admit` report that NO gate run produced, so promotion and grant tests have something to act on.
 * It carries the label `TEST_FIXTURE_LABEL` inside the digest; `loadAdmittedReport` refuses it unless the caller opts in
 * with `allowTestFixtures`, which no service does. The real gate cannot produce an admit without a provider model and
 * stored job evidence, so this is the only way to get one in this environment.
 */
export async function insertLabeledAdmitReport(
  grader: MongoService,
  input: {
    candidateId: string;
    parentHash: string;
    childHash: string;
    parent: HarnessBundle;
    child: HarnessBundle;
    verdict?: GateReport['verdict'];
    computedClass?: MutationClass;
    over?: Partial<GateReport>;
    underOver?: Record<string, unknown>;
  },
): Promise<{ report: GateReport; digest: string }> {
  const classification = input.computedClass ?? classifyMutation(input.parent, input.child).mutationClass!;
  const report: GateReport = {
    reportId: reportIdOf(input.parentHash, childProjectionOf(input.child)),
    candidateId: input.candidateId,
    parentHash: input.parentHash,
    childHash: input.childHash,
    evaluatorHash: EVALUATOR_HASH,
    fixtureGeneratorHash: FIXTURE_GENERATOR_HASH,
    runtimeHash: input.child.runtimeAdapterHash,
    workerProfileHash: 'd'.repeat(64),
    splitManifestCommitment: 'e'.repeat(64),
    pairedTrials: [],
    trialRowsDigest: contentHash([], 'gate-trial-rows'),
    causalControls: {
      schema: GATE_CONTROLS_SCHEMA,
      decisionSummary: {
        triggerGain: 2,
        triggerRequiredGain: 2,
        splits: { train: { trials: 6, parentSuccesses: 0, candidateSuccesses: 2 } },
        protectedRegressedWorlds: 0,
      },
      admittedUnder: {
        ruleHash: ADMISSION_RULE_HASH,
        gateHash: 'f'.repeat(64),
        freezeHash: 'f'.repeat(64),
        campaignId: 'fixture',
        compilerHash: COMPILER_HASH,
        parentCompilerHash: input.parent.compilerHash,
        childCompilerHash: input.child.compilerHash,
        attempt: { ordinal: 1, parentAttempts: 1 },
        resumes: 0,
        evidence: {
          portKind: 'worker',
          portLabel: TEST_FIXTURE_LABEL,
          modelKind: 'provider',
          profileId: 'fixture',
        },
        ...input.underOver,
      },
    } as never,
    knownAuthorityFlips: authorityFlipsOf(input.parent, input.child),
    cost: { ...ZERO_COST },
    verdict: input.verdict ?? 'admit',
    reasonCodes: [],
    computedClass: classification,
    ...input.over,
  };
  await new GateStore(grader).saveReport(report);
  return { report, digest: reportDigestOf(report) };
}
