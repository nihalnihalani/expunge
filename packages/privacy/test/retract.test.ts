import { createHash } from 'node:crypto';
import { validateProjectionPayload } from '@expunge/contracts';
import type { RevokeResult } from '@expunge/mongo';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OWNER_POLICY,
  RetractionRunner,
  afterClosure,
  afterDisposal,
  failClosed,
  initialState,
  progressPayload,
  registerRawSource,
  retractionIdOf,
  type ArtifactKind,
} from '../src/index.js';
import {
  FakeEligibility,
  FakeProvenance,
  FakeRawStore,
  FakePurger,
  FakeRegeneration,
  FakeRuns,
  POLICY,
  RecordingProjection,
  SCOPE,
  StaticCatalog,
} from './fakes.js';

const policy = DEFAULT_OWNER_POLICY(POLICY);
const closure = (over: Partial<RevokeResult> = {}): RevokeResult => ({
  closureId: 'c',
  ids: [],
  complete: false,
  frontier: ['x'],
  discovered: 1,
  rounds: 1,
  stalledReason: null,
  ...over,
});

describe('retraction state machine (pure transitions)', () => {
  it('stays in closing and fail-closed while the closure is incomplete, however many rounds ran', () => {
    let state = initialState(SCOPE, 'src-1', policy, 'source_retracted');
    expect(state.phase).toBe('closing');
    expect(failClosed(state)).toBe(true);
    state = afterClosure(
      state,
      closure({ frontier: ['a', 'b'], stalledReason: 'node_budget', discovered: 40 }),
      [],
    );
    expect(state).toMatchObject({
      phase: 'closing',
      closureComplete: false,
      frontierSize: 2,
      stalledReason: 'node_budget',
    });
    expect(failClosed(state)).toBe(true);
  });

  it('moves to disposing only when the closure is complete, and to complete only when disposal is exhausted', () => {
    let state = initialState(SCOPE, 'src-1', policy, 'source_retracted');
    state = afterClosure(state, closure({ complete: true, frontier: [], discovered: 7, rounds: 3 }), [
      'job-1',
      'job-1',
      'job-2',
    ]);
    expect(state).toMatchObject({ phase: 'disposing', closureComplete: true, discovered: 7 });
    expect(state.cancelledJobs).toEqual(['job-1', 'job-2']);
    expect(failClosed(state)).toBe(true);
    state = afterDisposal(state, {
      deleted: 2,
      regenerated: 1,
      keptRevoked: 1,
      needsOwner: ['h1'],
      cursor: 'z',
      exhausted: false,
    });
    expect(state.phase).toBe('disposing');
    state = afterDisposal(state, {
      deleted: 1,
      regenerated: 0,
      keptRevoked: 0,
      needsOwner: ['h1'],
      cursor: null,
      exhausted: true,
    });
    expect(state).toMatchObject({
      phase: 'complete',
      deleted: 3,
      regenerated: 1,
      keptRevoked: 1,
      needsOwner: ['h1'],
    });
    expect(failClosed(state)).toBe(false);
  });

  it('its progress payload satisfies the strict retraction_progress contract', () => {
    const state = afterClosure(
      initialState(SCOPE, 'src-1', policy, 'source_retracted'),
      closure({ complete: true, frontier: [], discovered: 5 }),
      ['job-9'],
    );
    const payload = progressPayload(state);
    expect(payload).toMatchObject({
      sourceId: 'src-1',
      closureComplete: true,
      revoked: 5,
      runsCancelled: 1,
      failClosed: true,
    });
    expect(() => validateProjectionPayload('retraction_progress', payload)).not.toThrow();
    expect(payload.retractionId).toBe(retractionIdOf(SCOPE, 'src-1'));
  });
});

