/**
 * FAKE RAINDROP SERVER for protocol and fault tests. Not Raindrop; not evidence about Raindrop's behavior or plan
 * access. It speaks just enough of the ingestion API (events/track, events/track_partial, signals/track, OTLP
 * /v1/traces) and the Query API (events list/detail, signals catalog, traces, deletions) plus a JSON-RPC /mcp, with
 * controllable faults: transient failures, auth failures, enrichment that arrives after N reads, a trace cap,
 * filter-bound cursors. Everything it records is exposed for assertions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
const otlp = require('@opentelemetry/otlp-transformer/build/src/generated/root.js');
const TraceRequest = otlp.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

export type DecodedSpan = {
  name: string;
  scope?: string;
  /** OTLP status code: 0 unset, 1 ok, 2 error. */
  status: number;
  attributes: Record<string, string | number | boolean | null>;
};

export type FakeEvent = {
  id: string;
  event_name: string;
  user_id: string;
  convo_id: string | null;
  timestamp: string;
  received_at: string;
  user_input: string | null;
  assistant_output: string | null;
  properties: Record<string, unknown>;
  feature_flags: Record<string, unknown>;
  signals?: Array<{ id: string; name: string; score: number | null }>;
  tool_calls?: Array<{ tool_name: string }>;
  error_spans?: unknown[];
  topics?: unknown[];
};

type PendingEnrichment = { afterReads: number; reads: number; apply: (event: FakeEvent) => void };

