import { createHash } from 'node:crypto';
import { compact, decodedVariants, isHeldOutKey } from './leak.js';

/**
 * Sanitization for everything that leaves the process as telemetry: tool arguments and results, errors,
 * attributes. It is a STRUCTURAL allowlist. A string value survives only if its key is explicitly allowed and
 * it looks like an identifier or short enum (never free text), and it contains none of the forbidden literals.
 * Everything else becomes `{ redacted, sha256, length }`, so equal values stay comparable without being readable.
 * `redactPii` on the SDK is regex-based and is NOT relied on for this.
 */
export type SanitizationPolicy = {
  /** Keys whose short identifier-like string values may pass through. */
  allowStringKeys: readonly string[];
  /** Lowercase literals (subject names, handles) that must never appear in any emitted string. */
  forbiddenLiterals: readonly string[];
  maxDepth: number;
  maxKeys: number;
  maxArray: number;
  maxStringLength: number;
};

export const DEFAULT_ALLOWED_STRING_KEYS = [
  'toolId',
  'tool',
  'name',
  'kind',
  'status',
  'decision',
  'code',
  'phase',
  'category',
  'stepId',
  'collectionId',
  'fieldId',
  'edgeId',
  'effectKind',
  'recordIdBsonType',
  'domainStatus',
  'externalErasureStatus',
  'receiptId',
  'jobId',
  'runId',
  'worldId',
  'harnessHash',
  'scopeId',
  'op',
] as const;

export const DEFAULT_SANITIZATION: SanitizationPolicy = {
  allowStringKeys: DEFAULT_ALLOWED_STRING_KEYS,
  forbiddenLiterals: [],
  maxDepth: 6,
  maxKeys: 50,
  maxArray: 50,
  maxStringLength: 200,
};

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:\-/]*$/;

export type Redacted = { redacted: true; sha256: string; length: number };

export function redact(value: string): Redacted {
  return {
    redacted: true,
    sha256: createHash('sha256').update(value).digest('hex').slice(0, 16),
    length: value.length,
  };
}

/** Folded, punctuation-free and decoded matching, the same comparison the leak guard uses. */
function containsForbidden(value: string, policy: SanitizationPolicy): boolean {
  const literals = policy.forbiddenLiterals.map(compact).filter(Boolean);
  if (!literals.length) return false;
  return decodedVariants(value).some((variant) => {
    const flat = compact(variant);
    return literals.some((literal) => flat.includes(literal));
  });
}

export function sanitizeValue(
  value: unknown,
  policy: SanitizationPolicy = DEFAULT_SANITIZATION,
  key = '',
  depth = 0,
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (
      policy.allowStringKeys.includes(key) &&
      value.length <= policy.maxStringLength &&
      IDENTIFIER.test(value) &&
      !containsForbidden(value, policy)
    )
      return value;
    return redact(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (depth >= policy.maxDepth) return { truncated: 'depth' };
  if (Array.isArray(value)) {
    const items = value.slice(0, policy.maxArray).map((item) => sanitizeValue(item, policy, key, depth + 1));
    return value.length > policy.maxArray
      ? [...items, { truncated: 'array', omitted: value.length - policy.maxArray }]
      : items;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [entryKey, child] of entries.slice(0, policy.maxKeys)) {
      // A key that names held-out truth is renamed and its whole value reduced to a hash: nothing under it is readable.
      if (isHeldOutKey(entryKey)) {
        out[`key_${redact(entryKey).sha256}`] = redact(JSON.stringify(child) ?? '');
        continue;
      }
      out[sanitizeKey(entryKey, policy)] = sanitizeValue(child, policy, entryKey, depth + 1);
    }
    if (entries.length > policy.maxKeys) out['_truncated'] = entries.length - policy.maxKeys;
    return out;
  }
  return null;
}

/** Keys are structural, but a key can itself carry data (an object keyed by a name). Hash anything unsafe. */
function sanitizeKey(key: string, policy: SanitizationPolicy): string {
  if (key.length <= 64 && IDENTIFIER.test(key) && !containsForbidden(key, policy)) return key;
  return `key_${redact(key).sha256}`;
}

/** An error becomes a code and a redacted message; stack traces and raw messages never leave the process. */
export function sanitizeError(error: unknown, policy: SanitizationPolicy = DEFAULT_SANITIZATION) {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name.slice(0, 64),
      ...(typeof code === 'string' && IDENTIFIER.test(code) ? { code: code.slice(0, 64) } : {}),
      message:
        error.message &&
        IDENTIFIER.test(error.message) &&
        error.message.length <= 64 &&
        !containsForbidden(error.message, policy)
          ? error.message
          : redact(error.message ?? ''),
    };
  }
  return { name: 'NonError', message: redact(String(error)) };
}

/**
 * Free text from a model (a diagnostic's `detail`). It cannot be proven free of personal data, so it FAILS CLOSED:
 *  - with no forbidden literals in the policy nothing can be checked, so all of it is replaced by a hash;
 *  - with literals, text that contains one (in any folded, split or encoded form) is replaced by a hash;
 *  - anything else is length-capped.
 * A caller that wants readable text must therefore supply the literal list of the trusted job.
 */
export function sanitizeFreeText(value: string, policy: SanitizationPolicy = DEFAULT_SANITIZATION): string {
  if (policy.forbiddenLiterals.length === 0 || containsForbidden(value, policy))
    return `[redacted:${redact(value).sha256}]`;
  return value.length > 200 ? `${value.slice(0, 200)}...[truncated]` : value;
}

/** A string for places that accept only strings (SDK properties): identifier-like values or a hash. */
export function sanitizeProperty(value: string, policy: SanitizationPolicy = DEFAULT_SANITIZATION): string {
  if (value.length <= policy.maxStringLength && IDENTIFIER.test(value) && !containsForbidden(value, policy))
    return value;
  return `redacted:${redact(value).sha256}`;
}
