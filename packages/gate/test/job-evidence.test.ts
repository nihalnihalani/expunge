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
  ...over,
});
const withStamps = (stamps: unknown, fence = 1, extra: Partial<Job> = {}) =>
  job({
    lease: { ownerId: 'w', fence, until: new Date(), heartbeatAt: new Date() },
    checkpoint: { attestedRuntimeHash: RT, attestedModels: stamps } as never,
    ...extra,
  });
const job = (over: Partial<Job> & { checkpoint?: unknown } = {}): Job =>
  ({
    _id: 'j1',
    kind: 'cleanup',
    status: 'succeeded',
    lease: { ownerId: 'w', fence: 1, until: new Date(), heartbeatAt: new Date() },
    binding: {
      jobId: 'j1',
      runId: 'run-1',
      worldId: 'w1',
      harnessHash: expected.bundleHash,
      scopeRevision: 1,
      workerProfileHash: 'a'.repeat(64),
    },
    checkpoint: { attestedRuntimeHash: RT, attestedModels: [stamp()] },
    ...over,
  }) as unknown as Job;

const rec = (row: Job | null) => ({
  job: row,
  stamps: (row?.checkpoint as { attestedModels?: unknown } | null)?.attestedModels,
});

describe('verifyArm reads the stored job and fails closed', () => {
  it('verifies a provider run pinned to the right harness, world and run', () => {
    expect(verifyArm(rec(job()), expected, profile)).toEqual({
      verified: true,
      runtimeHash: RT,
      reasons: [],
    });
  });
  const cases: Array<[string, Job | null, string, Partial<typeof expected>?, Partial<typeof profile>?]> = [
    ['no job row', null, 'job_missing'],
    ['wrong kind', job({ kind: 'observe' }), 'job_kind'],
    ['another run', job({ binding: { ...job().binding, runId: 'x' } }), 'run_mismatch'],
    ['another world', job({ binding: { ...job().binding, worldId: 'x' } }), 'world_mismatch'],
    [
      'another harness',
      job({ binding: { ...job().binding, harnessHash: 'f'.repeat(64) } }),
      'harness_mismatch',
    ],
    ['completed but not succeeded', job({ status: 'failed' }), 'status_mismatch'],
    ['cancelled but not cancelled', job(), 'status_mismatch', { outcome: 'cancelled' }],
    ['the port says failed for a succeeded job', job(), 'status_mismatch', { outcome: 'failed' }],
    ['the port says incomplete for a succeeded job', job(), 'status_mismatch', { outcome: 'incomplete' }],
    ['the port says refused for a succeeded job', job(), 'status_mismatch', { outcome: 'refused' }],
    ['the port says completed for a failed job', job({ status: 'failed' }), 'status_mismatch'],
    [
      'a succeeded job whose own terminal decision is a failure',
      job({
        checkpoint: {
          attestedRuntimeHash: RT,
          attestedModels: [stamp()],
          terminal: { decision: { status: 'failed' } },
        } as never,
      }),
      'status_mismatch',
    ],
    ['no runtime attestation', job({ checkpoint: { attestedModels: [stamp()] } }), 'runtime_unattested'],
    ['no model stamp', job({ checkpoint: { attestedRuntimeHash: RT } }), 'model_unstamped'],
    [
      'the superseded singular stamp',
      job({ checkpoint: { attestedRuntimeHash: RT, attestedModel: stamp() } }),
      'model_unstamped',
    ],
    ['an empty stamp list', withStamps([]), 'model_unstamped'],
    [
      'a stamp without a fence',
      withStamps([{ source: 'provider', provider: 'openai', modelId: 'gpt-5' }]),
      'model_unstamped',
    ],
    [
      'fake source',
      withStamps([
        stamp({
          source: 'fake',
          provider: 'FAKE_DETERMINISTIC_TEST_PROVIDER',
          modelId: 'fake-deterministic-1',
        }),
      ]),
      'model_not_provider',
    ],
    ['unknown source', withStamps([stamp({ source: 'maybe' })]), 'model_not_provider'],
    [
      'an overridden endpoint',
      withStamps([stamp({ endpoint: 'overridden', endpointHostHash: 'a'.repeat(64) })]),
      'endpoint_not_default',
    ],
    ['an unlabeled endpoint', withStamps([stamp({ endpoint: undefined })]), 'endpoint_not_default'],
    ['another model', withStamps([stamp({ modelId: 'gpt-4' })]), 'model_not_frozen_profile'],
    ['another provider', withStamps([stamp({ provider: 'other' })]), 'model_not_frozen_profile'],
    ['a fake profile', job(), 'profile_not_provider', {}, { modelKind: 'fake' }],
    ['a profile with no provider', job(), 'model_not_frozen_profile', {}, { provider: '' }],
    [
      'stamps that disagree across sessions',
      withStamps([stamp(), stamp({ fence: 2, modelId: 'gpt-4' })], 2),
      'model_stamps_disagree',
    ],
    ['two stamps for one fence', withStamps([stamp(), stamp()]), 'model_stamp_duplicate_fence'],
    [
      'a takeover with no stamp for the final fence',
      withStamps([stamp()], 2),
      'model_stamp_missing_final_fence',
    ],
    ['a malformed entry beside a good one', withStamps([stamp(), { fence: 2 }], 1), 'model_stamp_malformed'],
  ];
  for (const [label, row, reason, exp, prof] of cases)
    it(`${label} is not real evidence (${reason})`, () => {
      const facts = verifyArm(rec(row), { ...expected, ...exp }, { ...profile, ...prof });
      expect(facts.verified).toBe(false);
      expect(facts.reasons).toContain(reason);
    });
  it('one stamp per claiming session, the last for the final fence, verifies', () => {
    const facts = verifyArm(
      rec(withStamps([stamp(), stamp({ fence: 2 }), stamp({ fence: 3 })], 3)),
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
