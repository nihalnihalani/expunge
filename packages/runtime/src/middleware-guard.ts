import type { ChatMiddleware } from '@expunge/vendor-openmuse';

type Hook = (...args: unknown[]) => unknown;

/**
 * Observability middleware must never decide whether a job runs. TanStack AI treats a throwing middleware hook as a
 * model-run failure, so the runtime wraps every hook of host-supplied middleware: an error (thrown or rejected) is
 * reported through `onError` and the hook then behaves as if it had returned nothing, which every hook defines as "no
 * change". Return values of healthy hooks pass through untouched.
 */
export function guardMiddleware(
  middleware: readonly ChatMiddleware[],
  onError: (hook: string, error: unknown) => void,
): ChatMiddleware[] {
  return middleware.map((original) => {
    const guarded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(original)) {
      if (typeof value !== 'function') {
        guarded[key] = value;
        continue;
      }
      guarded[key] = (...args: unknown[]) => {
        const label = `${original.name ?? 'middleware'}.${key}`;
        try {
          const result = (value as Hook).apply(original, args);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function')
            return (result as Promise<unknown>).then(undefined, (error: unknown) => {
              onError(label, error);
              return undefined;
            });
          return result;
        } catch (error) {
          onError(label, error);
          return undefined;
        }
      };
    }
    return guarded as ChatMiddleware;
  });
}
