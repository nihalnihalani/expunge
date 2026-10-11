import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Episode,
  IngestClient,
  closeTracing,
  initTracing,
  operationIdFor,
  raindropQueryConfigFromEnv,
  raindropWriteConfigFromEnv,
  verifierSignalIntent,
} from '@expunge/observability';
import { defineTool } from '@expunge/vendor-openmuse';
import {
  InMemoryEvidenceStore,
  OutboxDispatcher,
  RaindropQueryClient,
  assembleEvidenceBundle,
  observeEvent,
  type EvidenceObservation,
} from '../src/index.js';
import { Clock, InMemoryOutbox, SCOPE } from './helpers.js';

/**
 * LIVE Raindrop smoke. It talks to the real Raindrop ingestion and Query APIs with the project's own keys, so it is
 * SKIPPED unless all of RAINDROP_API_KEY, RAINDROP_QUERY_API_KEY and RAINDROP_PROJECT_ID are set. Under
 * EXPUNGE_REQUIRE_LIVE_TESTS=1 a missing variable FAILS the suite instead, so a skipped run can never pass as proof.
 *
 * Status of this file: it has never been executed against Raindrop (no keys exist yet). Nothing here is evidence
 * until a run with real keys has produced the IDs this test writes to .expunge/tmp/raindrop-live-evidence.json.
 * The outbox in this test is the in-memory one (labeled), so it proves the Raindrop side of delivery only.
 */
const REQUIRED = ['RAINDROP_API_KEY', 'RAINDROP_QUERY_API_KEY', 'RAINDROP_PROJECT_ID'] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const requireLive = process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(
  label: string,
  read: () => Promise<T | null>,
  timeoutMs: number,
  everyMs = 4000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`live smoke timed out waiting for: ${label}`);
    await sleep(everyMs);
  }
}

