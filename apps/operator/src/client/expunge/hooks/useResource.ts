import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpungeApiError, expungeFetch, isAbort } from '../api';

export type ResourceStatus =
  | 'loading'
  | 'ok'
  | 'error'
  | 'unavailable'
  | 'not_found'
  | 'retrying'
  | 'disconnected';

export interface ResourceState<T> {
  status: ResourceStatus;
  /** Last good data. Kept across retrying, disconnected and error so views can show it, labeled. */
  data: T | undefined;
  error: ExpungeApiError | undefined;
  /** Local time of the last successful read. */
  updatedAt: number | null;
  attempt: number;
  nextRetryMs: number | null;
  refresh: () => void;
}

/** Full-jitter exponential backoff: 1, 2, 4, 8, 16, 30 s ceilings. */
export function backoffDelay(attempt: number, random = Math.random) {
  const ceiling = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(500, Math.round(random() * ceiling));
}

export const DISCONNECTED_AFTER = 5;
const UNAVAILABLE_RECHECK_MS = 30_000;

export interface ResourceOptions {
  /** Poll interval after a success. Paused while the tab is hidden. */
  pollMs?: number;
}

/**
 * Reads one route with the shared state vocabulary of docs/ui/COMPONENT-STATES.md:
 * transport failures retry with backoff (retrying, then disconnected after five),
 * 503/501 are `unavailable` and re-checked slowly, 404 is `not_found`, any other
 * HTTP failure is `error`. A reload only ever issues GETs.
 */
export function useResource<T>(
  path: string | null,
  options: ResourceOptions = {},
): ResourceState<T> {
  const [state, setState] = useState<Omit<ResourceState<T>, 'refresh'>>({
    status: 'loading',
    data: undefined,
    error: undefined,
    updatedAt: null,
    attempt: 0,
    nextRetryMs: null,
  });
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const pollMs = options.pollMs;
  const wake = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    setState((previous) => ({
      ...previous,
      status: previous.data === undefined ? 'loading' : previous.status,
    }));
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        // Paused while hidden; the visibility listener resumes immediately.
        schedule(1000);
        return;
      }
      try {
        const data = await expungeFetch<T>(path, { signal: controller.signal });
        attempt = 0;
        setState({
          status: 'ok',
          data,
          error: undefined,
          updatedAt: Date.now(),
          attempt: 0,
          nextRetryMs: null,
        });
        if (pollMs) schedule(pollMs);
      } catch (cause) {
        if (controller.signal.aborted || isAbort(cause)) return;
        const error =
          cause instanceof ExpungeApiError
            ? cause
            : new ExpungeApiError('transport', 0, 'transport', 'Read failed.');
        if (error.kind === 'transport') {
          attempt += 1;
          const delay = backoffDelay(attempt);
          setState((previous) => ({
            ...previous,
            status: attempt >= DISCONNECTED_AFTER ? 'disconnected' : 'retrying',
            error,
            attempt,
            nextRetryMs: delay,
          }));
          schedule(delay);
          return;
        }
        const unavailable = error.status === 503 || error.status === 501;
        setState((previous) => ({
          ...previous,
          status: unavailable
            ? 'unavailable'
            : error.status === 404
              ? 'not_found'
              : 'error',
          error,
          attempt: 0,
          nextRetryMs: null,
        }));
        if (unavailable) schedule(UNAVAILABLE_RECHECK_MS);
      }
    };
    wake.current = () => {
      attempt = 0;
      schedule(0);
    };
    void run();
    const onVisible = () => {
      if (!document.hidden) wake.current?.();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [path, generation, pollMs]);
  return { ...state, refresh };
}
