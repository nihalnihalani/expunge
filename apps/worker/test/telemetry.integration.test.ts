/**
 * Worker telemetry against the REAL JobRepository and OutboxRepository on a local replica set (the unauthenticated
 * protocol lane: MONGODB_TEST_URI). It proves that a job's terminal state and its Raindrop read-back intent commit or
 * abort together, and that a telemetry fault never strands the job. This is MongoDB protocol evidence only: not Atlas
 * RBAC, not Raindrop (a labeled FAKE ingestion server is used), and the model is the labeled FakeChatModel.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { contentHash } from '@expunge/contracts';
import {
  ArtifactRepository,
  JobRepository,
  OutboxRepository,
  ProjectionRepository,
  type MongoService,
} from '@expunge/mongo';
import {
  TelemetryIntentConflict,
  closeTracing,
  episodeEventId,
  initTracing,
  operationIdFor,
} from '@expunge/observability';
import { FakeChatModel, fakeText } from '@expunge/runtime/testing';
import {
  HASH,
  TEST_URI,
  actor,
  createJob,
  liveSuite,
  openEnvironment,
  type LiveEnvironment,
  deployWorker,
} from '../../../packages/mongo/test/support.js';
import { FakeRaindrop } from '../../../packages/observability/test/fake-raindrop.js';
import { FakeToolProvider, FixedModelResolver, makeBundle } from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  asArtifactReader,
  asDispatchJobs,
  MongoCommittedReader,
  asProjectionSink,
  createTelemetry,
  workerConfigFromEnv,
  type LogEntry,
} from '../src/index.js';

const describeLive = liveSuite(TEST_URI, 'MONGODB_TEST_URI');
const bundle = makeBundle({ toolPolicy: { grants: ['echo'], prerequisites: [] } });
const harnessHash = contentHash(bundle);

describeLive(
  'worker telemetry with the real JobRepository and OutboxRepository (local protocol lane)',
  () => {
    const fake = new FakeRaindrop();
    let env: LiveEnvironment;
    let setup: MongoService;
    let executor: MongoService;
    beforeAll(async () => {
      await fake.start();
      initTracing(
        { writeKey: fake.keys().writeKey, projectId: 'proj-1', endpoint: fake.ingestUrl },
        { disableBatching: true, bufferSize: 1 },
      );
      env = await openEnvironment('wtel');
      setup = env.service;
      executor = await env.as('domain_executor');
    }, 30_000);
    beforeEach(async () => {
      fake.reset();
      await env.reset();
      await deployWorker(setup, bundle); // stores the artifact and points the scope's deployment at it
      await setup.control.collection('artifact_eligibility').insertOne({
        tenantId: actor.tenantId,
        env: actor.env,
        scopeId: actor.scopeId,
        artifactHash: harnessHash,
        state: 'permitted',
        policyHash: HASH,
        reasonCode: 'test',
        sourceIds: [],
        updatedAt: new Date(),
      });
    });
    afterAll(async () => {
      await closeTracing();
      await fake.stop();
      if (env) await env.dispose();
    }, 30_000);

    function dispatcher(logs: LogEntry[] = []) {
      const jobs = new JobRepository(executor);
      const tracing = initTracing({
        writeKey: fake.keys().writeKey,
        projectId: 'proj-1',
        endpoint: fake.ingestUrl,
      });
      return new Dispatcher({
        jobs: asDispatchJobs(jobs),
        resolver: new MongoJobResolver(jobs),
        artifacts: asArtifactReader(new ArtifactRepository(executor)),
        tools: new FakeToolProvider(() => []),
        models: new FixedModelResolver({
          spec: 'fake/fake',
          textAdapter: new FakeChatModel([fakeText('narrative only')]).adapter,
        }),
        receipts: new MongoCompletionReceiptReader(executor),
        projection: asProjectionSink(new ProjectionRepository(executor)),
        telemetry: createTelemetry({
          tracing,
          outbox: new OutboxRepository(executor),
          transaction: (work) => executor.transaction(work),
          log: (entry) => logs.push(entry),
        }),
        log: (entry) => logs.push(entry),
        config: workerConfigFromEnv({
          EXPUNGE_WORKER_ID: 'worker-int-1',
          EXPUNGE_WORKER_LEASE_MS: '600',
          EXPUNGE_TENANT_ID: actor.tenantId,
          EXPUNGE_ENV: actor.env,
          EXPUNGE_SCOPE_ID: actor.scopeId,
        }),
      });
    }
    const outbox = () => setup.control.collection('telemetry_outbox');
    const jobRow = async (id: string) => await setup.control.collection('jobs').findOne({ _id: id } as never);
    const operationFor = (id: string) =>
      operationIdFor({
        kind: 'sdk_event',
        jobId: id,
        discriminator: `episode:${episodeEventId({ role: 'worker', jobId: id, runId: `run-${id}`, attempt: 1 })}:1`,
      });

    it('commits the terminal job state and the read-back intent together', async () => {
      const id = await createJob(setup, { harnessHash });
      const result = await dispatcher().runJob(id);
      expect(result.outcome).toBe('failed');
      expect(await jobRow(id)).toMatchObject({ status: 'failed' });
      const row = await outbox().findOne({ _id: operationFor(id) as never });
      expect(row).toMatchObject({
        kind: 'sdk_event',
        jobId: id,
        status: 'pending',
        attempts: 0,
        evidenceRequired: ['assistant_output'],
      });
      expect(row?.payload).toMatchObject({ type: 'sdk_event', role: 'worker' });
      expect(await outbox().countDocuments({})).toBe(1);
    });

    it('a conflicting intent aborts the transaction INCLUDING the job state, and the plain retry still finishes the job', async () => {
      const id = await createJob(setup, { harnessHash });
      // An earlier, non-atomic enqueue of the same operation exists, so the in-transaction insert hits a duplicate key.
      await outbox().insertOne({
        _id: operationFor(id),
        tenantId: actor.tenantId,
        env: actor.env,
        scopeId: actor.scopeId,
        operationId: operationFor(id),
        kind: 'sdk_event',
        dedupeKey: operationFor(id),
        jobId: id,
        payload: { type: 'sdk_event', eventId: 'preexisting', role: 'worker' },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(0),
        lease: { ownerId: '', fence: 0, until: new Date(0), heartbeatAt: new Date(0) },
        evidenceRequired: ['assistant_output'],
        attained: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      const logs: LogEntry[] = [];
      const result = await dispatcher(logs).runJob(id);
      // If the aborted transaction had NOT rolled the finish back, the plain retry would find no live lease.
      expect(result.outcome).toBe('failed');
      expect(await jobRow(id)).toMatchObject({ status: 'failed' });
      expect(logs.some((l) => l.message.includes('could not commit with the job state'))).toBe(true);
      expect(logs.find((l) => l.message.includes('could not commit'))?.code).toBe(
        TelemetryIntentConflict.name,
      );
      expect(await outbox().countDocuments({})).toBe(1); // the pre-existing row; nothing duplicated
    });

    it('MongoCommittedReader confirms a success only from a majority read of the job AND its receipt', async () => {
      const id = await createJob(setup, { harnessHash });
      const reader = new MongoCommittedReader(executor);
      expect(await reader.confirmSucceeded(actor, id, 'rcpt-1')).toBe(false); // job is queued
      await setup.control
        .collection('jobs')
        .updateOne(
          { _id: id } as never,
          { $set: { status: 'succeeded' } },
          { bypassDocumentValidation: true },
        );
      expect(await reader.confirmSucceeded(actor, id, 'rcpt-1')).toBe(false); // no receipt row yet
      expect(await reader.confirmSucceeded(actor, id, undefined)).toBe(false); // success without a receipt id
      await setup.control
        .collection('completion_receipts')
        .insertOne({ _id: 'rcpt-1', jobId: id, actor } as never, { bypassDocumentValidation: true });
      expect(await reader.confirmSucceeded(actor, id, 'rcpt-1')).toBe(true);
      expect(await reader.confirmSucceeded({ ...actor, scopeId: 'elsewhere' }, id, 'rcpt-1')).toBe(false);
    });

    it('O8: a ROLLED-BACK finish is never confirmed as succeeded, and a committed one is (job row AND receipt both required)', async () => {
      const id = await createJob(setup, { harnessHash });
      const reader = new MongoCommittedReader(executor);
      const jobs = setup.control.collection('jobs');
      const receipts = setup.control.collection('completion_receipts');
      const bypass = { bypassDocumentValidation: true };

      // A finish that writes the job state AND its receipt in one transaction, and then ABORTS.
      const aborted = setup.client.startSession();
      aborted.startTransaction();
      await jobs.updateOne(
        { _id: id } as never,
        { $set: { status: 'succeeded' } },
        { session: aborted, ...bypass },
      );
      await receipts.insertOne({ _id: 'rcpt-rolled-back', jobId: id, actor } as never, {
        session: aborted,
        ...bypass,
      });
      expect(await reader.confirmSucceeded(actor, id, 'rcpt-rolled-back')).toBe(false); // not committed yet
      await aborted.abortTransaction();
      await aborted.endSession();
      expect(await reader.confirmSucceeded(actor, id, 'rcpt-rolled-back')).toBe(false); // rolled back: never confirmed
      expect(await jobs.findOne({ _id: id } as never)).toMatchObject({ status: 'queued' });

      // The job row committed without the receipt is not a reportable success either.
      await jobs.updateOne({ _id: id } as never, { $set: { status: 'succeeded' } }, bypass);
      expect(await reader.confirmSucceeded(actor, id, 'rcpt-rolled-back')).toBe(false);

      // Both committed together: confirmed.
      const committed = setup.client.startSession();
      committed.startTransaction();
      await receipts.insertOne({ _id: 'rcpt-committed', jobId: id, actor } as never, {
        session: committed,
        ...bypass,
      });
      await committed.commitTransaction();
      await committed.endSession();
      expect(await reader.confirmSucceeded(actor, id, 'rcpt-committed')).toBe(true);
    });
  },
);
