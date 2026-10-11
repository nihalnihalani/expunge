import { authHeaders } from '../api';

/**
 * Typed wrapper over the operator's /api/expunge routes. Unlike the shell's api(), it
 * keeps the server's closed error code and the list of missing configuration names
 * (names only), and it distinguishes transport failures from HTTP answers.
 */
export class ExpungeApiError extends Error {
  constructor(
    readonly kind: 'http' | 'transport',
    readonly status: number,
    readonly code: string,
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = 'ExpungeApiError';
  }
}

const TIMEOUT_MS = 15_000;

/** AbortSignal.any is recent; this keeps older browsers working. */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    },
  };
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

export async function expungeFetch<T>(
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  const timeout = withTimeout(options.signal, TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`/api/expunge${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...authHeaders(),
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: timeout.signal,
    });
  } catch (cause) {
    timeout.done();
    // A caller abort (unmount, route change) is not a transport failure.
    if (options.signal?.aborted) throw cause;
    throw new ExpungeApiError(
      'transport',
      0,
      'transport',
      'Could not reach the operator.',
    );
  }
  timeout.done();
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
    missing?: string[];
  } | null;
  if (!response.ok)
    throw new ExpungeApiError(
      'http',
      response.status,
      data?.code ?? 'error',
      data?.error ?? `Request failed (${response.status}).`,
      Array.isArray(data?.missing) ? data.missing.slice(0, 20) : [],
    );
  return data as T;
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}
