import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import { WINDOW_COMPLETE, buildQueryIdentity, nextWindowIdentity } from '../src/index.js';
import { SCOPE, identity, makeRig, seedWorkerEvents } from './helpers.js';

const fake = new FakeRaindrop();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const REQUIRED = ['assistant_output', 'tool_calls', 'signals'];
const eventListRequests = () =>
  fake.requests.filter((r) => r.method === 'GET' && r.path === '/v1/events').length;

describe('observer paging under a fixed query identity', () => {
  it('commits every page with its cursor, stores each event once, and does not rescan a completed window', async () => {
    seedWorkerEvents(fake, 7);
    const { runner, cursors, evidence } = makeRig(fake);
    const query = identity();
    const result = await runner.runOnce(query, { requiredFields: REQUIRED, pageSize: 3 });
    expect(result).toMatchObject({
      status: 'complete',
      windowComplete: true,
      pagesCommitted: 3,
      observationsStored: 7,
      pending: [],
      held: [],
    });
    expect(result.ready).toHaveLength(7);
    expect(cursors.rows.get('proj-1\u0000v1')?.providerCursor).toBe(WINDOW_COMPLETE);
    expect(evidence.rows.size).toBe(7);
    const requestsBefore = eventListRequests();
    const again = await runner.runOnce(query, { requiredFields: REQUIRED, pageSize: 3 });
    expect(again).toMatchObject({ status: 'complete', windowComplete: true, observationsStored: 0 });
    expect(eventListRequests()).toBe(requestsBefore); // completed window: no list request at all
  });

  it('filters by the fixed identity only (other roles and other windows are not scanned)', async () => {
    seedWorkerEvents(fake, 3);
    fake.seedEvent({
      id: 'improver-1',
      timestamp: '2026-06-01T00:00:00.000Z',
      properties: { role: 'improver' },
    });
    fake.seedEvent({ id: 'too-old', timestamp: '2020-01-01T00:00:00.000Z', properties: { role: 'worker' } });
    const { runner, evidence } = makeRig(fake);
    await runner.runOnce(identity(), { requiredFields: [] });
    const ids = [...evidence.rows.values()].map((rows) => rows[0]!.externalEventId).sort();
    expect(ids).toEqual(['evt-000', 'evt-001', 'evt-002']);
  });

  it('crash BEFORE a page commit repeats only that page; nothing is lost or duplicated', async () => {
    seedWorkerEvents(fake, 6);
    const { runner, cursors, evidence } = makeRig(fake);
    const query = identity();
    let commits = 0;
    await expect(
      runner.runOnce(query, {
        requiredFields: REQUIRED,
        pageSize: 2,
        hooks: {
          beforeCommit: () => {
            if (++commits === 2) throw new Error('crash before commit of page 2');
          },
        },
      }),
    ).rejects.toThrow('crash before commit');
    expect(evidence.rows.size).toBe(2); // only page 1 committed
    const stored = cursors.rows.get('proj-1\u0000v1')!;
    expect(stored.revision).toBe(1);
    expect(stored.providerCursor).toBeTruthy();
    const before = eventListRequests();
    const result = await runner.runOnce(query, { requiredFields: REQUIRED, pageSize: 2 });
    expect(result).toMatchObject({ status: 'complete', windowComplete: true, observationsStored: 4 });
    expect(evidence.rows.size).toBe(6);
    expect([...evidence.rows.values()].every((rows) => rows.length === 1)).toBe(true); // no duplicate revisions
    expect(eventListRequests() - before).toBe(2); // resumed from the committed cursor: pages 2 and 3 only
  });

  it('crash AFTER a page commit resumes after it without refetching or double counting', async () => {
    seedWorkerEvents(fake, 4);
    const { runner, evidence } = makeRig(fake);
    const query = identity();
    let commits = 0;
    await expect(
      runner.runOnce(query, {
        requiredFields: REQUIRED,
        pageSize: 2,
        hooks: {
          afterCommit: () => {
            if (++commits === 1) throw new Error('crash after commit');
          },
        },
      }),
    ).rejects.toThrow('crash after commit');
    expect(evidence.rows.size).toBe(2);
    const result = await runner.runOnce(query, { requiredFields: REQUIRED, pageSize: 2 });
    expect(result.observationsStored).toBe(2);
    expect(evidence.rows.size).toBe(4);
  });

  it('refuses to resume a cursor under a changed filter identity', async () => {
    seedWorkerEvents(fake, 2);
    const { runner } = makeRig(fake);
    await runner.runOnce(identity(), { requiredFields: [] });
    const changed = buildQueryIdentity({
      projectId: 'proj-1',
      observerVersion: 'v1',
      filter: { eventName: 'expunge.worker', properties: { role: 'improver' } },
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2099-01-01T00:00:00.000Z',
      overlapMs: 60_000,
    });
    await expect(runner.runOnce(changed, { requiredFields: [] })).rejects.toThrow(
      'ObserverQueryIdentityChanged',
    );
  });

  it('a new window gets a new identity that starts one overlap before the previous end', () => {
    const first = identity({ windowEnd: '2026-06-01T01:00:00.000Z' });
    const next = nextWindowIdentity(first, 'v1', new Date('2026-06-01T02:00:00.000Z'));
    expect(next.windowStart).toBe('2026-06-01T00:59:00.000Z');
    expect(next.windowEnd).toBe('2026-06-01T02:00:00.000Z');
    expect(next.observerVersion).toBe('v1@2026-06-01T00:59:00.000Z');
    expect(next.filterHash).toBe(first.filterHash);
  });
});

