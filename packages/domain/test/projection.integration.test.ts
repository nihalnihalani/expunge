/**
 * The read projection (snapshot, event pages, job list) in front of a real replica set. Jobs are run through the REAL
 * gateway tools by the labeled SCRIPTED DRIVER (no model), so every event, receipt and job row is committed state. The
 * responses are parsed with the operator's own strict schemas (apps/operator/src/server/expunge/schemas.ts), which is the
 * contract the operator enforces on this service.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProjectionRepository } from '@expunge/mongo';
import { describeLive } from '../../mongo/test/support.js';
import {
  snapshotSchema,
  jobListSchema,
  parseEventsPage,
} from '../../../apps/operator/src/server/expunge/schemas.js';
import type { ServiceConfig } from '../src/service/config.js';
import { ServiceRefusal } from '../src/service/errors.js';
import { serveProjection } from '../src/service/projection.js';
import { driveExpert, openRig, type Rig, type Seeded } from './rig.js';

describeLive('read projection from committed state (local protocol lane, SCRIPTED DRIVER)', () => {
  let rig: Rig;
  let finished: Seeded;
  let finishedJobId: string;
  let idle: Seeded;
  let idleJobId: string;
  let config: ServiceConfig;
  const base = 'http://domain.test/internal/projection';
  const get = async (scope: ServiceConfig, key: 'GET jobs' | 'GET events', path: string, id?: string) =>
    (await serveProjection(rig.domain, scope, { key, ...(id ? { id } : {}) }, new URL(`${base}${path}`)))
      .body as Record<string, any>;

  beforeAll(async () => {
    rig = await openRig('projection');
    finished = await rig.seed('direct_nested', 'projection-finished');
    const run = await rig.open(finished, 'expert');
    finishedJobId = run.jobId;
    const trace = await driveExpert(run.tools);
    expect(trace.at(-1)).toMatchObject({ tool: 'complete_cleanup', ok: true });
    idle = await rig.seed('direct_nested', 'projection-idle');
    idleJobId = (await rig.open(idle, 'expert')).jobId; // claimed, no tool called yet
    config = {
      owner: { ownerId: 'owner', scope: finished.binding },
      tokens: { read: 'r'.repeat(32) },
      previewTtlMs: 60_000,
    };
  }, 120_000);
  afterAll(async () => {
    if (rig) await rig.dispose();
  }, 30_000);

  it('the snapshot of a finished job is committed state in the shape the operator parses, with its epoch and receipt reference', async () => {
    const body = await get(config, 'GET jobs', `/jobs/${finishedJobId}`, finishedJobId);
    const snapshot = snapshotSchema.parse(body); // the operator's strict contract
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      jobId: finishedJobId,
      kind: 'cleanup',
      status: 'succeeded',
      phase: null,
    });
    const epoch = await rig.domain.projections.epochOf(finished.binding, finishedJobId);
    expect(snapshot.streamEpoch).toBe(epoch);
    const events = await rig.domain.projections.read(finished.binding, 0, finishedJobId, 1000);
    expect(snapshot.sequence).toBe(events.at(-1)!.sequence);
    const ref = await rig.domain.projections.receiptReference(finished.binding, finishedJobId);
    expect(ref).not.toBeNull();
    expect(snapshot.receipt).toEqual({ receiptId: ref!.receiptId, sequence: ref!.receiptSequence });
    expect(Object.values(snapshot.phaseStates).every((state) => state === 'committed')).toBe(true);
    expect(snapshot.coverage.registeredCollectionIds).toEqual(finished.world.scope.collectionIds);
    expect(snapshot.coverage.inspectedCollectionIds.length).toBeGreaterThan(0); // from the committed completion receipt
    expect(snapshot.limits.toolCalls.used).toBeGreaterThan(0);
    expect(snapshot.limits.toolCalls.cap).toBeGreaterThan(0); // the cap comes from the pinned bundle's limits
    expect(snapshot.limits.changedDocuments.used).toBeGreaterThan(0);
    expect(snapshot.cancellation).toEqual({ requested: false, requestedAt: null });
  });

  it('the snapshot of a job with no events yet has no epoch, no receipt and pending phases (nothing is invented)', async () => {
    const snapshot = snapshotSchema.parse(
      await get(config2(idle), 'GET jobs', `/jobs/${idleJobId}`, idleJobId),
    );
    expect(snapshot.streamEpoch).toBeUndefined();
    expect(snapshot).toMatchObject({ status: 'running', sequence: 0, receipt: null, phase: null });
    expect(Object.values(snapshot.phaseStates).every((state) => state === 'pending')).toBe(true);
  });

  function config2(seeded: Seeded): ServiceConfig {
    return { ...config, owner: { ownerId: 'owner', scope: seeded.binding } };
  }

  it('event pages are ordered, bounded, from one epoch, and chain with nextSequence until an empty tail', async () => {
    const all = parseEventsPage(
      await get(config, 'GET events', `/jobs/${finishedJobId}/events?afterSequence=0`, finishedJobId),
      finishedJobId,
      0,
    );
    expect(all.events.length).toBeGreaterThan(5);
    expect(all.streamEpoch).toBeDefined();
    const sequences = all.events.map((e) => e.sequence);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1)); // contiguous from 1
    // Pages of 3 reproduce the same list and name the same epoch every time.
    const chained: number[] = [];
    let after = 0;
    for (let guard = 0; guard < 100; guard++) {
      const page = parseEventsPage(
        await get(
          config,
          'GET events',
          `/jobs/${finishedJobId}/events?afterSequence=${after}&limit=3`,
          finishedJobId,
        ),
        finishedJobId,
        after,
      );
      expect(page.events.length).toBeLessThanOrEqual(3);
      expect(page.streamEpoch).toBe(all.streamEpoch);
      if (page.events.length === 0) {
        expect(page.nextSequence).toBe(after); // an empty tail keeps the cursor
        break;
      }
      chained.push(...page.events.map((e) => e.sequence));
      after = page.nextSequence;
    }
    expect(chained).toEqual(sequences);
  });

  it('a reset changes the epoch every page and snapshot serves, an append does not', async () => {
    const reseeded = await rig.seed('direct_nested', 'projection-reset');
    const run = await rig.open(reseeded, 'expert');
    await driveExpert(run.tools);
    const cfg = config2(reseeded);
    const before = await get(cfg, 'GET events', `/jobs/${run.jobId}/events?afterSequence=0`, run.jobId);
    const snapshotBefore = await get(cfg, 'GET jobs', `/jobs/${run.jobId}`, run.jobId);
    expect(snapshotBefore.streamEpoch).toBe(before.streamEpoch);
    await rig.domain.projections.append(reseeded.binding, {
      eventId: `${run.jobId}:extra`,
      jobId: run.jobId,
      runId: run.job.binding.runId,
      artifactIds: [],
      kind: 'cancel_requested',
      payload: { requestedAt: new Date().toISOString(), by: 'owner' },
    });
    expect(
      (await get(cfg, 'GET events', `/jobs/${run.jobId}/events?afterSequence=0`, run.jobId)).streamEpoch,
    ).toBe(before.streamEpoch); // append keeps it
    await new ProjectionRepository(rig.env.service).resetStream(reseeded.binding, run.jobId, 'restore'); // setup administrator
    const after = await get(
      cfg,
      'GET events',
      `/jobs/${run.jobId}/events?afterSequence=${before.nextSequence}`,
      run.jobId,
    );
    expect(after.events).toEqual([]);
    expect(after.streamEpoch).not.toBe(before.streamEpoch);
    expect((await get(cfg, 'GET jobs', `/jobs/${run.jobId}`, run.jobId)).streamEpoch).toBe(after.streamEpoch);
  });

  it('the list carries receipt fields only for a job with a committed receipt, pages with a cursor, and filters', async () => {
    const both = await listBoth();
    const finishedItem = both.find((item) => item.jobId === finishedJobId)!;
    expect(finishedItem).toMatchObject({
      status: 'succeeded',
      worldId: finished.world.worldId,
      receiptDomainStatus: 'complete_in_registered_scope',
    });
    expect(finishedItem.receiptId).toBeDefined();
    expect(finishedItem.receiptSequence).toBeGreaterThan(0);
    expect(finishedItem.verifiedWorldRevision).toBeGreaterThanOrEqual(0);
    // The scope of this service holds only its own jobs; check a second scope's list for the no-receipt shape.
    const idleList = jobListSchema.parse(await get(config2(idle), 'GET jobs', '/jobs'));
    const idleItem = idleList.items.find((item) => item.jobId === idleJobId)!;
    expect(idleItem).toMatchObject({ status: 'running', sequence: 0 });
    // Scope isolation: each service lists only its own scope's jobs.
    expect(idleList.items.map((i) => i.jobId)).not.toContain(finishedJobId);
    expect(both.map((i) => i.jobId)).not.toContain(idleJobId);
    for (const field of ['receiptId', 'receiptSequence', 'verifiedWorldRevision', 'receiptDomainStatus'])
      expect(idleItem).not.toHaveProperty(field);
    expect(jobListSchema.parse(await get(config, 'GET jobs', '/jobs?status=queued')).items).toEqual([]);
    expect(
      jobListSchema
        .parse(await get(config, 'GET jobs', '/jobs?kind=cleanup&status=succeeded'))
        .items.map((i) => i.jobId),
    ).toContain(finishedJobId);
  });

  async function listBoth() {
    const list = jobListSchema.parse(await get(config, 'GET jobs', '/jobs?limit=200'));
    return list.items;
  }

  it('list pages are bounded and the cursor walks every job exactly once', async () => {
    // Two more jobs in the same scope as `finished` so there is something to page.
    const extra = await rig.open(finished, 'expert', { jobId: 'job-expert-extra-a' });
    const extra2 = await rig.open(finished, 'expert', { jobId: 'job-expert-extra-b' });
    void extra;
    void extra2;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = jobListSchema.parse(
        await get(config, 'GET jobs', `/jobs?limit=1${cursor ? `&cursor=${cursor}` : ''}`),
      );
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((i) => i.jobId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no job twice
    expect(seen).toEqual(expect.arrayContaining([finishedJobId, 'job-expert-extra-a', 'job-expert-extra-b']));
  });

  it("refuses what it should: another scope's job is 404, unknown query parameters, bad cursors and bad numbers are 400, a limit is clamped", async () => {
    await expect(get(config, 'GET jobs', `/jobs/${idleJobId}`, idleJobId)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await expect(
      get(config, 'GET events', `/jobs/${idleJobId}/events?afterSequence=0`, idleJobId),
    ).rejects.toMatchObject({ status: 404 });
    for (const [key, path, id] of [
      ['GET jobs', '/jobs?tenantId=other', undefined],
      ['GET jobs', '/jobs?scopeId=other', undefined],
      ['GET jobs', '/jobs?cursor=%00', undefined],
      ['GET jobs', '/jobs?cursor=not!valid', undefined],
      ['GET jobs', '/jobs?kind=promote_everything', undefined],
      ['GET jobs', '/jobs?status=exploded', undefined],
      ['GET jobs', '/jobs?limit=-1', undefined],
      ['GET events', `/jobs/${finishedJobId}/events?afterSequence=-1`, finishedJobId],
      ['GET events', `/jobs/${finishedJobId}/events?afterSequence=abc`, finishedJobId],
      ['GET events', `/jobs/${finishedJobId}/events?actor=x`, finishedJobId],
      ['GET jobs', `/jobs/${finishedJobId}?x=1`, finishedJobId],
    ] as const)
      await expect(get(config, key, path, id), path).rejects.toBeInstanceOf(ServiceRefusal);
    const clamped = await get(
      config,
      'GET events',
      `/jobs/${finishedJobId}/events?afterSequence=0&limit=100000`,
      finishedJobId,
    );
    expect(clamped.events.length).toBeLessThanOrEqual(500);
    expect((await get(config, 'GET jobs', '/jobs?limit=100000')).items.length).toBeLessThanOrEqual(200);
  });
});
