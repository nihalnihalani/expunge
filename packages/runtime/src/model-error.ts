/**
 * Which side of the model boundary an inner run error is on, from STRUCTURED fields only (HTTP status, error code, error
 * name), never from message text: a message can echo the candidate's own prompt, so reading it could let a candidate steer
 * the classification.
 *
 *  - `ModelUnavailable` (infrastructure; the provider, the network or the worker's own credential): HTTP 429 (only after the
 *    SDK's bounded retries, see MODEL_RETRY_POLICY), 5xx, 401, 403 and 404 (the worker's key or model configuration, never
 *    something a candidate controls), connection-level network codes, provider overload / rate-limit / outage codes, and a
 *    missing credential.
 *  - `ModelRunFailed` (everything else): other 4xx such as a request the provider rejected, any TIMEOUT (HTTP 408, a
 *    timeout code or name: the runtime's phase watchdog fires before the SDK's own timeout, so a timeout that still arrives
 *    is not provider evidence and must not turn a candidate's slow, huge-prompt call into "infrastructure"), and any error
 *    whose structured fields say nothing. Unknown stays here on purpose: counting an unclassified failure as infrastructure
 *    would excuse a candidate's own failures.
 */
export type ModelFailureCode = 'ModelUnavailable' | 'ModelRunFailed';

const UNAVAILABLE_STATUS = new Set([401, 403, 404, 429]);
const TIMEOUT_STATUS = 408;
const TIMEOUT_CODES = new Set([
  'timeout',
  'ETIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TIMEOUT_NAMES = new Set(['APIConnectionTimeoutError']);
const UNAVAILABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'rate_limit_exceeded',
  'rate_limit_error',
  'insufficient_quota',
  'overloaded_error',
  'server_error',
  'service_unavailable',
  'invalid_api_key',
  'authentication_error',
  'permission_error',
]);
const UNAVAILABLE_NAMES = new Set(['MissingProviderCredentialError', 'APIConnectionError', 'FetchError']);

const statusOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
};
const unavailableStatus = (status: number): boolean => status >= 500 || UNAVAILABLE_STATUS.has(status);

/** One structured record: a thrown error, or the `{ code }` of a RUN_ERROR event. */
function classifyRecord(record: Record<string, unknown>): ModelFailureCode | null {
  const name = typeof record.name === 'string' ? record.name : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const status = statusOf(record.status) ?? statusOf(record.statusCode) ?? statusOf(record.code);
  // Timeouts first: never provider-side, whatever else the record says.
  if (TIMEOUT_NAMES.has(name) || TIMEOUT_CODES.has(code) || status === TIMEOUT_STATUS)
    return 'ModelRunFailed';
  if (UNAVAILABLE_NAMES.has(name)) return 'ModelUnavailable';
  if (status !== undefined && status >= 400 && status <= 599)
    return unavailableStatus(status) ? 'ModelUnavailable' : 'ModelRunFailed';
  if (UNAVAILABLE_CODES.has(code)) return 'ModelUnavailable';
  return null;
}

/** Classifies a thrown value or a RUN_ERROR-shaped object, following `cause` a few levels. */
export function classifyModelFailure(error: unknown): ModelFailureCode {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const verdict = classifyRecord(current as Record<string, unknown>);
    if (verdict) return verdict;
    current = (current as { cause?: unknown }).cause;
  }
  return 'ModelRunFailed';
}
