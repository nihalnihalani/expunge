import { contentHash, type ScopeKey } from '@expunge/contracts';
import { requireGuard, type LeakGuard } from './leak.js';

/**
 * The leak-guard file format shared by its producer (the privacy controller's exporter) and its consumer (the evidence
 * process). The file carries its own scope, provider organization, entry count and digest so a consumer can refuse a file
 * that is for another scope or organization, truncated, or edited. It holds subject literals in PLAINTEXT: treat it as
 * sensitive on the filesystem (mode 0600, mounted read-only, never logged or committed).
 *
 * What the digest does NOT prove: that the file is the CURRENT generation of the subject set. A newer registration after
 * export is invisible to a running consumer; a Mongo generation row to compare against is a recorded follow-up.
 */
export const GUARD_FILE_FORMAT = 'expunge-guard-v1';

export type GuardFile = {
  format: typeof GUARD_FILE_FORMAT;
  scope: ScopeKey;
  providerOrganizationId: string;
  /** The export generation recorded in `guard_exports` by the privacy controller; the observer HOLDs when it is not the latest. */
  generation: number;
  generatedAt: string;
  count: number;
  digest: string;
  forbiddenLiterals: string[];
  privateIds?: { salt: string; hashes: string[] };
};

export class GuardFileError extends Error {
  constructor(readonly reason: string) {
    super(`GuardFileError:${reason}`);
    this.name = 'GuardFileError';
  }
}

const body = (guard: LeakGuard) => ({
  forbiddenLiterals: [...guard.forbiddenLiterals].sort(),
  privateIds: guard.privateIds
    ? { salt: guard.privateIds.salt, hashes: [...guard.privateIds.hashes].sort() }
    : null,
});
export const guardDigest = (guard: LeakGuard): string => contentHash(body(guard), 'leak-guard-file');

export function serializeGuardFile(
  guard: LeakGuard,
  meta: { scope: ScopeKey; providerOrganizationId: string; generation: number; now?: Date },
): string {
  requireGuard(guard);
  const file: GuardFile = {
    format: GUARD_FILE_FORMAT,
    scope: { tenantId: meta.scope.tenantId, env: meta.scope.env, scopeId: meta.scope.scopeId },
    providerOrganizationId: meta.providerOrganizationId,
    generation: meta.generation,
    generatedAt: (meta.now ?? new Date()).toISOString(),
    count: guard.forbiddenLiterals.length + (guard.privateIds?.hashes.length ?? 0),
    digest: guardDigest(guard),
    forbiddenLiterals: [...guard.forbiddenLiterals],
    ...(guard.privateIds
      ? { privateIds: { salt: guard.privateIds.salt, hashes: [...guard.privateIds.hashes] } }
      : {}),
  };
  return JSON.stringify(file);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Parses and verifies a guard file against the scope and provider organization the consumer serves. Refuses (never
 * silently drops) a malformed `privateIds` block, a wrong format, another scope or organization, a count or digest mismatch.
 * Errors carry a closed reason, never file contents.
 */
export function parseGuardFile(
  text: string,
  expected: { scope: ScopeKey; providerOrganizationId: string },
): { guard: LeakGuard; generation: number; generatedAt: string; count: number; digest: string } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new GuardFileError('not_json');
  }
  if (raw.format !== GUARD_FILE_FORMAT) throw new GuardFileError('format');
  const scope = raw.scope as Partial<ScopeKey> | undefined;
  if (
    !scope ||
    scope.tenantId !== expected.scope.tenantId ||
    scope.env !== expected.scope.env ||
    scope.scopeId !== expected.scope.scopeId
  )
    throw new GuardFileError('scope_mismatch');
  if (raw.providerOrganizationId !== expected.providerOrganizationId)
    throw new GuardFileError('organization_mismatch');
  if (!isStrings(raw.forbiddenLiterals)) throw new GuardFileError('forbiddenLiterals');
  let privateIds: LeakGuard['privateIds'];
  if (raw.privateIds !== undefined) {
    const p = raw.privateIds as { salt?: unknown; hashes?: unknown } | null;
    if (!p || typeof p.salt !== 'string' || !isStrings(p.hashes)) throw new GuardFileError('privateIds');
    privateIds = { salt: p.salt, hashes: p.hashes };
  }
  const guard: LeakGuard = {
    forbiddenLiterals: raw.forbiddenLiterals,
    ...(privateIds ? { privateIds } : {}),
  };
  const count = guard.forbiddenLiterals.length + (privateIds?.hashes.length ?? 0);
  if (raw.count !== count) throw new GuardFileError('count_mismatch');
  if (raw.digest !== guardDigest(guard)) throw new GuardFileError('digest_mismatch');
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt)))
    throw new GuardFileError('generatedAt');
  if (typeof raw.generation !== 'number' || !Number.isSafeInteger(raw.generation) || raw.generation < 1)
    throw new GuardFileError('generation');
  requireGuard(guard);
  return {
    guard,
    generation: raw.generation,
    generatedAt: raw.generatedAt,
    count,
    digest: raw.digest as string,
  };
}
