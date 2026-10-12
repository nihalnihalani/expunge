import type {
  ExpungeReadiness,
  ReadinessCheck,
  ReadinessReason,
  SourceReadinessView,
} from '../../shared/expunge.js';
import { describeExpungeConfig, type ExpungeConfigView } from './config.js';
import type {
  ExpungeDomainService,
  DomainErrorCode,
} from './domain-service.js';

const PROBE_TIMEOUT_MS = 3000;
export const EVIDENCE_STALE_MS = 60 * 60 * 1000;

/** Fixed vocabulary. Never echoes an upstream body, URL or credential. */
/** Allowed difference between the backend's clock and this one before a future proof time is rejected. */
export const EVIDENCE_CLOCK_SKEW_MS = 5_000;

const DETAIL: Record<ReadinessReason | 'evidence_clock_skew', string> = {
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
  source_registration_unreported:
    'The domain service has not reported a registered real source. Cleanup is blocked until the actual source registry is connected.',
  source_missing:
    'No owner-approved real source is registered for this scope. Register the source and its exact cleanup policy with the domain service.',
  source_revoked:
    'The source registration has been revoked. Cleanup remains blocked until the owner reviews and authorizes a current registration.',
  source_unsupported:
    'The domain service cannot support the registered source within the declared scope. Review the source adapter and measured limitations.',
  legacy_backend:
    'This is a legacy fixture backend. It cannot authorize real-source cleanup or establish production readiness.',
  cleanup_permission_not_checked:
    'The domain service has not checked cleanup permission for the current source registration. Cleanup is blocked.',
  cleanup_permission_denied:
    'The domain service denied cleanup permission for this source. Ask the source owner to review the intended write scope.',
  cleanup_permission_revoked:
    'Cleanup permission for this source has been revoked. A new owner authorization is required before any cleanup.',
  evidence_unconfigured:
    'The backend reports that the observability path (Raindrop) is not configured.',
  evidence_never_proven:
    'The backend has not yet proven that observability events can be written and read back. Improvement proposals will wait for evidence.',
  evidence_clock_skew:
    "The backend's evidence proof is dated in the future, so the clocks disagree and the proof is not trusted. Treated as stale.",
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

/** Pure mapping of the domain's validated registry/permission DTO; never probes or infers a grant. */
export function describeSourceReadiness(
  source: SourceReadinessView | null | undefined,
  observedAt: string,
  backendKind: 'live' | 'fixture' = 'live',
): { sourceRegistered: ReadinessCheck; cleanupAuthorized: ReadinessCheck } {
  const fail = (reason: ReadinessReason) =>
    check('fail', reason, DETAIL[reason], observedAt);
  if (backendKind !== 'live')
    return {
      sourceRegistered: fail('legacy_backend'),
      cleanupAuthorized: fail('legacy_backend'),
    };
  if (!source)
    return {
      sourceRegistered: fail('source_registration_unreported'),
      cleanupAuthorized: check(
        'unknown',
        'cleanup_permission_not_checked',
        DETAIL.cleanup_permission_not_checked,
        null,
      ),
    };
  const completeBinding =
    source.sourceId !== null &&
    source.sourceKind !== null &&
    source.sourceRegistrationHash !== null &&
    source.registrationRevision !== null &&
    source.policyRevision !== null &&
    source.authorizationRevision !== null;
  const sourceRegistered =
    source.registration === 'active' && completeBinding
      ? check(
          'pass',
          null,
          source.sourceKind === 'isolated_replay'
            ? 'The backend reports an active registration for an isolated replay copy with its current identity, policy and authorization revisions. Cleaning the copy does not erase the original source.'
            : 'The backend reports an active owner-approved real-source registration with its current identity, policy and authorization revisions.',
          observedAt,
        )
      : fail(
          source.registration === 'missing'
            ? 'source_missing'
            : source.registration === 'revoked'
              ? 'source_revoked'
              : 'source_unsupported',
        );
  const cleanupAuthorized =
    sourceRegistered.status !== 'pass'
      ? check(
          'unknown',
          'cleanup_permission_not_checked',
          DETAIL.cleanup_permission_not_checked,
          null,
        )
      : source.permission === 'authorized'
        ? check(
            'pass',
            null,
            'The backend reports owner-authorized cleanup permission for this source registration. Each effect still rechecks current authority.',
            observedAt,
          )
        : fail(
            source.permission === 'denied'
              ? 'cleanup_permission_denied'
              : source.permission === 'revoked'
                ? 'cleanup_permission_revoked'
                : 'cleanup_permission_not_checked',
          );
  return { sourceRegistered, cleanupAuthorized };
}

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
    source: null,
    sourceRegistered: unknown(
      'the domain service has not reported source registration.',
    ),
    cleanupAuthorized: unknown(
      'the domain service has not reported cleanup permission.',
    ),
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
  const sourceChecks =
    authorized.status === 'pass'
      ? describeSourceReadiness(body.source, checkedAt, body.backend.kind)
      : {
          sourceRegistered: unknown('this owner is not bound to a scope.'),
          cleanupAuthorized: unknown('this owner is not bound to a scope.'),
        };
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
    Date.parse(body.evidence.readBackProvenAt) - now().getTime() >
    EVIDENCE_CLOCK_SKEW_MS
  )
    // A proof dated in the future cannot be fresh: the clocks disagree, so it is not trusted (DA-7 RD4).
    // The readiness vocabulary has no clock reason, so it is reported as stale with its own sentence.
    evidenceReady = check(
      'fail',
      'evidence_stale',
      DETAIL.evidence_clock_skew,
      body.evidence.readBackProvenAt,
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
    ...sourceChecks,
    source: body.source ?? null,
    evidenceReady,
    ready: [
      config.configured,
      reachable,
      authorized,
      sourceChecks.sourceRegistered,
      sourceChecks.cleanupAuthorized,
      evidenceReady,
    ].every((item) => item.status === 'pass'),
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
