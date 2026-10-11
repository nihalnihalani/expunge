import type { Environment, ScopeKey } from '@expunge/contracts';

/** The three inbound principals. The worker wake token is outbound (domain to worker) and is not one of them. */
export type ServicePrincipal = 'read' | 'job_write' | 'approval';

export const MIN_SERVICE_TOKEN_LENGTH = 24;
const ENVIRONMENTS: readonly Environment[] = ['dev', 'evaluation', 'demo'];

export type ServiceConfig = {
  /** The one owner and scope every inbound principal is bound to. Nothing in a request can change either. */
  owner: { ownerId: string; scope: ScopeKey };
  /** `read` is required; a write principal that is not configured makes its routes unavailable (501), never open. */
  tokens: { read: string; job_write?: string; approval?: string };
  /** Outbound: where and with which credential the service wakes a worker after it queues a job. */
  wake?: { origin: string; token: string };
  /** The frozen worker profile a submitted job is pinned to; without it submission is unsupported. */
  workerProfileHash?: string;
  previewTtlMs: number;
};

/** A configuration problem, described by variable names only. Values are never reported. */
export class ServiceConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`ServiceConfigError:${problems.join(',')}`);
    this.name = 'ServiceConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Reads the service configuration from the environment. Each token must be at least 24 characters and the tokens
 * must be pairwise different, so one leaked credential can never act as another principal. The owner and scope are
 * taken from trusted configuration here; no request header or body ever supplies them.
 */
export function serviceConfigFromEnv(env: Env): ServiceConfig {
  const problems: string[] = [];
  const text = (name: string) => env[name]?.trim() ?? '';
  const token = (name: string, required: boolean): string | undefined => {
    const value = text(name);
    if (!value) {
      if (required) problems.push(`${name}:missing`);
      return undefined;
    }
    if (value.length < MIN_SERVICE_TOKEN_LENGTH) problems.push(`${name}:too_short`);
    return value;
  };
  const read = token('EXPUNGE_INTERNAL_TOKEN', true);
  const jobWrite = token('EXPUNGE_JOB_WRITE_TOKEN', false);
  const approval = token('EXPUNGE_APPROVAL_TOKEN', false);
  const wakeToken = token('EXPUNGE_WAKE_TOKEN', false);
  const present = [
    ['EXPUNGE_INTERNAL_TOKEN', read],
    ['EXPUNGE_JOB_WRITE_TOKEN', jobWrite],
    ['EXPUNGE_APPROVAL_TOKEN', approval],
    ['EXPUNGE_WAKE_TOKEN', wakeToken],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  for (let left = 0; left < present.length; left++)
    for (let right = left + 1; right < present.length; right++)
      if (present[left]![1] === present[right]![1])
        problems.push(`${present[left]![0]}=${present[right]![0]}:tokens_must_differ`);

  const ownerId = text('OWNER_ID');
  if (!ownerId) problems.push('OWNER_ID:missing');
  const tenantId = text('EXPUNGE_TENANT_ID');
  const scopeId = text('EXPUNGE_SCOPE_ID');
  const scopeEnv = text('EXPUNGE_ENV');
  if (!tenantId) problems.push('EXPUNGE_TENANT_ID:missing');
  if (!scopeId) problems.push('EXPUNGE_SCOPE_ID:missing');
  if (!ENVIRONMENTS.includes(scopeEnv as Environment)) problems.push('EXPUNGE_ENV:invalid');

  const workerUrl = text('EXPUNGE_WORKER_URL');
  if (workerUrl && !validOrigin(workerUrl)) problems.push('EXPUNGE_WORKER_URL:invalid');
  if (workerUrl && !wakeToken) problems.push('EXPUNGE_WAKE_TOKEN:missing');
  const profile = text('EXPUNGE_WORKER_PROFILE_HASH');
  if (profile && !/^[a-f0-9]{64}$/.test(profile)) problems.push('EXPUNGE_WORKER_PROFILE_HASH:invalid');

  if (problems.length > 0 || !read) throw new ServiceConfigError(problems);
  return {
    owner: { ownerId, scope: { tenantId, env: scopeEnv as Environment, scopeId } },
    tokens: {
      read,
      ...(jobWrite ? { job_write: jobWrite } : {}),
      ...(approval ? { approval } : {}),
    },
    ...(workerUrl && wakeToken ? { wake: { origin: workerUrl, token: wakeToken } } : {}),
    ...(profile ? { workerProfileHash: profile } : {}),
    previewTtlMs: 15 * 60 * 1000,
  };
}
