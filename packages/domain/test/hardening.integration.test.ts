import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRINCIPALS } from '@expunge/mongo';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { describeLive } from '../../mongo/test/support.js';
import { DomainStore, GATEWAY_PRINCIPALS, createDomainEnv } from '../src/index.js';
import { sanitizeDiagnostic } from '../src/tools/report-diagnostic.js';
import { keyText } from '../src/values.js';
import { SCRIPTED_DRIVER_LABEL, attempt, openRig, toolsFor, type Rig } from './rig.js';

describe('sanitizeDiagnostic (DA-5 DG12)', () => {
  it('removes identity values and e-mail local parts whatever the case or the Unicode spelling', () => {
    const secrets = ['a.b@x.test', 'Zoë-Quill-7731'];
    for (const message of [
      'could not find A.B@X.TEST in notes',
      'the local part a.b was searched',
      'the LOCAL PART A.B was searched',
      'looked for zoë-quill-7731 and ZOË-QUILL-7731',
      // Decomposed (e + combining diaeresis) and fullwidth spellings fold to the same text.
      'looked for Zoë-Quill-7731',
      'looked for ａ．ｂ＠ｘ．ｔｅｓｔ',
    ]) {
      const cleaned = sanitizeDiagnostic(message, secrets);
      expect(cleaned.toLowerCase()).not.toMatch(/a\.b|zo[eë]̈?-quill/);
      expect(cleaned).toContain('[binding]');
    }
  });

  it('strips control characters, keeps ordinary text and bounds the length', () => {
    expect(sanitizeDiagnostic('line one\nline\ttwo\u0000end', [])).toBe('line one line two end');
    expect(sanitizeDiagnostic('x'.repeat(900), [])).toHaveLength(500);
    // A needle shorter than three characters would redact ordinary words, so it is not used.
    expect(sanitizeDiagnostic('an ox is here', ['ox', 'an'])).toBe('an ox is here');
  });
});

