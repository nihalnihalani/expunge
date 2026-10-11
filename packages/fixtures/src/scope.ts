import { contentHash, scopeIdentity } from '@expunge/contracts';
import type { Environment, ScopeKey, WorldSpec } from '@expunge/contracts';
import { WorldSpecError } from './types.js';

/**
 * The one default binding for synthetic evaluation worlds. World hashing and the emitted registry scope both
 * read this resolved value, so an implicit default and the explicit equivalent are indistinguishable.
 */
export const DEFAULT_SCOPE_KEY: Readonly<ScopeKey> = Object.freeze({
  tenantId: 'synthetic-evaluation-tenant',
  env: 'evaluation',
  scopeId: 'synthetic-evaluation-scope',
});

const ENVIRONMENTS: readonly Environment[] = ['dev', 'evaluation', 'demo'];
const MAX_IDENTIFIER_LENGTH = 256;

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

/**
 * Select exactly {tenantId, env, scopeId} from a trusted binding. Extra ActorContext keys (actorId,
 * authorizationRevision, or anything else) never reach a hash or a document. Identifier values are opaque:
 * they are validated but never trimmed, case-folded or otherwise normalized.
 */
export function resolveScopeKey(binding?: unknown): ScopeKey {
  if (binding === undefined) return { ...DEFAULT_SCOPE_KEY };
  if (binding === null || typeof binding !== 'object') throw new WorldSpecError(['trusted_scope_binding']);
  const { tenantId, env, scopeId } = binding as Record<string, unknown>;
  if (!isIdentifier(tenantId) || !isIdentifier(scopeId) || !ENVIRONMENTS.includes(env as Environment)) {
    throw new WorldSpecError(['trusted_scope_binding']);
  }
  return { tenantId, env: env as Environment, scopeId };
}

/** Domain-separated world identity over the spec commitment, private seed and the selected scope key only. */
export function worldIdFor(specHash: string, seed: string, scope: ScopeKey): string {
  const digest = contentHash({ specHash, seed, scope: scopeIdentity(scope) }, 'world');
  return `world_${digest.slice(0, 24)}`;
}

/**
 * A distinct ScopeKey for one world instance under a base tenant/environment. The scope registry row is keyed
 * by the ScopeKey, so worlds seeded side by side into one database each need their own scopeId. The derivation
 * excludes the world ID, so the result can be passed back to `generateWorld` as the explicit binding.
 *
 * TRUSTED USE ONLY: the derived scope is produced by the trusted fixture builder from server configuration
 * (`base`), never from model, client or Hider arguments.
 */
export function deriveWorldScopeKey(
  spec: WorldSpec,
  seed: string,
  base: ScopeKey = DEFAULT_SCOPE_KEY,
): ScopeKey {
  const { tenantId, env } = resolveScopeKey(base);
  const digest = contentHash(
    { specHash: contentHash(spec, 'world-spec'), seed, tenantId, env },
    'world-scope',
  );
  return { tenantId, env, scopeId: `scope_${digest.slice(0, 24)}` };
}
