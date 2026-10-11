import { describe, expect, it } from 'vitest';
import {
  OWNER_EPISODE_LIMITS,
  buildExpertStaticBundle,
  buildW0Bundle,
  WORKER_TOOL_IDS,
} from '@expunge/baselines';
import { VOCABULARY_HASH, COMPILER_HASH } from '@expunge/harness-compiler';
import type { HarnessBundle } from '@expunge/contracts';
import { ELIGIBILITY_POLICY_HASH, ELIGIBILITY_POLICY_ID } from '../../fixtures/src/index.js';
import {
  DEFAULT_AUTHORITY_FLOOR,
  EFFECT_TOOLS,
  FloorMismatch,
  FloorViolation,
  GATEWAY_RULES,
  PolicyEvaluator,
  SYNTHETIC_OWNER_POLICY_V1,
  UnknownOwnerPolicy,
  assertBundleWithinFloor,
  authorityFloorHash,
  buildDecisionInput,
  createAuthorityFloor,
  eligibilityOf,
  floorIssues,
  inputsRecord,
  ownerPolicyFor,
  toolArgsDigest,
  type JobSnapshot,
} from '../src/index.js';

const H = (c: string) => c.repeat(64);
const hashes = {
  runtimeAdapterHash: H('1'),
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: DEFAULT_AUTHORITY_FLOOR.hash,
  eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
  sourceEligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
};
const w0 = () => buildW0Bundle(hashes);
const expert = () => buildExpertStaticBundle(hashes);

const base = (overrides: Partial<JobSnapshot> = {}): JobSnapshot => ({
  toolId: 'inspect_scope',
  worldRevision: 0,
  plan: null,
  batch: null,
  discovery: null,
  arrayFieldsRegistered: null,
  arrayFieldsInspected: null,
  verification: null,
  completionReceiptCommitted: false,
  priorEffects: {},
  priorCalls: 1,
  ...overrides,
});
const plan = (overrides: Partial<NonNullable<JobSnapshot['plan']>> = {}) => ({
  targetCount: 4,
  worldRevision: 0,
  batchCount: 2,
  committedBatches: 0,
  ...overrides,
});

describe('authority floor', () => {
  it('hashes the same floor the same way regardless of list order, and a changed floor differently', () => {
    const spec = {
      allowedTools: [...WORKER_TOOL_IDS],
      allowedEffects: ['tombstone', 'delete', 'redact', 'restrict'] as const,
      maxLimits: OWNER_EPISODE_LIMITS,
    };
    expect(authorityFloorHash(spec)).toBe(DEFAULT_AUTHORITY_FLOOR.hash);
    expect(authorityFloorHash({ ...spec, allowedTools: [...spec.allowedTools].reverse() })).toBe(
      DEFAULT_AUTHORITY_FLOOR.hash,
    );
    expect(authorityFloorHash({ ...spec, allowedEffects: ['delete'] })).not.toBe(
      DEFAULT_AUTHORITY_FLOOR.hash,
    );
    expect(authorityFloorHash({ ...spec, maxLimits: { ...OWNER_EPISODE_LIMITS, toolCalls: 11 } })).not.toBe(
      DEFAULT_AUTHORITY_FLOOR.hash,
    );
  });

  it('accepts the baseline bundles and refuses a bundle outside the floor', () => {
    for (const bundle of [w0(), expert()]) {
      expect(floorIssues(bundle, DEFAULT_AUTHORITY_FLOOR)).toEqual([]);
      expect(() => assertBundleWithinFloor(bundle, DEFAULT_AUTHORITY_FLOOR)).not.toThrow();
    }
    const tight = createAuthorityFloor({
      allowedTools: WORKER_TOOL_IDS.filter((tool) => tool !== 'apply_cleanup_batch'),
      allowedEffects: ['delete'],
      maxLimits: { ...OWNER_EPISODE_LIMITS, toolCalls: 6 },
    });
    expect(() => assertBundleWithinFloor({ ...expert(), authorityFloorHash: tight.hash }, tight)).toThrow(
      FloorViolation,
    );
    const codes = floorIssues(expert(), tight).map((entry) => entry.code);
    expect(codes).toContain('floor_violation');
    expect(codes).toContain('limits_exceed_owner');
    expect(codes).toContain('infrastructure_hash_mismatch');
  });
});

