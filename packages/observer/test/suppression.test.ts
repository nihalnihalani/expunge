import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IngestClient } from '@expunge/observability';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import { InMemoryEvidenceStore, OutboxDispatcher, RaindropQueryClient } from '../src/index.js';
import { Clock, GUARD, InMemoryOutbox, SCOPE } from './helpers.js';

/** FAKE Raindrop server and in-memory outbox: protocol evidence for the local export suppression gate only. */
const fake = new FakeRaindrop();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const USER = 'u_00000000000000000000000000000a01';
const OTHER = 'u_00000000000000000000000000000b02';

function rig(suppressed: (org: string) => Promise<ReadonlySet<string>>) {
  const clock = new Clock();
  const outbox = new InMemoryOutbox(clock);
  const dispatcher = new OutboxDispatcher(
    {
      outbox,
      ingest: new IngestClient({
        writeKey: fake.keys().writeKey,
        projectId: 'proj-1',
        baseUrl: fake.ingestUrl,
        timeoutMs: 2000,
      }),
      query: new RaindropQueryClient({
        queryKey: fake.keys().queryKey,
        projectId: 'proj-1',
        baseUrl: fake.queryUrl,
        maxAttempts: 1,
        sleep: async () => undefined,
      }),
      evidence: new InMemoryEvidenceStore(),
      transaction: (work) => work(undefined as never),
      scope: SCOPE,
      projectId: 'proj-1',
      guard: GUARD,
      suppression: { suppressedUserIds: suppressed },
      providerOrganizationId: 'org-1',
    },
    { ownerId: 'dispatcher-1', now: clock.now, random: () => 0.5, maxAttempts: 5, baseDelayMs: 1000 },
  );
  const add = (userId: string, eventId: string) =>
    outbox.add({
      operationId: `op-${eventId}`,
      kind: 'event',
      jobId: 'job-1',
      payload: {
        type: 'event',
        eventId,
        event: 'cleanup_summary',
        userId,
        origin: 'verifier_feedback',
        output: '{"status":"failed"}',
        properties: {},
      } as never,
      evidenceRequired: ['assistant_output'],
    });
  return { clock, outbox, dispatcher, add };
}

describe('local export suppression gate in the outbox dispatcher (FAKE Raindrop, in-memory outbox)', () => {
  it('holds an event for a suppressed user id: nothing is sent, nothing is attained, and the row is not dead-lettered', async () => {
    const { dispatcher, add, outbox } = rig(async () => new Set([USER]));
    add(USER, 'evt-1');
    const outcome = await dispatcher.runOnce();
    expect(outcome).toMatchObject({ result: 'blocked', detail: 'ExportSuppressed', attained: [] });
    expect(fake.ingestEvents).toHaveLength(0);
    expect(outbox.rows.get('op-evt-1')?.status).not.toBe('dead_letter');
  });

  it('sends an event for a user id that is not suppressed, in the same scope', async () => {
    const { dispatcher, add } = rig(async () => new Set([USER]));
    fake.seedEvent({ id: 'evt-2', assistant_output: '{"status":"failed"}' });
    add(OTHER, 'evt-2');
    const outcome = await dispatcher.runOnce();
    expect(outcome?.attained).toContain('ingest_accepted');
    expect(fake.ingestEvents.length).toBeGreaterThan(0);
  });

  it('after the suppression is released the held event is sent', async () => {
    let active = true;
    const { dispatcher, add, clock } = rig(async () => new Set(active ? [USER] : []));
    fake.seedEvent({ id: 'evt-3', assistant_output: '{"status":"failed"}' });
    add(USER, 'evt-3');
    expect((await dispatcher.runOnce())?.result).toBe('blocked');
    active = false;
    clock.advance(60 * 60_000);
    const outcome = await dispatcher.runOnce();
    expect(outcome?.attained).toContain('ingest_accepted');
  });

  it('asks for the suppression list of the dispatcher organization, not of its scope', async () => {
    const asked: string[] = [];
    const { dispatcher, add } = rig(async (org) => (asked.push(org), new Set<string>()));
    fake.seedEvent({ id: 'evt-5', assistant_output: '{"status":"failed"}' });
    add(USER, 'evt-5');
    await dispatcher.runOnce();
    expect(asked).toEqual(['org-1']);
  });

  it('a dispatcher cannot be built without a suppression source or an organization', () => {
    const deps = { guard: GUARD, scope: SCOPE, projectId: 'proj-1' } as never;
    expect(() => new OutboxDispatcher(deps, { ownerId: 'x' })).toThrow('SuppressionRequired');
  });

  it('fails closed when the suppression list cannot be read: the event is not sent', async () => {
    const { dispatcher, add } = rig(async () => {
      throw new Error('store down');
    });
    add(USER, 'evt-4');
    await expect(dispatcher.runOnce()).rejects.toThrow('store down');
    expect(fake.ingestEvents).toHaveLength(0);
  });
});
