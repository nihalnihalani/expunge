/**
 * Which side of the model boundary an inner run error is on, from STRUCTURED fields only (HTTP status, error code, error
 * name), never from message text: a message can echo the candidate's own prompt, so reading it could let a candidate steer
 * the classification.
 *
 *  - Infrastructure (the provider, the network or the worker's own credential), in three distinct codes the gate counts
 *    separately:
 *      `ProviderRateLimited`: HTTP 429 (only after the SDK's bounded retries, see MODEL_RETRY_POLICY) and the structured
 *        rate-limit codes (`rate_limit_exceeded`, `rate_limit_error`, `insufficient_quota`).
 *      `ProviderServerError`: HTTP 5xx and the structured server-side codes (`overloaded_error`, `server_error`,
 *        `service_unavailable`).
 *      `ModelUnavailable`: 401, 403 and 404 (the worker's key or model configuration, never something a candidate controls),
 *        connection-level network codes, an authentication or permission error code, and a missing credential.
 *  - `ModelRunFailed` (everything else): other 4xx such as a request the provider rejected, any TIMEOUT (HTTP 408, a
 *    timeout code or name: the runtime's phase watchdog fires before the SDK's own timeout, so a timeout that still arrives
 *    is not provider evidence and must not turn a candidate's slow, huge-prompt call into "infrastructure"), and any error
 *    whose structured fields say nothing. Unknown stays here on purpose: counting an unclassified failure as infrastructure
 *    would excuse a candidate's own failures.
 */
export type ModelFailureCode =
  'ModelUnavailable' | 'ProviderServerError' | 'ProviderRateLimited' | 'ModelRunFailed';

const UNAVAILABLE_STATUS = new Set([401, 403, 404]);
const RATE_LIMIT_STATUS = 429;
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
  'invalid_api_key',
  'authentication_error',
  'permission_error',
]);
const RATE_LIMIT_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'insufficient_quota']);
const SERVER_ERROR_CODES = new Set(['overloaded_error', 'server_error', 'service_unavailable']);
const UNAVAILABLE_NAMES = new Set(['MissingProviderCredentialError', 'APIConnectionError', 'FetchError']);

const statusOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
};

/** One structured record: a thrown error, or the `{ code }` of a RUN_ERROR event. */
function classifyRecord(record: Record<string, unknown>): ModelFailureCode | null {
  const name = typeof record.name === 'string' ? record.name : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const status = statusOf(record.status) ?? statusOf(record.statusCode) ?? statusOf(record.code);
  // Timeouts first: never provider-side, whatever else the record says.
  if (TIMEOUT_NAMES.has(name) || TIMEOUT_CODES.has(code) || status === TIMEOUT_STATUS)
    return 'ModelRunFailed';
  if (UNAVAILABLE_NAMES.has(name)) return 'ModelUnavailable';
  if (status !== undefined && status >= 400 && status <= 599) {
    if (status >= 500) return 'ProviderServerError';
    if (status === RATE_LIMIT_STATUS) return 'ProviderRateLimited';
    return UNAVAILABLE_STATUS.has(status) ? 'ModelUnavailable' : 'ModelRunFailed';
  }
  if (RATE_LIMIT_CODES.has(code)) return 'ProviderRateLimited';
  if (SERVER_ERROR_CODES.has(code)) return 'ProviderServerError';
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
