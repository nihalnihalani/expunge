import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import type { ScopeKey } from '@expunge/contracts';
import { GuardFileError, parseGuardFile, type LeakGuard } from '@expunge/observability';
import { ErasureSuppressionRepository, type MongoService } from '@expunge/mongo';
import type { ExportSuppression } from './outbox-dispatcher.js';
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
 * Not verified: that it is the current generation of the subject set (follow-up: a Mongo generation row). It is read once at
 * start; a changed subject set needs a restart. Absent => undefined, so the process stays BLOCKED; invalid => throws.
 */
export function loadGuardFile(
  path: string | undefined,
  expected: { scope: ScopeKey; providerOrganizationId: string },
): LeakGuard | undefined {
  if (!path?.trim()) return undefined;
  try {
    // Stat and read the SAME open file (no stat-then-read gap in which the path could be swapped).
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0)
        throw new EvidenceSourceError('EXPUNGE_LEAK_GUARD_FILE:mode');
      return parseGuardFile(readFileSync(fd, 'utf8'), expected).guard;
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

/** The export-suppression source: users under an active erasure, read with the observer principal's own FIND right. */
export function suppressionFromService(service: MongoService): ExportSuppression {
  const repository = new ErasureSuppressionRepository(service);
  return {
    suppressedUserIds: async (providerOrganizationId) =>
      new Set(await repository.activeUserKeys(providerOrganizationId)),
  };
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