describe('owner policy', () => {
  it('matches the fixture generator policy byte for byte', () => {
    expect(SYNTHETIC_OWNER_POLICY_V1.id).toBe(ELIGIBILITY_POLICY_ID);
    expect(SYNTHETIC_OWNER_POLICY_V1.hash).toBe(ELIGIBILITY_POLICY_HASH);
    expect(
      ownerPolicyFor({
        eligibilityPolicyId: ELIGIBILITY_POLICY_ID,
        eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH,
      }),
    ).toBe(SYNTHETIC_OWNER_POLICY_V1);
  });
  it('refuses a registry naming an unknown policy or a known id with another hash', () => {
    expect(() =>
      ownerPolicyFor({ eligibilityPolicyId: 'other', eligibilityPolicyHash: ELIGIBILITY_POLICY_HASH }),
    ).toThrow(UnknownOwnerPolicy);
    expect(() =>
      ownerPolicyFor({ eligibilityPolicyId: ELIGIBILITY_POLICY_ID, eligibilityPolicyHash: H('f') }),
    ).toThrow(UnknownOwnerPolicy);
  });
  it("reads a record's effect from its envelope and retains everything else", () => {
    const registry = {
      eligibilityPolicyId: ELIGIBILITY_POLICY_ID,
      allowedEffectKinds: ['redact', 'delete'] as ('redact' | 'delete')[],
    };
    expect(
      eligibilityOf(registry, { eligibility: { effect: 'redact', policyId: ELIGIBILITY_POLICY_ID } }),
    ).toEqual({
      eligible: true,
      effect: 'redact',
    });
    expect(
      eligibilityOf(registry, { eligibility: { effect: 'tombstone', policyId: ELIGIBILITY_POLICY_ID } }),
    ).toEqual({
      eligible: false,
      reason: 'effect_not_allowed',
    });
    expect(eligibilityOf(registry, { eligibility: { effect: 'redact', policyId: 'another' } })).toEqual({
      eligible: false,
      reason: 'policy_mismatch',
    });
    expect(eligibilityOf(registry, {})).toEqual({ eligible: false, reason: 'missing_metadata' });
    expect(
      eligibilityOf(registry, { eligibility: { effect: 5, policyId: ELIGIBILITY_POLICY_ID } as never }),
    ).toEqual({
      eligible: false,
      reason: 'missing_metadata',
    });
  });
});

describe('decision inputs built from committed state', () => {
  it('treats unknown state as null and a plan as current only while the revision matches', () => {
    const empty = buildDecisionInput(base());
    expect(empty.facts.plan_target_count).toBeNull();
    expect(empty.facts.verification_status).toBeNull();
    expect(empty.bindings).toMatchObject({
      preview_plan: null,
      action_receipt: null,
      completion_receipt: null,
      approval_grant: null,
    });
    expect(empty.facts.retry_count).toBe(0);

    const fresh = buildDecisionInput(base({ plan: plan(), worldRevision: 0 }));
    expect(fresh.bindings.preview_plan).toBe('valid');
    expect(fresh.facts.world_revision_fresh).toBe(true);
    // Each committed batch advanced the revision once; that keeps the plan current.
    const midway = buildDecisionInput(base({ plan: plan({ committedBatches: 1 }), worldRevision: 1 }));
    expect(midway.bindings.preview_plan).toBe('valid');
    expect(midway.bindings.action_receipt).toBe('invalid');
    // A foreign write makes it stale.
    const foreign = buildDecisionInput(base({ plan: plan({ committedBatches: 1 }), worldRevision: 2 }));
    expect(foreign.bindings.preview_plan).toBe('invalid');
    expect(foreign.facts.world_revision_fresh).toBe(false);
    const done = buildDecisionInput(base({ plan: plan({ committedBatches: 2 }), worldRevision: 2 }));
    expect(done.bindings.action_receipt).toBe('valid');
  });

  it('derives verification status and the completion binding from the latest sweep at the current revision', () => {
    const clean = buildDecisionInput(
      base({ worldRevision: 3, verification: { residuals: 0, worldRevision: 3 } }),
    );
    expect(clean.facts).toMatchObject({ verification_status: 'valid', verification_residuals: 0 });
    expect(clean.bindings.completion_receipt).toBe('valid');
    const dirty = buildDecisionInput(
      base({ worldRevision: 3, verification: { residuals: 2, worldRevision: 3 } }),
    );
    expect(dirty.facts).toMatchObject({ verification_status: 'invalid', verification_residuals: 2 });
    expect(dirty.bindings.completion_receipt).toBe('invalid');
    const stale = buildDecisionInput(
      base({ worldRevision: 4, verification: { residuals: 0, worldRevision: 3 } }),
    );
    expect(stale.facts).toMatchObject({ verification_status: 'invalid', verification_residuals: null });
    expect(buildDecisionInput(base({ completionReceiptCommitted: true })).bindings.completion_receipt).toBe(
      'valid',
    );
  });

  it('counts retries as calls beyond the first and carries prior effects', () => {
    const input = buildDecisionInput(base({ priorCalls: 3, priorEffects: { apply_cleanup_batch: 2 } }));
    expect(input.facts.retry_count).toBe(2);
    expect(input.prior).toEqual({ apply_cleanup_batch: 2 });
  });

  it('records only numbers, booleans, strings and nulls, with an observation time for every input', () => {
    const when = new Date('2026-10-11T10:00:00.000Z');
    const record = inputsRecord(buildDecisionInput(base({ plan: plan() })), when);
    expect(record.facts.plan_target_count).toBe(4);
    expect(record.facts.batch_effect_kind).toBeNull();
    expect(record.observedAt?.['facts.plan_target_count']).toBe('2026-10-11T10:00:00.000Z');
    expect(record.observedAt?.['bindings.preview_plan']).toBe('2026-10-11T10:00:00.000Z');
  });

  it('digests tool arguments over the tool and its arguments', () => {
    expect(toolArgsDigest('inspect_scope', { a: 1, b: 2 })).toBe(
      toolArgsDigest('inspect_scope', { b: 2, a: 1 }),
    );
    expect(toolArgsDigest('inspect_scope', {})).not.toBe(toolArgsDigest('resolve_subject', {}));
    expect(toolArgsDigest('inspect_scope', undefined)).toBe(toolArgsDigest('inspect_scope', null));
  });
});

