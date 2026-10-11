import { createHash } from 'node:crypto';
import type { ExternalErasureJob, ScopeKey } from '@expunge/contracts';
import type { Tombstone } from '@expunge/mongo';

/**
 * Post-restore erasure re-application (DA-10 B-1). A restore brings back records that were erased after the backup was
 * taken. The erasure facts recorded since then are NOT in the restored database, so they must come from somewhere that
 * survived: the ledger `exportErasureLedger` writes from the live (or damaged-but-readable) database BEFORE it is wiped, or
 * an independent copy. This module replays that ledger into the restored database with the privacy controller principal:
 *
 *  - erasure jobs (`external_deletions`): inserted when missing, advanced (compare-and-swap on history length) when the
 *    restored copy is behind, never moved backwards; the store flips each job's `erasure_suppressions` rows in the same
 *    transaction, and a reconcile pass repairs any gap;
 *  - source tombstones (`raw_artifacts`): a source the ledger says was purged is purged again (a source never comes back).
 *
 * Idempotent (every step is a set-to-target operation) and resumable (a cursor records how many items of each step are
 * done). It reports DONE only when a verification pass finds nothing pending AND the two things this module cannot do
 * itself were ATTESTED (not verified) by a named reference: that world-record deletions (effects/receipts against the owner source) were
 * reconciled, and that derived artifacts (lessons, eligibility) were retracted by the retraction runner. Anything pending
 * keeps the restored system out of service.
 */
export const LEDGER_FORMAT = 'expunge-erasure-ledger-v1';
export const REQUIRED_ATTESTATIONS = ['world-effects-reconciled', 'derived-artifacts-retracted'] as const;

export type ErasureLedger = {
  format: typeof LEDGER_FORMAT;
  exportedAt: string;
  jobs: ExternalErasureJob[];
  tombstones: Array<{ scope: ScopeKey; tombstone: Tombstone }>;
};

export interface ReapplyPorts {
  getJob(scope: ScopeKey, requestKey: string): Promise<ExternalErasureJob | null>;
  insertJob(job: ExternalErasureJob): Promise<'created' | 'exists'>;
  replaceJob(job: ExternalErasureJob, expectedHistoryLength: number): Promise<boolean>;
  /** Re-derives suppression rows from stored jobs for one organization (reconcileExportSuppression). */
  reconcileSuppression(providerOrganizationId: string): Promise<unknown>;
  /** Active suppression keys the job expects but the database does not hold. */
  suppressionGap(job: ExternalErasureJob): Promise<number>;
  getTombstone(scope: ScopeKey, sourceId: string): Promise<Tombstone | null>;
  putTombstone(scope: ScopeKey, tombstone: Tombstone): Promise<void>;
}

export type ReapplyCursor = {
  ledgerSha256: string;
  steps: { jobs: number; tombstones: number; suppression: number };
  attestations: Record<string, string>;
};
export const newCursor = (ledgerSha256: string): ReapplyCursor => ({
  ledgerSha256,
  steps: { jobs: 0, tombstones: 0, suppression: 0 },
  attestations: {},
});

/**
 * Printed with every report. The two attestations are free text in an unauthenticated cursor file: no principal vouches for
 * them and nothing checks them against the database. DONE therefore means only that the replayed jobs, suppressions and
 * tombstones are present; it does NOT establish that erasure is complete.
 */
export const REAPPLY_NOTICE =
  'world-effects-reconciled and derived-artifacts-retracted are ATTESTED, NOT VERIFIED (free text in an unauthenticated ' +
  'cursor file). DONE covers only the replayed erasure jobs, suppressions and tombstones; it does NOT mean erasure is ' +
  'complete. Keep the restored system out of service if any cleanup or erasure completed after the backup, until verified ' +
  're-application exists.';

export type ReapplyReport = {
  done: boolean;
  notice: string;
  applied: { jobsInserted: number; jobsAdvanced: number; jobsKept: number; tombstones: number };
  pending: string[];
};

export const ledgerSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const DATE_FIELDS = ['receivedAt', 'dueBy', 'completedAt'] as const;
const reviveJob = (raw: Record<string, unknown>): ExternalErasureJob => {
  const job = { ...raw } as Record<string, unknown>;
  for (const field of DATE_FIELDS)
    if (typeof job[field] === 'string') job[field] = new Date(job[field] as string);
  job.history = ((job.history as Array<Record<string, unknown>>) ?? []).map((h) => ({
    ...h,
    at: new Date(h.at as string),
  }));
  return job as unknown as ExternalErasureJob;
};

