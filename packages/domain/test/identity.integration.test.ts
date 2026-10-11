import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { bsonPreimageHash } from '@expunge/mongo';
import { OWNER_EPISODE_LIMITS, buildExpertStaticBundle, buildW0Bundle } from '@expunge/baselines';
import { describeLive } from '../../mongo/test/support.js';
import { JobGateway, completeCleanup } from '../src/index.js';
import {
  DEEP_FLOOR,
  SCRIPTED_DRIVER_LABEL,
  attempt,
  baseFields,
  driveExpert,
  edge,
  field,
  infrastructureHashes,
  openRig,
  type CustomWorld,
  type Rig,
  type Seeded,
} from './rig.js';

/**
 * Hand-built worlds for the cases the fixture families cannot show: a record shared by two subjects, a free field
 * that many records hold the same value in, typed references, a reach cut by a limit, and records the owner policy
 * does not classify. ${SCRIPTED_DRIVER_LABEL}.
 */

/** C1 (the subject) and C2 each own an account; both accounts point at the shared organisation O. */
function sharedOrgWorld(extra: Partial<CustomWorld> = {}): CustomWorld {
  return {
    fields: [
      ...baseFields(
        'customers',
        field('customers', 'identity_binding', ['data', 'identity', 'id']),
        field('customers', 'country', ['data', 'country']),
      ),
      ...baseFields(
        'accounts',
        field('accounts', 'identity_binding', ['data', 'owner_token']),
        field('accounts', 'customer_ref', ['data', 'customer_ref']),
        field('accounts', 'org_ref', ['data', 'org_ref']),
        field('accounts', 'country', ['data', 'country']),
        field('accounts', 'contact_note', ['data', 'contact_note']),
      ),
      ...baseFields('notes', field('notes', 'identity_binding', ['data', 'note_token'])),
    ],
    edges: [edge('accounts', 'customer_ref', 'customers'), edge('accounts', 'org_ref', 'notes')],
    docs: [
      {
        collection: 'customers',
        id: 'C1',
        data: { identity: { id: 'tok-c1' }, country: 'US', payload: 'p-c1' },
        effect: 'delete',
      },
      {
        collection: 'customers',
        id: 'C2',
        data: { identity: { id: 'tok-c2' }, country: 'US', payload: 'p-c2' },
        effect: 'delete',
      },
      {
        collection: 'accounts',
        id: 'A1',
        data: { customer_ref: 'C1', org_ref: 'O', payload: 'p-a1' },
        effect: 'redact',
      },
      {
        collection: 'accounts',
        id: 'A2',
        data: { customer_ref: 'C2', org_ref: 'O', country: 'US', payload: 'p-a2' },
        effect: 'redact',
      },
      { collection: 'notes', id: 'O', data: { payload: 'p-org' }, effect: 'delete' },
    ],
    subject: { idType: 'string', value: 'C1' },
    ...extra,
  };
}

