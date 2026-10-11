import { timingSafeEqual } from 'node:crypto';
import { MIN_SERVICE_TOKEN_LENGTH, type ServiceConfig, type ServicePrincipal } from './config.js';

export type AuthResult =
  | { ok: true; principal: ServicePrincipal }
  | { ok: false; status: 401 | 403; error: 'unauthorized' | 'forbidden' };

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Authenticates a request to exactly one principal, and checks that the request names the owner this service is bound
 * to. Every configured token is compared (no early exit on a match) so timing does not say which one was close.
 * A request can claim an owner header but the binding is configuration: a different owner is refused, a missing
 * owner header is refused, and no scope is ever read from the request.
 */
export function authenticate(request: Request, config: ServiceConfig): AuthResult {
  const header = request.headers.get('authorization');
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  let principal: ServicePrincipal | null = null;
  for (const name of ['read', 'job_write', 'approval'] as const) {
    const expected = config.tokens[name];
    if (expected && expected.length >= MIN_SERVICE_TOKEN_LENGTH && equal(presented, expected))
      principal = name;
  }
  if (!principal) return { ok: false, status: 401, error: 'unauthorized' };
  if (request.headers.get('x-expunge-owner-id') !== config.owner.ownerId)
    return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, principal };
}

/** Which principal may call which route family. A token never works outside its own family. */
export const ROUTE_PRINCIPAL: Readonly<Record<string, ServicePrincipal>> = {
  'GET readiness': 'read',
  'GET worlds': 'read',
  'GET jobs': 'read',
  'GET events': 'read',
  'GET artifacts': 'read',
  'GET proposals': 'read',
  'GET deployments': 'read',
  'GET threads': 'read',
  'POST previews': 'job_write',
  'POST jobs': 'job_write',
  'POST cancel': 'job_write',
  'POST decision': 'approval',
};
