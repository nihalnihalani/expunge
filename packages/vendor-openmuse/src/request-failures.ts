/** Shared bounded structured request-failure policy for runtime classification and retry-watchdog evidence. */
export const boundedErrorRecords = (error: unknown): Record<string, unknown>[] => {
  const records: Record<string, unknown>[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    records.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return records;
};

const NAMES = new Set(['APIConnectionTimeoutError', 'TimeoutError', 'AbortError', 'APIUserAbortError']);
const CODES = new Set([
  'timeout',
  'ETIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ABORT_ERR',
  'UND_ERR_ABORTED',
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_PROTOCOL',
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_UNESCAPED_CHARACTERS',
  'UND_ERR_INVALID_ARG',
]);
const PROVIDER_STATUS = new Set([401, 403, 404, 429]);

export const structuredStatus = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
};

/** Any explicit request failure in the inspected chain vetoes an infrastructure wrapper, without reading messages. */
export function hasRequestFailureVeto(record: Record<string, unknown>): boolean {
  if (
    (typeof record.name === 'string' && NAMES.has(record.name)) ||
    (typeof record.code === 'string' && CODES.has(record.code))
  )
    return true;
  return [record.status, record.statusCode, record.code].some((value) => {
    const status = structuredStatus(value);
    return status !== undefined && status >= 400 && status < 500 && !PROVIDER_STATUS.has(status);
  });
}
