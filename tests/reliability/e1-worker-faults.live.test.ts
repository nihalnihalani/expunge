/**
 * E1: worker fault injection against a real local replica set.
 *
 * Child processes run the product Dispatcher + repositories (see fault/worker-child.ts); the driver kills (SIGKILL)
 * or freezes (SIGSTOP) one at a named point and a second worker takes over. Every assertion is about committed
 * database state, never about what a process says. Stand-ins are labeled: FakeChatModel, FakeToolProvider and the
 * single tool (a real fenced effect through EffectRepository.commitEffect). Local replica-set evidence only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import {
  ArtifactRepository,
  DeploymentRepository,
  ProjectionRepository,
  type MongoService,
} from '@expunge/mongo';
import { makeBundle } from '../../packages/runtime/test/fakes.js';
import {
  HASH,
  actor,
  createJob,
  openEnvironment,
  recordDecisionFor,
  type LiveEnvironment,
} from '../../packages/mongo/test/support.js';
import { ChildWorker, spawnWorker } from './fault/driver.js';
import { buildIntent, type ChildConfig, type FaultSpec } from './fault/protocol.js';
import { liveGate, sleep, waitUntil } from './support.js';

const URI = process.env.MONGODB_TEST_URI;
const describeLive = liveGate(Boolean(URI), 'MONGODB_TEST_URI', 'no local replica set configured');
const LEASE_MS = 700;
const bundle = makeBundle({ toolPolicy: { grants: ['apply'], prerequisites: [] } });
const harnessHash = contentHash(bundle);
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

type StoredJob = {
  status: string;
  lease: { ownerId: string; fence: number; until: Date };
  checkpoint: unknown;
};

describeLive('worker crash, stall and takeover (child processes, real replica set)', () => {
  let env: LiveEnvironment;
  let setup: MongoService;
  let jobId: string;
  const children: ChildWorker[] = [];

  beforeAll(async () => {
    env = await openEnvironment('e1');
    setup = env.service;
  }, 30_000);
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);
  beforeEach(async () => {
    await env.reset();
    await new ArtifactRepository(setup).insert(bundle);
    await setup.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash: harnessHash,
      state: 'permitted',
      policyHash: HASH,
      reasonCode: 'test',
      sourceIds: [],
      updatedAt: new Date(),
    });
    // Since PKT-54 the worker refuses a cleanup job at start unless the scope's deployment pointer names its pinned
    // harness. Deploy the bundle through the real repository, as the setup administrator would.
    await new DeploymentRepository(setup).initialize(actor, 'worker', harnessHash, 1);
    jobId = await createJob(setup, { harnessHash });
    await recordDecisionFor(setup, buildIntent(jobId, harnessHash));
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
  });

  const config = (workerId: string, mode: 'run' | 'poll', faults: FaultSpec[] = []): ChildConfig => ({
    uri: URI!,
    worldDb: setup.world.databaseName,
    controlDb: setup.control.databaseName,
    privateDb: setup.privateDb!.databaseName,
    jobId,
    harnessHash,
    workerId,
    leaseMs: LEASE_MS,
    scope,
    mode,
    faults,
  });
  const start = (workerId: string, mode: 'run' | 'poll' = 'run', faults: FaultSpec[] = []) => {
    const child = spawnWorker(config(workerId, mode, faults));
    children.push(child);
    return child;
  };

  const job = async () =>
    (await setup.control.collection('jobs').findOne({ _id: jobId } as never)) as unknown as StoredJob;
  async function state() {
    return {
      job: await job(),
      effects: await setup.control.collection('effects').countDocuments(),
      receipts: await setup.control.collection('action_receipts').countDocuments(),
      applied:
        (
          (await setup.world.collection('reliability_marker').findOne({ _id: jobId } as never)) as {
            applied?: number;
          } | null
        )?.applied ?? 0,
      revision:
        (
          (await setup.world.collection('world_revisions').findOne({ _id: `world-${jobId}` } as never)) as {
            revision?: number;
          } | null
        )?.revision ?? 0,
      projection: await new ProjectionRepository(setup).read(scope, 0, jobId),
    };
  }
  const leaseExpired = async () => new Date((await job()).lease.until).getTime() <= Date.now();

  const contiguous = (rows: Array<{ sequence: number; eventId: string }>) => {
    expect(rows.map((r) => r.sequence)).toEqual(rows.map((_, i) => i + 1));
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(rows.length);
  };
  async function expiry() {
    await waitUntil(leaseExpired, 10_000, 25);
    await sleep(50);
  }

  it('reference: an unfaulted worker claims, runs the tool once, commits one effect and finishes the job', async () => {
    const worker = start('worker-ref');
    await worker.waitForExit();
    expect(worker.result(), worker.diagnostics).toMatchObject({
      outcome: 'failed',
      reason: 'NoCompletionReceipt',
    });
    const s = await state();
    expect([s.effects, s.receipts, s.applied, s.revision]).toEqual([1, 1, 1, 1]);
    expect(s.job.lease).toMatchObject({ ownerId: 'worker-ref', fence: 1 });
    expect(worker.points).toEqual(
      expect.arrayContaining([
        'after-claim',
        'tool-start',
        'before-effect',
        'after-commit-before-ack',
        'before-finish',
        'after-finish',
      ]),
    );
    expect(s.projection.map((e) => e.kind)).toEqual(['job_started', 'job_failed']);
    contiguous(s.projection);
  }, 60_000);

  it('crash before the effect: SIGKILL leaves a running job with no effect; the next worker applies it exactly once', async () => {
    const a = start('worker-a', 'run', [{ point: 'before-effect', action: 'kill' }]);
    expect((await a.waitForExit()).signal).toBe('SIGKILL');
    expect(a.points).toEqual(expect.arrayContaining(['after-claim', 'tool-start', 'before-effect']));
    expect(a.points).not.toContain('after-commit-before-ack');
    const crashed = await state();
    expect(crashed.job).toMatchObject({ status: 'running', lease: { ownerId: 'worker-a', fence: 1 } });
    expect([crashed.effects, crashed.receipts, crashed.applied, crashed.revision]).toEqual([0, 0, 0, 0]);

    await expiry();
    const b = start('worker-b');
    await b.waitForExit();
    expect(b.effects().map((e) => e.replayed)).toEqual([false]);
    const s = await state();
    expect([s.effects, s.receipts, s.applied, s.revision]).toEqual([1, 1, 1, 1]);
    expect(s.job.lease).toMatchObject({ ownerId: 'worker-b', fence: 2 });
    contiguous(s.projection);
    expect(s.projection.at(-1)?.kind).toBe('job_failed');
  }, 90_000);

  it('crash before the effect, recovered by the dispatcher poll alone (no wake command): a polling worker finds the abandoned job', async () => {
    const a = start('worker-a', 'run', [{ point: 'before-effect', action: 'kill' }]);
    expect((await a.waitForExit()).signal).toBe('SIGKILL');
    const c = start('worker-c', 'poll');
    await c.waitForExit(30_000);
    expect(c.result(), c.diagnostics).toMatchObject({ outcome: 'failed', reason: 'NoCompletionReceipt' });
    const s = await state();
    expect([s.effects, s.receipts, s.applied, s.revision]).toEqual([1, 1, 1, 1]);
    expect(s.job.lease).toMatchObject({ ownerId: 'worker-c', fence: 2 });
  }, 90_000);

  it('crash after the commit and before the acknowledgement: the takeover replays the saved receipt and applies nothing twice', async () => {
    const a = start('worker-a', 'run', [{ point: 'after-commit-before-ack', action: 'kill' }]);
    expect((await a.waitForExit()).signal).toBe('SIGKILL');
    const first = a.effects()[0]!;
    const crashed = await state();
    expect([crashed.effects, crashed.receipts, crashed.applied, crashed.revision]).toEqual([1, 1, 1, 1]);
    expect(crashed.job.status).toBe('running');

    await expiry();
    const b = start('worker-b');
    await b.waitForExit();
    const second = b.effects()[0]!;
    expect(second.replayed).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
    const s = await state();
    expect([s.effects, s.receipts, s.applied, s.revision]).toEqual([1, 1, 1, 1]);
    expect(s.job.lease).toMatchObject({ ownerId: 'worker-b', fence: 2 });
  }, 90_000);

  it('crash before the first projection event: the job is claimed and running, the stream is empty, and the takeover builds a contiguous stream from 1', async () => {
    const a = start('worker-a', 'run', [{ point: 'before-projection', action: 'kill', nth: 1 }]);
    expect((await a.waitForExit()).signal).toBe('SIGKILL');
    const crashed = await state();
    expect(crashed.job).toMatchObject({ status: 'running', lease: { ownerId: 'worker-a', fence: 1 } });
    expect(crashed.projection).toEqual([]);
    await expiry();
    const b = start('worker-b');
    await b.waitForExit();
    const s = await state();
    expect([s.effects, s.applied]).toEqual([1, 1]);
    contiguous(s.projection);
    expect(s.projection.map((e) => e.kind)).toEqual(['job_started', 'job_failed']);
  }, 90_000);

  it('crash after the terminal transition and before its projection event: the job is terminal, and the next worker repairs the stream once (no duplicate)', async () => {
    const a = start('worker-a', 'run', [{ point: 'before-projection', action: 'kill', nth: 2 }]);
    expect((await a.waitForExit()).signal).toBe('SIGKILL');
    const crashed = await state();
    expect(crashed.job.status).toBe('failed'); // the authoritative state is committed
    expect(crashed.projection.map((e) => e.kind)).toEqual(['job_started']); // the sanitized stream is behind it
    contiguous(crashed.projection);

    await expiry();
    const b = start('worker-b');
    await b.waitForExit();
    expect(b.result()?.outcome).toBe('terminal'); // a terminal job is not re-run
    expect(b.events.find((e) => e.event === 'repaired')).toMatchObject({ count: 1 }); // the startup sweep repaired it
    const s = await state();
    expect([s.effects, s.applied]).toEqual([1, 1]);
    expect(s.projection.map((e) => e.kind)).toEqual(['job_started', 'job_failed']);
    expect(s.projection.at(-1)?.eventId).toBe(`${jobId}:failed:1`); // the deterministic id of the lost event
    contiguous(s.projection);
    expect(s.job.status).toBe('failed');

    // Idempotent: a further worker finds the terminal event present and appends nothing.
    const c = start('worker-c');
    await c.waitForExit();
    expect(c.events.find((e) => e.event === 'repaired')).toMatchObject({ count: 0 });
    const again = await state();
    expect(again.projection.filter((e) => e.kind === 'job_failed')).toHaveLength(1);
    expect(again.projection.map((e) => e.sequence)).toEqual(s.projection.map((e) => e.sequence));
  }, 90_000);

  it('lease expiry and takeover: a frozen worker (SIGSTOP) loses the job; its late job, effect and terminal projection writes are all fenced out', async () => {
    const a = start('worker-a', 'run', [{ point: 'tool-start', action: 'stop' }]);
    await a.waitForPoint('tool-start');
    await sleep(100); // the process is now stopped: no renewals, no writes
    await expiry();
    const b = start('worker-b');
    await b.waitForExit();
    const afterB = await state();
    expect([afterB.effects, afterB.receipts, afterB.applied, afterB.revision]).toEqual([1, 1, 1, 1]);
    expect(afterB.job.lease).toMatchObject({ ownerId: 'worker-b', fence: 2 });

    a.cont(); // the zombie wakes up and tries to carry on with fence 1
    await a.waitForExit();
    const afterA = await state();
    // The zombie is not refused with an error: commitEffect looks the effect up first, so a stale-fence retry of a
    // logical effect that already committed gets the SAVED receipt back (idempotent, nothing applied again).
    const lateReceipts = a.effects();
    expect(lateReceipts.length).toBeGreaterThan(0);
    for (const late of lateReceipts) {
      expect(late.replayed).toBe(true);
      expect(late.receiptId).toBe(b.effects()[0]!.receiptId);
    }
    expect([afterA.effects, afterA.receipts, afterA.applied, afterA.revision]).toEqual([1, 1, 1, 1]);
    expect(afterA.job).toEqual(afterB.job); // status, lease and checkpoint untouched by the late worker
    // The projection append is fenced too: the resumed worker (fence 1) is refused (StaleFence) and the stream still
    // holds exactly the takeover's events, so the zombie's late job_failed (`<job>:failed:1`) never appears.
    expect(afterA.projection.map((e) => e.eventId)).toEqual(afterB.projection.map((e) => e.eventId));
    expect(afterA.projection.filter((e) => e.kind === 'job_failed')).toHaveLength(1);
    expect(afterA.projection.some((e) => e.eventId === `${jobId}:failed:1`)).toBe(false);
    expect(afterA.projection.at(-1)).toMatchObject({ kind: 'job_failed', eventId: `${jobId}:failed:2` });
    expect(a.result()).toMatchObject({ outcome: 'failed', reason: 'already_terminal' });
    contiguous(afterA.projection);
  }, 90_000);

  it('stall after the commit and before the acknowledgement: the takeover replays; the resumed first worker changes nothing', async () => {
    const a = start('worker-a', 'run', [{ point: 'after-commit-before-ack', action: 'stop' }]);
    await a.waitForPoint('after-commit-before-ack');
    await sleep(100);
    const committed = await state();
    expect([committed.effects, committed.applied]).toEqual([1, 1]);
    await expiry();
    const b = start('worker-b');
    await b.waitForExit();
    expect(b.effects()[0]).toMatchObject({ replayed: true });
    const afterB = await state();
    expect([afterB.effects, afterB.receipts, afterB.applied, afterB.revision]).toEqual([1, 1, 1, 1]);

    a.cont();
    await a.waitForExit();
    const afterA = await state();
    expect([afterA.effects, afterA.receipts, afterA.applied, afterA.revision]).toEqual([1, 1, 1, 1]);
    expect(afterA.job).toEqual(afterB.job);
    expect(afterA.job.lease).toMatchObject({ ownerId: 'worker-b', fence: 2 });
  }, 90_000);
});