if (missing.length > 0 && !requireLive) {
  describe.skip(`live Raindrop smoke (skipped: ${missing.join(', ')} not set)`, () =>
    it('skipped', () => {}));
} else if (missing.length > 0) {
  describe('live Raindrop smoke', () => {
    it('requires live Raindrop credentials (EXPUNGE_REQUIRE_LIVE_TESTS=1)', () => {
      throw new Error(`live suites are required but these variables are not set: ${missing.join(', ')}`);
    });
  });
} else {
  describe('live Raindrop smoke: one worker interaction, read back, signalled, and cited', () => {
    it('writes an episode, reads it back by event id with matching identity, delivers a verifier signal, and assembles a cited bundle', async () => {
      const write = raindropWriteConfigFromEnv(process.env);
      const query = raindropQueryConfigFromEnv(process.env);
      if (!write.ok || !query.ok) throw new Error('configuration unexpectedly incomplete');

      const runId = `smoke-${randomUUID()}`;
      const jobId = `job-${runId}`;
      const harnessHash = createHash('sha256').update(runId).digest('hex');
      const tracing = initTracing(write.config, { disableBatching: true, bufferSize: 1 });
      const episode = Episode.begin(tracing, {
        role: 'worker',
        jobId,
        runId,
        attempt: 1,
        harnessHash,
        workerProfileHash: createHash('sha256').update('profile').digest('hex'),
        worldId: 'world-smoke',
        completionPolicy: 'verified_receipt',
        telemetryUserId: `smoke_${runId.slice(6, 14)}`,
        input: 'live smoke: inspect one collection',
      });
      const tool = defineTool({
        name: 'inspect_scope',
        description: 'inspect',
        parameters: z.object({ collectionId: z.string() }),
        execute: async () => ({ status: 'ok', rows: 3 }),
      });
      const [instrumented] = episode.instrumentTools([tool]);
      await episode.run(async () => {
        await (instrumented!.execute as (args: unknown) => Promise<unknown>)({ collectionId: 'customers' });
      });
      await episode.complete({
        status: 'failed',
        endedBy: 'finished',
        toolCalls: 1,
        phases: 1,
        elapsedMs: 5,
      });
      await closeTracing(); // flushes buffered spans and events

      const client = new RaindropQueryClient({
        queryKey: query.config.queryKey,
        projectId: query.config.projectId,
        ...(query.config.baseUrl ? { baseUrl: query.config.baseUrl } : {}),
      });
      // 1. Event visible by ID, carrying the identity we stamped.
      const event = await poll('event visible by id', () => client.getEvent(episode.eventId), 180_000);
      expect(event.properties.run_id).toBe(runId);
      expect(event.properties.harness_hash).toBe(harnessHash);
      // 2. Trace read-back for the same event, with the tool span present.
      const traces = await poll(
        'tool span visible',
        async () => {
          const read = await client.getTraces(episode.eventId);
          return read.spans.some((span) => span.span_name === 'inspect_scope') ? read : null;
        },
        180_000,
      );

      // 3. Deliver a verifier signal through the real ingestion path with the in-memory (labeled) outbox, and wait for
      //    the dispatcher to reach evidence_ready.
      const clock = new Clock(Date.now());
      const outbox = new InMemoryOutbox(clock);
      const evidence = new InMemoryEvidenceStore();
      const intent = verifierSignalIntent({
        jobId,
        eventId: episode.eventId,
        passed: false,
        evaluationId: `eval-${runId}`,
        harnessHash,
      });
      outbox.add({
        operationId: operationIdFor(intent),
        kind: intent.kind,
        jobId,
        payload: intent.payload as never,
        evidenceRequired: intent.evidenceRequired,
      });
      const dispatcher = new OutboxDispatcher(
        {
          outbox,
          ingest: new IngestClient({
            writeKey: write.config.writeKey,
            projectId: write.config.projectId,
            ...(write.config.endpoint ? { baseUrl: write.config.endpoint } : {}),
          }),
          query: client,
          evidence,
          transaction: (work) => work(undefined as never),
          scope: SCOPE,
          projectId: query.config.projectId,
        },
        { ownerId: 'live-smoke', now: clock.now, holdTimeoutMs: 20 * 60_000, leaseMs: 30_000 },
      );
      const finalOutcome = await poll(
        'outbox evidence_ready',
        async () => {
          const outcome = await dispatcher.runOnce();
          if (outcome?.result === 'evidence_ready') return outcome;
          if (outcome?.result === 'dead_letter' || outcome?.result === 'blocked')
            throw new Error(`dispatch ended ${outcome.result}`);
          clock.advance(60_000); // make a held or retrying row due again; the real wait is the poll interval
          return null;
        },
        300_000,
        5000,
      );
      const row = outbox.rows.get(operationIdFor(intent))!;
      expect(finalOutcome.attained).toEqual([
        'sdk_enqueued',
        'ingest_accepted',
        'query_visible',
        'evidence_ready',
      ]);

      // 4. A bundle that cites the real IDs.
      const finalEvent = (await client.getEvent(episode.eventId))!;
      const observation: EvidenceObservation = observeEvent(query.config.projectId, finalEvent, traces);
      const signal = finalEvent.signals?.find((s) => s.name === 'cleanup_not_verified');
      expect(signal, 'the signal we sent is visible on the event').toBeDefined();
      const bundle = assembleEvidenceBundle({
        evidenceId: `ev-${runId}`,
        actor: SCOPE,
        binding: {
          jobId,
          runId,
          worldId: 'world-smoke',
          harnessHash,
          scopeRevision: 1,
          workerProfileHash: 'p'.repeat(64),
        },
        split: 'train',
        observation,
        tools: [],
        diagnostics: [],
        failureWitnesses: [],
        cost: {
          modelCalls: 0,
          toolCalls: 1,
          inputTokens: 0,
          outputTokens: 0,
          costMicrousd: 0,
          unpricedCalls: 0,
          mongoOperations: 0,
          wallTimeMs: 5,
        },
        confidence: 0.5,
        sources: [
          {
            provider: 'raindrop',
            externalEventId: episode.eventId,
            externalSignalIds: signal ? [signal.id] : [],
            localSourceIds: [operationIdFor(intent)],
            origin: 'verifier_feedback',
            redactionPolicy: 'v1',
            retrievedAt: new Date().toISOString(),
            contentHash: observation.contentHash,
            permittedUse: 'training',
          },
        ],
      });
      expect(bundle.sources[0]!.externalEventId).toBe(episode.eventId);

      // Evidence to report: identifiers and counts only, never keys or content.
      mkdirSync('.expunge/tmp', { recursive: true });
      writeFileSync(
        '.expunge/tmp/raindrop-live-evidence.json',
        JSON.stringify(
          {
            eventId: episode.eventId,
            runId,
            harnessHash,
            traceSpanCount: traces.spans.length,
            tracePotentiallyTruncated: traces.potentiallyTruncated,
            signalId: signal?.id ?? null,
            outboxAttained: Object.fromEntries(
              Object.entries(row.attained).map(([state, proof]) => [state, proof.at]),
            ),
            evidenceContentHash: observation.contentHash,
          },
          null,
          2,
        ),
      );
    }, 600_000);
  });
}