function rig(kinds: Record<string, ArtifactKind>, nodesPerCall = 1000) {
  const eligibility = new FakeEligibility();
  const provenance = new FakeProvenance(eligibility, nodesPerCall);
  const raw = new FakeRawStore();
  const purger = new FakePurger();
  const regeneration = new FakeRegeneration();
  const projection = new RecordingProjection();
  const runner = new RetractionRunner({
    provenance,
    eligibility,
    catalog: new StaticCatalog(kinds),
    raw,
    purger,
    runs: new FakeRuns({ 'lesson-1': ['job-running'] }),
    regeneration,
    projection,
    policy,
    disposalBatch: 2,
    now: () => new Date('2026-06-02T00:00:00Z'),
  });
  return { eligibility, provenance, raw, purger, regeneration, projection, runner };
}

async function seed(r: ReturnType<typeof rig>) {
  await registerRawSource({ raw: r.raw, eligibility: r.eligibility, policyHash: POLICY }, SCOPE, {
    sourceId: 'src-1',
    kind: 'transcript',
    content: 'private transcript text',
    retention: 'raw',
  });
  for (const id of ['lesson-1', 'bundle-1', 'candidate-1', 'harness-1', 'mystery-1'])
    await r.eligibility.permit(SCOPE, id, POLICY, 'registered');
  for (const id of ['lesson-1', 'bundle-1', 'harness-1', 'mystery-1'])
    await r.provenance.append(SCOPE, 'src-1', id, 'derived_from');
  await r.provenance.append(SCOPE, 'lesson-1', 'candidate-1', 'derived_from');
}

const KINDS: Record<string, ArtifactKind> = {
  'lesson-1': 'lesson',
  'bundle-1': 'evidence_bundle',
  'candidate-1': 'candidate',
  'harness-1': 'harness',
};

describe('retraction protocol over ports', () => {
  it('closes the closure first, then disposes per owner policy, and is complete only at the end', async () => {
    const r = rig(KINDS);
    await seed(r);
    const state = await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const);
    expect(state).toMatchObject({
      phase: 'complete',
      closureComplete: true,
      deleted: 2,
      regenerated: 2,
      keptRevoked: 2,
    });
    // raw source and the evidence bundle are deleted; the lesson and candidate are queued for regeneration.
    expect(r.eligibility.rows.get('src-1')?.state).toBe('source_deleted');
    expect(r.eligibility.rows.get('bundle-1')?.state).toBe('source_deleted');
    expect(r.regeneration.requests.map((x) => [x.artifactHash, x.kind]).sort()).toEqual([
      ['candidate-1', 'candidate'],
      ['lesson-1', 'lesson'],
    ]);
    // A harness and an unclassifiable artifact stay revoked and are handed to their owner, never silently deleted.
    expect(state.needsOwner.sort()).toEqual(['harness-1', 'mystery-1']);
    expect(r.eligibility.rows.get('harness-1')?.state).toBe('revoked');
    expect(r.eligibility.rows.get('mystery-1')?.state).toBe('revoked');
    expect(state.cancelledJobs).toEqual(['job-running']);
    // source_deleted edges exist for what was deleted.
    expect(
      r.provenance.edges
        .filter((e) => e.kind === 'source_deleted')
        .map((e) => e.toId)
        .sort(),
    ).toEqual(['bundle-1', 'src-1']);
  });

  it('replaces the raw source with a tombstone that holds no content, hash or size', async () => {
    const r = rig(KINDS);
    await seed(r);
    await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const);
    expect(r.raw.rows.has('src-1')).toBe(false);
    const tombstone = r.raw.tombstones.get('src-1')!;
    expect(Object.keys(tombstone).sort()).toEqual([
      'closureId',
      'deletedAt',
      'kind',
      'policyHash',
      'reasonCode',
      'sourceId',
    ]);
    expect(JSON.stringify(tombstone)).not.toContain('private transcript');
    // The closure id is a hash of scope and source id (non-personal); the CONTENT hash and size are gone.
    const contentSha = createHash('sha256').update('private transcript text').digest('hex');
    expect(JSON.stringify(tombstone)).not.toContain(contentSha);
    expect(JSON.stringify(tombstone)).not.toContain('sizeBytes');
  });

  it('with a small step budget it reports fail-closed progress and resumes to completion', async () => {
    const r = rig(KINDS, 2);
    await seed(r);
    const first = await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const, {
      maxSteps: 1,
      bounds: { maxNodes: 2 },
    });
    expect(first.phase).toBe('closing');
    expect(failClosed(first)).toBe(true);
    expect(first.closureComplete).toBe(false);
    // While incomplete, nothing reached or beneath the source may be retrieved.
    expect(await r.provenance.permitted(SCOPE, ['src-1', 'lesson-1', 'bundle-1', 'candidate-1'])).toEqual([]);
    const resumed = await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const, {
      bounds: { maxNodes: 2 },
    });
    expect(resumed).toMatchObject({ phase: 'complete', closureComplete: true });
    expect(failClosed(resumed)).toBe(false);
  });

  it('reports every step as a retraction_progress event ending in a not-fail-closed completion', async () => {
    const r = rig(KINDS, 2);
    await seed(r);
    await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const, { bounds: { maxNodes: 2 } });
    const events = r.projection.events;
    expect(events.length).toBeGreaterThan(2);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    expect(events.every((e) => e.kind === 'retraction_progress')).toBe(true);
    for (const event of events)
      expect(() => validateProjectionPayload('retraction_progress', event.payload)).not.toThrow();
    expect(events.at(0)!.payload.failClosed).toBe(true);
    expect(events.at(-1)!.payload).toMatchObject({ closureComplete: true, failClosed: false });
  });

  it('is idempotent: a second run changes nothing and disposes nothing twice', async () => {
    const r = rig(KINDS);
    await seed(r);
    await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const);
    const edges = r.provenance.edges.length;
    const tombstone = JSON.stringify(r.raw.tombstones.get('src-1'));
    const again = await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const);
    expect(again.phase).toBe('complete');
    expect(again.deleted).toBe(0); // rows already source_deleted are skipped
    expect(r.provenance.edges.length).toBe(edges);
    expect(JSON.stringify(r.raw.tombstones.get('src-1'))).toBe(tombstone);
    expect(r.regeneration.requests).toHaveLength(2); // idempotent queue
  });
});

