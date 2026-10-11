import { describe, expect, it } from 'vitest';
import type { ExternalErasureJob, ScopeKey } from '@expunge/contracts';
import type { Tombstone } from '@expunge/mongo';
import {
  LEDGER_FORMAT,
  REAPPLY_NOTICE,
  REQUIRED_ATTESTATIONS,
  ledgerSha256,
  newCursor,
  parseLedger,
  reapplyErasures,
  type ErasureLedger,
  type ReapplyPorts,
} from '../src/index.js';

const SCOPE: ScopeKey = { tenantId: 't', env: 'evaluation', scopeId: 's' };
const job = (
  key: string,
  historyLength: number,
  extra: Partial<ExternalErasureJob> = {},
): ExternalErasureJob =>
  ({
    ...SCOPE,
    requestKey: key,
    providerOrganizationId: 'org-1',
    requester: 'dpo',
    regulation: 'gdpr',
    namespacedUserIds: ['u_1'],
    localExportSuppression: 'active',
    remoteJobId: null,
    receivedAt: new Date(0),
    dueBy: null,
    completedAt: null,
    providerStatus: 'pending',
    subjectEntries: [{ user_id: 'u_1', requested_on: '2026-10-01', revoked_at: null }],
    providerSnapshot: null,
    history: Array.from({ length: historyLength }, (_v, i) => ({
      at: new Date(i),
      status: 's',
      snapshotHash: 'h',
    })),
    ...extra,
  }) as ExternalErasureJob;
const tombstone = (id: string): Tombstone => ({
  sourceId: id,
  kind: 'transcript' as Tombstone['kind'],
  deletedAt: new Date(5),
  reasonCode: 'subject_erasure_request' as Tombstone['reasonCode'],
  policyHash: 'a'.repeat(64),
  closureId: null,
});
const ledger = (jobs: ExternalErasureJob[], tombstones: Tombstone[] = []): ErasureLedger => ({
  format: LEDGER_FORMAT,
  exportedAt: new Date(10).toISOString(),
  jobs,
  tombstones: tombstones.map((t) => ({ scope: SCOPE, tombstone: t })),
});

/** In-memory ports: a stand-in for the restored database, with a suppression table derived from the stored jobs. */
function memory(initialJobs: ExternalErasureJob[] = [], initialTombs: Tombstone[] = []) {
  const jobs = new Map(initialJobs.map((j) => [j.requestKey, structuredClone(j)]));
  const tombs = new Map(initialTombs.map((t) => [t.sourceId, t]));
  const suppressed = new Set<string>();
  const calls = { insert: 0, replace: 0, reconcile: 0, put: 0 };
  let breakSuppression = false;
  const ports: ReapplyPorts = {
    getJob: async (_s, key) => structuredClone(jobs.get(key) ?? null),
    insertJob: async (j) => {
      calls.insert++;
      if (jobs.has(j.requestKey)) return 'exists';
      jobs.set(j.requestKey, structuredClone(j));
      return 'created';
    },
    replaceJob: async (j, expected) => {
      calls.replace++;
      if ((jobs.get(j.requestKey)?.history.length ?? -1) !== expected) return false;
      jobs.set(j.requestKey, structuredClone(j));
      return true;
    },
    reconcileSuppression: async () => {
      calls.reconcile++;
      if (breakSuppression) return;
      for (const j of jobs.values()) if (j.localExportSuppression === 'active') suppressed.add(j.requestKey);
    },
    suppressionGap: async (j) =>
      j.localExportSuppression === 'active' && !suppressed.has(j.requestKey) ? 1 : 0,
    getTombstone: async (_s, id) => tombs.get(id) ?? null,
    putTombstone: async (_s, t) => {
      calls.put++;
      tombs.set(t.sourceId, t);
    },
  };
  return { ports, jobs, tombs, suppressed, calls, breakSuppression: () => (breakSuppression = true) };
}
const attested = (c = newCursor('x')) => {
  for (const name of REQUIRED_ATTESTATIONS) c.attestations[name] = `ticket-${name}`;
  return c;
};
const run = (l: ErasureLedger, m: ReturnType<typeof memory>, cursor = newCursor('h')) =>
  reapplyErasures(l, 'h', m.ports, cursor);

