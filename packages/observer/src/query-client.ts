import { z } from 'zod';

/**
 * Raindrop Query API client (https://query.raindrop.ai). A SEPARATE read key from the ingestion write key. Pagination is
 * `meta.cursor` / `meta.has_more` under a fixed filter; `/v1/signals` is a definition CATALOG (resolve a UUID, then
 * filter events by it); `/v1/traces` takes `event_id`, returns at most 1000 spans and has no cursor.
 */
export type QueryErrorKind =
  | 'auth'
  | 'forbidden'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'narrow_request'
  | 'bad_request'
  | 'not_found'
  | 'network'
  | 'invalid_response';

export class RaindropQueryError extends Error {
  constructor(
    readonly kind: QueryErrorKind,
    readonly status: number | null,
    readonly retryAfterMs?: number,
    /** For `invalid_response`: the zod issue PATHS that failed (e.g. `data.tool_calls.0.name`). Paths only, never values. */
    readonly paths: readonly string[] = [],
  ) {
    super(`RaindropQuery:${kind}${status ? `:${status}` : ''}${paths.length ? `:${paths.join(',')}` : ''}`);
    this.name = 'RaindropQueryError';
  }
}

const looseObject = z.looseObject;
const eventSchema = looseObject({
  id: z.string(),
  event_name: z.string(),
  user_id: z.string().nullable().optional(),
  convo_id: z.string().nullable().optional(),
  timestamp: z.string(),
  received_at: z.string().optional(),
  user_input: z.string().nullable().optional(),
  assistant_output: z.string().nullable().optional(),
  properties: z.record(z.string(), z.unknown()).optional().default({}),
  feature_flags: z.record(z.string(), z.unknown()).optional().default({}),
  signals: z
    .array(looseObject({ id: z.string(), name: z.string(), score: z.number().nullable().optional() }))
    .optional(),
  // Documented shape (QueryEventToolCall, query.raindrop.ai/v1/openapi.json): the name is `tool_name`.
  tool_calls: z
    .array(
      looseObject({
        tool_name: z.string(),
        status: z.string().optional(),
        duration_ms: z.number().optional(),
        started_at: z.string().optional(),
        span_id: z.string().optional(),
      }),
    )
    .optional(),
  error_spans: z.array(z.unknown()).optional(),
  topics: z.array(z.unknown()).optional(),
});
export type RaindropEvent = z.infer<typeof eventSchema>;

const spanSchema = looseObject({
  span_id: z.string(),
  trace_id: z.string().optional(),
  parent_span_id: z.string().nullable().optional(),
  span_name: z.string(),
  span_type: z.string(),
  status: z.string().optional(),
  duration_ns: z.union([z.number(), z.string()]).optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  input_tokens: z.number().nullable().optional(),
  output_tokens: z.number().nullable().optional(),
});
export type RaindropSpan = z.infer<typeof spanSchema>;

const signalSchema = looseObject({ id: z.string(), name: z.string(), type: z.string().optional() });
export type RaindropSignal = z.infer<typeof signalSchema>;

const meta = z.object({ cursor: z.string().nullable().optional(), has_more: z.boolean() });
const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), meta });
const detail = <T extends z.ZodType>(item: T) => z.object({ data: item });

const deletionJobSchema = looseObject({
  id: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'rejected']),
  regulation: z.string(),
  requester: z.string(),
  received_at: z.string(),
  due_by: z.string(),
  completed_at: z.string().nullable(),
  user_ids: z.array(
    looseObject({ user_id: z.string(), requested_on: z.string(), revoked_at: z.string().nullable() }),
  ),
});
export type DeletionJob = z.infer<typeof deletionJobSchema>;

export type EventListParams = {
  limit?: number;
  cursor?: string | null;
  /** '+timestamp' for ascending scans, '-timestamp' (default) for newest first. */
  orderBy?: '+timestamp' | '-timestamp';
  timestampGte?: string;
  timestampLt?: string;
  eventName?: string;
  /** Exact-match event properties: `properties[key]=value`. */
  properties?: Readonly<Record<string, string | number | boolean>>;
  /** Canonical signal UUID (never a signal name). */
  signal?: string;
};

