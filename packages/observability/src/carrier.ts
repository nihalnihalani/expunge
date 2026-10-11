import type { SubagentRun } from 'raindrop-ai';
import type { Episode } from './episode.js';
import type { RaindropTracing } from './tracing.js';

/** The three headers a dispatch carrier needs. Send ALL of them: instrumentation rewrites traceparent and baggage. */
export const CARRIER_HEADERS = ['traceparent', 'baggage', 'x-raindrop-handoff'] as const;
export type CarrierHeaderName = (typeof CARRIER_HEADERS)[number];
export type CarrierHeaders = Partial<Record<CarrierHeaderName, string>>;

export type DispatchedCarrier = {
  childEventId: string;
  /** Headers to forward through AUTHENTICATED internal dispatch. Empty when no span could be recorded. */
  headers: Record<string, string>;
  /** False when tracing is disabled: there is nothing to link to, and no link is invented. */
  linked: boolean;
};

/**
 * Parent side of a detached dispatch (worker -> grader, observer -> improver...). The child's event id is
 * preallocated (a stable domain job id) so the link resolves while the child is still queued.
 */
export function dispatchSubagent(
  episode: Episode,
  options: { name: string; childEventId: string; input?: unknown },
): DispatchedCarrier {
  const dispatch = episode.interaction.subagent({
    name: options.name,
    childEventId: options.childEventId,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return {
    childEventId: dispatch.childEventId,
    headers: dispatch.carrier ? dispatch.headers : {},
    linked: dispatch.carrier !== null,
  };
}

/**
 * Picks the carrier headers out of an incoming request's headers. Call this ONLY for requests that already passed
 * service authentication: a carrier names the event the child will be attributed to, so an unauthenticated one is an
 * attribution-forging channel. Returns null when none is present (an unlinked run is legitimate).
 */
export function pickCarrierHeaders(
  incoming: Readonly<Record<string, string | string[] | undefined>>,
): CarrierHeaders | null {
  const lower = new Map(Object.entries(incoming).map(([name, value]) => [name.toLowerCase(), value]));
  const picked: CarrierHeaders = {};
  for (const name of CARRIER_HEADERS) {
    const value = lower.get(name);
    const single = Array.isArray(value) ? value[0] : value;
    if (single) picked[name] = single;
  }
  return Object.keys(picked).length ? picked : null;
}

/** True when the handoff header (the one nothing rewrites) is present alongside the standard pair. */
export function carrierIsComplete(headers: CarrierHeaders | null): boolean {
  return Boolean(headers?.traceparent && headers.baggage && headers['x-raindrop-handoff']);
}

/** Child side: runs `fn` as the detached sub-agent's own run, linked to the dispatching context when a carrier arrived. */
export function runAsSubagent<T>(
  tracing: RaindropTracing,
  headers: CarrierHeaders | null,
  options: { name: string; eventId: string; userId: string; convoId?: string },
  fn: (run: SubagentRun) => Promise<T>,
): Promise<T> {
  return tracing.client.withSubagentRun(headers, fn, {
    name: options.name,
    eventId: options.eventId,
    userId: options.userId,
    ...(options.convoId ? { convoId: options.convoId } : {}),
  });
}
