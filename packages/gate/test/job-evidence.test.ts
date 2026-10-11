import { describe, expect, it } from 'vitest';
import type { Job } from '@expunge/contracts';
import { contentHash } from '@expunge/contracts';
import { AttestedJobEvidence, modelStampsOf, verifyArm } from '../src/job-evidence.js';
import type { EpisodeOutcome, WorkerProfile } from '../src/types.js';

const RT = 'c'.repeat(64);
const profile: WorkerProfile & { provider: string } = {
  profileId: 'p',
  modelId: 'gpt-5',
  modelKind: 'provider',
  provider: 'openai',
  params: {},
};
const expected: { runId: string; worldId: string; bundleHash: string; outcome: EpisodeOutcome } = {
  runId: 'run-1',
  worldId: 'w1',
  bundleHash: 'b'.repeat(64),
  outcome: 'completed',
};
const stamp = (over: Record<string, unknown> = {}) => ({
  fence: 1,
  source: 'provider',
  provider: 'openai',
  modelId: 'gpt-5',
  spec: 'openai/gpt-5',
  endpoint: 'default',
  runtimeHash: RT,
  ...over,
});
const job = (over: Partial<Job> = {}, fence = 1): Job =>
  ({
    _id: 'j1',
    kind: 'cleanup',
    status: 'succeeded',
    lease: { ownerId: 'w', fence, until: new Date(), heartbeatAt: new Date() },
    binding: {
      jobId: 'j1',
      runId: 'run-1',
      worldId: 'w1',
      harnessHash: expected.bundleHash,
      scopeRevision: 1,
      workerProfileHash: 'a'.repeat(64),
    },
    checkpoint: { v: 1 },
    ...over,
  }) as unknown as Job;
/** What the gate is handed for one arm: the job row and its attestation rows. */
const rec = (stamps: unknown, jobOver: Partial<Job> = {}, fence = 1) => ({
  job: job(jobOver, fence),
  stamps,
});
const good = () => rec([stamp()]);

