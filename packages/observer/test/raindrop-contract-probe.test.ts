import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IngestClient, raindropQueryConfigFromEnv, raindropWriteConfigFromEnv } from '@expunge/observability';
import { RaindropQueryClient } from '../src/index.js';

/**
 * LIVE CONTRACT PROBE (DA-6 O9). The fake Raindrop server encodes the author's reading of the documentation; this probe
 * records what the real service does for each assumption the code relies on, so a live claim can be checked against
 * reality and the fake corrected. It writes SHAPES AND COUNTS ONLY (never keys or content) to
 * .expunge/tmp/raindrop-contract-probe.json.
 *
 * It needs RAINDROP_API_KEY, RAINDROP_QUERY_API_KEY and RAINDROP_PROJECT_ID. Without them it skips; under
 * EXPUNGE_REQUIRE_LIVE_TESTS=1 it FAILS by name. STATUS: never executed against Raindrop (no keys exist yet).
 */
const REQUIRED = ['RAINDROP_API_KEY', 'RAINDROP_QUERY_API_KEY', 'RAINDROP_PROJECT_ID'] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const requireLive = process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (missing.length > 0 && !requireLive) {
  describe.skip(`live contract probe (skipped: ${missing.join(', ')} not set)`, () =>
    it('skipped', () => {}));
} else if (missing.length > 0) {
  describe('live contract probe', () => {
    it('requires live Raindrop credentials (EXPUNGE_REQUIRE_LIVE_TESTS=1)', () => {
      throw new Error(`live suites are required but these variables are not set: ${missing.join(', ')}`);
    });
  });
} else {
  describe('live contract probe: what Raindrop actually does for each assumption in the code', () => {
    it('records ingestion status, signal duplication, pagination, the signal catalog and trace shape', async () => {
      const write = raindropWriteConfigFromEnv(process.env);
      const query = raindropQueryConfigFromEnv(process.env);
      if (!write.ok || !query.ok) throw new Error('configuration unexpectedly incomplete');
      const ingest = new IngestClient({
        writeKey: write.config.writeKey,
        projectId: write.config.projectId,
        ...(write.config.endpoint ? { baseUrl: write.config.endpoint } : {}),
      });
      const client = new RaindropQueryClient({
        queryKey: query.config.queryKey,
        projectId: query.config.projectId,
        ...(query.config.baseUrl ? { baseUrl: query.config.baseUrl } : {}),
      });
      const eventId = `probe-${randomUUID()}`;
      const report: Record<string, unknown> = { eventId };

      // A1. An accepted event batch answers 2xx with an empty body (the code treats 204 as acceptance only).
      const sent = await ingest.trackEvents([
        {
          user_id: 'probe_00000000000000a1',
          event: 'expunge.contract_probe',
          event_id: eventId,
          properties: { probe: 'true' },
          ai_data: { output: '{"probe":true}' },
        },
      ]);
      report.eventIngest = sent.ok
        ? { ok: true, status: sent.status }
        : { ok: false, kind: sent.kind, status: sent.status };

      // A2. Visibility lag: how long until the Query API returns the event by id.
      const started = Date.now();
      let event = await client.getEvent(eventId);
      while (!event && Date.now() - started < 180_000) {
        await sleep(3000);
        event = await client.getEvent(eventId);
      }
      report.eventVisibleAfterMs = event ? Date.now() - started : null;
      expect(event, 'the probe event must become visible').not.toBeNull();

      // A3. Signal duplication: the same signal sent twice with the same dedupe_key. Does the vendor keep one or two?
      const signal = {
        event_id: eventId,
        signal_name: 'contract_probe_signal',
        signal_type: 'default' as const,
        properties: { dedupe_key: `probe-${eventId}` },
      };
      const first = await ingest.trackSignals([signal]);
      const second = await ingest.trackSignals([signal]);
      report.signalIngest = [first, second].map((r) =>
        r.ok ? { ok: true, status: r.status } : { ok: false, kind: r.kind },
      );
      const deadline = Date.now() + 180_000;
      let count = 0;
      while (Date.now() < deadline) {
        count = ((await client.getEvent(eventId))?.signals ?? []).filter(
          (s) => s.name === signal.signal_name,
        ).length;
        if (count >= 2) break;
        await sleep(4000);
      }
      report.signalCountAfterTwoSends = count; // 1 means the vendor collapses duplicates; 2 means it double counts

      // A4. Pagination: limit=1 listing and whether more pages are advertised.
      const page = await client.listEvents({ limit: 1, orderBy: '+timestamp' });
      report.pagination = {
        returned: page.data.length,
        hasMore: page.hasMore,
        hasCursor: page.cursor !== null,
      };

      // A5. The signal catalog: field names only.
      const catalog = await client.listSignals();
      report.signalCatalog = {
        count: catalog.data.length,
        fields: catalog.data[0] ? Object.keys(catalog.data[0]).sort() : [],
        hasMore: catalog.hasMore,
      };

      // A6. Trace read-back shape for the probe event.
      const traces = await client.getTraces(eventId);
      report.traces = { spans: traces.spans.length, potentiallyTruncated: traces.potentiallyTruncated };

      mkdirSync('.expunge/tmp', { recursive: true });
      writeFileSync('.expunge/tmp/raindrop-contract-probe.json', JSON.stringify(report, null, 2));
    }, 600_000);
  });
}
