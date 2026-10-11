/**
 * Defense in depth for nodejs/node#60717 (fixed in Node 24.13.1 and 25.4.0).
 *
 * On affected Node versions, util.inspect adds an inherited `errors` accessor
 * (for example ZodError's) to the keys it formats without an own-property
 * check, so console.error(<ZodError>) throws "Cannot read properties of
 * undefined (reading 'value')". The exception escapes request handlers, such
 * as the CopilotKit runtime's run-request parser, and turns a 400 into a crash.
 *
 * This patches console.error/warn/info/log so that, only when the original
 * call throws and at least one argument is an Error, the call is retried once
 * with each Error argument replaced by `${name}: ${message}`.
 *
 * - Successful calls are untouched: same arguments, same output, same result.
 * - Non-Error arguments are never changed or dropped.
 * - Nothing is swallowed: if no argument is an Error, or the retry also
 *   throws, the original failure is rethrown.
 * - Installing twice does not wrap twice.
 *
 * Remove this module once the repository's Node floor is at or above the fix.
 */
type Method = 'error' | 'warn' | 'info' | 'log';
type Sink = Record<Method, (...args: unknown[]) => unknown>;

const METHODS: readonly Method[] = ['error', 'warn', 'info', 'log'];
const MARK = Symbol.for('expunge.safeConsole.installed');

// Cross-realm safe: instanceof alone misses Errors created in another vm context.
const isError = (value: unknown): value is Error =>
  value instanceof Error ||
  Object.prototype.toString.call(value) === '[object Error]';

function describe(error: Error): string {
  let name = 'Error';
  let message = '';
  try {
    name = String(error.name);
  } catch {
    // Keep the generic name; describing an error must never throw.
  }
  try {
    message = String(error.message);
  } catch {
    // Keep an empty message.
  }
  return `${name}: ${message}`;
}

/** Returns true when it patched the target, false when it was already patched. */
export function installSafeConsole(target: Sink = console as Sink): boolean {
  const marked = target as unknown as Record<symbol, unknown>;
  if (marked[MARK]) return false;
  for (const method of METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = (...args: unknown[]) => {
      try {
        return Reflect.apply(original, target, args);
      } catch (failure) {
        if (!args.some(isError)) throw failure;
        try {
          return Reflect.apply(
            original,
            target,
            args.map((arg) => (isError(arg) ? describe(arg) : arg)),
          );
        } catch {
          throw failure;
        }
      }
    };
  }
  Object.defineProperty(target, MARK, { value: true });
  return true;
}

installSafeConsole();