describe('P34-2 a leak reason always removes the bytes, whatever the owner disposition (FAKE stores)', () => {
  it('keep_revoked never keeps bytes for a subject-literal hit: harness and unknown kinds are purged and no longer kept', async () => {
    const r = rig(KINDS);
    await seed(r);
    const state = await r.runner.run(SCOPE, 'src-1', 'scan_SubjectLiteral' as const);
    expect(state.phase).toBe('complete');
    expect(state.keptRevoked).toBe(0);
    expect(state.needsOwner).toEqual([]);
    // Every affected artifact, the harness and the unknown one included, had its bytes removed for the scan reason.
    expect(r.purger.purged.map((p) => p.id).sort()).toEqual(
      ['bundle-1', 'candidate-1', 'harness-1', 'lesson-1', 'mystery-1', 'src-1'].sort(),
    );
    expect(r.purger.purged.every((p) => p.reason === 'scan_SubjectLiteral')).toBe(true);
    expect(r.eligibility.rows.get('harness-1')?.state).toBe('source_deleted');
  });

  it('a non-leak reason still lets the owner policy keep a revoked harness, and purges nothing', async () => {
    const r = rig(KINDS);
    await seed(r);
    const state = await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const);
    expect(state.keptRevoked).toBe(2);
    expect(r.purger.purged).toEqual([]);
  });
});

describe('P34-5 progress event ids never repeat across runs (FAKE stores)', () => {
  it('a resumed run uses new ids, and ids inside one run are unique', async () => {
    const r = rig(KINDS, 2);
    await seed(r);
    await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const, { maxSteps: 1 });
    const firstRun = r.projection.events.map((e) => e.eventId);
    await r.runner.run(SCOPE, 'src-1', 'source_retracted' as const);
    const ids = r.projection.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(firstRun.length).some((id) => firstRun.includes(id))).toBe(false);
  });
});
