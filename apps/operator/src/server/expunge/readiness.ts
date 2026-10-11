import type {
  ExpungeReadiness,
  ReadinessCheck,
  ReadinessReason,
} from '../../shared/expunge.js';
import { describeExpungeConfig, type ExpungeConfigView } from './config.js';
import type {
  ExpungeDomainService,
  DomainErrorCode,
} from './domain-service.js';

const PROBE_TIMEOUT_MS = 3000;
export const EVIDENCE_STALE_MS = 60 * 60 * 1000;

/** Fixed vocabulary. Never echoes an upstream body, URL or credential. */
const DETAIL: Record<ReadinessReason, string> = {
  env_missing:
    'Server configuration is missing. Set the named variables in the server environment and restart the operator.',
  env_malformed:
    'Server configuration is present but malformed. Check the named variables.',
  connect_refused:
    'The domain service did not accept a connection. Check that it is running at the configured address.',
  timeout: 'The domain service did not answer within 3 seconds.',
  tls_error:
    'The connection to the domain service failed during the TLS handshake.',
  http_5xx: 'The domain service answered with a server error.',
  bad_response:
    'The domain service answered with a response the operator could not read.',
  unauthorized:
    'The domain service rejected this operator credential (HTTP 401).',
  forbidden:
    'The domain service refused this operator credential for the projection (HTTP 403).',
  scope_unbound:
    'The domain service accepted the credential but has not bound this owner to a scope.',
  evidence_unconfigured:
    'The backend reports that the observability path (Raindrop) is not configured.',
  evidence_never_proven:
    'The backend has not yet proven that observability events can be written and read back. Cleanup can run; improvement proposals will wait for evidence.',
  evidence_stale:
    'The last proof that observability events can be read back is more than an hour old.',
  evidence_dead_letter:
    'The backend reports observability events that could not be delivered (dead letters).',
};

const check = (
  status: ReadinessCheck['status'],
  reason: ReadinessReason | null,
  detail: string,
  observedAt: string | null,
  missing: string[] = [],
): ReadinessCheck => ({ status, reason, missing, detail, observedAt });

const unknown = (why: string): ReadinessCheck =>
  check('unknown', null, `Not evaluated: ${why}`, null);

function reachFailure(code: DomainErrorCode): ReadinessReason {
  if (code === 'unreachable') return 'connect_refused';
  if (code === 'timeout') return 'timeout';
  if (code === 'tls_error') return 'tls_error';
  if (code === 'upstream_error') return 'http_5xx';
  return 'bad_response';
}

export async function computeReadiness(
  config: ExpungeConfigView,
  domain: ExpungeDomainService | undefined,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<ExpungeReadiness> {
  const checkedAt = now().toISOString();
  const base = {
    checkedAt,
    writes: config.writes,
    telemetry: config.telemetry,
  };
  if (config.configured.status !== 'pass' || !domain)
    return {
      ...base,
      backend: { kind: 'none', version: null },
      configured: config.configured,
      reachable: unknown('the domain service is not configured.'),
      authorized: unknown('the domain service is not configured.'),
      evidenceReady: unknown('the domain service is not configured.'),
      ready: false,
    };
  const probe = await domain.probeReadiness(
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(PROBE_TIMEOUT_MS),
  );
  if (probe.kind === 'error') {
    if (probe.code === 'unauthorized' || probe.code === 'forbidden')
      return {
        ...base,
        backend: { kind: 'none', version: null },
        configured: config.configured,
        reachable: check(
          'pass',
          null,
          'The domain service answered.',
          checkedAt,
        ),
        authorized: check('fail', probe.code, DETAIL[probe.code], checkedAt),
        evidenceReady: unknown('this operator is not authorized.'),
        ready: false,
      };
    const reason = reachFailure(probe.code);
    return {
      ...base,
      backend: { kind: 'none', version: null },
      configured: config.configured,
      reachable: check('fail', reason, DETAIL[reason], checkedAt),
      authorized: unknown('the domain service is not reachable.'),
      evidenceReady: unknown('the domain service is not reachable.'),
      ready: false,
    };
  }
  const { body } = probe;
  const reachable = check(
    'pass',
    null,
    'The domain service answered the readiness route.',
    checkedAt,
  );
  const authorized = body.scope.bound
    ? check(
        'pass',
        null,
        'The domain service accepted the credential and bound this owner to a scope.',
        checkedAt,
      )
    : check('fail', 'scope_unbound', DETAIL.scope_unbound, checkedAt);
  let evidenceReady: ReadinessCheck;
  if (authorized.status !== 'pass')
    evidenceReady = unknown('this owner is not bound to a scope.');
  else if (!body.evidence.configured)
    evidenceReady = check(
      'fail',
      'evidence_unconfigured',
      DETAIL.evidence_unconfigured,
      checkedAt,
    );
  else if (body.evidence.deadLetters > 0)
    evidenceReady = check(
      'fail',
      'evidence_dead_letter',
      DETAIL.evidence_dead_letter,
      checkedAt,
    );
  else if (!body.evidence.writeProvenAt || !body.evidence.readBackProvenAt)
    evidenceReady = check(
      'fail',
      'evidence_never_proven',
      DETAIL.evidence_never_proven,
      null,
    );
  else if (
    now().getTime() - Date.parse(body.evidence.readBackProvenAt) >
    EVIDENCE_STALE_MS
  )
    evidenceReady = check(
      'fail',
      'evidence_stale',
      DETAIL.evidence_stale,
      body.evidence.readBackProvenAt,
    );
  else
    evidenceReady = check(
      'pass',
      null,
      'The backend proved that observability events can be written and read back.',
      body.evidence.readBackProvenAt,
    );
  return {
    ...base,
    backend: body.backend,
    configured: config.configured,
    reachable,
    authorized,
    evidenceReady,
    ready: [config.configured, reachable, authorized, evidenceReady].every(
      (item) => item.status === 'pass',
    ),
  };
}

/** Five-second cache so a page of polling clients cannot fan out to the backend. */
export class ReadinessCache {
  private entry?: { at: number; value: Promise<ExpungeReadiness> };
  constructor(
    private readonly config: ExpungeConfigView,
    private readonly domain: ExpungeDomainService | undefined,
    private readonly ttlMs = 5000,
    private readonly clock: () => number = Date.now,
  ) {}
  /**
   * The computation is shared by every caller for the cache window, so it must not take any one
   * caller's abort signal: a viewer who navigates away would otherwise make everyone else see a
   * timeout. The caller's signal only decides whether it keeps waiting for the answer; the
   * domain transport has its own timeout.
   */
  get(force = false, _signal?: AbortSignal) {
    const now = this.clock();
    if (!force && this.entry && now - this.entry.at < this.ttlMs)
      return this.entry.value;
    const value = computeReadiness(
      this.config,
      this.domain,
      undefined,
      () => new Date(now),
    );
    this.entry = { at: now, value };
    // Never cache a rejected promise.
    value.catch(() => {
      if (this.entry?.value === value) this.entry = undefined;
    });
    return value;
  }
}

export { describeExpungeConfig };
