import { describe, expect, it } from 'vitest';
import { classifyModelFailure } from '../src/model-error.js';

describe('classifyModelFailure: structured fields decide, text never does', () => {
  it('provider, network and worker-credential failures are ModelUnavailable', () => {
    for (const error of [
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { code: 'ECONNRESET' },
      { code: 'UND_ERR_SOCKET' },
      { code: 'invalid_api_key' },
      { name: 'MissingProviderCredentialError' },
      { name: 'APIConnectionError' },
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    ])
      expect(classifyModelFailure(error), JSON.stringify(error)).toBe('ModelUnavailable');
  });

  it('5xx statuses and server-side codes are ProviderServerError', () => {
    for (const error of [
      { status: 500 },
      { status: 503 },
      { statusCode: 504 },
      { status: 599 },
      { code: '502' },
      { code: 'overloaded_error' },
      { code: 'server_error' },
      { code: 'service_unavailable' },
      { message: 'x', cause: { cause: { status: 504 } } },
      Object.assign(new Error('wrapped'), { cause: { status: 500, name: 'APIError' } }),
    ])
      expect(classifyModelFailure(error), JSON.stringify(error)).toBe('ProviderServerError');
  });

  it('429 and rate-limit codes are ProviderRateLimited', () => {
    for (const error of [
      { status: 429 },
      { statusCode: '429' },
      { code: '429' },
      { code: 'rate_limit_exceeded' },
      { code: 'rate_limit_error' },
      { code: 'insufficient_quota' },
      { message: 'x', cause: { status: 429 } },
    ])
      expect(classifyModelFailure(error), JSON.stringify(error)).toBe('ProviderRateLimited');
  });

  it('a status outranks a code, and a timeout outranks both', () => {
    expect(classifyModelFailure({ status: 503, code: 'rate_limit_exceeded' })).toBe('ProviderServerError');
    expect(classifyModelFailure({ status: 429, code: 'server_error' })).toBe('ProviderRateLimited');
    expect(classifyModelFailure({ status: 429, code: 'ETIMEDOUT' })).toBe('ModelRunFailed');
    expect(classifyModelFailure({ status: 408 })).toBe('ModelRunFailed');
  });

  it('message text never yields the new codes', () => {
    for (const text of [
      '503 Service Unavailable',
      'HTTP 429 Too Many Requests',
      'rate_limit_exceeded',
      'overloaded_error',
    ])
      expect(classifyModelFailure(new Error(text)), text).toBe('ModelRunFailed');
    expect(classifyModelFailure({ message: '500 429' })).toBe('ModelRunFailed');
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
});
