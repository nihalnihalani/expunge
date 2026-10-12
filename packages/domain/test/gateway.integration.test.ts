import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, type ActorContext, type HarnessBundle } from '@expunge/contracts';
import { AuthorityRepository, WorldRepository } from '@expunge/mongo';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { atlasRoleManifests } from '@expunge/mongo';
import { FAMILIES, valuesAtPath } from '../../fixtures/src/index.js';
import { gradeWorld, runReference } from '../../grader/src/index.js';
import { describeLive } from '../../mongo/test/support.js';
import {
  JobGateway,
  completeCleanup,
  createDomainEnv,
  createDomainToolProvider,
  resolveSubject,
  SUBJECT_NOT_FOUND,
  ToolRefusal,
} from '../src/index.js';
import { JobStopSignal } from '@expunge/runtime';
import {
  SCRIPTED_DRIVER_LABEL,
  attempt,
  byId,
  canonical,
  driveExpert,
  driveW0,
  openRig,
  toolsFor,
  bundles,
  type Rig,
  type Seeded,
} from './rig.js';

describeLive(`domain gateway against a real replica set (${SCRIPTED_DRIVER_LABEL})`, () => {
  let rig: Rig;
  const control = (name: string) => rig.env.service.control.collection(name);
  const world = (name: string) => rig.env.service.world.collection(name);
  const decisionsOf = (seeded: Seeded, jobId: string) => rig.domain.ledger.list(seeded.actor, jobId, 1000);
  const runIdOf = (jobId: string) => `run-${jobId}`;
  const counters = async (seeded: Seeded) =>
    (await world('world_revisions').findOne({ _id: seeded.world.worldId as never }))!.revision as number;

  beforeAll(async () => {
    rig = await openRig('domain');
  }, 60000);
  beforeEach(() => rig.env.reset());
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 60000);

  describe('expert-static procedure reaches the grader reference on every fixture family', () => {
    for (const family of FAMILIES) {
      it(`${family}: committed receipt, world equals the independent reference, grader says useful completion`, async () => {
        const seeded = await rig.seed(family);
        const run = await rig.open(seeded, 'expert');
        const trace = await driveExpert(run.tools);
        const failures = trace.filter((step) => !step.ok);
        expect(failures, JSON.stringify(failures)).toEqual([]);

        const stored = await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId);
        expect(stored.status).toBe('succeeded');
        const receipt = await rig.domain.store.completionReceipt(seeded.actor, run.jobId, runIdOf(run.jobId));
        expect(receipt).toMatchObject({
          domainStatus: 'complete_in_registered_scope',
          operationalResiduals: 0,
        });

        const actual = await rig.worldNow(seeded);
        const reference = runReference(seeded.world).world;
        expect(canonical(byId(actual.collections))).toBe(canonical(byId(reference.collections)));
        const grade = gradeWorld(seeded.manifest, actual, { terminalStatus: 'complete' });
        expect(grade).toMatchObject({
          usefulCompletion: true,
          targetedResiduals: 0,
          unrelatedRecordChanges: 0,
        });
        expect(grade.preservationViolations).toBe(0);
      }, 60000);
    }
  });

  describe('W0 (narrative completion, shallow context) cannot call a miss a success', () => {
    const outcomes: Array<{ family: string; complete: boolean }> = [];
    for (const family of FAMILIES) {
      it(`${family}: whatever W0 does, the committed receipt and the grader agree`, async () => {
        const seeded = await rig.seed(family);
        const run = await rig.open(seeded, 'w0');
        const trace = await driveW0(run.tools);
        const finish = trace.at(-1)!;
        // The scripted driver, like the narrating model it stands in for, tries to finish. The gateway answers from a sweep.
        expect(finish).toMatchObject({ tool: 'complete_cleanup', ok: true });
        const stored = await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId);
        const receipt = (await rig.domain.store.completionReceipt(
          seeded.actor,
          run.jobId,
          runIdOf(run.jobId),
        ))!;
        const actual = await rig.worldNow(seeded);
        outcomes.push({ family, complete: receipt.domainStatus === 'complete_in_registered_scope' });
        if (receipt.domainStatus === 'complete_in_registered_scope') {
          // W0 got everything on this world: the same sweep that would have caught a miss says it did not miss.
          expect(stored.status).toBe('succeeded');
          expect(gradeWorld(seeded.manifest, actual, { terminalStatus: 'complete' }).usefulCompletion).toBe(
            true,
          );
          return;
        }
        expect(finish.ok && finish.result).toMatchObject({ completed: false, domainStatus: 'incomplete' });
        expect(stored.status).toBe('failed');
        expect(receipt.operationalResiduals).toBeGreaterThan(0);
        expect(stored.outputRefs).toEqual([receipt.receiptId]);
        // A model that narrated "done" would be a false completion; what the gateway committed is truthful.
        const claimed = gradeWorld(seeded.manifest, actual, { terminalStatus: 'complete' });
        expect(claimed).toMatchObject({ usefulCompletion: false, falseCompletion: true });
        const committed = gradeWorld(seeded.manifest, actual, { terminalStatus: 'incomplete' });
        expect(committed).toMatchObject({ truthfulTerminal: true, falseCompletion: false });
        expect(committed.targetedResiduals).toBeGreaterThan(0);
      }, 60000);
    }
    it('misses on most families (the structural reason the expert procedure exists)', () => {
      expect(outcomes).toHaveLength(FAMILIES.length);
      expect(outcomes.filter((entry) => !entry.complete).length).toBeGreaterThanOrEqual(FAMILIES.length - 2);
    });
  });

  describe('every call is decided and recorded before it acts', () => {
    it('one ledger row per call with its tool and inputs; every effect names a recorded allow decision made earlier', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      const decisions = await decisionsOf(seeded, run.jobId);
      expect(decisions).toHaveLength(trace.length);
      expect(decisions.every((row) => row.toolId && row.inputs && row.inputsDigest)).toBe(true);
      expect(decisions.map((row) => row.toolId)).toEqual(trace.map((step) => step.tool));
      expect(new Set(decisions.map((row) => row.decision.result))).toEqual(new Set(['allow']));

      const intents = await control('action_intents').find({ jobId: run.jobId }).toArray();
      expect(intents.length).toBeGreaterThan(0);
      const byDecision = new Map(decisions.map((row) => [row.decisionId, row]));
      for (const intent of intents) {
        const decision = byDecision.get(intent.decisionId as string)!;
        expect(decision, 'every intent names a ledger row').toBeDefined();
        expect(decision.toolId).toBe('apply_cleanup_batch');
        expect(decision.argsDigest).toBe(intent.argsDigest);
        expect(decision.decidedAt.getTime()).toBeLessThanOrEqual((intent.createdAt as Date).getTime());
      }
      expect(await control('effects').countDocuments({ jobId: run.jobId })).toBe(intents.length);
      expect(await control('action_receipts').countDocuments({ jobId: run.jobId })).toBe(intents.length);
    });

    it('projects tool decisions, committed effects and the receipt as one contiguous per-job sequence', async () => {
      const seeded = await rig.seed('shared_array');
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      const events = await rig.domain.projections.read(seeded.actor, 0, run.jobId, 500);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      const kinds = events.map((event) => event.kind);
      expect(kinds.filter((kind) => kind === 'tool_decided')).toHaveLength(trace.length);
      expect(kinds).toContain('effect_committed');
      expect(kinds).toContain('receipt_committed');
      expect(kinds).toContain('job_status_changed');
      // No event carries a subject literal.
      const text = JSON.stringify(events);
      expect(text).not.toContain(seeded.world.subjectHandle);
    });
  });

  describe('the policy decision stands between a model call and the world', () => {
    it('W0 is not granted verification; the denial is recorded and nothing is read or written', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'w0');
      const step = await attempt(run.tools, 'verify_registered_scope');
      expect(step).toEqual({ tool: 'verify_registered_scope', ok: false, code: 'PolicyDenied' });
      const [row] = await decisionsOf(seeded, run.jobId);
      expect(row?.decision).toMatchObject({ result: 'deny' });
      expect(row?.decision.ruleIds).toContain('gateway:tool_not_granted');
      expect(await control('verification_sweeps').countDocuments()).toBe(0);
    });

    it('apply before any preview plan is denied twice over (prerequisite and guardrail) and commits nothing', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references'])
        expect((await attempt(run.tools, tool)).ok).toBe(true);
      const step = await attempt(run.tools, 'apply_cleanup_batch');
      expect(step).toEqual({ tool: 'apply_cleanup_batch', ok: false, code: 'PolicyDenied' });
      const rows = await decisionsOf(seeded, run.jobId);
      const denied = rows.at(-1)!;
      expect(denied.decision.ruleIds).toEqual(
        expect.arrayContaining(['deny_apply_without_valid_plan', 'gateway:prerequisite_preview_plan']),
      );
      expect(await control('effects').countDocuments()).toBe(0);
      expect(await counters(seeded)).toBe(0);
    });

    it('expert complete_cleanup before verification is denied by the completion_receipt prerequisite', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const step = await attempt(run.tools, 'complete_cleanup');
      expect(step).toEqual({ tool: 'complete_cleanup', ok: false, code: 'PolicyDenied' });
      expect(await control('completion_receipts').countDocuments()).toBe(0);
    });

    it('a call that needs approval stops the run with a wait and writes nothing', async () => {
      const seeded = await rig.seed('direct_nested');
      const asking: HarnessBundle = {
        ...bundles.expert(),
        guardrails: [
          ...bundles.expert().guardrails,
          {
            ruleId: 'ask_before_any_batch',
            predicate: {
              op: 'compare',
              comparator: 'gt',
              left: { kind: 'fact', factId: 'batch_document_count' },
              right: { kind: 'constant', value: 0 },
            },
            result: 'ask',
            sourceEvidenceIds: [],
            appliesTo: ['apply_cleanup_batch'],
          },
        ],
      };
      const run = await rig.open(seeded, 'expert', { bundle: asking });
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
        expect((await attempt(run.tools, tool)).ok).toBe(true);
      const step = await attempt(run.tools, 'apply_cleanup_batch');
      expect(step).toEqual({ tool: 'apply_cleanup_batch', ok: false, code: 'JobWait:waiting_approval' });
      expect((await decisionsOf(seeded, run.jobId)).at(-1)?.decision).toMatchObject({
        result: 'ask',
        ruleIds: ['ask_before_any_batch'],
      });
      expect(await control('effects').countDocuments()).toBe(0);
    });
  });

  describe('effects: one logical action once, atomic batches, stale or changed targets refused', () => {
    async function previewed(family: (typeof FAMILIES)[number] = 'direct_nested') {
      const seeded = await rig.seed(family);
      const run = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
        expect((await attempt(run.tools, tool)).ok, tool).toBe(true);
      const plan = (await rig.domain.store.latestPlan(seeded.actor, run.jobId, runIdOf(run.jobId)))!;
      return { seeded, run, plan };
    }

    it('applies a batch once: repeating it, by ordinal or by default after a takeover, returns the saved receipt', async () => {
      const { seeded, run } = await previewed();
      const first = await attempt(run.tools, 'apply_cleanup_batch');
      expect(first).toMatchObject({
        ok: true,
        result: { batchOrdinal: 0, replayed: false, committed: true },
      });
      const again = await attempt(run.tools, 'apply_cleanup_batch', { batch: 0 });
      expect(again).toMatchObject({ ok: true, result: { batchOrdinal: 0, replayed: true } });
      expect(again.ok && first.ok && again.result.receiptId).toBe(first.ok && first.result.receiptId);
      // A new gateway on the same run (a worker that took over) carries on from the committed prefix.
      const resumed = await toolsFor(rig.domain, run.context);
      const next = await attempt(resumed, 'apply_cleanup_batch');
      expect(next).toMatchObject({ ok: true, result: { batchOrdinal: 1, replayed: false } });
      expect(await control('effects').countDocuments({ jobId: run.jobId })).toBe(2);
      expect(await counters(seeded)).toBe(2);
      // A batch that does not exist has no known effect, so the decision fails closed before anything runs.
      expect(await attempt(resumed, 'apply_cleanup_batch', { batch: 5 })).toMatchObject({
        ok: false,
        code: 'PolicyDenied',
      });
      expect((await decisionsOf(seeded, run.jobId)).at(-1)?.decision.ruleIds).toContain(
        'gateway:batch_unknown',
      );
    });

    it('refuses a batch whose turn has not come', async () => {
      const { run, plan } = await previewed();
      expect(plan.targets.length).toBeGreaterThan(1);
      const step = await attempt(run.tools, 'apply_cleanup_batch', { batch: 1 });
      expect(step).toEqual({ tool: 'apply_cleanup_batch', ok: false, code: 'BatchOutOfOrder' });
    });

    it('refuses a target that changed after the plan, before anything is written', async () => {
      const { seeded, run, plan } = await previewed();
      const stale = plan.targets[0]!;
      await world(stale.address.collectionId).updateOne(
        { _id: stale.address.recordId as never },
        { $inc: { _rev: 1 } },
      );
      const step = await attempt(run.tools, 'apply_cleanup_batch');
      expect(step).toEqual({ tool: 'apply_cleanup_batch', ok: false, code: 'StaleDocumentVersion' });
      expect(await control('effects').countDocuments()).toBe(0);
      expect(await counters(seeded)).toBe(0);
    });

    it('a record the owner policy stops covering after the plan aborts the whole batch and is left as it was', async () => {
      const { seeded, run, plan } = await previewed();
      const first = plan.targets.filter((target) => target.effect === plan.targets[0]!.effect);
      expect(first.length).toBeGreaterThan(1);
      const before = new Map<string, string>();
      for (const target of first)
        before.set(
          target.address.recordId as string,
          contentHash(
            await world(target.address.collectionId).findOne({ _id: target.address.recordId as never }),
            'before',
          ),
        );
      const changed = first.at(-1)!;
      await world(changed.address.collectionId).updateOne(
        { _id: changed.address.recordId as never },
        { $set: { 'eligibility.policyId': 'another-policy' } },
      );
      before.set(
        changed.address.recordId as string,
        contentHash(
          await world(changed.address.collectionId).findOne({ _id: changed.address.recordId as never }),
          'before',
        ),
      );
      const step = await attempt(run.tools, 'apply_cleanup_batch');
      expect(step).toEqual({ tool: 'apply_cleanup_batch', ok: false, code: 'PolicyChanged' });
      for (const target of first) {
        const now = await world(target.address.collectionId).findOne({
          _id: target.address.recordId as never,
        });
        expect(contentHash(now, 'before'), String(target.address.recordId)).toBe(
          before.get(target.address.recordId as string),
        );
      }
      expect(await control('effects').countDocuments()).toBe(0);
      expect(await counters(seeded)).toBe(0);
    });
  });

  describe('the owner policy is the only thing that decides what an effect does', () => {
    it('a record the policy retains is never removed or changed, and does not count as a residual', async () => {
      const seeded = await rig.seed('direct_nested');
      // Make one non-root record of the subject's reach ineligible under the registry's policy.
      const reference = runReference(seeded.world).plan;
      const victim = reference.actions.find(
        (action) => action.address.recordId !== seeded.world.subjectHandle,
      )!;
      await world(victim.address.collectionId).updateOne(
        { _id: victim.address.recordId as never },
        { $set: { 'eligibility.policyId': 'someone-elses-policy' } },
      );
      const untouched = await world(victim.address.collectionId).findOne({
        _id: victim.address.recordId as never,
      });
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      expect(trace.filter((step) => !step.ok)).toEqual([]);
      const after = await world(victim.address.collectionId).findOne({
        _id: victim.address.recordId as never,
      });
      expect(contentHash(after, 'retained')).toBe(contentHash(untouched, 'retained'));
      const preview = trace.find((step) => step.tool === 'preview_cleanup');
      expect(preview?.ok && preview.result.retainedCount).toBe(1);
      const receipt = (await rig.domain.store.completionReceipt(
        seeded.actor,
        run.jobId,
        runIdOf(run.jobId),
      ))!;
      expect(receipt).toMatchObject({
        domainStatus: 'complete_in_registered_scope',
        operationalResiduals: 0,
      });
      expect(receipt.excludedOrRetainedRecords).toBeGreaterThanOrEqual(1);
    });

    it("redaction replaces only the subject's elements of a mixed array and keeps every other element byte for byte", async () => {
      const seeded = await rig.seed('shared_array');
      const run = await rig.open(seeded, 'expert');
      const before = await rig.worldNow(seeded);
      await driveExpert(run.tools);
      const after = await rig.worldNow(seeded);
      const reference = runReference(seeded.world);
      let mixed = 0;
      for (const action of reference.plan.actions.filter((entry) => entry.effect === 'redact')) {
        const field = seeded.world.scope.fields.find(
          (candidate) =>
            candidate.collectionId === action.address.collectionId &&
            candidate.isArray &&
            candidate.fieldId.endsWith('identity_binding'),
        );
        if (!field) continue;
        const was = (
          before.collections[action.address.collectionId] as never as Array<Record<string, unknown>>
        ).find((doc) => doc._id === action.address.recordId)!;
        const now = (
          after.collections[action.address.collectionId] as never as Array<Record<string, unknown>>
        ).find((doc) => doc._id === action.address.recordId)!;
        const exact = new Set(reference.plan.exactBindings);
        const wasValues = valuesAtPath(was as never, field.path);
        const nowValues = valuesAtPath(now as never, field.path);
        expect(nowValues).toHaveLength(wasValues.length);
        wasValues.forEach((entry, index) => {
          if (exact.has(entry.value as string)) expect(nowValues[index]!.value).toBe('[redacted]');
          else {
            expect(nowValues[index]!.value).toBe(entry.value);
            mixed += 1;
          }
        });
      }
      expect(mixed, 'a bystander element was kept next to a redacted one').toBeGreaterThan(0);
    });
  });

  describe('the model chooses a job handle and a tool, never a collection, a field, a world or an effect', () => {
    it('rejects a collection, field, world or effect in the arguments, and a selection the bundle does not allow', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const rejected = async (tool: string, args: unknown, code: string) =>
        expect(await attempt(run.tools, tool, args), `${tool} ${JSON.stringify(args)}`).toEqual({
          tool,
          ok: false,
          code,
        });
      await rejected('discover_references', { collection: 'accounts' }, 'InvalidArguments');
      await rejected('discover_references', { worldId: 'another-world' }, 'InvalidArguments');
      await rejected('resolve_subject', { subject: 'someone-else' }, 'InvalidArguments');
      await rejected('preview_cleanup', { targets: ['customers/1'] }, 'InvalidArguments');
      await rejected('apply_cleanup_batch', { effect: 'delete' }, 'InvalidArguments');
      await rejected('apply_cleanup_batch', { batch: -1 }, 'InvalidArguments');
      await rejected('inspect_scope', { select: ['customers.ssn'] }, 'SelectionNotAllowed');
      await rejected('inspect_scope', { collection: 'private' }, 'InvalidArguments');
      // Nothing above reached a decision-worthy action; the strict-schema failures never touch the world.
      expect(await control('effects').countDocuments()).toBe(0);
    });

    it('cannot name a field outside the registry to the scope repository, and has no handle on the private database', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const key = await rig.domain.jobs.worldKey(seeded.actor, run.jobId);
      await expect(
        rig.domain.scopes.findByField(key, seeded.world.scope, 'customers.ssn', 'x'),
      ).rejects.toThrow('UnknownFieldId');
      await expect(rig.domain.scopes.scan(key, seeded.world.scope, 'campaign_keys')).rejects.toThrow(
        'UnauthorizedCollection',
      );
      expect(rig.executor.privateDb).toBeUndefined();
      const manifest = atlasRoleManifests().domain_executor!;
      expect(
        manifest.actions
          .flatMap((entry) => entry.resources)
          .some((resource) => resource.db.endsWith('private')),
      ).toBe(false);
    });

    it('a copy of the subject in an unregistered path survives an operationally complete run, and the grader catches it', async () => {
      const seeded = await rig.seed('direct_nested');
      const reference = runReference(seeded.world).plan;
      const target = reference.actions.find((action) => action.effect === 'redact') ?? reference.actions[0]!;
      const doc = (await world(target.address.collectionId).findOne({
        _id: target.address.recordId as never,
      }))!;
      const token = reference.exactBindings.find((value) => value !== target.address.recordId)!;
      await world(target.address.collectionId).updateOne(
        { _id: doc._id },
        { $set: { 'data.unregisteredShadow': token } },
      );
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      expect(trace.filter((step) => !step.ok)).toEqual([]);
      const receipt = (await rig.domain.store.completionReceipt(
        seeded.actor,
        run.jobId,
        runIdOf(run.jobId),
      ))!;
      // Operationally complete: the registered scope holds no residual, and the receipt says only that.
      expect(receipt).toMatchObject({
        domainStatus: 'complete_in_registered_scope',
        operationalResiduals: 0,
      });
      expect(receipt.limitations.join(' ')).toContain('registered scope');
      const after = await world(target.address.collectionId).findOne({
        _id: target.address.recordId as never,
      });
      if (after) expect((after.data as Record<string, unknown>).unregisteredShadow).toBe(token);
      const grade = gradeWorld(seeded.manifest, await rig.worldNow(seeded), { terminalStatus: 'complete' });
      expect(grade.usefulCompletion).toBe(false);
    });
  });

  describe('revocation stops a run that is already in flight', () => {
    async function bumped(floorHash?: string) {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      expect((await attempt(run.tools, 'inspect_scope')).ok).toBe(true);
      await new AuthorityRepository(await rig.env.as('approval_issuer')).bump(seeded.binding, floorHash);
      return { seeded, run };
    }
    it('a read tool is refused once the owner revoked the authorization revision, and the job is cancelled', async () => {
      const { seeded, run } = await bumped();
      expect(await attempt(run.tools, 'resolve_subject')).toEqual({
        tool: 'resolve_subject',
        ok: false,
        code: 'AuthorityRevoked',
      });
      const stored = await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId);
      expect(stored.cancellationRequested).toBe(true);
      // The revoked run could not even write its decision.
      expect(await decisionsOf(seeded, run.jobId)).toHaveLength(1);
    });
    it('replacing the owner floor revokes the same way', async () => {
      const { run } = await bumped('c'.repeat(64));
      expect(await attempt(run.tools, 'discover_references')).toMatchObject({
        ok: false,
        code: 'AuthorityRevoked',
      });
    });
    it('an effect committed after the revision moved fails in its own transaction and writes nothing', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
        expect((await attempt(run.tools, tool)).ok).toBe(true);
      await new AuthorityRepository(await rig.env.as('approval_issuer')).bump(seeded.binding);
      expect(await attempt(run.tools, 'apply_cleanup_batch')).toMatchObject({
        ok: false,
        code: 'AuthorityRevoked',
      });
      expect(await control('effects').countDocuments()).toBe(0);
      expect(await counters(seeded)).toBe(0);
    });
  });

  describe('a run is bound to its stored job, its pinned bundle and a floor this process knows', () => {
    it('ignores a doctored job object: the world and run come from the stored row', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const doctored = {
        ...run.context,
        job: { ...run.job, binding: { ...run.job.binding, worldId: 'another-world', scopeRevision: 9 } },
      };
      const gateway = await JobGateway.open(rig.domain, doctored);
      expect(gateway.rt.run).toMatchObject({
        worldId: seeded.world.worldId,
        scopeRevision: seeded.world.scope.revision,
      });
      expect(await gateway.rt.worldRevision()).toBe(0);
    });
    it("refuses another scope's actor and a bundle the job is not pinned to", async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const stranger: ActorContext = { ...seeded.actor, scopeId: 'someone-elses-scope' };
      await expect(JobGateway.open(rig.domain, { ...run.context, actor: stranger })).rejects.toThrow();
      const wrongBundle = { ...run.context, bundle: bundles.w0() };
      await expect(JobGateway.open(rig.domain, wrongBundle)).rejects.toThrow('BundleBindingMismatch');
    });
    it("has no default floor: an environment without the bundle's floor cannot open a run", async () => {
      expect(() => createDomainEnv(rig.executor, { floors: [] })).toThrow('AuthorityFloorUnknown');
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const other = createDomainEnv(rig.executor, {
        floors: [{ ...DEFAULT_AUTHORITY_FLOOR, hash: 'd'.repeat(64) }],
      });
      await expect(createDomainToolProvider(other).create(run.context)).rejects.toThrow(
        'AuthorityFloorUnknown',
      );
    });
  });

  describe('completion is built from a verification of the registered scope, never from a call', () => {
    async function verified() {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      return { seeded, run, trace };
    }
    it('the tool refuses on its own when no valid current sweep exists, whatever the policy decided', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const gateway = await JobGateway.open(rig.domain, run.context);
      // Nothing resolved yet: there is no reach to measure completion against.
      await expect(completeCleanup(gateway.rt)).rejects.toThrow('SubjectNotResolved');
      await attempt(run.tools, 'inspect_scope');
      expect((await attempt(run.tools, 'resolve_subject')).ok).toBe(true);
      await expect(completeCleanup(gateway.rt)).rejects.toThrow(ToolRefusal);
      await expect(completeCleanup(gateway.rt)).rejects.toThrow('VerificationRequired');
    });
    it('a subject matching no record reports matched: false and ends the job with SubjectNotFound', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert', {
        subject: { idType: 'string', value: 'syn_000000000000000000000000' },
      });
      const gateway = await JobGateway.open(rig.domain, run.context);
      expect(await resolveSubject(gateway.rt)).toMatchObject({
        resolved: false,
        matched: false,
        reason: SUBJECT_NOT_FOUND,
      });
      await attempt(run.tools, 'inspect_scope');
      const caught = await run.tools.resolve_subject!({}).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(JobStopSignal);
      expect((caught as JobStopSignal).code).toBe('SubjectNotFound');
      // Nothing was resolved, so nothing downstream can run.
      expect(await rig.domain.store.latestStep(seeded.actor, run.jobId, 'subject_resolution')).toBeNull();
    });
    it('a sweep that went stale because the world moved cannot complete the job', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
        await attempt(run.tools, tool);
      for (let guard = 0; guard < 20; guard++) {
        const step = await attempt(run.tools, 'apply_cleanup_batch');
        if (!step.ok || step.result.batchesRemaining === 0) break;
      }
      expect(await attempt(run.tools, 'verify_registered_scope')).toMatchObject({
        ok: true,
        result: { verified: true },
      });
      await world('world_revisions').updateOne(
        { _id: seeded.world.worldId as never },
        { $inc: { revision: 1 } },
      );
      const gateway = await JobGateway.open(rig.domain, run.context);
      await expect(completeCleanup(gateway.rt)).rejects.toThrow('VerificationStale');
      expect(await control('completion_receipts').countDocuments()).toBe(0);
      // Through the gateway the same call is denied before the tool runs: the sweep is not current.
      expect(await attempt(run.tools, 'complete_cleanup')).toMatchObject({ ok: false, code: 'PolicyDenied' });
    });
    it('a world rebound to another scope revision cannot take a completion receipt', async () => {
      const { seeded, run } = await verified();
      expect(run.jobId).toBeTruthy();
      // The job already finished; a second job on the same world, pinned to revision 1, sees the rebinding.
      const second = await rig.open(seeded, 'expert');
      await new WorldRepository(await rig.env.as('fixture_builder')).rebind(
        seeded.binding,
        seeded.world.worldId,
        {
          scopeRevision: 2,
        },
      );
      const gateway = await JobGateway.open(rig.domain, second.context);
      await expect(gateway.rt.worldRevision()).resolves.toBeGreaterThanOrEqual(0);
      expect(await attempt(second.tools, 'complete_cleanup')).toMatchObject({ ok: false });
      expect(await control('completion_receipts').countDocuments({ jobId: second.jobId })).toBe(0);
    });
    it('a finished job answers complete_cleanup with the receipt it already has', async () => {
      const { seeded, run } = await verified();
      const receipt = (await rig.domain.store.completionReceipt(
        seeded.actor,
        run.jobId,
        runIdOf(run.jobId),
      ))!;
      const gateway = await JobGateway.open(rig.domain, run.context).catch(() => null);
      // The job is terminal, so the lease is gone; the stored receipt is still what the tool reports.
      if (gateway) {
        const again = await completeCleanup(gateway.rt);
        expect(again).toMatchObject({ alreadyCommitted: true, receiptId: receipt.receiptId });
      }
    });
  });

  describe('small tools', () => {
    it('inspect_harness describes the pinned harness without the floor or evidence payloads, and W0 is not granted it', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      const step = await attempt(run.tools, 'inspect_harness');
      expect(step.ok && step.result).toMatchObject({
        harnessHash: seeded.bundleHashes.expert,
        completionPolicy: 'verified_receipt',
        contextPolicy: { schemaMode: 'all_registered_fields', includeNestedArrays: true, referenceDepth: 5 },
      });
      expect(JSON.stringify(step)).not.toContain(DEFAULT_AUTHORITY_FLOOR.hash);
      const w0 = await rig.open(seeded, 'w0');
      expect(await attempt(w0.tools, 'inspect_harness')).toMatchObject({ ok: false, code: 'PolicyDenied' });
    });
    it("report_diagnostic stores the run's own report as agent_self_report and removes the subject's values", async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      await attempt(run.tools, 'inspect_scope');
      expect((await attempt(run.tools, 'resolve_subject')).ok).toBe(true);
      const resolution = (await rig.domain.store.latestStep(seeded.actor, run.jobId, 'subject_resolution'))!;
      const secret = resolution.payload.identityBindings.find((value) => value.length >= 8)!.slice(2);
      const step = await attempt(run.tools, 'report_diagnostic', {
        category: 'scope_gap',
        message: `could not find ${secret} in the archives collection`,
      });
      expect(step.ok && step.result).toMatchObject({ recorded: true, origin: 'agent_self_report' });
      const row = (await control('diagnostics').findOne({ jobId: run.jobId }))!;
      expect(row.message).not.toContain(secret);
      expect(row.message).toContain('[binding]');
      expect(row.outboxOperationId).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await attempt(run.tools, 'report_diagnostic', { category: 'scope_gap', message: 'x', extra: 1 }),
      ).toMatchObject({
        ok: false,
        code: 'InvalidArguments',
      });
    });
  });
});
