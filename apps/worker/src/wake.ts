import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { carrierIsComplete, pickCarrierHeaders, type CarrierHeaders } from '@expunge/observability';
import { z } from 'zod';
import type { Readiness } from './readiness.js';

/** The ONLY fields a wake command carries. Actor, scope, harness and budget come from the stored job. */
export const wakeCommandSchema = z
  .object({
    jobId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    commandId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();
export type WakeCommand = z.infer<typeof wakeCommandSchema>;

export type WakeDecision = 'accepted' | 'duplicate';

/** Idempotency record for wake commands, keyed by commandId. */
export interface WakeCommandStore {
  accept(command: WakeCommand): Promise<WakeDecision>;
  /**
   * Best-effort: forget a command that was accepted but could not be queued. The durable Mongo store is insert-only
   * for the worker principal and cannot do this; delivery then relies on the recovery poll.
   */
  release(command: WakeCommand): Promise<void>;
}

/**
 * Process-local dedupe for tests and for a worker started without a database. A restart forgets commandIds, so a
 * replayed wake may be delivered again; that is safe (claim is fenced) but not durable. Production uses
 * MongoWakeCommandStore (wiring.ts), which stores each commandId once in `wake_commands`.
 */
export class InMemoryWakeCommandStore implements WakeCommandStore {
  private readonly seen = new Set<string>();
  constructor(private readonly limit = 10_000) {}
  async accept(command: WakeCommand): Promise<WakeDecision> {
    if (this.seen.has(command.commandId)) return 'duplicate';
    this.seen.add(command.commandId);
    if (this.seen.size > this.limit) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return 'accepted';
  }
  async release(command: WakeCommand): Promise<void> {
    this.seen.delete(command.commandId);
  }
}

export function authenticateWake(authorization: string | undefined, expectedToken: string): boolean {
  if (!expectedToken || !authorization?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export interface WakeTarget {
  /** True when a wake would be queued now. Checked BEFORE a command id is recorded, so a full queue never burns one. */
  canAccept(): boolean;
  /**
   * Queues the job for the dispatcher. Returns false when the bounded queue is full or the worker is stopping. `carrier`
   * is the trace context of the AUTHENTICATED dispatching service, present only when complete; it links telemetry and
   * never carries authority.
   */
  wake(command: WakeCommand, carrier?: CarrierHeaders | null): boolean;
}

const MAX_BODY_BYTES = 1024;
/** A trace context is a few hundred bytes; anything larger is not a carrier. */
const MAX_CARRIER_VALUE_LENGTH = 2048;

/** The carrier of an already-authenticated request, or null when absent, incomplete or oversized. */
export function carrierOf(headers: IncomingMessage['headers']): CarrierHeaders | null {
  const picked = pickCarrierHeaders(headers);
  if (!picked || !carrierIsComplete(picked)) return null;
  return Object.values(picked).every((value) => value.length <= MAX_CARRIER_VALUE_LENGTH) ? picked : null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Authenticated wake endpoint plus health/readiness. Wake responses never disclose whether a job exists
 * or who owns it. While readiness is BLOCKED the worker refuses wakes (503) instead of claiming jobs.
 */
export function createWakeServer(options: {
  token: string;
  store: WakeCommandStore;
  target: WakeTarget;
  readiness: () => Readiness;
}): Server {
  return createServer(async (req, res) => {
    try {
      const path = req.url ?? '';
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'alive' });
      if (req.method === 'GET' && path === '/readyz') {
        const readiness = options.readiness();
        return send(res, readiness.status === 'READY' ? 200 : 503, {
          status: readiness.status,
          lines: readiness.lines,
          checks: readiness.checks,
          reachability: readiness.reachability,
          notes: readiness.notes ?? [],
        });
      }
      if (req.method !== 'POST' || path !== '/internal/wake') return send(res, 404, { error: 'NotFound' });
      if (!authenticateWake(req.headers.authorization, options.token))
        return send(res, 401, { error: 'Unauthorized' });
      if (!req.headers['content-type']?.startsWith('application/json'))
        return send(res, 415, { error: 'UnsupportedMediaType' });
      const readiness = options.readiness();
      if (readiness.status !== 'READY')
        return send(res, 503, { error: 'Blocked', blockers: readiness.blockers.map((b) => b.code) });
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, { error: 'PayloadTooLarge' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'InvalidCommand' });
      }
      const command = wakeCommandSchema.safeParse(parsed);
      if (!command.success) return send(res, 400, { error: 'InvalidCommand' });
      if (!options.target.canAccept()) return send(res, 429, { error: 'Busy' });
      const decision = await options.store.accept(command.data);
      if (decision === 'duplicate') return send(res, 200, { status: 'duplicate' });
      if (!options.target.wake(command.data, carrierOf(req.headers))) {
        // A race between canAccept and wake. The id may stay recorded (durable stores are insert-only), which is safe:
        // the job is still queued and the recovery poll will pick it up.
        await options.store.release(command.data);
        return send(res, 429, { error: 'Busy' });
      }
      return send(res, 202, { status: 'accepted' });
    } catch {
      return send(res, 500, { error: 'Internal' });
    }
  });
}