describe('late enrichment', () => {
  it('keeps an event pending until its signals and tool calls arrive, then stores a NEW revision and drains pending', async () => {
    seedWorkerEvents(fake, 1, false); // no tool_calls / signals yet
    fake.enrichLater('evt-000', 3, (event) => {
      event.tool_calls = [{ name: 'inspect_scope' }];
      event.signals = [{ id: 'sig-1', name: 'cleanup_verified', score: null }];
    });
    const { runner, cursors, evidence } = makeRig(fake);
    const query = identity();
    const first = await runner.runOnce(query, { requiredFields: REQUIRED });
    expect(first).toMatchObject({ windowComplete: true, ready: [], pending: ['evt-000'] });
    expect(cursors.rows.get('proj-1\u0000v1')!.pendingEnrichmentIds).toEqual(['evt-000']);
    // The window is complete, yet the known event is still reread by ID until enrichment lands.
    let last = first;
    for (let i = 0; i < 6 && last.pending.length; i++)
      last = await runner.runOnce(query, { requiredFields: REQUIRED });
    expect(last).toMatchObject({ ready: ['evt-000'], pending: [] });
    const revisions = [...evidence.rows.values()][0]!;
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions[0]!.presentFields).not.toContain('signals');
    expect(revisions.at(-1)!.presentFields).toEqual(expect.arrayContaining(['signals', 'tool_calls']));
    expect(revisions.at(-1)!.revision).toBe(revisions.length);
    expect(cursors.rows.get('proj-1\u0000v1')!.pendingEnrichmentIds).toEqual([]);
  });

  it('reports an event HELD (not ready) when enrichment is still missing after the hold period', async () => {
    seedWorkerEvents(fake, 1, false);
    let clock = new Date('2026-06-02T00:00:00Z').getTime();
    const { runner } = makeRig(fake);
    const query = identity();
    const options = { requiredFields: REQUIRED, holdAfterMs: 60_000, now: () => new Date(clock) };
    expect((await runner.runOnce(query, options)).held).toEqual([]);
    clock += 120_000;
    const later = await runner.runOnce(query, options);
    expect(later).toMatchObject({ ready: [], pending: ['evt-000'], held: ['evt-000'] });
  });

  it('a missing signal on a visible event is never treated as proof of no failure', async () => {
    seedWorkerEvents(fake, 1, false);
    const { runner } = makeRig(fake);
    const result = await runner.runOnce(identity(), { requiredFields: ['signals'] });
    expect(result.ready).toEqual([]);
    expect(result.pending).toEqual(['evt-000']);
  });
});

describe('trace evidence and provider faults', () => {
  it('reads traces per event when asked and keeps the truncation flag in the stored observation', async () => {
    seedWorkerEvents(fake, 2);
    fake.traces.set(
      'evt-000',
      Array.from({ length: 1000 }, (_, i) => ({ span_id: `s${i}`, span_name: 'x', span_type: 'INTERNAL' })),
    );
    fake.traces.set('evt-001', [
      {
        span_id: 'a',
        span_name: 'chat',
        span_type: 'LLM_GENERATION',
        model: 'gpt-5',
        provider: 'openai',
        input_tokens: 5,
        output_tokens: 2,
      },
    ]);
    const { runner, evidence } = makeRig(fake);
    await runner.runOnce(identity(), { requiredFields: ['spans'], fetchTraces: true });
    const rows = new Map([...evidence.rows.values()].map((r) => [r[0]!.externalEventId, r[0]!]));
    expect(rows.get('evt-000')!.potentiallyTruncated).toBe(true);
    expect(rows.get('evt-001')!.potentiallyTruncated).toBe(false);
    expect(rows.get('evt-001')!.spans[0]).toMatchObject({
      type: 'LLM_GENERATION',
      model: 'gpt-5',
      provider: 'openai',
      inputTokens: 5,
    });
  });

  it('a 401 blocks the scan WITHOUT touching the stored cursor; a later run resumes', async () => {
    seedWorkerEvents(fake, 4);
    const { runner, cursors } = makeRig(fake);
    const query = identity();
    await runner.runOnce(query, { requiredFields: [], pageSize: 2, maxPages: 1 });
    const revisionBefore = cursors.rows.get('proj-1\u0000v1')!.revision;
    fake.failNext(/GET \/v1\/events$/, [401]);
    const blocked = await runner.runOnce(query, { requiredFields: [], pageSize: 2 });
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'auth' });
    expect(cursors.rows.get('proj-1\u0000v1')!.revision).toBe(revisionBefore);
    const resumed = await runner.runOnce(query, { requiredFields: [], pageSize: 2 });
    expect(resumed).toMatchObject({ status: 'complete', windowComplete: true });
  });

  it('persistent provider errors end the run as error (not complete) and keep the cursor', async () => {
    seedWorkerEvents(fake, 2);
    const { runner, cursors } = makeRig(fake, { maxAttempts: 2 });
    fake.failNext(/GET \/v1\/events$/, [500, 500]);
    const result = await runner.runOnce(identity(), { requiredFields: [] });
    expect(result).toMatchObject({ status: 'error', reason: 'server', windowComplete: false });
    expect(cursors.rows.get('proj-1\u0000v1')!.providerCursor).toBeNull();
  });

  it('a scope other than the runner scope never sees its rows (evidence keyed by scope)', async () => {
    seedWorkerEvents(fake, 1);
    const { runner, evidence } = makeRig(fake);
    await runner.runOnce(identity(), { requiredFields: [] });
    expect(await evidence.latest('proj-1', 'evt-000', SCOPE)).not.toBeNull();
    expect(await evidence.latest('proj-1', 'evt-000', { ...SCOPE, scopeId: 'other' })).toBeNull();
  });
});
