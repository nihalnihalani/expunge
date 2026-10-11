/**
 * Shared helpers for the reliability and containment probes.
 *
 * Everything here talks to real sockets, real child processes and (for the live lanes) a real local replica set.
 * Anything that stands in for a product component is labeled FAKE in its name. Nothing in this directory is
 * evidence about Atlas, a model provider, Raindrop or CopilotKit Intelligence.
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import type { Server } from 'node:http';
import { describe, it } from 'vitest';

export const REQUIRE_LIVE = process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1';

/** A suite that runs when `ready` is true, skips otherwise, and FAILS when live suites are required. */
export function liveGate(ready: boolean, what: string, reason: string): typeof describe {
  return ((name: string, factory: () => void) => {
    if (ready) return describe(name, factory);
    if (!REQUIRE_LIVE) return describe.skip(`${name} [skipped: ${reason}]`, factory);
    return describe(name, () => {
      it(`requires ${what} (EXPUNGE_REQUIRE_LIVE_TESTS=1): ${reason}`, () => {
        throw new Error(`${what} is not available but live suites are required: ${reason}`);
      });
    });
  }) as typeof describe;
}

export function dockerAvailable(): boolean {
  return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 }).status === 0;
}

export function containerRunning(name: string): boolean {
  const r = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', name], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

export function imagePresent(image: string): boolean {
  return spawnSync('docker', ['image', 'inspect', image], { timeout: 5000 }).status === 0;
}

/** Listens on an ephemeral loopback port; resolves the port. */
export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export type RawReply = { text: string; statuses: number[]; closed: boolean; error?: string };

/** Sends exact bytes on a fresh TCP connection and collects everything received within `windowMs`. */
export function rawExchange(port: number, payload: string | Buffer, windowMs = 1500): Promise<RawReply> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let closed = false;
    let error: string | undefined;
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = () => {
      socket.destroy();
      const text = Buffer.concat(chunks).toString('latin1');
      const statuses = [...text.matchAll(/^HTTP\/1\.[01] (\d{3})/gm)].map((m) => Number(m[1]));
      resolve({ text, statuses, closed, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(finish, windowMs);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', (err) => {
      error = (err as NodeJS.ErrnoException).code ?? err.message;
      clearTimeout(timer);
      finish();
    });
    socket.once('close', () => {
      closed = true;
      clearTimeout(timer);
      finish();
    });
    socket.once('connect', () => socket.write(payload));
  });
}

/** One well-formed JSON POST, returned as { status, body, headers }. */
export async function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('TimedOutWaiting');
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
