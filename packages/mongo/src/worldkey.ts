import type { Job, RunBinding, ScopeKey } from '@expunge/contracts';
import { fail } from './client.js';

const BRAND: unique symbol = Symbol('expunge.worldKey');
/** Keys this module issued. A copy or a hand-built look-alike is not in the set, so it is refused at run time. */
const ISSUED = new WeakSet<object>();

/**
 * The only way to name a world to a repository: a key derived from a stored job's run binding, or from the
 * stored scope binding of a world that exists under a trusted scope. The brand is a module-private symbol, so a
 * bare string, a plain object or a request value cannot be passed where a WorldKey is required, in types or at
 * run time. A model or HTTP caller can name a job handle; it can never name a world.
 */
export type WorldKey = Readonly<
  ScopeKey & {
    worldId: string;
    scopeRevision: number;
    /** The job this capability belongs to, when it came from a job. */
    jobId: string | null;
  }
> & { readonly [BRAND]: true };

function make(scope: ScopeKey, worldId: string, scopeRevision: number, jobId: string | null): WorldKey {
  if (!worldId || !Number.isSafeInteger(scopeRevision) || scopeRevision < 1) fail('InvalidWorldKey');
  const key = Object.freeze({
    tenantId: scope.tenantId,
    env: scope.env,
    scopeId: scope.scopeId,
    worldId,
    scopeRevision,
    jobId,
    [BRAND]: true as const,
  });
  ISSUED.add(key);
  return key;
}
/** The world a job is bound to, from its stored actor scope and run binding. */
export function worldKeyOf(job: Pick<Job, '_id' | 'actor'> & { binding: RunBinding }): WorldKey {
  return make(job.actor, job.binding.worldId, job.binding.scopeRevision, job._id);
}
/**
 * Used by `WorldRepository.bind` after it has read the world's stored binding under `scope`. Not for callers
 * that hold an unchecked world id.
 */
export function worldKeyFromStoredBinding(
  scope: ScopeKey,
  stored: { worldId: string; scopeRevision: number },
): WorldKey {
  return make(scope, stored.worldId, stored.scopeRevision, null);
}
export function isWorldKey(value: unknown): value is WorldKey {
  return typeof value === 'object' && value !== null && ISSUED.has(value);
}
export function assertWorldKey(value: unknown): asserts value is WorldKey {
  if (!isWorldKey(value)) fail('InvalidWorldKey');
}