describe('verifyArm reads the stored job and the attestation rows and fails closed', () => {
  it('verifies a provider run pinned to the right harness, world and run', () => {
    expect(verifyArm(good(), expected, profile)).toEqual({ verified: true, runtimeHash: RT, reasons: [] });
  });
  it('takes nothing from the job checkpoint: a checkpoint that claims everything adds nothing', () => {
    const forged = rec(undefined, {
      checkpoint: { attestedRuntimeHash: RT, attestedModels: [stamp()], attestedModel: stamp() } as never,
    });
    const facts = verifyArm(forged, expected, profile);
    expect(facts.verified).toBe(false);
    expect(facts.reasons).toEqual(expect.arrayContaining(['model_unstamped', 'runtime_unattested']));
  });
  const cases: Array<
    [
      string,
      ReturnType<typeof rec> | { job: null; stamps: unknown },
      string,
      Partial<typeof expected>?,
      Partial<typeof profile>?,
    ]
  > = [
    ['no job row', { job: null, stamps: [stamp()] }, 'job_missing'],
    ['wrong kind', rec([stamp()], { kind: 'observe' }), 'job_kind'],
    ['another run', rec([stamp()], { binding: { ...job().binding, runId: 'x' } }), 'run_mismatch'],
    ['another world', rec([stamp()], { binding: { ...job().binding, worldId: 'x' } }), 'world_mismatch'],
    [
      'another harness',
      rec([stamp()], { binding: { ...job().binding, harnessHash: 'f'.repeat(64) } }),
      'harness_mismatch',
    ],
    ['completed but not succeeded', rec([stamp()], { status: 'failed' }), 'status_mismatch'],
    ['cancelled but not cancelled', good(), 'status_mismatch', { outcome: 'cancelled' }],
    ['the port says failed for a succeeded job', good(), 'status_mismatch', { outcome: 'failed' }],
    ['the port says incomplete for a succeeded job', good(), 'status_mismatch', { outcome: 'incomplete' }],
    ['the port says refused for a succeeded job', good(), 'status_mismatch', { outcome: 'refused' }],
    ['the port says completed for a failed job', rec([stamp()], { status: 'failed' }), 'status_mismatch'],
    [
      'a succeeded job whose own terminal decision is a failure',
      rec([stamp()], { checkpoint: { terminal: { decision: { status: 'failed' } } } as never }),
      'status_mismatch',
    ],
    ['a stamp with no runtime hash', rec([stamp({ runtimeHash: undefined })]), 'runtime_unattested'],
    ['a stamp with a malformed runtime hash', rec([stamp({ runtimeHash: 'zz' })]), 'runtime_unattested'],
    ['no model stamp', rec(undefined), 'model_unstamped'],
    ['the superseded singular stamp', rec(stamp()), 'model_unstamped'],
    ['an empty stamp list', rec([]), 'model_unstamped'],
    [
      'a stamp without a fence',
      rec([{ source: 'provider', provider: 'openai', modelId: 'gpt-5' }]),
      'model_unstamped',
    ],
    [
      'fake source',
      rec([
        stamp({
          source: 'fake',
          provider: 'FAKE_DETERMINISTIC_TEST_PROVIDER',
          modelId: 'fake-deterministic-1',
        }),
      ]),
      'model_not_provider',
    ],
    ['unknown source', rec([stamp({ source: 'maybe' })]), 'model_not_provider'],
    [
      'an overridden endpoint',
      rec([stamp({ endpoint: 'overridden', endpointHostHash: 'a'.repeat(64) })]),
      'endpoint_not_default',
    ],
    ['an unlabeled endpoint', rec([stamp({ endpoint: undefined })]), 'endpoint_not_default'],
    ['another model', rec([stamp({ modelId: 'gpt-4' })]), 'model_not_frozen_profile'],
    ['another provider', rec([stamp({ provider: 'other' })]), 'model_not_frozen_profile'],
    ['a fake profile', good(), 'profile_not_provider', {}, { modelKind: 'fake' }],
    ['a profile with no provider', good(), 'model_not_frozen_profile', {}, { provider: '' }],
    [
      'stamps that disagree across sessions',
      rec([stamp(), stamp({ fence: 2, modelId: 'gpt-4' })], {}, 2),
      'model_stamps_disagree',
    ],
    [
      'runtime hashes that disagree across sessions',
      rec([stamp(), stamp({ fence: 2, runtimeHash: 'd'.repeat(64) })], {}, 2),
      'runtime_stamps_disagree',
    ],
    ['two stamps for one fence', rec([stamp(), stamp()]), 'model_stamp_duplicate_fence'],
    [
      'a takeover with no stamp for the final fence',
      rec([stamp()], {}, 2),
      'model_stamp_missing_final_fence',
    ],
    ['a malformed entry beside a good one', rec([stamp(), { fence: 2 }]), 'model_stamp_malformed'],
  ];
  for (const [label, record, reason, exp, prof] of cases)
    it(`${label} is not real evidence (${reason})`, () => {
      const facts = verifyArm(record, { ...expected, ...exp }, { ...profile, ...prof });
      expect(facts.verified).toBe(false);
      expect(facts.reasons).toContain(reason);
    });
  it('one stamp per claiming session, the last for the final fence, verifies', () => {
    const facts = verifyArm(
      rec([stamp(), stamp({ fence: 2 }), stamp({ fence: 3 })], {}, 3),
      expected,
      profile,
    );
    expect(facts.reasons).toEqual([]);
    expect(facts.verified).toBe(true);
  });
  it('malformed stamps are no stamp', () => {
    expect(modelStampsOf('provider')).toEqual([]);
    expect(modelStampsOf([{ source: 'provider' }])).toEqual([]);
    expect(modelStampsOf(null)).toEqual([]);
  });
});

describe('AttestedJobEvidence does not trust a run_attestations row for what it claims (DA-14 RA-1)', () => {
  const scope = { tenantId: 't', env: 'evaluation' as const, scopeId: 's' };
  const stored = job();
  const fakeService = { control: { collection: () => ({ findOne: async () => stored }) } } as never;
  const goodRow = (over: Record<string, unknown> = {}) => ({
    _id: contentHash({ ...scope, jobId: 'j1', fence: 1 }, 'run-attestation-row'),
    ...scope,
    jobId: 'j1',
    runId: 'run-1',
    ...stamp(),
    at: new Date(),
    createdAt: new Date(),
    ...over,
  });
  const read = (rows: unknown[]) =>
    new AttestedJobEvidence(fakeService, async () => rows as never).read(scope, 'j1');

  it('a genuine row verifies', async () => {
    const record = await read([goodRow()]);
    expect(record.defects).toEqual([]);
    expect(verifyArm(record, expected, profile).verified).toBe(true);
  });
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['a pre-inserted row with an invented id', { _id: 'x'.repeat(64) }, 'attestation_id_mismatch'],
    ['a row for another fence than its id says', { fence: 2 }, 'attestation_id_mismatch'],
    ['a row that names another job', { jobId: 'other' }, 'attestation_job_mismatch'],
    ['a row from another scope', { scopeId: 'elsewhere' }, 'attestation_scope_mismatch'],
    ['a row for another run than the job binding', { runId: 'run-9' }, 'attestation_run_mismatch'],
  ];
  for (const [label, over, defect] of bad)
    it(`${label} holds the arm (${defect})`, async () => {
      const record = await read([goodRow(over)]);
      expect(record.defects).toContain(defect);
      const facts = verifyArm(record, expected, profile);
      expect(facts.verified).toBe(false);
      expect(facts.reasons).toContain(defect);
    });
});
