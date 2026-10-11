import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

export type WorkerConfig = {
  /** Lease owner ID. Unique per process so two workers can never share a fence. */
  ownerId: string;
  leaseMs: number;
  renewEveryMs: number;
  maxConcurrent: number;
  maxQueued: number;
  phaseTimeoutMs: number;
  host: string;
  port: number;
};

function boundedInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`InvalidConfiguration:${name} must be an integer between ${min} and ${max}`);
  return value;
}

/**
 * Worker tuning from the environment. Names: EXPUNGE_WORKER_ID, EXPUNGE_WORKER_LEASE_MS (100..120000 as
 * JobRepository requires), EXPUNGE_WORKER_MAX_CONCURRENT (1..8), EXPUNGE_WORKER_MAX_QUEUED,
 * EXPUNGE_WORKER_PHASE_TIMEOUT_MS, EXPUNGE_WORKER_HOST (default loopback), EXPUNGE_WORKER_PORT.
 * No secret is read here (see readiness.ts for credentials).
 */
export function workerConfigFromEnv(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const leaseMs = boundedInt(env.EXPUNGE_WORKER_LEASE_MS, 'EXPUNGE_WORKER_LEASE_MS', 30_000, 100, 120_000);
  const suffix = randomBytes(4).toString('hex');
  const ownerId =
    env.EXPUNGE_WORKER_ID?.trim() ||
    `worker-${hostname()
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 40)}-${process.pid}-${suffix}`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) throw new Error('InvalidConfiguration:EXPUNGE_WORKER_ID');
  return {
    ownerId,
    leaseMs,
    renewEveryMs: Math.max(50, Math.floor(leaseMs / 3)),
    maxConcurrent: boundedInt(env.EXPUNGE_WORKER_MAX_CONCURRENT, 'EXPUNGE_WORKER_MAX_CONCURRENT', 2, 1, 8),
    maxQueued: boundedInt(env.EXPUNGE_WORKER_MAX_QUEUED, 'EXPUNGE_WORKER_MAX_QUEUED', 256, 1, 4096),
    phaseTimeoutMs: boundedInt(
      env.EXPUNGE_WORKER_PHASE_TIMEOUT_MS,
      'EXPUNGE_WORKER_PHASE_TIMEOUT_MS',
      120_000,
      1_000,
      600_000,
    ),
    host: env.EXPUNGE_WORKER_HOST?.trim() || '127.0.0.1',
    port: boundedInt(env.EXPUNGE_WORKER_PORT, 'EXPUNGE_WORKER_PORT', 4330, 0, 65_535),
  };
}
