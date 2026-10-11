import { Console } from 'node:console';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { installSafeConsole } from '../src/server/expunge/safe-console.js';

// The real failing shape: ZodError v3, as bundled by @ag-ui/core, exposes an
// inherited `errors` getter (nodejs/node#60717).
const zodV3 = createRequire(import.meta.resolve('@ag-ui/core'))('zod') as {
  z: {
    object: (shape: Record<string, unknown>) => {
      safeParse: (value: unknown) => { error?: Error };
    };
    string: () => unknown;
  };
};
const zodError = () => {
  const error = zodV3.z
    .object({ field: zodV3.z.string() })
    .safeParse({ field: 1 }).error;
  if (!error) throw new Error('Fixture did not produce a ZodError.');
  return error;
};
const sink = () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { console: new Console({ stdout: stream, stderr: stream }), chunks };
};
const tries = (run: () => void) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

describe('safe console (nodejs/node#60717 defense in depth)', () => {
  it('survives logging a real ZodError on this Node version', () => {
    const error = zodError();
    // Whether the unpatched console throws depends on the Node patch version:
    // true on 24.0 to 24.13.0 and 25.0 to 25.3, false on fixed versions.
    const unpatched = tries(() => sink().console.error('x', error));
    const patched = sink();
    expect(installSafeConsole(patched.console)).toBe(true);
    expect(
      tries(() => patched.console.error('Error running agent:', error)),
    ).toBe(false);
    const output = patched.chunks.join('');
    expect(output).toContain('Error running agent:');
    expect(output).toContain('ZodError');
    // Record which branch ran so a reader can tell the regression was exercised.
    expect(typeof unpatched).toBe('boolean');
  });

  it('leaves successful calls untouched', () => {
    const calls: unknown[][] = [];
    const target = {
      error: (...args: unknown[]) => {
        calls.push(args);
        return 'result';
      },
      warn: () => undefined,
      info: () => undefined,
      log: () => undefined,
    };
    installSafeConsole(target);
    const error = new Error('boom');
    const nested = { cause: error };
    expect(target.error('a', 1, error, nested, null)).toBe('result');
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe(error);
    expect(calls[0][3]).toBe(nested);
  });

  it('retries once with name and message for Error arguments only', () => {
    const calls: unknown[][] = [];
    const nested = { cause: new Error('inner') };
    const target = {
      error: (...args: unknown[]) => {
        calls.push(args);
        if (calls.length === 1) throw new TypeError('inspect failed');
        return undefined;
      },
      warn: () => undefined,
      info: () => undefined,
      log: () => undefined,
    };
    installSafeConsole(target);
    const typed = new RangeError('out of range');
    target.error('label', 42, typed, nested, undefined, null);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      'label',
      42,
      'RangeError: out of range',
      nested,
      undefined,
      null,
    ]);
    expect(calls[1][3]).toBe(nested);
  });

  it('treats Errors from another realm as Errors', () => {
    const foreign = runInNewContext('new Error("from another realm")') as Error;
    expect(foreign instanceof Error).toBe(false);
    const calls: unknown[][] = [];
    const target = {
      error: (...args: unknown[]) => {
        calls.push(args);
        if (calls.length === 1) throw new TypeError('inspect failed');
      },
      warn: () => undefined,
      info: () => undefined,
      log: () => undefined,
    };
    installSafeConsole(target);
    target.error(foreign);
    expect(calls[1]).toEqual(['Error: from another realm']);
  });

  it('never swallows: no Error argument or a failing retry rethrows the original failure', () => {
    const original = new TypeError('inspect failed');
    const noErrorSpy = vi.fn((..._args: unknown[]) => {
      throw original;
    });
    const noError = {
      error: noErrorSpy,
      warn: () => undefined,
      info: () => undefined,
      log: () => undefined,
    };
    installSafeConsole(noError);
    expect(() => noError.error('only', 'strings', { a: 1 })).toThrow(original);
    expect(noErrorSpy).toHaveBeenCalledTimes(1);

    const alwaysFailsSpy = vi.fn((..._args: unknown[]) => {
      throw original;
    });
    const alwaysFails = {
      error: alwaysFailsSpy,
      warn: () => undefined,
      info: () => undefined,
      log: () => undefined,
    };
    installSafeConsole(alwaysFails);
    expect(() => alwaysFails.error(new Error('x'))).toThrow(original);
    expect(alwaysFailsSpy).toHaveBeenCalledTimes(2);
  });

  it('describes an Error whose accessors throw without throwing', () => {
    const hostile = new Error('placeholder');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('unreadable');
      },
    });
    const calls: unknown[][] = [];
    const target = {
      error: (...args: unknown[]) => {
        calls.push(args);
        if (calls.length === 1) throw new TypeError('inspect failed');
      },
      warn: () => undefined,
      info: () => undefined,
      log: () => undefined,
    };
    installSafeConsole(target);
    expect(() => target.error(hostile)).not.toThrow();
    expect(calls[1]).toEqual(['Error: ']);
  });

  it('patches error, warn, info and log, and only once', () => {
    const attempts: Record<string, number> = {};
    const method =
      (name: string) =>
      (..._args: unknown[]) => {
        attempts[name] = (attempts[name] ?? 0) + 1;
        if (attempts[name] === 1) throw new TypeError('inspect failed');
      };
    const target = {
      error: method('error'),
      warn: method('warn'),
      info: method('info'),
      log: method('log'),
    };
    expect(installSafeConsole(target)).toBe(true);
    expect(installSafeConsole(target)).toBe(false);
    for (const name of ['error', 'warn', 'info', 'log'] as const)
      target[name](new Error(name));
    expect(attempts).toEqual({ error: 2, warn: 2, info: 2, log: 2 });
  });
});
