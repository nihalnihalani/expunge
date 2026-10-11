import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ScopeKey } from '@expunge/contracts';
import { serializeGuardFile, type PrivateIdSet } from '@expunge/observability';
import type { SubjectTokenStore } from './ports.js';
import { guardFor } from './registry.js';

/**
 * Writes the scope's leak guard (registered subject handles, plus an optional salted private-id set) to the file the
 * evidence process reads (EXPUNGE_LEAK_GUARD_FILE in @expunge/observer), with the scope, provider organization, count and
 * digest the reader verifies. Run with the privacy controller principal; the observer principal cannot read the subject map.
 *
 * The file holds subject literals in PLAINTEXT. It is written to a temp file created exclusively (`wx`, mode 0600, never
 * following a symlink at that name), fsynced, then renamed over the target, so a reader never sees a partial file and a
 * pre-existing file's permissions or symlink are not inherited. It must be mounted read-only into the evidence container and
 * never logged or committed. A guard that may be incomplete (more entries than one read can return) is refused.
 */
export async function exportGuardFile(
  deps: { tokens: SubjectTokenStore },
  scope: ScopeKey,
  path: string,
  extra: { providerOrganizationId: string; literals?: readonly string[]; privateIds?: PrivateIdSet },
): Promise<{ literals: number; privateIdHashes: number }> {
  const guard = await guardFor(deps, scope, {
    ...(extra.literals ? { literals: extra.literals } : {}),
    ...(extra.privateIds ? { privateIds: extra.privateIds } : {}),
  });
  const text = serializeGuardFile(guard, { scope, providerOrganizationId: extra.providerOrganizationId });
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp); // never leave a plaintext temp file behind when the rename fails
    throw error;
  }
  // Make the rename itself durable: fsync the directory entry.
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return { literals: guard.forbiddenLiterals.length, privateIdHashes: guard.privateIds?.hashes.length ?? 0 };
}