describeLive(`domain gateway hardening on a real replica set (${SCRIPTED_DRIVER_LABEL})`, () => {
  let rig: Rig;
  const control = (name: string) => rig.env.service.control.collection(name);

  beforeAll(async () => {
    rig = await openRig('dhard');
  }, 60000);
  beforeEach(() => rig.env.reset());
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 60000);

  describe('only the gateway principals can build the gateway (requirePrincipal)', () => {
    it('refuses every other principal at construction, for the environment and for the step log', async () => {
      expect([...GATEWAY_PRINCIPALS].sort()).toEqual(['domain_executor', 'setup']);
      for (const principal of PRINCIPALS) {
        const service = await rig.env.as(principal);
        const build = () => createDomainEnv(service, { floors: [DEFAULT_AUTHORITY_FLOOR] });
        const store = () => new DomainStore(service);
        if ((GATEWAY_PRINCIPALS as readonly string[]).includes(principal)) {
          expect(build, principal).not.toThrow();
          expect(store, principal).not.toThrow();
        } else {
          expect(build, principal).toThrow('PrincipalBoundary');
          expect(store, principal).toThrow('PrincipalBoundary');
        }
      }
    });
  });

  describe('DG5: control writes are fenced on the live lease', () => {
    it('a session that lost the lease cannot add a plan, and the new holder applies only a plan it made itself', async () => {
      const seeded = await rig.seed('direct_nested');
      const a = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject', 'discover_references'])
        expect((await attempt(a.tools, tool)).ok, tool).toBe(true);

      // Session A is taken over: its lease ends and worker-2 claims the job at the next fence.
      await rig.domain.jobs.release(seeded.actor, a.context.lease);
      const claimed = (await rig.domain.jobs.claim(seeded.actor, a.jobId, 'worker-2', 120_000))!;
      expect(claimed.lease.fence).toBe(a.context.lease.fence + 1);
      const contextB = {
        ...a.context,
        job: claimed,
        lease: { jobId: a.jobId, ownerId: 'worker-2', fence: claimed.lease.fence },
      };

      // A still believes it holds the job. Its write is refused by the fence; nothing reaches the plan or step logs.
      const stepsBefore = await control('domain_steps').countDocuments({ jobId: a.jobId });
      expect(await attempt(a.tools, 'preview_cleanup')).toEqual({
        tool: 'preview_cleanup',
        ok: false,
        code: 'LostLease',
      });
      expect(await control('preview_plans').countDocuments({ jobId: a.jobId })).toBe(0);
      expect(await attempt(a.tools, 'discover_references')).toMatchObject({ ok: false, code: 'LostLease' });
      expect(await control('domain_steps').countDocuments({ jobId: a.jobId })).toBe(stepsBefore);
      expect(
        await attempt(a.tools, 'report_diagnostic', { category: 'other', message: 'still here' }),
      ).toMatchObject({
        ok: false,
        code: 'LostLease',
      });
      expect(await control('diagnostics').countDocuments({ jobId: a.jobId })).toBe(0);

      // B has no plan of A's to consume: apply is refused, then B makes its own plan and applies that one.
      const b = await toolsFor(rig.domain, contextB);
      expect(await attempt(b, 'apply_cleanup_batch')).toMatchObject({ ok: false, code: 'PolicyDenied' });
      expect(await control('effects').countDocuments({ jobId: a.jobId })).toBe(0);
      expect((await attempt(b, 'preview_cleanup')).ok).toBe(true);
      expect(await attempt(b, 'apply_cleanup_batch')).toMatchObject({ ok: true });
      const plans = await control('preview_plans').find({ jobId: a.jobId }).toArray();
      expect(plans).toHaveLength(1);
      expect(await control('effects').countDocuments({ jobId: a.jobId })).toBe(1);

      // A's late apply cannot commit either: the effect transaction fences on the lease too.
      expect(await attempt(a.tools, 'apply_cleanup_batch')).toMatchObject({ ok: false });
      expect(await control('effects').countDocuments({ jobId: a.jobId })).toBe(1);
    });
  });

  describe('DG11: a deleted authority row stops the run like a revoked one', () => {
    it('refuses with AuthorityRevoked and cancels the job', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      expect((await attempt(run.tools, 'inspect_scope')).ok).toBe(true);
      const removed = await control('authority_revisions').deleteOne({
        tenantId: seeded.binding.tenantId,
        env: seeded.binding.env,
        scopeId: seeded.binding.scopeId,
      });
      expect(removed.deletedCount).toBe(1);
      expect(await attempt(run.tools, 'inspect_scope')).toEqual({
        tool: 'inspect_scope',
        ok: false,
        code: 'AuthorityRevoked',
      });
      const stored = await rig.domain.jobs.readAuthorized(seeded.actor, run.jobId);
      expect(stored.cancellationRequested).toBe(true);
      expect(['cancelled', 'running']).toContain(stored.status);
    });
  });

  describe('DG12: the stored diagnostic never carries the subject, whatever its spelling', () => {
    it('removes an upper-cased identity value and its local part from the stored report', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'expert');
      for (const tool of ['inspect_scope', 'resolve_subject'])
        expect(await attempt(run.tools, tool)).toMatchObject({ ok: true });
      const resolution = (await rig.domain.store.latestStep(seeded.actor, run.jobId, 'subject_resolution'))!;
      const values = resolution.payload.identityBindings.map(keyText).filter((value) => value.length >= 4);
      expect(values.length).toBeGreaterThan(0);
      const message = values
        .map((value) => `seen ${value.toUpperCase()} and ${value.toLowerCase()}`)
        .join('; ');
      const step = await attempt(run.tools, 'report_diagnostic', { category: 'scope_gap', message });
      expect(step.ok).toBe(true);
      const row = (await control('diagnostics').findOne({ jobId: run.jobId }))!;
      for (const value of values)
        expect((row.message as string).toLowerCase()).not.toContain(value.toLowerCase());
    });
  });

  describe('DG13: a run learns nothing about the structure its context policy hides', () => {
    it('W0 (selected_fields) sees no registered total and no hidden count; nothing names a hidden field', async () => {
      const seeded = await rig.seed('direct_nested');
      const run = await rig.open(seeded, 'w0');
      const inspected = await attempt(run.tools, 'inspect_scope');
      expect(inspected.ok).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (inspected as { result: Record<string, any> }).result;
      expect(result.hiddenFieldCount).toBeUndefined();
      for (const collection of result.collections) {
        expect(collection.registeredFields).toBeUndefined();
        expect(collection.visibleFieldCount).toBe(collection.visibleFieldIds.length);
      }
      const visibleIds = new Set(result.fields.map((entry: { fieldId: string }) => entry.fieldId));
      expect(visibleIds.size).toBeLessThan(seeded.world.scope.fields.length);
      const text = JSON.stringify(result);
      for (const hidden of seeded.world.scope.fields)
        if (!visibleIds.has(hidden.fieldId)) expect(text).not.toContain(hidden.fieldId);
    });
  });
});
