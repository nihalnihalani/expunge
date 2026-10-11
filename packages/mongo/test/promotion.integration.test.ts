import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MutationClass } from '@expunge/contracts';
import {
  ApprovalRepository,
  ArtifactRepository,
  AuthorityRepository,
  AuthorityPolicyRepository,
  CandidateRepository,
  DeploymentRepository,
  ProvenanceRepository,
  type GrantBinding,
  type PromotionInput,
} from '../src/index.js';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import {
  HASH,
  actor,
  bindingFor,
  describeLive,
  insertGateReport,
  issueGrant,
  openEnvironment,
  proposalOf,
  type LiveEnvironment,
} from './support.js';

const workerKey = {
  tenantId: actor.tenantId,
  env: actor.env,
  scopeId: actor.scopeId,
  target: 'worker',
} as const;
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

describeLive('promotion and rollback: authority derived from trusted rows (real replica set)', () => {
  let env: LiveEnvironment;
  let artifacts: ArtifactRepository;
  let deployments: DeploymentRepository;
  let policies: AuthorityPolicyRepository;
  let candidates: CandidateRepository;
  let approvals: ApprovalRepository;
  let authority: AuthorityRepository;

  beforeAll(async () => {
    env = await openEnvironment('promotion');
    artifacts = new ArtifactRepository(env.service);
    deployments = new DeploymentRepository(await env.as('promoter'));
    policies = new AuthorityPolicyRepository(env.service);
    candidates = new CandidateRepository(await env.as('proposer'));
    approvals = new ApprovalRepository(env.service);
    authority = new AuthorityRepository(env.service);
  }, 30000);
  beforeEach(async () => {
    await env.reset();
    await policies.install(workerKey, true);
  });
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  type Prepared = {
    parent: string;
    child: string;
    candidateId: string;
    reportId: string;
    digest: string;
    /** What a grant for this candidate must say, derived from the stored gate report. */
    binding: GrantBinding;
  };
  /**
   * A deployed parent, a distinct child artifact, an admitting gate report carrying the gate's class and, unless
   * `proposal` is false, the proposer's candidate row (which never carries a class).
   */
  async function prepare(
    n: number,
    computedClass: MutationClass | undefined,
    options: { parent?: string; proposal?: false | MutationClass; flips?: string[] } = {},
  ): Promise<Prepared> {
    const parent = options.parent ?? (await artifacts.insert(validBundle()))._id;
    if (!options.parent) await deployments.initialize(actor, 'worker', parent, 1);
    const child = (
      await artifacts.insert({
        ...validBundle(),
        parentHash: parent,
        contextPolicy: { ...validBundle().contextPolicy, referenceDepth: n },
      })
    )._id;
    const candidateId = `candidate-${n}`;
    const reportId = `report-${n}`;
    const digest = await insertGateReport(env.service, {
      parentHash: parent,
      childHash: child,
      candidateId,
      reportId,
      ...(options.flips ? { knownAuthorityFlips: options.flips } : {}),
      ...(computedClass ? { computedClass } : {}),
    });
    if (options.proposal !== false)
      await candidates.propose(
        proposalOf({
          candidateId,
          parentHash: parent,
          childHash: child,
          ...(options.proposal ? { claimedClass: options.proposal } : {}),
        }),
      );
    const binding = computedClass ? await bindingFor(env.service, reportId) : (undefined as never);
    return { parent, child, candidateId, reportId, digest, binding };
  }
  function promotionOf(p: Prepared, extra: Partial<PromotionInput> = {}): PromotionInput {
    return {
      actor,
      target: 'worker',
      candidateId: p.candidateId,
      parentHash: p.parent,
      childHash: p.child,
      parentRevision: 0,
      gateReportId: p.reportId,
      gateReportDigest: p.digest,
      runtimeHash: HASH,
      evaluatorHash: HASH,
      scopeRevision: 1,
      flipSetDigest: p.binding?.flipSetDigest ?? HASH,
      approvedDescriptor: p.binding?.approvedDescriptor ?? {},
      reason: 'test',
      validateAuthority: deployments.authority.validator(actor),
      ...extra,
    };
  }
  async function grantFor(
    p: Prepared,
    n: number,
    options: {
      expiresAt?: Date;
      overrides?: Parameters<typeof issueGrant>[1]['overrides'];
      raw?: boolean;
    } = {},
  ): Promise<string> {
    const grantId = `grant-${n}`;
    await issueGrant(env.service, {
      grantId,
      reportId: p.reportId,
      nonce: `nonce-${n}`,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
      ...(options.raw ? { raw: true } : {}),
    });
    return grantId;
  }
  const pointer = async () => deployments.read(workerKey);
  const consumptions = () => env.service.control.collection('grant_consumptions').countDocuments();
  const promotions = () => env.service.control.collection('promotions').countDocuments();
  const eligibility = (artifactHash: string, state: string, sourceIds: string[] = []) =>
    env.service.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash,
      state,
      policyHash: HASH,
      reasonCode: 'source_retracted',
      sourceIds,
      updatedAt: new Date(),
    });

  it('has one same-parent promotion; the loser grant is never consumed', async () => {
    const first = await prepare(1, 'authority_expansion');
    const second = await prepare(2, 'authority_expansion', { parent: first.parent });
    const inputs = [
      promotionOf(first, { grantId: await grantFor(first, 1) }),
      promotionOf(second, { grantId: await grantFor(second, 2) }),
    ];
    const results = await Promise.allSettled(inputs.map((input) => deployments.promote(input)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await consumptions()).toBe(1);
    expect(await promotions()).toBe(1);
    expect((await pointer())?.revision).toBe(1);
  });

  it('rolls back grant consumption when the parent pointer is stale', async () => {
    const first = await prepare(1, 'authority_expansion');
    const second = await prepare(2, 'authority_expansion', { parent: first.parent });
    await deployments.promote(promotionOf(first, { grantId: await grantFor(first, 1) }));
    const loserGrant = await grantFor(second, 2);
    await expect(deployments.promote(promotionOf(second, { grantId: loserGrant }))).rejects.toThrow(
      'StaleParent',
    );
    expect(await approvals.consumption(loserGrant)).toBeNull();
    expect(await consumptions()).toBe(1);
  });

  it('expired, changed or foreign grants fail without consumption or pointer movement', async () => {
    const p = await prepare(1, 'authority_expansion');
    const other = await prepare(2, 'authority_expansion', { parent: p.parent });
    const expired = await grantFor(p, 1, { expiresAt: new Date(0) });
    await expect(deployments.promote(promotionOf(p, { grantId: expired }))).rejects.toThrow(
      'ApprovalInvalidOrConsumed',
    );
    const changed = await grantFor(p, 2);
    await expect(
      deployments.promote(promotionOf(p, { grantId: changed, approvedDescriptor: { effect: 'widened' } })),
    ).rejects.toThrow('ApprovalInvalidOrConsumed');
    // A grant issued for another candidate cannot be spent on this one.
    const foreign = await grantFor(other, 3);
    await expect(deployments.promote(promotionOf(p, { grantId: foreign }))).rejects.toThrow(
      'ApprovalInvalidOrConsumed',
    );
    expect(await consumptions()).toBe(0);
    expect((await pointer())?.revision).toBe(0);
  });

  it('matches the approved descriptor canonically, not by BSON field order', async () => {
    const p = await prepare(1, 'authority_expansion');
    const descriptor = p.binding.approvedDescriptor as Record<string, unknown>;
    const reversed = Object.fromEntries(
      Object.entries(descriptor).reverse(),
    ) as typeof p.binding.approvedDescriptor;
    expect(Object.keys(reversed as object)).not.toEqual(Object.keys(descriptor));
    const grantId = await grantFor(p, 1, { overrides: { approvedDescriptor: reversed } });
    const receipt = await deployments.promote(promotionOf(p, { grantId, approvedDescriptor: reversed }));
    expect(receipt.consumedGrantId).toBe(grantId);
  });

  it('refuses grants whose expiry is further out than the maximum lifetime', async () => {
    const p = await prepare(1, 'authority_expansion');
    await expect(grantFor(p, 1, { expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) })).rejects.toThrow(
      'InvalidApprovalExpiry',
    );
  });

  it('aborts a promotion after pointer CAS without consuming its grant', async () => {
    const p = await prepare(1, 'authority_expansion');
    const grantId = await grantFor(p, 1);
    // An over-long reason fails the promotions validator after the grant and pointer were updated.
    await expect(
      deployments.promote(promotionOf(p, { grantId, reason: 'x'.repeat(300) })),
    ).rejects.toMatchObject({ code: 121 });
    expect((await pointer())?.revision).toBe(0);
    expect(await consumptions()).toBe(0);
    expect(await promotions()).toBe(0);
  });

  it('replays a committed promotion instead of re-executing it (lost acknowledgment)', async () => {
    const p = await prepare(1, 'authority_expansion');
    const input = promotionOf(p, { grantId: await grantFor(p, 1) });
    const first = await deployments.promote(input);
    const again = await deployments.promote(input);
    expect(again).toEqual(first);
    expect(await promotions()).toBe(1);
    expect(await consumptions()).toBe(1);
    expect((await pointer())?.revision).toBe(1);
  });

  it('keeps policy writes with the setup principal and makes installs idempotent', async () => {
    expect(await policies.install(workerKey, true)).toHaveProperty('behavioralRequiresApproval', true);
    await expect(policies.install(workerKey, false)).rejects.toThrow('PolicyConflict');
    await expect(policies.replace({ ...workerKey, target: 'hider' }, true)).rejects.toThrow(
      'AuthorityPolicyMissing',
    );
    expect(await env.service.control.collection('authority_policies').countDocuments()).toBe(1);
  });

  it('hashes the stored class into the gate report digest so it cannot be edited after the fact', async () => {
    const p = await prepare(1, 'tightening');
    await env.service.control
      .collection('gate_reports')
      .updateOne({ _id: p.reportId as never }, { $set: { computedClass: 'authority_expansion' } });
    await expect(deployments.promote(promotionOf(p))).rejects.toThrow('GateReportMismatch');
  });

  describe('L11: the approval requirement comes from the gate report and stored policy only', () => {
    it('requires a grant for an authority_expansion even when the proposer row and the caller say otherwise', async () => {
      const p = await prepare(1, 'authority_expansion', { proposal: 'tightening' });
      await expect(deployments.promote(promotionOf(p))).rejects.toThrow('ApprovalRequired');
      // A forged requiresApproval flag from an untyped (HTTP or model) caller is not read at all.
      const forged = { ...promotionOf(p), requiresApproval: false } as unknown as PromotionInput;
      await expect(deployments.promote(forged)).rejects.toThrow('ApprovalRequired');
      expect((await pointer())?.revision).toBe(0);
      expect(await promotions()).toBe(0);
    });

    it('does not read the candidate row at all: a row lying upward or missing changes nothing', async () => {
      const lying = await prepare(1, 'tightening', { proposal: 'authority_expansion' });
      expect((await deployments.promote(promotionOf(lying))).toRevision).toBe(1);
      const absent = await prepare(2, 'tightening', { parent: lying.child, proposal: false });
      const next = await deployments.promote({ ...promotionOf(absent), parentRevision: 1 });
      expect(next.toRevision).toBe(2);
    });

    it('never requires a grant for a gate-classified tightening, even when policy gates behavior', async () => {
      const p = await prepare(1, 'tightening');
      const receipt = await deployments.promote(promotionOf(p));
      expect(receipt.toRevision).toBe(1);
      expect(receipt).not.toHaveProperty('consumedGrantId');
      expect(await consumptions()).toBe(0);
    });

    it('follows the stored policy for behavioral changes', async () => {
      await policies.replace(workerKey, false);
      const open = await prepare(1, 'behavioral');
      expect((await deployments.promote(promotionOf(open))).toRevision).toBe(1);

      await policies.replace(workerKey, true);
      const gated = await prepare(2, 'behavioral', { parent: open.child });
      await expect(deployments.promote({ ...promotionOf(gated), parentRevision: 1 })).rejects.toThrow(
        'ApprovalRequired',
      );
      expect((await pointer())?.revision).toBe(1);
    });

    it('fails closed without a gate-written class and without a stored policy', async () => {
      const unclassified = await prepare(1, undefined);
      await expect(deployments.promote(promotionOf(unclassified))).rejects.toThrow('GateReportClassMissing');
      await env.service.control.collection('authority_policies').deleteMany({});
      const classified = await prepare(2, 'tightening', { parent: unclassified.parent });
      await expect(deployments.promote(promotionOf(classified))).rejects.toThrow('AuthorityPolicyMissing');
      expect((await pointer())?.revision).toBe(0);
    });

    it('rejects a gate report that contradicts the promotion binding', async () => {
      const p = await prepare(1, 'tightening');
      await expect(deployments.promote(promotionOf(p, { candidateId: 'someone-else' }))).rejects.toThrow(
        'GateReportMismatch',
      );
      await expect(deployments.promote(promotionOf(p, { gateReportDigest: HASH }))).rejects.toThrow(
        'GateReportMismatch',
      );
    });

    it('marks an existing candidate row promoted in the same transaction as the pointer move', async () => {
      const p = await prepare(1, 'tightening');
      await deployments.promote(promotionOf(p));
      const row = await env.service.control.collection('candidates').findOne({ candidateId: p.candidateId });
      expect(row).toHaveProperty('state', 'promoted');
    });
  });

  describe('L5: eligibility fence inside the promotion transaction', () => {
    it.each(['revoked', 'source_deleted'] as const)(
      'refuses a child whose source eligibility is %s',
      async (state) => {
        const p = await prepare(1, 'tightening');
        await eligibility(p.child, state, ['retracted-source']);
        await expect(deployments.promote(promotionOf(p))).rejects.toThrow('ArtifactIneligible');
        expect((await pointer())?.revision).toBe(0);
        expect(await promotions()).toBe(0);
      },
    );

    it('refuses a child derived from a revoked source, even when its own row is untouched', async () => {
      const p = await prepare(1, 'tightening');
      const provenance = new ProvenanceRepository(env.service);
      await eligibility('trace-1', 'permitted');
      await provenance.append(scope, 'trace-1', p.child, 'derived_from');
      // One round revokes the source and leaves the closure open: ancestry alone must stop the child.
      const partial = await provenance.revoke(scope, 'trace-1', HASH, 'source_retracted', { maxRounds: 1 });
      expect(partial.ids).toContain('trace-1');
      await expect(deployments.promote(promotionOf(p))).rejects.toThrow('ArtifactIneligible');
      expect(await promotions()).toBe(0);
    });

    it('does not require the child to be registered for retrieval', async () => {
      const p = await prepare(1, 'tightening');
      expect((await deployments.promote(promotionOf(p))).toRevision).toBe(1);
    });
  });

  describe('L4: rollback only to a hash that was active in the same key', () => {
    /** parent -> child promoted; returns both. */
    async function promoted() {
      const p = await prepare(1, 'tightening');
      await deployments.promote(promotionOf(p));
      return p;
    }
    const rollbackTo = (expectedHash: string, expectedRevision: number, toHash: string) =>
      deployments.rollback(
        actor,
        workerKey,
        expectedHash,
        expectedRevision,
        toHash,
        'rollback',
        deployments.authority.validator(actor),
        { expectedScopeRevision: 1 },
      );

    it('refuses an artifact that was never gated or promoted, even if it has a permitted row', async () => {
      const p = await promoted();
      const stranger = (
        await artifacts.insert({
          ...validBundle(),
          contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 9 },
        })
      )._id;
      await eligibility(stranger, 'permitted');
      await expect(rollbackTo(p.child, 1, stranger)).rejects.toThrow('RollbackTargetNeverDeployed');
      expect((await pointer())?.activeHash).toBe(p.child);
    });

    it('rolls back to the previously active hash as a new audited transition', async () => {
      const p = await promoted();
      // A changed context policy is a behavioral change, which the stored policy says needs a grant (D8-17).
      const grant = await approvals.issueRollback(actor, {
        target: 'worker',
        toHash: p.parent,
        expiresAt: new Date(Date.now() + 100_000),
      });
      const receipt = await deployments.rollback(
        actor,
        workerKey,
        p.child,
        1,
        p.parent,
        'rollback',
        deployments.authority.validator(actor),
        { expectedScopeRevision: 1, grant: { grantId: grant.grantId } },
      );
      expect(receipt).toMatchObject({ fromHash: p.child, toHash: p.parent, toRevision: 2 });
      expect(await promotions()).toBe(2);
      expect((await pointer())?.activeHash).toBe(p.parent);
    });

    it('refuses to roll back onto the active hash or onto a hash whose source was revoked', async () => {
      const p = await promoted();
      await expect(rollbackTo(p.child, 1, p.child)).rejects.toThrow('RollbackTargetIsActive');
      await eligibility(p.parent, 'revoked', ['retracted-source']);
      await expect(rollbackTo(p.child, 1, p.parent)).rejects.toThrow('ArtifactIneligible');
      expect((await pointer())?.activeHash).toBe(p.child);
    });

    it('is still a compare-and-swap on the expected active hash and revision', async () => {
      const p = await promoted();
      await expect(rollbackTo(p.child, 0, p.parent)).rejects.toThrow('StaleParent');
      expect((await pointer())?.activeHash).toBe(p.child);
    });
  });
  describe('D8-17: rollback is one transaction on the scope state the caller read, with a grant when it widens authority', () => {
    const granted = ['inspect_schema'];
    const wider = [...granted, 'apply_cleanup_batch'];
    const bundleWith = (grants: string[], parentHash: string | null = null) => ({
      ...validBundle(),
      parentHash,
      toolPolicy: { grants, prerequisites: [] },
    });
    /** `active` is deployed now; `target` was deployed before (a receipt names it), so it is a legal rollback target. */
    async function twoDeployed(activeGrants: string[], targetGrants: string[]) {
      const target = (await artifacts.insert(bundleWith(targetGrants)))._id;
      const active = (await artifacts.insert(bundleWith(activeGrants, target)))._id;
      await deployments.initialize(actor, 'worker', active, 1);
      await env.service.control.collection('promotions').insertOne({
        _id: 'seed-promotion' as never,
        ...workerKey,
        promotionId: 'seed-promotion',
        fromHash: target,
        toHash: active,
        fromRevision: 0,
        toRevision: 0,
        gateReportId: 'seed',
        gateReportDigest: HASH,
        runtimeHash: HASH,
        evaluatorHash: HASH,
        reason: 'seed',
        createdAt: new Date(),
      });
      return { active, target };
    }
    const roll = (
      from: string,
      to: string,
      options: Parameters<typeof deployments.rollback>[7] = { expectedScopeRevision: 1 },
      revision = 0,
    ) =>
      deployments.rollback(
        actor,
        workerKey,
        from,
        revision,
        to,
        'rollback',
        deployments.authority.validator(actor),
        options,
      );
    const refusals = () =>
      env.service.control.collection('rollback_refusals').find({}).sort({ at: 1 }).toArray();
    const issue = (toHash: string, expiresAt = new Date(Date.now() + 100_000)) =>
      approvals.issueRollback(actor, { target: 'worker', toHash, expiresAt });

    it('a rollback that narrows authority needs no grant and consumes none', async () => {
      const { active, target } = await twoDeployed(wider, granted);
      const receipt = await roll(active, target);
      expect(receipt).toMatchObject({ fromHash: active, toHash: target, toRevision: 1 });
      expect(receipt.consumedGrantId).toBeUndefined();
      expect(await consumptions()).toBe(0);
      expect((await pointer())?.activeHash).toBe(target);
    });

    it('a rollback that widens authority is refused without a grant, and the refusal is recorded', async () => {
      const { active, target } = await twoDeployed(granted, wider);
      await expect(roll(active, target)).rejects.toThrow('RollbackNeedsGrant');
      expect((await pointer())?.activeHash).toBe(active);
      expect((await refusals()).map((row) => [row.code, row.toHash])).toEqual([
        ['RollbackNeedsGrant', target],
      ]);
    });

    it('a bound, unexpired grant lets it through once, derived server-side, and is consumed with the pointer move', async () => {
      const { active, target } = await twoDeployed(granted, wider);
      const grant = await issue(target);
      // A wrong claim about the class is a refusal; the class comes from the stored bundles.
      await expect(
        roll(active, target, {
          expectedScopeRevision: 1,
          grant: { grantId: grant.grantId, reverseClass: 'tightening' },
        }),
      ).rejects.toThrow('ApprovalInvalidOrConsumed');
      expect(await consumptions()).toBe(0);
      const receipt = await roll(active, target, {
        expectedScopeRevision: 1,
        grant: { grantId: grant.grantId, reverseClass: 'authority_expansion' },
      });
      expect(receipt.consumedGrantId).toBe(grant.grantId);
      expect(await consumptions()).toBe(1);
      expect((await pointer())?.activeHash).toBe(target);
    });

    it('an expired, reused or mismatched grant moves nothing and consumes nothing', async () => {
      const { active, target } = await twoDeployed(granted, wider);
      const expired = await issue(target, new Date(Date.now() - 1000));
      await expect(
        roll(active, target, { expectedScopeRevision: 1, grant: { grantId: expired.grantId } }),
      ).rejects.toThrow('ApprovalInvalidOrConsumed');
      const reused = await issue(target);
      await env.service.control.collection('grant_consumptions').insertOne({
        _id: reused.grantId as never,
        ...workerKey,
        grantId: reused.grantId,
        promotionId: 'earlier',
        candidateId: reused.proposalId,
        consumedAt: new Date(),
      });
      await expect(
        roll(active, target, { expectedScopeRevision: 1, grant: { grantId: reused.grantId } }),
      ).rejects.toThrow('ApprovalInvalidOrConsumed');
      // A grant issued for another transition (to a third bundle) is not this transition's grant.
      const other = (await artifacts.insert(bundleWith([...wider, 'verify_registered_scope'])))._id;
      const foreign = await issue(other);
      await expect(
        roll(active, target, { expectedScopeRevision: 1, grant: { grantId: foreign.grantId } }),
      ).rejects.toThrow('ApprovalInvalidOrConsumed');
      expect(await consumptions()).toBe(1);
      expect((await pointer())?.activeHash).toBe(active);
      expect((await refusals()).map((row) => row.code)).toEqual(Array(3).fill('ApprovalInvalidOrConsumed'));
    });

    it('a stale or missing scope revision is refused and recorded', async () => {
      const { active, target } = await twoDeployed(wider, granted);
      await expect(roll(active, target, { expectedScopeRevision: 2 })).rejects.toThrow('StaleScopeRevision');
      await expect(
        deployments.rollback(
          actor,
          workerKey,
          active,
          0,
          target,
          'rollback',
          deployments.authority.validator(actor),
        ),
      ).rejects.toThrow('StaleScopeRevision');
      expect((await pointer())?.activeHash).toBe(active);
      expect((await refusals()).map((row) => row.code)).toEqual(['StaleScopeRevision', 'StaleScopeRevision']);
    });

    it('records a refused rollback onto the active hash and a stale parent', async () => {
      const { active, target } = await twoDeployed(wider, granted);
      await expect(roll(active, active)).rejects.toThrow('RollbackTargetIsActive');
      await expect(roll(active, target, { expectedScopeRevision: 1 }, 5)).rejects.toThrow('StaleParent');
      expect((await refusals()).map((row) => row.code)).toEqual(['RollbackTargetIsActive', 'StaleParent']);
    });

    it('the pointer moves under a rollback only if the scope revision is still the one it read', async () => {
      const { active, target } = await twoDeployed(wider, granted);
      await env.service.control
        .collection('deployments')
        .updateOne({ ...workerKey }, { $set: { scopeRevision: 2 } });
      await expect(roll(active, target)).rejects.toThrow('StaleScopeRevision');
      expect((await pointer())?.activeHash).toBe(active);
    });

    it('a concurrent promotion and rollback on one pointer: exactly one wins', async () => {
      const p = await prepare(1, 'tightening');
      await deployments.promote(promotionOf(p));
      const second = await prepare(2, 'tightening', { parent: p.child });
      const grant = await approvals.issueRollback(actor, {
        target: 'worker',
        toHash: p.parent,
        expiresAt: new Date(Date.now() + 100_000),
      });
      const outcomes = await Promise.allSettled([
        roll(p.child, p.parent, { expectedScopeRevision: 1, grant: { grantId: grant.grantId } }, 1),
        deployments.promote(promotionOf(second, { parentRevision: 1 })),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect((await pointer())?.revision).toBe(2);
    });

    it('two rollbacks spending one grant: exactly one wins and the grant is consumed once', async () => {
      const { active, target } = await twoDeployed(granted, wider);
      const grant = await issue(target);
      const options = { expectedScopeRevision: 1, grant: { grantId: grant.grantId } };
      const outcomes = await Promise.allSettled([
        roll(active, target, options),
        roll(active, target, options),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await consumptions()).toBe(1);
    });
  });
  describe('K8: a grant says only what the stored gate report says', () => {
    const flips = ['tool:apply_cleanup_batch:added', 'limit:changedDocuments:widened'];
    const forgeries: Array<[string, (p: Prepared) => Parameters<typeof issueGrant>[1]['overrides']]> = [
      ['a flip-set digest that does not match the report', () => ({ flipSetDigest: 'f'.repeat(64) })],
      [
        'an approved descriptor that does not match the report',
        () => ({ approvedDescriptor: { widened: true } }),
      ],
      [
        'a gate report digest that does not match the stored report',
        () => ({ gateReportDigest: 'e'.repeat(64) }),
      ],
      ['another child hash', () => ({ childHash: 'd'.repeat(64) })],
      ['another parent hash', () => ({ parentHash: 'd'.repeat(64) })],
      ['another candidate', () => ({ proposalId: 'someone-else' })],
    ];

    it.each(forgeries)('the issuer refuses a grant carrying %s', async (_label, forge) => {
      const p = await prepare(1, 'authority_expansion', { flips });
      await expect(grantFor(p, 1, { overrides: forge(p) })).rejects.toThrow('InvalidApprovalBinding');
      expect(await env.service.control.collection('approvals').countDocuments()).toBe(0);
    });

    it.each(forgeries)('promotion refuses a raw-inserted grant carrying %s', async (_label, forge) => {
      const p = await prepare(1, 'authority_expansion', { flips });
      const grantId = await grantFor(p, 1, { overrides: forge(p), raw: true });
      await expect(deployments.promote(promotionOf(p, { grantId }))).rejects.toThrow(
        'ApprovalInvalidOrConsumed',
      );
      expect(await consumptions()).toBe(0);
      expect((await pointer())?.revision).toBe(0);
    });

    it('derives the flip-set digest and descriptor from the report, so different flips mean different grants', async () => {
      const plain = await prepare(1, 'authority_expansion');
      const flipped = await prepare(2, 'authority_expansion', { parent: plain.parent, flips });
      expect(flipped.binding.flipSetDigest).not.toBe(plain.binding.flipSetDigest);
      expect(flipped.binding.approvedDescriptor).toMatchObject({
        computedClass: 'authority_expansion',
        flips: [...flips].sort(),
      });
      // The flip order in the report does not change the digest.
      expect(
        (await prepare(3, 'authority_expansion', { parent: plain.parent, flips: [...flips].reverse() }))
          .binding.flipSetDigest,
      ).toBe(flipped.binding.flipSetDigest);
    });

    it('refuses a request whose own flip-set or descriptor claim differs from the report, with a valid grant', async () => {
      const p = await prepare(1, 'authority_expansion', { flips });
      const grantId = await grantFor(p, 1);
      await expect(deployments.promote(promotionOf(p, { grantId, flipSetDigest: HASH }))).rejects.toThrow(
        'ApprovalInvalidOrConsumed',
      );
      await expect(
        deployments.promote(promotionOf(p, { grantId, approvedDescriptor: { effect: 'anything' } })),
      ).rejects.toThrow('ApprovalInvalidOrConsumed');
      expect((await deployments.promote(promotionOf(p, { grantId }))).consumedGrantId).toBe(grantId);
    });

    it('refuses to issue for a missing, rejected or unclassified gate report', async () => {
      const p = await prepare(1, 'authority_expansion');
      await expect(grantFor(p, 1, { overrides: { gateReportId: 'no-such-report' } })).rejects.toThrow(
        'GateReportMissing',
      );
      const rejected = await prepare(2, 'authority_expansion', { parent: p.parent });
      await env.service.control
        .collection('gate_reports')
        .updateOne({ _id: rejected.reportId as never }, { $set: { verdict: 'reject' } });
      await expect(grantFor(rejected, 2)).rejects.toThrow('InvalidApprovalBinding');
    });

    it('rejects a gate report edited after the grant was issued', async () => {
      const p = await prepare(1, 'authority_expansion', { flips });
      const grantId = await grantFor(p, 1);
      await env.service.control
        .collection('gate_reports')
        .updateOne({ _id: p.reportId as never }, { $set: { knownAuthorityFlips: [] } });
      await expect(deployments.promote(promotionOf(p, { grantId }))).rejects.toThrow('GateReportMismatch');
      expect(await consumptions()).toBe(0);
    });
  });

  describe('D8: promotion and rollback read and fence the stored authority', () => {
    const current = { ...actor, authorizationRevision: 2 };
    const asCurrent = (p: Prepared) =>
      promotionOf(p, { actor: current, validateAuthority: deployments.authority.validator(current) });

    it('denies a promotion by a stale actor and one that runs before the bump commits', async () => {
      const p = await prepare(1, 'tightening');
      await authority.bump(scope);
      await expect(deployments.promote(promotionOf(p))).rejects.toThrow('AuthorityRevisionStale');
      expect((await pointer())?.revision).toBe(0);
      expect(await promotions()).toBe(0);
    });

    it('allows the actor at the new revision and records that revision on the pointer', async () => {
      const p = await prepare(1, 'tightening');
      await authority.bump(scope);
      expect((await deployments.promote(asCurrent(p))).toRevision).toBe(1);
      expect(await pointer()).toMatchObject({ activeHash: p.child, authorizationRevision: 2 });
    });

    it('denies a rollback by a stale actor', async () => {
      const p = await prepare(1, 'tightening');
      await deployments.promote(promotionOf(p));
      await authority.bump(scope);
      await expect(
        deployments.rollback(
          actor,
          workerKey,
          p.child,
          1,
          p.parent,
          'rollback',
          deployments.authority.validator(actor),
          { expectedScopeRevision: 1 },
        ),
      ).rejects.toThrow('AuthorityRevisionStale');
      expect((await pointer())?.activeHash).toBe(p.child);
    });

    it('refuses a bundle compiled against a different owner floor than the stored one', async () => {
      const p = await prepare(1, 'tightening');
      await authority.bump(scope, 'c'.repeat(64));
      await expect(deployments.promote(asCurrent(p))).rejects.toThrow('AuthorityFloorMismatch');
      expect((await pointer())?.revision).toBe(0);
    });

    it('runs the caller-supplied authority validator inside the transaction and honors its refusal', async () => {
      const p = await prepare(1, 'authority_expansion');
      const grantId = await grantFor(p, 1);
      await expect(
        deployments.promote(
          promotionOf(p, {
            grantId,
            validateAuthority: async () => {
              throw new Error('owner-policy-refused');
            },
          }),
        ),
      ).rejects.toThrow('owner-policy-refused');
      expect(await consumptions()).toBe(0);
      expect((await pointer())?.revision).toBe(0);
    });

    it('fails closed without a stored authority row', async () => {
      const p = await prepare(1, 'tightening');
      await env.service.control.collection('authority_revisions').deleteMany({});
      await expect(deployments.promote(promotionOf(p))).rejects.toThrow('AuthorityMissing');
    });
  });
});
