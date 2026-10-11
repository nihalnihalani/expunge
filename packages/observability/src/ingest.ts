/**
 * Direct HTTP ingestion (https://raindrop.ai/docs/sdk/http-api): POST {base}/events/track and {base}/signals/track,
 * array bodies, write-key bearer, optional X-Raindrop-Project-Id, `204` on acceptance. A 204 means ACCEPTED FOR
 * INGESTION. It is not query visibility, not enrichment, and not proof of retention.
 */
export type IngestFailure = {
  ok: false;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  kind: 'auth' | 'rate_limited' | 'server' | 'timeout' | 'network' | 'bad_request';
  /** Transient: the same request may succeed later. Auth and bad requests are not. */
  retryable: boolean;
  retryAfterMs?: number;
};
export type IngestResult = { ok: true; status: number } | IngestFailure;

export type IngestEvent = {
  user_id: string;
  event: string;
  event_id: string;
  properties?: Record<string, unknown>;
  ai_data?: { model?: string; input?: string; output?: string; convo_id?: string };
  timestamp?: string;
};
export type IngestSignal = {
  event_id: string;
  signal_name: string;
  signal_type?: 'default' | 'feedback' | 'edit' | 'standard';
  sentiment?: 'POSITIVE' | 'NEGATIVE';
  properties?: Record<string, unknown>;
  timestamp?: string;
};

export type IngestClientOptions = {
  writeKey: string;
  projectId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const MAX_BATCH = 100;

export class IngestClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: IngestClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.raindrop.ai/v1').replace(/\/+$/, '');
    this.fetcher = options.fetch ?? fetch;
  }

  trackEvents(events: IngestEvent[]): Promise<IngestResult> {
    return this.post('/events/track', events);
  }
  trackSignals(signals: IngestSignal[]): Promise<IngestResult> {
    return this.post('/signals/track', signals);
  }

  private async post(path: string, body: unknown[]): Promise<IngestResult> {
    if (body.length === 0 || body.length > MAX_BATCH)
      return { ok: false, status: null, kind: 'bad_request', retryable: false };
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.writeKey}`,
          'Content-Type': 'application/json',
          ...(this.options.projectId ? { 'X-Raindrop-Project-Id': this.options.projectId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { ok: false, status: null, kind: timedOut ? 'timeout' : 'network', retryable: true };
    }
    if (response.status === 204 || response.status === 200 || response.status === 202)
      return { ok: true, status: response.status };
    return classify(response);
  }
}

function classify(response: Response): IngestFailure {
  const { status } = response;
  const retryAfter = Number(response.headers.get('retry-after'));
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3_600_000) : undefined;
  if (status === 401 || status === 403) return { ok: false, status, kind: 'auth', retryable: false };
  if (status === 429)
    return {
      ok: false,
      status,
      kind: 'rate_limited',
      retryable: true,
      ...(retryAfterMs ? { retryAfterMs } : {}),
    };
  if (status === 408) return { ok: false, status, kind: 'timeout', retryable: true };
  if (status >= 500)
    return { ok: false, status, kind: 'server', retryable: true, ...(retryAfterMs ? { retryAfterMs } : {}) };
  return { ok: false, status, kind: 'bad_request', retryable: false };
}
