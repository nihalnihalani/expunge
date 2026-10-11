import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LEDGER_FORMAT, parseLedger, type ErasureLedger } from './reapply.js';

/**
 * Integrity, completeness, retention and (optional) encryption of the erasure ledger (DA-15 E-4, E-5).
 *
 *  - Header (E-4): per-collection counts and the latest timestamps, recomputed from the body on open. A truncated or edited
 *    ledger no longer matches its own header, so `apply` refuses it.
 *  - MAC (E-5): HMAC-SHA256 over the canonical body, keyed by a privacy-controller secret read from the environment variable
 *    NAMED `EXPUNGE_LEDGER_MAC_KEY` (at least 32 characters). The key is never printed or stored in the file. It detects edits
 *    by anyone without the key; it does not hide the contents.
 *  - Retention (E-5): `header.retainUntil` (exportedAt plus `retentionDays`, default 30). An expired ledger is refused unless the
 *    caller opts in. Keep it at least as long as the backups it pairs with, and delete it at expiry; no pruning job exists.
 *  - Encryption (E-5): when `EXPUNGE_LEDGER_ENC_KEY` (64 hex characters = 32 bytes) is set, the file is AES-256-GCM encrypted.
 *    Otherwise the file is plaintext JSON mode 0600 and the DESTINATION must be an encrypted volume or bucket; the tool does
 *    not verify that.
 */
export const ENCRYPTED_FORMAT = 'expunge-erasure-ledger-enc-v1';
export const MAC_KEY_VARIABLE = 'EXPUNGE_LEDGER_MAC_KEY';
export const ENC_KEY_VARIABLE = 'EXPUNGE_LEDGER_ENC_KEY';
export const DEFAULT_RETENTION_DAYS = 30;

export type LedgerHeader = {
  counts: { jobs: number; tombstones: number };
  latest: { jobs: string | null; tombstones: string | null };
  retainUntil: string;
};
export type SealedLedger = ErasureLedger & { header: LedgerHeader; mac: string };

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

const latestIso = (dates: Date[]): string | null =>
  dates.length === 0 ? null : new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString();

export function buildHeader(
  ledger: Pick<ErasureLedger, 'jobs' | 'tombstones' | 'exportedAt'>,
  retentionDays = DEFAULT_RETENTION_DAYS,
): LedgerHeader {
  const jobTimes = ledger.jobs.flatMap((j) => [
    j.receivedAt,
    ...(j.completedAt ? [j.completedAt] : []),
    ...j.history.map((h) => h.at),
  ]);
  return {
    counts: { jobs: ledger.jobs.length, tombstones: ledger.tombstones.length },
    latest: {
      jobs: latestIso(jobTimes),
      tombstones: latestIso(ledger.tombstones.map((t) => t.tombstone.deletedAt)),
    },
    retainUntil: new Date(Date.parse(ledger.exportedAt) + retentionDays * 86_400_000).toISOString(),
  };
}

function requireMacKey(key: string | undefined): string {
  if (!key || key.length < 32)
    throw new Error(`LedgerMacKeyMissing: set ${MAC_KEY_VARIABLE} (at least 32 characters)`);
  return key;
}
const mac = (body: unknown, key: string): string =>
  createHmac('sha256', key).update(stable(body)).digest('hex');

/** Signs and (when `encKey` is given) encrypts a ledger into the text written to disk. */
export function sealLedger(
  ledger: ErasureLedger,
  options: { macKey: string | undefined; encKey?: string | undefined; retentionDays?: number },
): string {
  const key = requireMacKey(options.macKey);
  const header = buildHeader(ledger, options.retentionDays);
  const body = { ...ledger, header };
  const plain = JSON.stringify({ ...body, mac: mac(body, key) });
  if (!options.encKey) return plain;
  if (!/^[0-9a-f]{64}$/i.test(options.encKey))
    throw new Error(`LedgerEncKeyInvalid: ${ENC_KEY_VARIABLE} must be 64 hex characters`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(options.encKey, 'hex'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: ENCRYPTED_FORMAT,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

/**
 * Decrypts if needed, verifies the MAC, recomputes the header from the body and checks retention, then parses. Every
 * refusal is a closed code (LedgerEncrypted, LedgerDecryptFailed, LedgerMacInvalid, LedgerHeaderMismatch, LedgerExpired,
 * LedgerMacKeyMissing); none echoes content.
 */
export function openLedger(
  text: string,
  options: { macKey: string | undefined; encKey?: string | undefined; now?: Date; allowExpired?: boolean },
): ErasureLedger {
  const key = requireMacKey(options.macKey);
  let plain = text;
  type Outer = { format?: unknown; iv?: string; tag?: string; data?: string };
  let outer: Outer | null = null;
  try {
    outer = JSON.parse(text) as Outer;
  } catch {
    throw new Error('LedgerNotJson');
  }
  if (outer?.format === ENCRYPTED_FORMAT) {
    if (!options.encKey) throw new Error(`LedgerEncrypted: set ${ENC_KEY_VARIABLE}`);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(options.encKey, 'hex'),
        Buffer.from(outer.iv!, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(outer.tag!, 'base64'));
      plain = Buffer.concat([decipher.update(Buffer.from(outer.data!, 'base64')), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new Error('LedgerDecryptFailed');
    }
  }
  const raw = JSON.parse(plain) as Record<string, unknown>;
  const { mac: presented, ...body } = raw;
  if (typeof presented !== 'string') throw new Error('LedgerMacInvalid');
  const expected = Buffer.from(mac(body, key), 'hex');
  const given = Buffer.from(presented, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new Error('LedgerMacInvalid');
  const ledger = parseLedger(plain);
  const header = raw.header as LedgerHeader | undefined;
  if (raw.format !== LEDGER_FORMAT || !header) throw new Error('LedgerHeaderMismatch');
  const recomputed = buildHeader(ledger);
  if (
    header.counts.jobs !== recomputed.counts.jobs ||
    header.counts.tombstones !== recomputed.counts.tombstones ||
    header.latest.jobs !== recomputed.latest.jobs ||
    header.latest.tombstones !== recomputed.latest.tombstones
  )
    throw new Error('LedgerHeaderMismatch');
  if (!options.allowExpired && Date.parse(header.retainUntil) < (options.now ?? new Date()).getTime())
    throw new Error('LedgerExpired');
  return ledger;
}