export class FakeRaindrop {
  readonly ingestEvents: Array<Record<string, unknown>> = [];
  readonly partialEvents: Array<Record<string, unknown>> = [];
  readonly signalPosts: Array<Record<string, unknown>> = [];
  readonly spans: DecodedSpan[] = [];
  readonly requests: Array<{ method: string; path: string; auth: string | null; project: string | null }> =
    [];
  readonly events = new Map<string, FakeEvent>();
  readonly signalCatalog = new Map<string, { id: string; name: string; type: string }>();
  readonly deletions = new Map<string, Record<string, any>>();
  /** Spans returned by GET /v1/traces for an event id. */
  readonly traces = new Map<string, Array<Record<string, unknown>>>();
  traceCap = 1000;
  /** When false, an accepted signal POST is NOT reflected on the event (models slow or failed enrichment). */
  attachPostedSignals = true;
  mcpTools: Array<{ name: string; description?: string; inputSchema: unknown }> | null = [];
  mcpStatus = 200;
  private readonly pending = new Map<string, PendingEnrichment[]>();
  private failures: Array<{ match: RegExp; statuses: number[]; headers?: Record<string, string> }> = [];
  private server: Server;
  private writeKey = 'test-write-key-not-real';
  private queryKey = 'test-query-key-not-real';
  /** Reads (GET) served per path, for assertions about rereads. */
  readonly reads: Record<string, number> = {};

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }
  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }
  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }
  /** Base for ingestion clients (`.../v1`). */
  get ingestUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }
  /** Base for Query clients (no /v1; the client adds paths). */
  get queryUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get mcpUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }
  keys() {
    return { writeKey: this.writeKey, queryKey: this.queryKey };
  }

  reset(): void {
    for (const list of [this.ingestEvents, this.partialEvents, this.signalPosts, this.spans, this.requests])
      list.length = 0;
    this.events.clear();
    this.signalCatalog.clear();
    this.deletions.clear();
    this.traces.clear();
    this.pending.clear();
    this.failures = [];
    this.traceCap = 1000;
    this.attachPostedSignals = true;
    for (const key of Object.keys(this.reads)) delete this.reads[key];
    this.mcpTools = [];
    this.mcpStatus = 200;
  }

  /** The next requests whose path matches get these statuses, in order, before normal handling resumes. */
  failNext(match: RegExp, statuses: number[], headers?: Record<string, string>) {
    this.failures.push({ match, statuses: [...statuses], headers });
  }

  seedEvent(event: Partial<FakeEvent> & { id: string }): FakeEvent {
    const now = new Date().toISOString();
    const full: FakeEvent = {
      event_name: 'expunge.worker',
      user_id: 'tok_seed',
      convo_id: null,
      timestamp: now,
      received_at: now,
      user_input: null,
      assistant_output: null,
      properties: {},
      feature_flags: {},
      ...event,
    };
    this.events.set(full.id, full);
    return full;
  }

  /** Makes a field appear only after `afterReads` GET reads of the event detail/list (late enrichment). */
  enrichLater(eventId: string, afterReads: number, apply: (event: FakeEvent) => void) {
    const list = this.pending.get(eventId) ?? [];
    list.push({ afterReads, reads: 0, apply });
    this.pending.set(eventId, list);
  }

  private touch(event: FakeEvent): FakeEvent {
    for (const item of this.pending.get(event.id) ?? []) {
      item.reads += 1;
      if (item.reads > item.afterReads) item.apply(event);
    }
    return event;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const auth = req.headers.authorization ?? null;
    const project = (req.headers['x-raindrop-project-id'] as string | undefined) ?? null;
    this.requests.push({ method: req.method ?? 'GET', path, auth: auth ? 'present' : null, project });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    const fault = this.failures.find(
      (entry) => entry.match.test(`${req.method} ${path}`) && entry.statuses.length,
    );
    if (fault) return send(fault.statuses.shift() as number, { error: 'injected' }, fault.headers);

    const isIngest =
      req.method === 'POST' &&
      /^\/v1\/(events\/track|events\/track_partial|signals\/track|traces)$/.test(path);
    if (isIngest) {
      if (auth !== `Bearer ${this.writeKey}`) return send(401, { error: 'bad write key' });
      return this.ingest(path, body, send);
    }
    if (path === '/mcp') return this.mcp(auth, body, send);
    if (auth !== `Bearer ${this.queryKey}`) return send(401, { error: 'bad query key' });
    this.reads[path] = (this.reads[path] ?? 0) + 1;
    return this.query(req.method ?? 'GET', path, url.searchParams, body, send);
  }

  private ingest(path: string, body: Buffer, send: (s: number, p?: unknown) => void) {
    if (path === '/v1/traces') {
      const decoded = TraceRequest.decode(body);
      for (const rs of decoded.resourceSpans)
        for (const ss of rs.scopeSpans)
          for (const span of ss.spans) {
            const attributes: DecodedSpan['attributes'] = {};
            for (const a of span.attributes) {
              const v = a.value;
              attributes[a.key] =
                v.stringValue ??
                (v.intValue != null ? Number(v.intValue) : (v.doubleValue ?? v.boolValue ?? null));
            }
            this.spans.push({
              name: span.name,
              scope: ss.scope?.name,
              status: span.status?.code ?? 0,
              attributes,
            });
          }
      return send(204);
    }
    const parsed = JSON.parse(body.toString('utf8'));
    if (path === '/v1/events/track_partial') {
      this.partialEvents.push(parsed);
      this.upsert(parsed);
      return send(204);
    }
    if (!Array.isArray(parsed)) return send(400, { error: 'array body required' });
    if (path === '/v1/events/track') {
      for (const item of parsed) {
        this.ingestEvents.push(item);
        this.upsert({
          event_id: item.event_id,
          event: item.event,
          user_id: item.user_id,
          properties: item.properties,
          ai_data: item.ai_data,
        });
      }
      return send(204);
    }
    for (const item of parsed) {
      this.signalPosts.push(item);
      const event = this.events.get(item.event_id);
      if (event && this.attachPostedSignals) {
        let entry = this.signalCatalog.get(item.signal_name);
        if (!entry) {
          entry = { id: randomUUID(), name: item.signal_name, type: 'metric' };
          this.signalCatalog.set(item.signal_name, entry);
        }
        const signal = { id: entry.id, name: item.signal_name, score: null };
        this.enrichLater(event.id, 0, (e) => {
          e.signals = [...(e.signals ?? []).filter((s) => s.name !== signal.name), signal];
        });
      }
    }
    return send(204);
  }

  private upsert(item: any) {
    const id = item.event_id as string;
    const now = new Date().toISOString();
    const existing = this.events.get(id);
    const ai = item.ai_data ?? {};
    const event: FakeEvent = {
      ...(existing ?? {
        id,
        event_name: item.event ?? 'unknown',
        user_id: item.user_id ?? 'unknown',
        convo_id: ai.convo_id ?? item.convo_id ?? null,
        timestamp: now,
        received_at: now,
        user_input: null,
        assistant_output: null,
        properties: {},
        feature_flags: {},
      }),
    };
    if (ai.input != null) event.user_input = ai.input;
    if (ai.output != null) event.assistant_output = ai.output;
    if (item.properties) event.properties = { ...event.properties, ...item.properties };
    if (Array.isArray(ai.tool_calls) && ai.tool_calls.length)
      event.tool_calls = ai.tool_calls.map((t: any) => ({ tool_name: t.name }));
    this.events.set(id, event);
  }

  private query(
    method: string,
    path: string,
    params: URLSearchParams,
    body: Buffer,
    send: (s: number, p?: unknown, h?: Record<string, string>) => void,
  ) {
    if (method === 'GET' && path === '/v1/events') {
      const limit = Math.min(Math.max(Number(params.get('limit') ?? 50), 1), 500);
      const filters = [...params.entries()].filter(([k]) => k !== 'cursor' && k !== 'limit');
      const filterId = JSON.stringify(filters.sort());
      let offset = 0;
      const cursor = params.get('cursor');
      if (cursor) {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (decoded.filterId !== filterId) return send(400, { error: 'cursor does not match filters' });
        offset = decoded.offset;
      }
      let rows = [...this.events.values()];
      const gte = params.get('timestamp[gte]');
      const lt = params.get('timestamp[lt]');
      if (gte) rows = rows.filter((e) => e.timestamp >= gte);
      if (lt) rows = rows.filter((e) => e.timestamp < lt);
      for (const [key, value] of params.entries()) {
        const match = /^properties\[(.+?)\](?:\[eq\])?$/.exec(key);
        if (match) rows = rows.filter((e) => String(e.properties[match[1]!]) === value);
      }
      rows.sort((a, b) =>
        params.get('order_by')?.startsWith('+') || params.get('order_by') === ' timestamp'
          ? a.timestamp.localeCompare(b.timestamp)
          : b.timestamp.localeCompare(a.timestamp),
      );
      const page = rows.slice(offset, offset + limit).map((e) => this.touch(e));
      const has_more = offset + limit < rows.length;
      return send(200, {
        data: page,
        meta: {
          cursor: has_more
            ? Buffer.from(JSON.stringify({ filterId, offset: offset + limit })).toString('base64url')
            : null,
          has_more,
        },
      });
    }
    const detail = /^\/v1\/events\/([^/]+)$/.exec(path);
    if (method === 'GET' && detail) {
      const event = this.events.get(decodeURIComponent(detail[1]!));
      return event ? send(200, { data: this.touch(event) }) : send(404, { error: 'not found' });
    }
    if (method === 'GET' && path === '/v1/signals')
      return send(200, { data: [...this.signalCatalog.values()], meta: { cursor: null, has_more: false } });
    if (method === 'GET' && path === '/v1/traces') {
      const eventId = params.get('event_id');
      if (!eventId) return send(400, { error: 'event_id required' });
      const limit = Math.min(Number(params.get('limit') ?? 200), this.traceCap);
      return send(200, { data: (this.traces.get(eventId) ?? []).slice(0, limit) });
    }
    if (method === 'POST' && path === '/v1/deletions/users') {
      const input = JSON.parse(body.toString('utf8'));
      if (!Array.isArray(input.user_ids) || input.user_ids.length < 1 || input.user_ids.length > 100)
        return send(400, { error: 'user_ids' });
      const id = randomUUID();
      const received = new Date();
      const job = {
        id,
        status: 'pending',
        regulation: input.regulation ?? 'gdpr',
        requester: input.requester,
        received_at: received.toISOString(),
        due_by: new Date(received.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
        completed_at: null,
        user_ids: input.user_ids.map((u: string) => ({
          user_id: u,
          requested_on: received.toISOString().slice(0, 10),
          revoked_at: null,
        })),
      };
      this.deletions.set(id, job);
      return send(200, { data: job });
    }
    const deletion = /^\/v1\/deletions\/users\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (deletion) {
      const job = this.deletions.get(deletion[1]!);
      if (!job) return send(404, { error: 'not found' });
      if (method === 'GET' && !deletion[2]) return send(200, { data: job });
      if (method === 'DELETE' && deletion[2]) {
        const entry = job.user_ids.find((u: any) => u.user_id === decodeURIComponent(deletion[2]!));
        if (!entry) return send(404, { error: 'user not in job' });
        entry.revoked_at ??= new Date().toISOString();
        return send(200, { data: { job_id: job.id, user_id: entry.user_id, revoked_at: entry.revoked_at } });
      }
    }
    return send(404, { error: 'unknown route' });
  }

  private mcp(auth: string | null, body: Buffer, send: (s: number, p?: unknown) => void) {
    if (this.mcpStatus !== 200) return send(this.mcpStatus, { error: 'injected' });
    if (auth !== `Bearer ${this.queryKey}`) return send(401, { error: 'bad key' });
    if (body.length === 0) return send(405, { error: 'no server-initiated stream' });
    const rpc = JSON.parse(body.toString('utf8'));
    if (rpc.id === undefined) return send(202); // notifications
    if (rpc.method === 'initialize')
      return send(200, {
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: rpc.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-raindrop-mcp', version: '0.0.0' },
        },
      });
    if (rpc.method === 'tools/list')
      return this.mcpTools === null
        ? send(200, {
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32601, message: 'plan does not include tools' },
          })
        : send(200, { jsonrpc: '2.0', id: rpc.id, result: { tools: this.mcpTools } });
    return send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found' } });
  }
}
