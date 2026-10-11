import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import type { ScopeKey } from '@expunge/contracts';
import { GuardFileError, parseGuardFile, type LeakGuard } from '@expunge/observability';
import type { ObserverWindow } from './process.js';

type Env = Readonly<Record<string, string | undefined>>;

/** A configuration problem named by variable only; the file's contents and the values are never reported. */
export class EvidenceSourceError extends Error {
  constructor(readonly variable: string) {
    super(`EvidenceSourceError:${variable}`);
    this.name = 'EvidenceSourceError';
  }
}

/**
 * The leak guard the privacy controller exports (`exportGuardFile` in @expunge/privacy): subject handles as forbidden
 * literals and optionally the grader's salted private-id set, with the scope, provider organization, count and digest.
 * The observer principal cannot read the subject map, so the guard arrives as a file named by EXPUNGE_LEAK_GUARD_FILE
 * (owner-only mode, mounted read-only). The file holds subject literals in PLAINTEXT on this process's filesystem.
 *
 * Verified here: the file is not group/other accessible, it is for THIS scope and provider organization, the count and
 * digest match its content (not truncated or edited), and a malformed `privateIds` block is refused rather than dropped.
 * The digest is UNKEYED (a plain content hash): it detects truncation and accidental edits, not a deliberate forgery by whoever
 * can write the file (that party can recompute it); the file's integrity rests on its owner-only mode and read-only mount. The
 * organization check compares this process's configuration with the value the exporter was configured with; both come from
 * configuration, so it catches a mix-up between deployments, not a wrong organization configured in both places.
 * Freshness: `guardFreshness` compares the file's generation and digest with the latest `guard_exports` row the privacy
 * controller recorded; anything but an exact match HOLDs the process. The file is read once at start, so a newer export
 * stops the process (exit 3) and a restart re-reads it. Absent => undefined, so the process stays BLOCKED; invalid => throws.
 */
export function loadGuardFile(
  path: string | undefined,
  expected: { scope: ScopeKey; providerOrganizationId: string },
): LeakGuard | undefined {
  return loadGuardFileWithMeta(path, expected)?.guard;
}

export type LoadedGuard = { guard: LeakGuard; generation: number; digest: string };

export function loadGuardFileWithMeta(
  path: string | undefined,
  expected: { scope: ScopeKey; providerOrganizationId: string },
): LoadedGuard | undefined {
  if (!path?.trim()) return undefined;
  try {
    // Stat and read the SAME open file (no stat-then-read gap in which the path could be swapped).
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0)
        throw new EvidenceSourceError('EXPUNGE_LEAK_GUARD_FILE:mode');
      const parsed = parseGuardFile(readFileSync(fd, 'utf8'), expected);
      return { guard: parsed.guard, generation: parsed.generation, digest: parsed.digest };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof EvidenceSourceError) throw error;
    if (error instanceof GuardFileError)
      throw new EvidenceSourceError(`EXPUNGE_LEAK_GUARD_FILE:${error.reason}`);
    throw new EvidenceSourceError('EXPUNGE_LEAK_GUARD_FILE:unreadable');
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * The fixed observer window from configuration: EXPUNGE_OBSERVER_WINDOW_START and _END (UTC ISO instants, both or
 * neither), EXPUNGE_OBSERVER_VERSION (default v1) and optional EXPUNGE_OBSERVER_EVENT_NAME. Moving the window is a new
 * observer version, never an automatic slide (see the cursor identity in scan.ts).
 */
export function windowFromEnv(env: Env): ObserverWindow | undefined {
  const start = env.EXPUNGE_OBSERVER_WINDOW_START?.trim();
  const end = env.EXPUNGE_OBSERVER_WINDOW_END?.trim();
  if (!start && !end) return undefined;
  if (!start || !end || !ISO.test(start) || !ISO.test(end) || Date.parse(start) >= Date.parse(end))
    throw new EvidenceSourceError('EXPUNGE_OBSERVER_WINDOW_START/EXPUNGE_OBSERVER_WINDOW_END');
  const version = env.EXPUNGE_OBSERVER_VERSION?.trim() || 'v1';
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) throw new EvidenceSourceError('EXPUNGE_OBSERVER_VERSION');
  const eventName = env.EXPUNGE_OBSERVER_EVENT_NAME?.trim();
  return {
    filter: eventName ? { eventName } : {},
    windowStart: start,
    windowEnd: end,
    observerVersion: version,
  };
}

/** The slice of GuardExportRepository the observer reads (observer holds FIND on `guard_exports` and the generation row). */
export interface GuardExportReader {
  status(
    scope: ScopeKey,
    providerOrganizationId: string,
  ): Promise<{
    latest: { generation: number; digest: string } | null;
    subjectSetGeneration: number;
    covered: boolean;
  }>;
}

/**
 * Whether the guard this process holds is the latest one the privacy controller exported AND covers the current subject set.
 * `fresh` only on an exact generation and digest match with `covered` true; never exported, a newer export, an older file, a
 * digest mismatch, a subject registered after the export (`subject_set_ahead`) or an unreadable record are each a reason to
 * HOLD (the caller must not send). An unreadable record is a HOLD, never a pass.
 */
export async function guardFreshness(
  reader: GuardExportReader,
  expected: { scope: ScopeKey; providerOrganizationId: string },
  held: { generation: number; digest: string },
): Promise<'fresh' | 'never_exported' | 'stale' | 'digest_mismatch' | 'subject_set_ahead' | 'unreadable'> {
  let status;
  try {
    status = await reader.status(expected.scope, expected.providerOrganizationId);
  } catch {
    return 'unreadable';
  }
  if (!status.latest) return 'never_exported';
  if (status.latest.generation !== held.generation) return 'stale';
  if (status.latest.digest !== held.digest) return 'digest_mismatch';
  return status.covered ? 'fresh' : 'subject_set_ahead';
}

/**
 * The guard watch: `check()` is the freshness verdict. `isFresh()` answers a drain/scan gate with one fresh check (never a
 * cached pass); the interval is the backstop that calls `onStale(verdict)` once when a check is not fresh, after which the
 * watch is stopped. Timers are injectable through the global clock so a test can drive them with fake timers.
 */
export function startGuardWatch(options: {
  check: () => Promise<'fresh' | string>;
  intervalMs: number;
  onStale: (verdict: string) => void;
}): { isFresh(): Promise<boolean>; stop(): void } {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void options.check().then(
      (verdict) => {
        if (verdict === 'fresh' || stopped) return;
        stopped = true;
        clearInterval(timer);
        options.onStale(verdict);
      },
      () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        options.onStale('unreadable');
      },
    );
  }, options.intervalMs);
  return {
    async isFresh() {
      if (stopped) return false;
      try {
        return (await options.check()) === 'fresh';
      } catch {
        return false;
      }
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