export type Page<T> = { data: T[]; cursor: string | null; hasMore: boolean };

export type QueryClientOptions = {
  queryKey: string;
  projectId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
};

/** The documented trace ceiling. Reaching it means the evidence MAY be incomplete. */
export const TRACE_CAP = 1000;

export class RaindropQueryClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  constructor(private readonly options: QueryClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://query.raindrop.ai').replace(/\/+$/, '');
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
  }

  async listEvents(params: EventListParams = {}): Promise<Page<RaindropEvent>> {
    const query = new URLSearchParams();
    query.set('limit', String(Math.min(Math.max(params.limit ?? 100, 1), 500)));
    query.set('order_by', params.orderBy ?? '-timestamp');
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.timestampGte) query.set('timestamp[gte]', params.timestampGte);
    if (params.timestampLt) query.set('timestamp[lt]', params.timestampLt);
    if (params.eventName) query.set('event_name', params.eventName);
    if (params.signal) query.set('signal', params.signal);
    for (const [key, value] of Object.entries(params.properties ?? {}))
      query.set(`properties[${key}]`, String(value));
    const parsed = await this.get('/v1/events', query, page(eventSchema));
    return { data: parsed.data, cursor: parsed.meta.cursor ?? null, hasMore: parsed.meta.has_more };
  }

  /** The event by ID, or null when it is not (yet) visible. */
  async getEvent(eventId: string): Promise<RaindropEvent | null> {
    try {
      return (
        await this.get(
          `/v1/events/${encodeURIComponent(eventId)}`,
          new URLSearchParams(),
          detail(eventSchema),
        )
      ).data;
    } catch (error) {
      if (error instanceof RaindropQueryError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  async listSignals(cursor?: string | null): Promise<Page<RaindropSignal>> {
    const query = new URLSearchParams({ limit: '500' });
    if (cursor) query.set('cursor', cursor);
    const parsed = await this.get('/v1/signals', query, page(signalSchema));
    return { data: parsed.data, cursor: parsed.meta.cursor ?? null, hasMore: parsed.meta.has_more };
  }

  /** Resolves a signal NAME to its canonical UUID by walking the catalog (bounded pages). Null if undefined. */
  async resolveSignalId(name: string, maxPages = 10): Promise<string | null> {
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const result: Page<RaindropSignal> = await this.listSignals(cursor);
      const hit = result.data.find((signal) => signal.name === name);
      if (hit) return hit.id;
      if (!result.hasMore || !result.cursor) return null;
      cursor = result.cursor;
    }
    return null;
  }

  /**
   * Spans of one event, requested at the maximum limit. `/v1/traces` has no cursor: a response of exactly the cap means
   * spans beyond it cannot be read, so the evidence is flagged potentially truncated, never assumed complete.
   */
  async getTraces(eventId: string): Promise<{ spans: RaindropSpan[]; potentiallyTruncated: boolean }> {
    const query = new URLSearchParams({ event_id: eventId, limit: String(TRACE_CAP) });
    const parsed = await this.get('/v1/traces', query, z.object({ data: z.array(spanSchema) }));
    return { spans: parsed.data, potentiallyTruncated: parsed.data.length >= TRACE_CAP };
  }

  /**
   * Organization-wide user deletion REQUEST (POST). Filing is not erasure: the job is `pending` with a `due_by` date
   * (30 days) until the provider reports `completed`. The project header does not narrow it.
   */
  async requestUserDeletion(input: {
    userIds: string[];
    requester: string;
    regulation: 'gdpr' | 'ccpa' | 'other';
  }): Promise<DeletionJob> {
    if (input.userIds.length < 1 || input.userIds.length > 100)
      throw new RaindropQueryError('bad_request', null);
    const response = await this.send('POST', '/v1/deletions/users', new URLSearchParams(), {
      user_ids: input.userIds,
      requester: input.requester,
      regulation: input.regulation,
    });
    return this.parse(response, detail(deletionJobSchema)).data;
  }

  async getDeletion(jobId: string): Promise<DeletionJob> {
    return (
      await this.get(
        `/v1/deletions/users/${encodeURIComponent(jobId)}`,
        new URLSearchParams(),
        detail(deletionJobSchema),
      )
    ).data;
  }

  /**
   * CANCELS one user's PENDING deletion (their data is KEPT). This is DELETE-as-cancel and is never a purge; the method
   * name says so on purpose.
   */
  async cancelPendingUserDeletion(
    jobId: string,
    userId: string,
  ): Promise<{ jobId: string; userId: string; revokedAt: string }> {
    const result = await this.send(
      'DELETE',
      `/v1/deletions/users/${encodeURIComponent(jobId)}/${encodeURIComponent(userId)}`,
      new URLSearchParams(),
    );
    const parsed = this.parse(
      result,
      detail(looseObject({ job_id: z.string(), user_id: z.string(), revoked_at: z.string() })),
    );
    return { jobId: parsed.data.job_id, userId: parsed.data.user_id, revokedAt: parsed.data.revoked_at };
  }

  private get<T extends z.ZodType>(path: string, query: URLSearchParams, schema: T): Promise<z.infer<T>> {
    return this.send('GET', path, query).then((body) => this.parse(body, schema));
  }

  private parse<T extends z.ZodType>(body: unknown, schema: T): z.infer<T> {
    const result = schema.safeParse(body);
    if (!result.success) {
      // Paths only: an issue's message or received value can carry event content, so neither is kept.
      const paths = [
        ...new Set(result.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)')),
      ].slice(0, 20);
      throw new RaindropQueryError('invalid_response', null, undefined, paths);
    }
    return result.data;
  }

  /** One request with bounded, jittered retries for transient failures only. */
  private async send(method: string, path: string, query: URLSearchParams, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ''}`;
    let lastError: RaindropQueryError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await this.fetcher(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.queryKey}`,
            'X-Raindrop-Project-Id': this.options.projectId,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
        if (response.ok) {
          try {
            return await response.json();
          } catch {
            throw new RaindropQueryError('invalid_response', response.status);
          }
        }
        throw classify(response);
      } catch (error) {
        const failure = error instanceof RaindropQueryError ? error : networkFailure(error);
        lastError = failure;
        if (!isRetryable(failure) || attempt === this.maxAttempts) throw failure;
        await this.sleep(this.delayFor(failure, attempt));
      }
    }
    throw lastError ?? new RaindropQueryError('network', null);
  }

  private delayFor(error: RaindropQueryError, attempt: number): number {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(exponential * (0.5 + this.random() * 0.5));
    return error.retryAfterMs !== undefined
      ? Math.min(Math.max(error.retryAfterMs, jittered), this.maxDelayMs * 4)
      : jittered;
  }
}

function classify(response: Response): RaindropQueryError {
  const status = response.status;
  const header = Number(response.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
  if (status === 401) return new RaindropQueryError('auth', status);
  if (status === 403) return new RaindropQueryError('forbidden', status);
  if (status === 404) return new RaindropQueryError('not_found', status);
  if (status === 408) return new RaindropQueryError('narrow_request', status); // narrow the query; never replay it unchanged
  if (status === 429) return new RaindropQueryError('rate_limited', status, retryAfterMs);
  if (status >= 500) return new RaindropQueryError('server', status, retryAfterMs);
  return new RaindropQueryError('bad_request', status);
}

function networkFailure(error: unknown): RaindropQueryError {
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return new RaindropQueryError(timedOut ? 'timeout' : 'network', null);
}

const isRetryable = (error: RaindropQueryError) =>
  ['rate_limited', 'server', 'timeout', 'network'].includes(error.kind);
