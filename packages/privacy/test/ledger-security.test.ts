import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExternalErasureJob, ScopeKey } from '@expunge/contracts';
import type { Tombstone } from '@expunge/mongo';
import { LEDGER_FORMAT, buildHeader, openLedger, sealLedger, type ErasureLedger } from '../src/index.js';

const SCOPE: ScopeKey = { tenantId: 't', env: 'evaluation', scopeId: 's' };
const MAC = 'm'.repeat(40);
const ENC = 'ab'.repeat(32);
const job = (key: string, n: number): ExternalErasureJob =>
  ({
    ...SCOPE,
    requestKey: key,
    providerOrganizationId: 'org-1',
    requester: 'dpo',
    regulation: 'gdpr',
    namespacedUserIds: ['u_1'],
    localExportSuppression: 'active',
    remoteJobId: null,
    receivedAt: new Date(1000),
    dueBy: null,
    completedAt: null,
    providerStatus: 'pending',
    subjectEntries: [],
    providerSnapshot: null,
    history: Array.from({ length: n }, (_v, i) => ({
      at: new Date(2000 + i),
      status: 's',
      snapshotHash: 'h',
    })),
  }) as ExternalErasureJob;
const tomb = (id: string, at: number): Tombstone => ({
  sourceId: id,
  kind: 'transcript' as Tombstone['kind'],
  deletedAt: new Date(at),
  reasonCode: 'subject_erasure_request' as Tombstone['reasonCode'],
  policyHash: 'a'.repeat(64),
  closureId: null,
});
const ledger = (exportedAt = new Date().toISOString()): ErasureLedger => ({
  format: LEDGER_FORMAT,
  exportedAt,
  jobs: [job('a', 2), job('b', 1)],
  tombstones: [
    { scope: SCOPE, tombstone: tomb('s1', 5000) },
    { scope: SCOPE, tombstone: tomb('s2', 9000) },
  ],
});
const error = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO_ERROR';
};
const resign = (body: Record<string, unknown>) => {
  const stable = (v: unknown): string =>
    JSON.stringify(v, (_k, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : x,
    );
  return JSON.stringify({ ...body, mac: createHmac('sha256', MAC).update(stable(body)).digest('hex') });
};

describe('erasure ledger header, MAC, retention and encryption', () => {
  it('the header carries per-collection counts and latest timestamps', () => {
    const header = buildHeader(ledger('2026-10-11T00:00:00.000Z'));
    expect(header.counts).toEqual({ jobs: 2, tombstones: 2 });
    expect(header.latest).toEqual({
      jobs: new Date(2001).toISOString(),
      tombstones: new Date(9000).toISOString(),
    });
    expect(header.retainUntil).toBe('2026-11-10T00:00:00.000Z');
  });

  it('round-trips signed (and encrypted), and the output never contains either key', () => {
    const l = ledger();
    const plain = sealLedger(l, { macKey: MAC });
    expect(openLedger(plain, { macKey: MAC }).jobs).toHaveLength(2);
    const enc = sealLedger(l, { macKey: MAC, encKey: ENC });
    expect(enc).not.toContain('requestKey'); // contents are not readable
    expect(openLedger(enc, { macKey: MAC, encKey: ENC }).tombstones).toHaveLength(2);
    for (const text of [plain, enc]) {
      expect(text).not.toContain(MAC);
      expect(text).not.toContain(ENC);
    }
  });

  it('refuses a wrong MAC key, an edited body and a missing or short key, without echoing the key', () => {
    const text = sealLedger(ledger(), { macKey: MAC });
    expect(error(() => openLedger(text, { macKey: 'x'.repeat(40) }))).toBe('LedgerMacInvalid');
    const edited = JSON.parse(text);
    edited.jobs[0].requester = 'someone-else';
    expect(error(() => openLedger(JSON.stringify(edited), { macKey: MAC }))).toBe('LedgerMacInvalid');
    const unsigned = JSON.parse(text);
    delete unsigned.mac;
    expect(error(() => openLedger(JSON.stringify(unsigned), { macKey: MAC }))).toBe('LedgerMacInvalid');
    for (const key of [undefined, '', 'short']) {
      const message = error(() => openLedger(text, { macKey: key }));
      expect(message).toContain('LedgerMacKeyMissing');
      expect(message).not.toContain('short');
    }
    expect(error(() => sealLedger(ledger(), { macKey: undefined }))).toContain('LedgerMacKeyMissing');
  });

  it('refuses a ledger whose header disagrees with its body even when it is correctly signed (a truncated export)', () => {
    const sealed = JSON.parse(sealLedger(ledger(), { macKey: MAC }));
    const { mac: _mac, ...body } = sealed;
    const truncated = { ...body, jobs: body.jobs.slice(0, 1) }; // header still says 2 jobs
    expect(error(() => openLedger(resign(truncated), { macKey: MAC }))).toBe('LedgerHeaderMismatch');
    const staleLatest = {
      ...body,
      header: { ...body.header, latest: { ...body.header.latest, tombstones: new Date(1).toISOString() } },
    };
    expect(error(() => openLedger(resign(staleLatest), { macKey: MAC }))).toBe('LedgerHeaderMismatch');
  });

  it('enforces the stated retention unless the caller opts in', () => {
    const old = sealLedger(ledger(new Date(Date.now() - 40 * 86_400_000).toISOString()), { macKey: MAC });
    expect(error(() => openLedger(old, { macKey: MAC }))).toBe('LedgerExpired');
    expect(openLedger(old, { macKey: MAC, allowExpired: true }).jobs).toHaveLength(2);
    const custom = sealLedger(ledger(new Date(Date.now() - 40 * 86_400_000).toISOString()), {
      macKey: MAC,
      retentionDays: 90,
    });
    expect(openLedger(custom, { macKey: MAC }).jobs).toHaveLength(2);
  });

  it('an encrypted ledger needs the encryption key, rejects a wrong one and a tampered ciphertext', () => {
    const enc = sealLedger(ledger(), { macKey: MAC, encKey: ENC });
    expect(error(() => openLedger(enc, { macKey: MAC }))).toContain('LedgerEncrypted');
    expect(error(() => openLedger(enc, { macKey: MAC, encKey: 'cd'.repeat(32) }))).toBe(
      'LedgerDecryptFailed',
    );
    const tampered = JSON.parse(enc);
    tampered.data = Buffer.from(
      Buffer.from(tampered.data, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b)),
    ).toString('base64');
    expect(error(() => openLedger(JSON.stringify(tampered), { macKey: MAC, encKey: ENC }))).toBe(
      'LedgerDecryptFailed',
    );
    expect(error(() => sealLedger(ledger(), { macKey: MAC, encKey: 'nothex' }))).toContain(
      'LedgerEncKeyInvalid',
    );
  });
});