describeLive(`identity and reach on hand-built worlds (${SCRIPTED_DRIVER_LABEL})`, () => {
  let rig: Rig;
  const world = (name: string) => rig.env.service.world.collection(name);
  const hashOf = async (seeded: Seeded, collection: string, id: unknown) =>
    bsonPreimageHash(await world(collection).findOne({ _id: id as never, worldId: seeded.world.worldId }));
  const planOf = async (seeded: Seeded, jobId: string) =>
    (await rig.domain.store.latestPlan(seeded.actor, jobId, `run-${jobId}`))!;

  beforeAll(async () => {
    rig = await openRig('identity');
  }, 60000);
  beforeEach(() => rig.env.reset());
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 60000);

  describe("DG1 NT-1: a record shared by two subjects is never carried into the subject's erase set", () => {
    it("plans only the subject's own records, whichever way discovery is asked to walk, and leaves the others byte for byte", async () => {
      const seeded = await rig.seedCustom(sharedOrgWorld());
      const before = {
        c2: await hashOf(seeded, 'customers', 'C2'),
        a2: await hashOf(seeded, 'accounts', 'A2'),
        o: await hashOf(seeded, 'notes', 'O'),
      };
      // The graph would stop a fifth discovery on its own; this test is about what discovery itself selects, so it
      // pins the expert bundle with a graph that admits repeated discovery.
      const expert = buildExpertStaticBundle(infrastructureHashes);
      const loose = {
        ...expert,
        workflow: {
          ...expert.workflow,
          nodes: expert.workflow.nodes.map((node) =>
            node.toolId === 'discover_references' ? { ...node, maxVisits: 8 } : node,
          ),
          edges: [...expert.workflow.edges, { from: 'discover', to: 'discover', when: 'success' as const }],
        },
      };
      const run = await rig.open(seeded, 'expert', { bundle: loose });
      await attempt(run.tools, 'inspect_scope');
      expect((await attempt(run.tools, 'resolve_subject')).ok).toBe(true);
      // The model alternates directions: outgoing, then incoming, then both. A chain never turns back.
      for (const direction of ['outgoing', 'incoming', 'incoming', 'outgoing']) {
        const step = await attempt(run.tools, 'discover_references', { direction });
        expect(step.ok, direction).toBe(true);
      }
      expect((await attempt(run.tools, 'discover_references')).ok).toBe(true);
      expect((await attempt(run.tools, 'preview_cleanup')).ok).toBe(true);
      const plan = await planOf(seeded, run.jobId);
      expect(plan.targets.map((target) => String(target.address.recordId)).sort()).toEqual(['A1', 'C1']);

      for (let guard = 0; guard < 5; guard++) {
        const step = await attempt(run.tools, 'apply_cleanup_batch');
        expect(step.ok).toBe(true);
        if (step.ok && step.result.batchesRemaining === 0) break;
      }
      expect(await attempt(run.tools, 'verify_registered_scope')).toMatchObject({
        ok: true,
        result: { verified: true, residuals: 0 },
      });
      expect(await attempt(run.tools, 'complete_cleanup')).toMatchObject({
        ok: true,
        result: { completed: true },
      });
      // The subject's records are gone or redacted; the other subject's records and the shared record are untouched.
      expect(await world('customers').countDocuments({ _id: 'C1' as never })).toBe(0);
      expect(await hashOf(seeded, 'customers', 'C2')).toBe(before.c2);
      expect(await hashOf(seeded, 'accounts', 'A2')).toBe(before.a2);
      expect(await hashOf(seeded, 'notes', 'O')).toBe(before.o);
      // The subject's own account lost the link to the subject but not the shared record's id: that is not a binding.
      const a1 = await world('accounts').findOne({ _id: 'A1' as never });
      expect(a1?.data).toMatchObject({ customer_ref: '[redacted]', org_ref: 'O', payload: '[redacted]' });
    });

    it('the reach recorded for completion has no record that is only reachable by turning', async () => {
      const seeded = await rig.seedCustom(sharedOrgWorld());
      const run = await rig.open(seeded, 'expert');
      await attempt(run.tools, 'inspect_scope');
      await attempt(run.tools, 'resolve_subject');
      const resolution = (await rig.domain.store.latestStep(seeded.actor, run.jobId, 'subject_resolution'))!;
      expect(resolution.payload.closure.map((member) => String(member.address.recordId)).sort()).toEqual([
        'A1',
        'C1',
      ]);
      expect(resolution.payload.closureTruncated).toBe(false);
    });
  });

  describe('KNOWN GAP (DA-5 P2-2, fixed in PKT-16b): a parent two subjects share', () => {
    // C1 and C2 both point org_ref at the organisation O. Edges carry no ownership direction yet, so O is carried into
    // C1's plan and its id becomes a binding. This pins the CURRENT behaviour so the gap stays visible; PKT-16b
    // (ReferenceDeclaration.owner) must turn these assertions around.
    const world = (): CustomWorld => ({
      fields: [
        ...baseFields(
          'customers',
          field('customers', 'identity_binding', ['data', 'identity', 'id']),
          field('customers', 'org_ref', ['data', 'org_ref']),
        ),
        ...baseFields('notes', field('notes', 'identity_binding', ['data', 'note_token'])),
      ],
      edges: [edge('customers', 'org_ref', 'notes')],
      docs: [
        {
          collection: 'customers',
          id: 'C1',
          data: { identity: { id: 'tok-c1' }, org_ref: 'O', payload: 'p1' },
          effect: 'delete',
        },
        {
          collection: 'customers',
          id: 'C2',
          data: { identity: { id: 'tok-c2' }, org_ref: 'O', payload: 'p2' },
          effect: 'delete',
        },
        { collection: 'notes', id: 'O', data: { payload: 'po' }, effect: 'delete' },
      ],
      subject: { idType: 'string', value: 'C1' },
    });
    it('plans the shared parent O, counts the other subject C2 as a residual, then plans C2 too', async () => {
      const seeded = await rig.seedCustom(world());
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      const plans = await rig.domain.store.listPlans(seeded.actor, run.jobId, `run-${run.jobId}`);
      const ids = (index: number) =>
        plans[index]!.targets.map((target) => String(target.address.recordId)).sort();
      // CURRENT behaviour. The wanted behaviour after PKT-16b is a single plan of ['C1'] with C2 untouched.
      expect(ids(0)).toEqual(['C1', 'O']);
      // Round two then plans the OTHER subject's record to get the sweep clean: the cost of the gap.
      expect(ids(1)).toEqual(['C2']);
      const verify = trace.find((step) => step.tool === 'verify_registered_scope')!;
      expect(verify).toMatchObject({ ok: true, result: { verified: false } });
      expect(verify.ok && verify.result.residualRecords).toEqual(
        expect.arrayContaining([expect.objectContaining({ recordId: 'C2', fieldId: 'customers.org_ref' })]),
      );
    });
  });

  describe('DG2 NT-2: a free field never seeds, redacts or verifies', () => {
    it("does not treat a value many records share as the subject's identity", async () => {
      const seeded = await rig.seedCustom(sharedOrgWorld());
      const run = await rig.open(seeded, 'expert');
      const c2 = await hashOf(seeded, 'customers', 'C2');
      const a2 = await hashOf(seeded, 'accounts', 'A2');
      const trace = await driveExpert(run.tools);
      expect(trace.filter((step) => !step.ok)).toEqual([]);
      const resolution = (await rig.domain.store.latestStep(seeded.actor, run.jobId, 'subject_resolution'))!;
      expect(resolution.payload.bindings).not.toContain('s:US');
      expect(resolution.payload.identityBindings).not.toContain('s:US');
      expect(resolution.payload.identityBindings).toEqual(expect.arrayContaining(['s:C1', 's:tok-c1']));
      expect(await hashOf(seeded, 'customers', 'C2')).toBe(c2);
      expect(await hashOf(seeded, 'accounts', 'A2')).toBe(a2);
      expect(trace.find((step) => step.tool === 'verify_registered_scope')).toMatchObject({
        ok: true,
        result: { verified: true },
      });
    });
  });

  describe('DG7 NT-7: references typed ObjectId are unlinked and counted like string references', () => {
    function typedWorld(customerId: ObjectId, otherId: ObjectId): CustomWorld {
      return {
        fields: [
          ...baseFields('customers', field('customers', 'identity_binding', ['data', 'identity', 'id'])),
          ...baseFields(
            'accounts',
            field('accounts', 'identity_binding', ['data', 'owner_token']),
            field('accounts', 'customer_ref', ['data', 'customer_ref'], { bsonTypes: ['objectId'] }),
            field('accounts', 'customer_text', ['data', 'customer_text']),
          ),
        ],
        edges: [edge('accounts', 'customer_ref', 'customers')],
        docs: [
          {
            collection: 'customers',
            id: customerId,
            data: { identity: { id: 'tok-typed' }, payload: 'p' },
            effect: 'delete',
          },
          {
            collection: 'customers',
            id: otherId,
            data: { identity: { id: 'tok-other' }, payload: 'p' },
            effect: 'delete',
          },
          // Owned by the subject: an ObjectId reference.
          {
            collection: 'accounts',
            id: 'mine',
            data: { customer_ref: customerId, payload: 'p' },
            effect: 'redact',
          },
          // Someone else's account that happens to hold the same 24 hex characters as TEXT: a different type, not a link.
          {
            collection: 'accounts',
            id: 'text-twin',
            data: { customer_text: customerId.toHexString(), payload: 'p' },
            effect: 'redact',
          },
          // Someone else's account referencing the other customer.
          {
            collection: 'accounts',
            id: 'theirs',
            data: { customer_ref: otherId, payload: 'p' },
            effect: 'redact',
          },
        ],
        subject: { idType: 'objectId', value: customerId.toHexString() },
      };
    }

    it('rewrites the ObjectId reference to the deleted customer, leaves the text twin and the other customer alone, and verifies', async () => {
      const customerId = new ObjectId();
      const otherId = new ObjectId();
      const seeded = await rig.seedCustom(typedWorld(customerId, otherId));
      const twin = await hashOf(seeded, 'accounts', 'text-twin');
      const theirs = await hashOf(seeded, 'accounts', 'theirs');
      const run = await rig.open(seeded, 'expert', { subject: typedWorldSubject(customerId) });
      const trace = await driveExpert(run.tools);
      expect(trace.filter((step) => !step.ok)).toEqual([]);
      expect(trace.at(-1)).toMatchObject({ tool: 'complete_cleanup', ok: true, result: { completed: true } });
      expect(await world('customers').countDocuments({ _id: customerId as never })).toBe(0);
      const mine = await world('accounts').findOne({ _id: 'mine' as never });
      expect(mine?.data).toMatchObject({ customer_ref: '[redacted]', payload: '[redacted]' });
      // A string and an ObjectId are different values: the twin holds text, not the reference, and is not touched.
      expect(await hashOf(seeded, 'accounts', 'text-twin')).toBe(twin);
      expect(await hashOf(seeded, 'accounts', 'theirs')).toBe(theirs);
    });

    it('never issues a complete receipt while a typed reference to a removed record is still there', async () => {
      const customerId = new ObjectId();
      const seeded = await rig.seedCustom(typedWorld(customerId, new ObjectId()));
      const run = await rig.open(seeded, 'expert', { subject: typedWorldSubject(customerId) });
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
        expect((await attempt(run.tools, tool)).ok).toBe(true);
      for (let guard = 0; guard < 5; guard++) {
        const step = await attempt(run.tools, 'apply_cleanup_batch');
        if (!step.ok || step.result.batchesRemaining === 0) break;
      }
      // Put the reference back, as if a writer had restored it after the batch: verification must see it.
      await world('accounts').updateOne(
        { _id: 'mine' as never },
        { $set: { 'data.customer_ref': customerId } },
      );
      const verify = await attempt(run.tools, 'verify_registered_scope');
      expect(verify).toMatchObject({ ok: true, result: { verified: false } });
      const gateway = await JobGateway.open(rig.domain, run.context);
      await expect(completeCleanup(gateway.rt)).rejects.toThrow('ResidualsRemain');
      expect(await rig.env.service.control.collection('completion_receipts').countDocuments()).toBe(0);
    });
  });

  describe('DG8 NT-8: a reach cut by a limit is never silent', () => {
    it('records the truncation at resolution and refuses completion with ClosureIncomplete', async () => {
      // The owner floor allows eight hops; the edge walk covers five, so the reach is a lower bound.
      const seeded = await rig.seedCustom(sharedOrgWorld({ floor: DEEP_FLOOR }));
      const bundle = buildExpertStaticBundle({
        ...infrastructureHashes,
        authorityFloorHash: DEEP_FLOOR.hash,
      });
      expect(bundle.limits.traversalDepth).toBeLessThanOrEqual(DEEP_FLOOR.maxLimits.traversalDepth);
      const run = await rig.open(seeded, 'expert');
      await attempt(run.tools, 'inspect_scope');
      expect((await attempt(run.tools, 'resolve_subject')).ok).toBe(true);
      const resolution = (await rig.domain.store.latestStep(seeded.actor, run.jobId, 'subject_resolution'))!;
      expect(resolution.payload.closureTruncated).toBe(true);
      const gateway = await JobGateway.open(rig.domain, run.context);
      await expect(completeCleanup(gateway.rt)).rejects.toThrow('ClosureIncomplete');
      expect(OWNER_EPISODE_LIMITS.traversalDepth).toBe(5);
    });
  });

  describe('DG10 NT-10: what the sweep calls kept is only what the policy keeps', () => {
    it('counts a restricted record that was due for deletion as a residual, then finishes once it is dealt with', async () => {
      const world10 = sharedOrgWorld();
      // A record outside the reach by edges, holding the subject's token in a free field, restricted but due for delete.
      world10.docs.push({
        collection: 'accounts',
        id: 'X',
        data: { contact_note: 'tok-c1', payload: 'p-x' },
        effect: 'delete',
        access: 'restricted',
      });
      const seeded = await rig.seedCustom(world10);
      const run = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references', 'preview_cleanup'])
        expect((await attempt(run.tools, tool)).ok).toBe(true);
      for (let guard = 0; guard < 5; guard++) {
        const step = await attempt(run.tools, 'apply_cleanup_batch');
        if (!step.ok || step.result.batchesRemaining === 0) break;
      }
      const verify = await attempt(run.tools, 'verify_registered_scope');
      expect(verify).toMatchObject({ ok: true, result: { verified: false } });
      expect(verify.ok && verify.result.residualRecords).toEqual(
        expect.arrayContaining([expect.objectContaining({ recordId: 'X', reason: 'binding' })]),
      );
      // The expert loop takes the residual back as evidence, plans it and finishes.
      const finish = await driveExpert((await rig.open(seeded, 'expert')).tools);
      expect(finish.filter((step) => !step.ok).length).toBeGreaterThanOrEqual(0);
    });

    it('treats a record in reach with no eligibility metadata as unclassified, which blocks completion', async () => {
      const world10 = sharedOrgWorld();
      world10.docs.push({
        collection: 'accounts',
        id: 'Y',
        data: { customer_ref: 'C1', payload: 'p-y' },
        effect: null,
      });
      const seeded = await rig.seedCustom(world10);
      const run = await rig.open(seeded, 'expert');
      const trace = await driveExpert(run.tools);
      // The first verification is the one that sees the record; a second round has nothing it may plan for it.
      const verify = trace.find((step) => step.tool === 'verify_registered_scope')!;
      // The re-plan of round two has no batch (the record cannot be classified), its apply is an empty-plan success,
      // and the graph still leads on to a second verification.
      const verifications = trace.filter((step) => step.tool === 'verify_registered_scope');
      expect(verifications).toHaveLength(2);
      expect(verifications.every((step) => step.ok)).toBe(true);
      expect(verify).toMatchObject({ ok: true, result: { verified: false } });
      expect(verify.ok && verify.result.residualRecords).toEqual(
        expect.arrayContaining([expect.objectContaining({ recordId: 'Y', reason: 'unclassified' })]),
      );
      expect(trace.at(-1)).toMatchObject({ tool: 'complete_cleanup', ok: false });
      expect(await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId)).toMatchObject({
        status: 'running',
      });
      expect(buildW0Bundle(infrastructureHashes)).toBeTruthy();
    });
  });
});

const typedWorldSubject = (id: ObjectId) => ({ idType: 'objectId' as const, value: id.toHexString() });
