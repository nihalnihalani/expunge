import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { HASH, claimRow, describeLive, freezeRow, openEnvironment, type LiveEnvironment } from './support.js';

const scope = { tenantId: 'protocol-test', env: 'evaluation', scopeId: 'scope' } as const;
const DOCUMENT_VALIDATION_FAILED = 121;

/** One valid row per collection; each is mutated to show the strict validator says no. */
const valid: Record<string, Record<string, unknown>> = {
  campaign_freezes: freezeRow('campaign-1'),
  gate_claims: claimRow({ campaignId: 'campaign-1', parentHash: HASH, childProjectionHash: 'b'.repeat(64) }),
  gate_attempts: { _id: HASH, attempts: 1 },
  gate_held_runs: {
    _id: `${HASH}:campaign-1:1`,
    claimKey: HASH,
    campaignId: 'campaign-1',
    attempt: 1,
    freezeHash: HASH,
    reasonCodes: ['missing_information'],
    excluded: 'superseded_by_resume',
    trials: [{ pairId: 'p' }],
  },
  world_faults: {
    _id: 'world-1',
    ...scope,
    worldId: 'world-1',
    plan: { partialAcknowledgements: 0, interruptAfterEffects: null, transientFailures: 1 },
    planHash: HASH,
    createdAt: new Date(),
  },
  rollback_refusals: {
    _id: 'refusal-1',
    ...scope,
    target: 'worker',
    toHash: HASH,
    code: 'RollbackNeedsGrant',
    at: new Date(),
    actor: { actorId: 'owner', authorizationRevision: 1 },
  },
  campaign_artifact_permits: {
    _id: `campaign-1:${HASH}`,
    ...scope,
    campaignId: 'campaign-1',
    artifactHash: HASH,
    freezeHash: HASH,
    createdAt: new Date(),
  },
};
const invalid: Record<string, Array<[string, Record<string, unknown>]>> = {
  campaign_freezes: [
    ['a field the schema does not name', { extra: 1 }],
    ['an evaluator hash that is not a hash', { evaluatorHash: 'nope' }],
    ['a negative attempt cap', { maxAttemptsPerParent: -1 }],
  ],
  gate_claims: [
    ['an unknown state', { state: 'half-open' }],
    ['a candidate key that is not a hash', { _id: 'candidate' }],
    ['a field the schema does not name', { extra: 1 }],
  ],
  gate_attempts: [['a negative counter', { attempts: -1 }]],
  gate_held_runs: [
    ['an exclusion reason that is not the one defined', { excluded: 'dropped' }],
    ['a field the schema does not name', { extra: 1 }],
  ],
  world_faults: [
    [
      'a negative transient count',
      { plan: { partialAcknowledgements: 0, interruptAfterEffects: null, transientFailures: -1 } },
    ],
    ['a plan hash that is not a hash', { planHash: 'x' }],
    ['a field the schema does not name', { extra: 1 }],
  ],
  rollback_refusals: [
    ['a code outside the audited set', { code: 'Anything' }],
    ['a target that is not a deployment target', { target: 'prod' }],
  ],
  campaign_artifact_permits: [
    ['an artifact that is not a hash', { artifactHash: 'bundle' }],
    ['a field the schema does not name', { extra: 1 }],
  ],
};

describeLive('the gate, fault, refusal and permit collections validate strictly (real replica set)', () => {
  let env: LiveEnvironment;
  beforeAll(async () => {
    env = await openEnvironment('gatecoll');
  }, 30000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  for (const [collection, row] of Object.entries(valid))
    it(`${collection}: accepts its row and refuses malformed ones`, async () => {
      const rows = env.service.control.collection(collection);
      await rows.insertOne(structuredClone(row) as never);
      let n = 0;
      for (const [label, change] of invalid[collection] ?? []) {
        // A fresh, well-formed _id, so the only thing wrong with the row is what the case changes.
        n += 1;
        const _id = /^[a-f0-9]{64}$/.test(String(row._id))
          ? n.toString(16).padStart(64, '0')
          : `${String(row._id)}-${n}`;
        await expect(
          rows.insertOne({ ...structuredClone(row), _id, ...change } as never),
          label,
        ).rejects.toMatchObject({
          code: DOCUMENT_VALIDATION_FAILED,
        });
      }
    });

  it('keeps one fault plan per world and one claim per candidate (unique keys)', async () => {
    const faults = env.service.control.collection('world_faults');
    await faults.insertOne(structuredClone(valid.world_faults) as never);
    await expect(
      faults.insertOne({ ...structuredClone(valid.world_faults), _id: 'world-1-again' } as never),
    ).rejects.toMatchObject({ code: 11000 });
    const claims = env.service.control.collection('gate_claims');
    await claims.insertOne(structuredClone(valid.gate_claims) as never);
    await expect(claims.insertOne(structuredClone(valid.gate_claims) as never)).rejects.toMatchObject({
      code: 11000,
    });
  });
});