describe('reapplyErasures', () => {
  it('inserts missing jobs, advances a job that is behind, keeps one that is ahead, and re-creates tombstones', async () => {
    const m = memory([job('behind', 1), job('ahead', 3)]);
    const report = await run(
      ledger([job('missing', 2), job('behind', 2), job('ahead', 2)], [tombstone('src-1')]),
      m,
      attested(newCursor('h')),
    );
    expect(report.applied).toEqual({ jobsInserted: 1, jobsAdvanced: 1, jobsKept: 1, tombstones: 1 });
    expect(m.jobs.get('behind')!.history).toHaveLength(2);
    expect(m.jobs.get('ahead')!.history).toHaveLength(3); // never moved backwards
    expect(m.tombs.has('src-1')).toBe(true);
    expect(report.pending).toEqual([]);
    expect(report.done).toBe(true);
  });

  it('is idempotent: a second run changes nothing and is still done', async () => {
    const m = memory();
    const l = ledger([job('a', 2)], [tombstone('s')]);
    await run(l, m, attested(newCursor('h')));
    const again = await run(l, m, attested(newCursor('h')));
    expect(again.applied).toEqual({ jobsInserted: 0, jobsAdvanced: 0, jobsKept: 1, tombstones: 0 });
    expect(again.done).toBe(true);
  });

  it('refuses DONE until the two attestations exist, naming each missing one', async () => {
    const m = memory();
    const report = await run(ledger([job('a', 1)]), m);
    expect(report.done).toBe(false);
    expect(report.pending).toEqual(REQUIRED_ATTESTATIONS.map((n) => `attestation required: ${n}`));
  });

  it('refuses DONE while a suppression row is still missing after reconcile', async () => {
    const m = memory();
    m.breakSuppression();
    const report = await run(ledger([job('a', 1)]), m, attested(newCursor('h')));
    expect(report.done).toBe(false);
    expect(report.pending).toContain('suppression rows missing: 1');
  });

  it('a released job needs no suppression; a lost compare-and-swap leaves the job pending', async () => {
    const released = memory();
    expect(
      (
        await run(
          ledger([job('r', 1, { localExportSuppression: 'released' })]),
          released,
          attested(newCursor('h')),
        )
      ).done,
    ).toBe(true);
    const racing = memory([job('behind', 1)]);
    racing.ports.replaceJob = async () => false; // another writer moved it first
    const report = await run(ledger([job('behind', 2)]), racing, attested(newCursor('h')));
    expect(report.done).toBe(false);
    expect(report.pending).toContain('erasure jobs missing or behind: 1');
  });

  it('resumes from the cursor after a crash and does not repeat finished items', async () => {
    const m = memory();
    const l = ledger([job('a', 1), job('b', 1), job('c', 1)]);
    const cursor = newCursor('h');
    let writes = 0;
    await expect(
      reapplyErasures(l, 'h', m.ports, cursor, () => {
        if (++writes === 2) throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    expect(cursor.steps.jobs).toBe(2); // two items recorded before the crash
    const insertsBefore = m.calls.insert;
    const resumed = await reapplyErasures(l, 'h', m.ports, attested(cursor));
    expect(m.calls.insert - insertsBefore).toBe(1); // only 'c' remained
    expect(resumed.done).toBe(true);
  });

  it('refuses a cursor made for another ledger', async () => {
    await expect(reapplyErasures(ledger([]), 'h', memory().ports, newCursor('other'))).rejects.toThrow(
      'CursorLedgerMismatch',
    );
  });
});

describe('parseLedger', () => {
  it('revives dates and refuses unknown formats and non-JSON, without echoing content', () => {
    const l = ledger([job('a', 2)], [tombstone('s')]);
    const text = JSON.stringify(l);
    const parsed = parseLedger(text);
    expect(parsed.jobs[0]!.receivedAt).toBeInstanceOf(Date);
    expect(parsed.jobs[0]!.history[0]!.at).toBeInstanceOf(Date);
    expect(parsed.tombstones[0]!.tombstone.deletedAt).toBeInstanceOf(Date);
    expect(ledgerSha256(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => parseLedger('{nope')).toThrow('LedgerNotJson');
    expect(() => parseLedger(JSON.stringify({ ...l, format: 'v0' }))).toThrow('LedgerFormat');
  });
});

describe('reapply report honesty', () => {
  it('every report, DONE included, says the attestations are ATTESTED, NOT VERIFIED and that DONE is not "erasure complete"', async () => {
    const done = await run(ledger([job('a', 1)]), memory(), attested(newCursor('h')));
    const pending = await run(ledger([job('a', 1)]), memory());
    for (const report of [done, pending]) {
      expect(report.notice).toBe(REAPPLY_NOTICE);
      expect(report.notice).toContain('ATTESTED, NOT VERIFIED');
      expect(report.notice).toContain('does NOT mean erasure is complete');
      expect(report.notice).toContain('out of service');
    }
    expect(done.done).toBe(true);
  });
});
