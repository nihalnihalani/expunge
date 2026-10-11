import { describe, expect, it } from 'vitest';
import { classifyModelFailure } from '../src/model-error.js';

describe('classifyModelFailure: structured fields decide, text never does', () => {
  it('provider, network and worker-credential failures are ModelUnavailable', () => {
    for (const error of [
      { status: 503 },
      { statusCode: 500 },
      { status: 429 },
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { code: '502' },
      { code: 'ECONNRESET' },
      { code: 'UND_ERR_SOCKET' },
      { code: 'overloaded_error' },
      { name: 'MissingProviderCredentialError' },
      { name: 'APIConnectionError' },
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
      { message: 'x', cause: { cause: { status: 504 } } },
    ])
      expect(classifyModelFailure(error), JSON.stringify(error)).toBe('ModelUnavailable');
  });

  it('request-side 4xx and anything unstructured are ModelRunFailed', () => {
    for (const error of [
      { status: 400 },
      { status: 408 }, // a timeout is never provider evidence
      { code: 'timeout' },
      { code: 'ETIMEDOUT' },
      { code: 'UND_ERR_HEADERS_TIMEOUT' },
      { name: 'APIConnectionTimeoutError' },
      { name: 'APIConnectionError', code: 'ETIMEDOUT' }, // timeout wins over the connection error name
      { status: 413 },
      { status: 422 },
      { code: '400' },
      { code: 'context_length_exceeded' },
      new Error('503 Service Unavailable'),
      { message: 'ECONNRESET rate_limit_exceeded 429' },
      'boom',
      null,
      undefined,
    ])
      expect(classifyModelFailure(error), String(JSON.stringify(error))).toBe('ModelRunFailed');
  });

  it('a status wins over a code, and the cause chain is bounded', () => {
    expect(classifyModelFailure({ status: 400, code: 'ECONNRESET' })).toBe('ModelRunFailed');
    let deep: Record<string, unknown> = { status: 503 };
    for (let i = 0; i < 6; i++) deep = { cause: deep };
    expect(classifyModelFailure(deep)).toBe('ModelRunFailed'); // too deep to trust
  });

  it('vetoes nested timeouts before considering any infrastructure wrapper', () => {
    for (const error of [
      {
        name: 'APIConnectionError',
        cause: { name: 'TypeError', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } },
      },
      { status: 503, cause: { code: 'ETIMEDOUT' } },
      { name: 'FetchError', cause: { status: 408 } },
      { name: 'APIConnectionError', cause: { name: 'APIConnectionTimeoutError' } },
      { statusCode: 429, cause: { cause: { cause: { name: 'TimeoutError' } } } },
      { status: 503, statusCode: 408 },
    ])
      expect(classifyModelFailure(error)).toBe('ModelRunFailed');
  });

  it('vetoes explicit request construction failures and aborts across the bounded chain', () => {
    for (const error of [
      { name: 'FetchError', code: 'ERR_INVALID_URL' },
      { name: 'FetchError', cause: { code: 'ERR_INVALID_URL' } },
      { name: 'APIConnectionError', cause: { code: 'ERR_INVALID_ARG_TYPE' } },
      { status: 503, cause: { code: 'UND_ERR_INVALID_ARG' } },
      { status: 429, cause: { name: 'AbortError' } },
      { name: 'APIConnectionError', cause: { name: 'APIUserAbortError' } },
      { name: 'FetchError', cause: { code: 'ABORT_ERR' } },
    ])
      expect(classifyModelFailure(error)).toBe('ModelRunFailed');
  });

  it('keeps request status precedence even when a wrapper or code claims infrastructure', () => {
    for (const error of [
      { status: 400, name: 'APIConnectionError', code: 'ECONNRESET' },
      { name: 'APIConnectionError', cause: { status: 400, code: 'ECONNRESET' } },
      { status: 503, cause: { status: 422 } },
    ])
      expect(classifyModelFailure(error)).toBe('ModelRunFailed');
  });

  it('does not inspect message text or unbounded causes, and terminates on cycles', () => {
    expect(classifyModelFailure({ status: 503, cause: { message: 'ETIMEDOUT ERR_INVALID_URL' } })).toBe(
      'ModelUnavailable',
    );
    let deep: Record<string, unknown> = { code: 'ETIMEDOUT' };
    for (let i = 0; i < 4; i++) deep = { cause: deep };
    expect(classifyModelFailure({ status: 503, cause: deep })).toBe('ModelUnavailable');
    const cycle: Record<string, unknown> = {};
    cycle.cause = cycle;
    expect(classifyModelFailure(cycle)).toBe('ModelRunFailed');
  });
});
