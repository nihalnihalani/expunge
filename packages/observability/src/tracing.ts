import { createHash } from 'node:crypto';
import { trace, type Tracer } from '@opentelemetry/api';
import { Raindrop } from 'raindrop-ai';
import type { RaindropWriteConfig } from './config.js';

/**
 * One tracing initialization per process. The Raindrop SDK owns the global OpenTelemetry tracer provider (its own
 * NodeSDK); initializing it twice, or beside another global provider, produces competing exporters. A second call with
 * the SAME configuration returns the existing instance; with a different one it throws instead of silently re-routing
 * telemetry.
 */
export class RaindropTracing {
  constructor(
    readonly client: Raindrop,
    readonly config: Readonly<Omit<RaindropWriteConfig, 'writeKey'>>,
    readonly tracer: Tracer,
  ) {}
  /** Drains buffered telemetry. Call once at process shutdown. */
  close(): Promise<void> {
    return this.client.close();
  }
}

let current: { identity: string; tracing: RaindropTracing } | undefined;

const identityOf = (config: RaindropWriteConfig) =>
  createHash('sha256')
    .update(JSON.stringify([config.projectId, config.endpoint ?? '', config.writeKey]))
    .digest('hex');

export type TracingOptions = {
  /** Send spans immediately instead of batching (tests and short-lived tools). */
  disableBatching?: boolean;
  /** SDK signal/event buffer (events per flush, and flush delay). Defaults are the SDK's. Signals are BUFFERED. */
  bufferSize?: number;
  bufferTimeoutMs?: number;
};

export function initTracing(config: RaindropWriteConfig, options: TracingOptions = {}): RaindropTracing {
  const identity = identityOf(config);
  if (current) {
    if (current.identity === identity) return current.tracing;
    throw new Error('TracingAlreadyInitialized');
  }
  const client = new Raindrop({
    writeKey: config.writeKey,
    projectId: config.projectId,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    // Regex redaction is defence in depth only; the structural sanitizer in this package is the control.
    redactPii: true,
    // Never mirror telemetry to a local debugger/Workshop daemon.
    localWorkshopUrl: false,
    debugLogs: false,
    maxTextFieldChars: 20_000,
    ...(options.disableBatching !== undefined ? { disableBatching: options.disableBatching } : {}),
    ...(options.bufferSize !== undefined ? { bufferSize: options.bufferSize } : {}),
    ...(options.bufferTimeoutMs !== undefined ? { bufferTimeout: options.bufferTimeoutMs } : {}),
  });
  const { writeKey: _writeKey, ...publicConfig } = config;
  const tracing = new RaindropTracing(client, publicConfig, trace.getTracer('expunge', '0.1.0'));
  current = { identity, tracing };
  return tracing;
}

/** The process's tracing instance, if initialized. */
export function currentTracing(): RaindropTracing | undefined {
  return current?.tracing;
}

/** Drains and forgets the process's tracing instance (process shutdown; tests). */
export async function closeTracing(): Promise<void> {
  const existing = current;
  current = undefined;
  await existing?.tracing.close();
}
