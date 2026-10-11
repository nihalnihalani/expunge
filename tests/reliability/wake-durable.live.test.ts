/**
 * commandId replay across a worker restart, against the product's durable store on a real local replica set.
 *
 * Server = the product's createWakeServer. Durable store = the product's MongoWakeCommandStore over the product's
 * WakeCommandRepository, connected as the domain_executor principal. "Restart" means: close the first server and its
 * store, build a second server with a fresh store instance over the same database. FakeWakeTarget stands in for the
 * dispatcher queue. Local replica-set evidence only (MONGODB_TEST_URI); not Atlas.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest';
import { WakeCommandRepository, type MongoService } from '@expunge/mongo';
import { openEnvironment, type LiveEnvironment } from '../../packages/mongo/test/support.js';
import { MongoWakeCommandStore } from '../../apps/worker/src/wiring.js';
import {
  InMemoryWakeCommandStore,
  createWakeServer,
  type WakeCommand,
  type WakeCommandStore,
  type WakeTarget,
} from '../../apps/worker/src/wake.js';
import type { Readiness } from '../../apps/worker/src/readiness.js';
import { closeServer, liveGate, listen, postJson } from './support.js';

const URI = process.env.MONGODB_TEST_URI;
const describeLive = liveGate(Boolean(URI), 'MONGODB_TEST_URI', 'no local replica set configured');
const TOKEN = randomBytes(24).toString('hex');
const auth = { Authorization: `Bearer ${TOKEN}` };

const ready: Readiness = {
  status: 'READY',
  blockers: [],
  lines: ['READY: FAKE readiness'],
  checks: {
    provider: 'configured',
    scope: 'configured',
    database: 'configured',
    wakeToken: 'configured',
    domainTools: 'configured',
  },
  reachability: 'not_checked',
};

/** FAKE dispatcher queue. */
class FakeWakeTarget {
  readonly woken: WakeCommand[] = [];
  constructor(private accepting = true) {}
  setAccepting(value: boolean) {
    this.accepting = value;
  }
  canAccept() {
    return this.accepting;
  }
  wake(command: WakeCommand) {
    if (!this.accepting) return false;
    this.woken.push(command);
    return true;
  }
}

describeLive('commandId replay across restart (local replica set, domain_executor principal)', () => {
  let env: LiveEnvironment;
  let executor: MongoService;
  const open: Server[] = [];
  beforeAll(async () => {
    env = await openEnvironment('wakedur');
    executor = await env.as('domain_executor');
  }, 30_000);
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);
  afterEach(async () => {
    for (const server of open.splice(0)) await closeServer(server);
    await env.service.control.collection('wake_commands').deleteMany({});
  });

  const durableStore = (): WakeCommandStore => new MongoWakeCommandStore(new WakeCommandRepository(executor));
  async function boot(store: WakeCommandStore, target = new FakeWakeTarget()) {
    const server = createWakeServer({
      token: TOKEN,
      store,
      target: target as unknown as WakeTarget,
      readiness: () => ready,
    });
    open.push(server);
    return { server, port: await listen(server), target };
  }
  const cmd = (id: string, job = 'job-1') => ({ jobId: job, commandId: id });

  it('a replay after a restart is a duplicate and wakes nothing', async () => {
    const first = await boot(durableStore());
    expect((await postJson(first.port, '/internal/wake', cmd('cmd-restart-0001'), auth)).status).toBe(202);
    expect(first.target.woken).toHaveLength(1);
    await closeServer(first.server);

    const second = await boot(durableStore()); // fresh store instance, same database: the "restarted" worker
    const replay = await postJson(second.port, '/internal/wake', cmd('cmd-restart-0001'), auth);
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.text)).toEqual({ status: 'duplicate' });
    expect(second.target.woken).toEqual([]);
    expect((await postJson(second.port, '/internal/wake', cmd('cmd-restart-0002'), auth)).status).toBe(202);
  });

  it('contrast: the process-local store forgets the command on restart and wakes again (safe because claims are fenced, but not idempotent)', async () => {
    const first = await boot(new InMemoryWakeCommandStore());
    expect((await postJson(first.port, '/internal/wake', cmd('cmd-restart-0003'), auth)).status).toBe(202);
    await closeServer(first.server);
    const second = await boot(new InMemoryWakeCommandStore());
    expect((await postJson(second.port, '/internal/wake', cmd('cmd-restart-0003'), auth)).status).toBe(202);
    expect(second.target.woken).toHaveLength(1);
  });

  it('two workers sharing the database accept one command exactly once between them', async () => {
    const a = await boot(durableStore());
    const b = await boot(durableStore());
    const replies = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        postJson((i % 2 ? a : b).port, '/internal/wake', cmd('cmd-shared-0001'), auth),
      ),
    );
    const counts = replies.reduce<Record<number, number>>(
      (m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }),
      {},
    );
    expect(counts).toEqual({ 202: 1, 200: 99 });
    expect(a.target.woken.length + b.target.woken.length).toBe(1);
  });

  it('stores one insert-only row per command id holding only ids and a timestamp', async () => {
    const { port } = await boot(durableStore());
    await postJson(port, '/internal/wake', cmd('cmd-row-00001', 'job-row'), auth);
    const rows = await env.service.control.collection('wake_commands').find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['_id', 'acceptedAt', 'commandId', 'jobId']);
    expect(rows[0]).toMatchObject({ _id: 'cmd-row-00001', commandId: 'cmd-row-00001', jobId: 'job-row' });
    expect(JSON.stringify(rows[0])).not.toContain(TOKEN);
  });

  it('KNOWN LIMITATION: if the queue fills between the capacity check and the queueing, the durable store keeps the id, so the sender retry is answered "duplicate" although nothing was queued', async () => {
    // The worker principal is insert-only on wake_commands and cannot withdraw an id; delivery then relies on the
    // dispatcher recovery poll. This test records the behavior so a fix (or the poll being removed) is noticed.
    const target = new FakeWakeTarget();
    target.canAccept = () => true; // the race: the capacity pre-check passes ...
    target.wake = () => false; // ... and the queue is full by the time it is used
    const { port } = await boot(durableStore(), target);
    expect((await postJson(port, '/internal/wake', cmd('cmd-race-00001'), auth)).status).toBe(429);
    const retry = await postJson(port, '/internal/wake', cmd('cmd-race-00001'), auth);
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.text)).toEqual({ status: 'duplicate' });
    expect(target.woken).toEqual([]);
  });

  it('a full queue seen BEFORE recording does not burn the id: the retry is accepted once there is room', async () => {
    const target = new FakeWakeTarget(false);
    const { port } = await boot(durableStore(), target);
    expect((await postJson(port, '/internal/wake', cmd('cmd-full-00001'), auth)).status).toBe(429);
    target.setAccepting(true);
    expect((await postJson(port, '/internal/wake', cmd('cmd-full-00001'), auth)).status).toBe(202);
    expect(target.woken).toHaveLength(1);
  });
});