/** Parses a ledger file's text, reviving dates; refuses an unknown format. Errors name the problem, never the content. */
export function parseLedger(text: string): ErasureLedger {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('LedgerNotJson');
  }
  if (raw.format !== LEDGER_FORMAT || !Array.isArray(raw.jobs) || !Array.isArray(raw.tombstones))
    throw new Error('LedgerFormat');
  return {
    format: LEDGER_FORMAT,
    exportedAt: String(raw.exportedAt),
    jobs: (raw.jobs as Array<Record<string, unknown>>).map(reviveJob),
    tombstones: (raw.tombstones as Array<{ scope: ScopeKey; tombstone: Record<string, unknown> }>).map(
      (t) => ({
        scope: t.scope,
        tombstone: {
          ...t.tombstone,
          deletedAt: new Date(t.tombstone.deletedAt as string),
        } as unknown as Tombstone,
      }),
    ),
  };
}

const scopeOf = (job: ScopeKey): ScopeKey => ({ tenantId: job.tenantId, env: job.env, scopeId: job.scopeId });

/**
 * Applies the ledger and verifies. `persist` is called after every item so a crash resumes where it stopped; a cursor made
 * for a different ledger is refused (it would skip items the new ledger needs).
 */
export async function reapplyErasures(
  ledger: ErasureLedger,
  ledgerHash: string,
  ports: ReapplyPorts,
  cursor: ReapplyCursor,
  persist: (cursor: ReapplyCursor) => Promise<void> | void = () => undefined,
): Promise<ReapplyReport> {
  if (cursor.ledgerSha256 !== ledgerHash) throw new Error('CursorLedgerMismatch');
  const applied = { jobsInserted: 0, jobsAdvanced: 0, jobsKept: 0, tombstones: 0 };

  for (let i = cursor.steps.jobs; i < ledger.jobs.length; i++) {
    const job = ledger.jobs[i]!;
    const scope = scopeOf(job);
    const current = await ports.getJob(scope, job.requestKey);
    if (!current) {
      if ((await ports.insertJob(job)) === 'created') applied.jobsInserted++;
    } else if (current.history.length < job.history.length) {
      // Behind the ledger: advance with a compare-and-swap; a lost race re-reads on the next loop of the verification.
      if (await ports.replaceJob(job, current.history.length)) applied.jobsAdvanced++;
    } else applied.jobsKept++; // equal or ahead: never moved backwards
    cursor.steps.jobs = i + 1;
    await persist(cursor);
  }

  const organizations = [...new Set(ledger.jobs.map((j) => j.providerOrganizationId))].sort();
  for (let i = cursor.steps.suppression; i < organizations.length; i++) {
    await ports.reconcileSuppression(organizations[i]!);
    cursor.steps.suppression = i + 1;
    await persist(cursor);
  }

  for (let i = cursor.steps.tombstones; i < ledger.tombstones.length; i++) {
    const { scope, tombstone } = ledger.tombstones[i]!;
    if (!(await ports.getTombstone(scope, tombstone.sourceId))) {
      await ports.putTombstone(scope, tombstone);
      applied.tombstones++;
    }
    cursor.steps.tombstones = i + 1;
    await persist(cursor);
  }

  // Verification reads the database again: DONE is a statement about its state, not about the loops above.
  const pending: string[] = [];
  let behind = 0;
  let gaps = 0;
  for (const job of ledger.jobs) {
    const current = await ports.getJob(scopeOf(job), job.requestKey);
    if (!current || current.history.length < job.history.length) behind++;
    gaps += await ports.suppressionGap(job);
  }
  let missingTombstones = 0;
  for (const { scope, tombstone } of ledger.tombstones)
    if (!(await ports.getTombstone(scope, tombstone.sourceId))) missingTombstones++;
  if (behind > 0) pending.push(`erasure jobs missing or behind: ${behind}`);
  if (gaps > 0) pending.push(`suppression rows missing: ${gaps}`);
  if (missingTombstones > 0) pending.push(`source tombstones missing: ${missingTombstones}`);
  for (const name of REQUIRED_ATTESTATIONS)
    if (!cursor.attestations[name]) pending.push(`attestation required: ${name}`);
  return { done: pending.length === 0, notice: REAPPLY_NOTICE, applied, pending };
}