describe('policy evaluation', () => {
  const evaluator = (bundle: HarnessBundle = expert()) =>
    new PolicyEvaluator(bundle, DEFAULT_AUTHORITY_FLOOR);
  const decide = (bundle: HarnessBundle, snapshot: Partial<JobSnapshot>, revision = 1) =>
    evaluator(bundle).decide(base(snapshot), revision, DEFAULT_AUTHORITY_FLOOR.hash).decision;

  it('allows a granted read tool with no prerequisite', () => {
    expect(decide(expert(), { toolId: 'inspect_scope' })).toEqual({
      result: 'allow',
      ruleIds: [],
      authorizationRevision: 1,
    });
  });

  it('denies apply without a valid preview plan through both the prerequisite and the expert guardrail', () => {
    const none = decide(expert(), { toolId: 'apply_cleanup_batch' });
    expect(none.result).toBe('deny');
    expect(none.ruleIds).toContain('deny_apply_without_valid_plan');
    expect(none.ruleIds).toContain(GATEWAY_RULES.prerequisite('preview_plan'));
    const stale = decide(expert(), {
      toolId: 'apply_cleanup_batch',
      plan: plan({ worldRevision: 0 }),
      worldRevision: 5,
    });
    expect(stale.result).toBe('deny');
    const ok = decide(expert(), {
      toolId: 'apply_cleanup_batch',
      plan: plan(),
      batch: { documentCount: 2, effectKind: 'redact', policyStatus: 'eligible' },
    });
    expect(ok).toEqual({ result: 'allow', ruleIds: [], authorizationRevision: 1 });
  });

  it('requires the prerequisites the expert bundle names for verification and completion', () => {
    expect(
      decide(expert(), {
        toolId: 'verify_registered_scope',
        plan: plan({ committedBatches: 1 }),
        worldRevision: 1,
      }).ruleIds,
    ).toContain(GATEWAY_RULES.prerequisite('action_receipt'));
    const verifyOk = decide(expert(), {
      toolId: 'verify_registered_scope',
      plan: plan({ committedBatches: 2 }),
      worldRevision: 2,
    });
    expect(verifyOk.result).toBe('allow');
    expect(decide(expert(), { toolId: 'complete_cleanup' }).ruleIds).toContain(
      GATEWAY_RULES.prerequisite('completion_receipt'),
    );
    expect(
      decide(expert(), {
        toolId: 'complete_cleanup',
        worldRevision: 2,
        verification: { residuals: 0, worldRevision: 2 },
      }).result,
    ).toBe('allow');
    expect(
      decide(expert(), {
        toolId: 'complete_cleanup',
        worldRevision: 2,
        verification: { residuals: 1, worldRevision: 2 },
      }).result,
    ).toBe('deny');
  });

  it('denies a tool the bundle does not grant and a tool outside the floor', () => {
    const verdict = decide(w0(), { toolId: 'verify_registered_scope' });
    expect(verdict.result).toBe('deny');
    expect(verdict.ruleIds).toContain(GATEWAY_RULES.toolNotGranted);
    const tight = createAuthorityFloor({
      allowedTools: ['inspect_scope'],
      allowedEffects: ['delete'],
      maxLimits: OWNER_EPISODE_LIMITS,
    });
    const tightBundle: HarnessBundle = { ...expert(), authorityFloorHash: tight.hash };
    const out = new PolicyEvaluator(tightBundle, tight).decide(
      base({ toolId: 'resolve_subject' }),
      1,
      tight.hash,
    ).decision;
    expect(out.result).toBe('deny');
    expect(out.ruleIds).toContain(GATEWAY_RULES.toolNotInFloor);
    const effect = new PolicyEvaluator(tightBundle, tight).decide(
      base({
        toolId: 'inspect_scope',
        batch: { documentCount: 1, effectKind: 'tombstone', policyStatus: 'eligible' },
      }),
      1,
      tight.hash,
    ).decision;
    expect(effect.ruleIds).toContain(GATEWAY_RULES.effectNotInFloor);
  });

  it('merges a restrictive guardrail by severity and fails closed on an unknown fact', () => {
    const asking: HarnessBundle = {
      ...expert(),
      guardrails: [
        {
          ruleId: 'ask_when_large',
          predicate: {
            op: 'compare',
            comparator: 'gt',
            left: { kind: 'fact', factId: 'batch_document_count' },
            right: { kind: 'constant', value: 10 },
          },
          result: 'ask',
          sourceEvidenceIds: [],
          appliesTo: ['apply_cleanup_batch'],
        },
      ],
    };
    const ready = {
      toolId: 'apply_cleanup_batch',
      plan: plan(),
    };
    expect(
      decide(asking, {
        ...ready,
        batch: { documentCount: 11, effectKind: 'delete', policyStatus: 'eligible' },
      }),
    ).toMatchObject({
      result: 'ask',
      ruleIds: ['ask_when_large'],
    });
    expect(
      decide(asking, {
        ...ready,
        batch: { documentCount: 3, effectKind: 'delete', policyStatus: 'eligible' },
      }).result,
    ).toBe('allow');
    // An effect with no batch is unknown and denied outright (DA-5a G2), whatever the ask rule would have said.
    expect(decide(asking, { ...ready, batch: null }).result).toBe('deny');
    // For a read, an unknown fact still makes an ask rule fire: unknown is never collapsed to allow.
    const unknownFact: HarnessBundle = {
      ...expert(),
      guardrails: [
        {
          ruleId: 'ask_when_frontier_open',
          predicate: {
            op: 'compare',
            comparator: 'gt',
            left: { kind: 'fact', factId: 'frontier_open_count' },
            right: { kind: 'constant', value: 0 },
          },
          result: 'ask',
          sourceEvidenceIds: [],
          appliesTo: ['inspect_scope'],
        },
      ],
    };
    expect(decide(unknownFact, { toolId: 'inspect_scope', discovery: null }).result).toBe('ask');
    // A deny from another source outranks the ask.
    expect(
      decide(asking, {
        toolId: 'apply_cleanup_batch',
        batch: { documentCount: 11, effectKind: 'delete', policyStatus: 'eligible' },
      }).result,
    ).toBe('deny');
  });

  it('reports the authorization revision it was given and never trusts the bundle for it', () => {
    expect(decide(expert(), { toolId: 'inspect_scope' }, 7).authorizationRevision).toBe(7);
  });

  describe('DA-5a G1: the floor is the one the bundle names and the one stored for the scope', () => {
    const noDelete = createAuthorityFloor({
      allowedTools: WORKER_TOOL_IDS,
      allowedEffects: ['redact', 'restrict', 'tombstone'],
      maxLimits: OWNER_EPISODE_LIMITS,
    });
    it('G1: refuses to build an evaluator whose floor is not the floor the bundle names', () => {
      const bundle: HarnessBundle = { ...expert(), authorityFloorHash: noDelete.hash };
      expect(() => new PolicyEvaluator(bundle, DEFAULT_AUTHORITY_FLOOR)).toThrow(FloorMismatch);
      expect(() => new PolicyEvaluator(expert(), noDelete)).toThrow('FloorMismatch');
      expect(() => new PolicyEvaluator(bundle, noDelete)).not.toThrow();
    });
    it('G1: a floor that excludes delete denies a delete batch under its own bundle, never allows it', () => {
      const bundle: HarnessBundle = { ...expert(), authorityFloorHash: noDelete.hash };
      const verdict = new PolicyEvaluator(bundle, noDelete).decide(
        base({
          toolId: 'apply_cleanup_batch',
          plan: plan(),
          batch: { documentCount: 1, effectKind: 'delete', policyStatus: 'eligible' },
        }),
        1,
        noDelete.hash,
      );
      expect(verdict.decision.result).toBe('deny');
      expect(verdict.decision.ruleIds).toContain(GATEWAY_RULES.effectNotInFloor);
    });
    it('G1: denies with gateway:floor_mismatch when the stored owner floor is no longer the run floor', () => {
      const evaluator = new PolicyEvaluator(expert(), DEFAULT_AUTHORITY_FLOOR);
      const verdict = evaluator.decide(base({ toolId: 'inspect_scope' }), 1, 'b'.repeat(64));
      expect(verdict.decision.result).toBe('deny');
      expect(verdict.decision.ruleIds).toContain(GATEWAY_RULES.floorMismatch);
      expect(GATEWAY_RULES.floorMismatch).toBe('gateway:floor_mismatch');
      // The same call under the stored floor is allowed, so the deny comes from the mismatch alone.
      expect(
        evaluator.decide(base({ toolId: 'inspect_scope' }), 1, DEFAULT_AUTHORITY_FLOOR.hash).decision.result,
      ).toBe('allow');
    });
  });

  describe('DA-5a G2: an effect with an unknown batch fails closed', () => {
    it('G2: apply_cleanup_batch with batch null is deny gateway:batch_unknown even when the plan is current', () => {
      const verdict = new PolicyEvaluator(expert(), DEFAULT_AUTHORITY_FLOOR).decide(
        base({ toolId: 'apply_cleanup_batch', plan: plan(), batch: null }),
        1,
        DEFAULT_AUTHORITY_FLOOR.hash,
      );
      expect(verdict.decision.result).toBe('deny');
      expect(verdict.decision.ruleIds).toContain(GATEWAY_RULES.batchUnknown);
      expect(GATEWAY_RULES.batchUnknown).toBe('gateway:batch_unknown');
    });
    it('G2: a batch whose effect kind is not one of the four is also unknown', () => {
      const verdict = new PolicyEvaluator(expert(), DEFAULT_AUTHORITY_FLOOR).decide(
        base({
          toolId: 'apply_cleanup_batch',
          plan: plan(),
          batch: { documentCount: 1, effectKind: 'purge' as never, policyStatus: 'eligible' },
        }),
        1,
        DEFAULT_AUTHORITY_FLOOR.hash,
      );
      expect(verdict.decision.ruleIds).toContain(GATEWAY_RULES.batchUnknown);
    });
    it('G2: the same tool with a known allowed batch is still allowed', () => {
      expect(EFFECT_TOOLS).toEqual(['apply_cleanup_batch']);
      const verdict = new PolicyEvaluator(expert(), DEFAULT_AUTHORITY_FLOOR).decide(
        base({
          toolId: 'apply_cleanup_batch',
          plan: plan(),
          batch: { documentCount: 1, effectKind: 'redact', policyStatus: 'eligible' },
        }),
        1,
        DEFAULT_AUTHORITY_FLOOR.hash,
      );
      expect(verdict.decision.result).toBe('allow');
    });
  });

  describe('DA-5a G7: approval grants are not wired yet', () => {
    it('G7: a prerequisite on approval_grant always denies today (fails closed); the positive case lands with C3', () => {
      const gated: HarnessBundle = {
        ...expert(),
        toolPolicy: {
          ...expert().toolPolicy,
          prerequisites: [
            ...expert().toolPolicy.prerequisites,
            {
              toolId: 'apply_cleanup_batch',
              requiredArtifact: 'approval_grant',
              binding: 'same_job_same_plan_current_revision',
            },
          ],
        },
      };
      const verdict = new PolicyEvaluator(gated, DEFAULT_AUTHORITY_FLOOR).decide(
        base({
          toolId: 'apply_cleanup_batch',
          plan: plan(),
          batch: { documentCount: 1, effectKind: 'redact', policyStatus: 'eligible' },
        }),
        1,
        DEFAULT_AUTHORITY_FLOOR.hash,
      );
      expect(verdict.decision.result).toBe('deny');
      expect(verdict.decision.ruleIds).toContain(GATEWAY_RULES.prerequisite('approval_grant'));
    });
  });
});
