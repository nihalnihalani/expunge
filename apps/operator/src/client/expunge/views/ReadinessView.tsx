import { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  ExpungeReadiness,
  ReadinessCheck,
  WorldSummary,
} from '../../../shared/expunge';
import {
  ConnectionBanner,
  type Connection,
} from '../components/ConnectionBanner';
import { HashChip } from '../components/HashChip';
import { useAnnounce } from '../components/LiveRegion';
import { PageHeading } from '../components/PageHeading';
import { TableWrap } from '../components/TableWrap';
import { StatusChip, type ChipState } from '../components/StatusChip';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { ageText, formatClock, formatTime } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { useResource } from '../hooks/useResource';
import { useReadiness } from '../readiness';
import type { ViewMeta, ViewProps } from '../registry';
import { telemetrySentence } from '../TelemetryNotice';

export const meta: ViewMeta = {
  id: 'setup',
  label: 'Setup',
  routes: ['setup'],
  scope: 'global',
  order: 90,
  navRoute: { name: 'setup' },
  home: 0,
};

const CHECKS = [
  {
    key: 'configured',
    name: 'Configured',
    question:
      'Are the server-side address and read credential present and well formed? No network is used.',
  },
  {
    key: 'reachable',
    name: 'Reachable',
    question: 'Does the domain service answer its readiness route?',
  },
  {
    key: 'authorized',
    name: 'Authorized',
    question:
      'Does it accept this operator credential and bind the owner to a scope?',
  },
  {
    key: 'evidenceReady',
    name: 'Evidence-ready',
    question:
      'Has the backend proven that observability events can be written and read back?',
  },
] as const;

/** Maps a check result to the shared chip vocabulary; the reason decides the family. */
export function chipFor(check: ReadinessCheck): ChipState {
  if (check.status === 'pass') return 'ok';
  if (check.status === 'unknown') return 'unknown';
  switch (check.reason) {
    case 'unauthorized':
    case 'forbidden':
    case 'scope_unbound':
      return 'rejected';
    case 'evidence_never_proven':
      return 'waiting_evidence';
    case 'evidence_stale':
      return 'stale';
    case 'evidence_dead_letter':
      return 'failed';
    default:
      return 'unavailable';
  }
}

export const STALE_AFTER_MS = 60_000;

export function connectionFor(status: string): Connection {
  if (status === 'retrying') return 'retrying';
  if (status === 'disconnected') return 'disconnected';
  if (status === 'unavailable') return 'unavailable';
  return 'live';
}

export function ReadinessRows({
  data,
  loading,
}: {
  data?: ExpungeReadiness;
  loading: boolean;
}) {
  return (
    <TableWrap label="Readiness checks">
      <table className="ex-table">
        <caption>
          Four separate checks. A configured address is never a connection test.
        </caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
            <th scope="col">What it means</th>
            <th scope="col">Observed</th>
          </tr>
        </thead>
        <tbody>
          {CHECKS.map((item) => {
            const check = data?.[item.key];
            return (
              <tr key={item.key}>
                <th scope="row">
                  {item.name}
                  <div className="ex-note">{item.question}</div>
                </th>
                <td>
                  {check ? (
                    <StatusChip state={chipFor(check)} />
                  ) : (
                    <span className="ex-muted">
                      {loading ? 'Checking' : '—'}
                    </span>
                  )}
                </td>
                <td>
                  {check ? (
                    <>
                      <div>{check.detail}</div>
                      {check.missing.length > 0 && (
                        <div>
                          Missing or malformed:{' '}
                          {check.missing.map((name, index) => (
                            <span key={name}>
                              {index > 0 && ', '}
                              <code className="ex-code">{name}</code>
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="ex-muted">
                      {loading ? 'Checking.' : 'Not available.'}
                    </span>
                  )}
                </td>
                <td className="ex-num">
                  {check ? formatTime(check.observedAt) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function Worlds({ authorized }: { authorized: boolean }) {
  const worlds = useResource<{ worlds: WorldSummary[] }>(
    authorized ? '/worlds' : null,
  );
  if (!authorized)
    return (
      <p className="ex-note">
        Worlds are listed once the domain service has authorized this operator.
      </p>
    );
  if (worlds.status === 'loading')
    return <Skeleton label="authorized worlds" />;
  if (worlds.status === 'unavailable')
    return (
      <UnavailableState
        what="The worlds list"
        reason={worlds.error?.message ?? 'The backend did not provide it.'}
        missing={worlds.error?.missing}
        onRecheck={worlds.refresh}
      />
    );
  if (!worlds.data)
    return (
      <ErrorState
        what="authorized worlds"
        error={worlds.error}
        onRetry={worlds.refresh}
      />
    );
  if (worlds.data.worlds.length === 0)
    return (
      <EmptyState title="No world is authorized for this owner.">
        The backend maps the owner to scopes. Ask the operator of the domain
        service to bind this owner to a world.
      </EmptyState>
    );
  return (
    <TableWrap label="Authorized worlds">
      <table className="ex-table">
        <caption>
          Controlled worlds this owner may clean up. Coverage is what the scope
          registry declares, not a guarantee that every copy of a subject is
          registered.
        </caption>
        <thead>
          <tr>
            <th scope="col">World</th>
            <th scope="col">Scope and revisions</th>
            <th scope="col">Registry</th>
            <th scope="col">Allowed effects</th>
            <th scope="col">Eligibility policy</th>
            <th scope="col">Limits</th>
            <th scope="col">Discovery</th>
          </tr>
        </thead>
        <tbody>
          {worlds.data.worlds.map((world) => (
            <tr key={world.worldId}>
              <th scope="row">
                {world.label}
                <div className="ex-note">
                  <span className="ex-data">{world.worldId}</span> · {world.env}
                </div>
                {world.maintenanceMode && (
                  <StatusChip state="unavailable" label="Maintenance mode" />
                )}
              </th>
              <td className="ex-num">
                {world.scopeId}
                <div className="ex-note">
                  scope rev {world.scopeRevision} · world rev{' '}
                  {world.worldRevision}
                </div>
              </td>
              <td className="ex-num">
                {world.collectionIds.length} collections
                <div className="ex-note">
                  {world.fieldCount} fields · {world.referenceEdgeCount}{' '}
                  reference edges
                </div>
              </td>
              <td>{world.allowedEffectKinds.join(', ')}</td>
              <td>
                {world.eligibilityPolicyId}
                <div>
                  <HashChip
                    value={world.eligibilityPolicyHash}
                    label="eligibility policy hash"
                  />
                </div>
              </td>
              <td className="ex-num">
                scan {world.documentLimits.maxScanned.toLocaleString()}
                <div className="ex-note">
                  change {world.documentLimits.maxChanged.toLocaleString()}
                </div>
              </td>
              <td>
                <StatusChip
                  state={
                    world.discoveryCompleteness.kind === 'partial'
                      ? 'incomplete'
                      : 'ok'
                  }
                  label={`Discovery ${world.discoveryCompleteness.kind}`}
                />
                {world.discoveryCompleteness.limitations.map((text) => (
                  <div className="ex-note" key={text}>
                    {text}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export default function ReadinessView(_props: ViewProps) {
  useDocumentTitle('Setup and readiness');
  const { resource, recheck } = useReadiness();
  const announce = useAnnounce();
  const now = useNow();
  const data = resource.data;
  const ageMs = resource.updatedAt === null ? null : now - resource.updatedAt;
  const stale = ageMs !== null && ageMs > STALE_AFTER_MS;
  const ready = data?.ready && !stale;
  const failing = data
    ? CHECKS.filter((item) => data[item.key].status !== 'pass').length
    : 0;
  const lastAnnounced = useRef<string>('');
  useEffect(() => {
    if (!data || stale) return;
    const text = data.ready
      ? 'All four readiness checks pass.'
      : `Not ready. ${failing} of 4 readiness checks do not pass.`;
    if (lastAnnounced.current !== text) {
      lastAnnounced.current = text;
      announce(text);
    }
  }, [data, stale, failing, announce]);
  const setupOnly =
    data?.configured.status === 'fail' && data.backend.kind === 'none';
  return (
    <div className="ex-page">
      <PageHeading eyebrow="Expunge" title="Setup and readiness">
        Cleanup runs only against a trusted domain service. These four checks
        are separate on purpose: a configured address says nothing about whether
        the service answers, accepts this operator, or can show evidence.
      </PageHeading>
      <ConnectionBanner
        connection={
          stale && resource.status === 'ok'
            ? 'stale'
            : connectionFor(resource.status)
        }
        attempt={resource.attempt}
        nextRetryMs={resource.nextRetryMs}
        updatedAt={resource.updatedAt}
        now={now}
        onRetry={recheck}
      />
      {setupOnly && (
        <div className="ex-banner ex-banner--info">
          <strong>Setup-only.</strong>
          <span>
            The domain service is not configured, so no cleanup can run. Chat
            additionally needs a model provider and CopilotKit Intelligence; see
            Settings and setup.
          </span>
        </div>
      )}
      {resource.status === 'error' && (
        <ErrorState
          what="readiness"
          error={resource.error}
          stale={!!data}
          onRetry={recheck}
        />
      )}
      <section className="ex-section" aria-labelledby="ex-ready-h">
        <h2 className="ex-h2" id="ex-ready-h">
          Readiness checks
        </h2>
        {resource.status === 'loading' && !data ? (
          <ReadinessRows loading />
        ) : (
          <>
            <ReadinessRows data={data} loading={false} />
            <div className="ex-actions">
              {data && (
                <StatusChip
                  state={stale ? 'stale' : ready ? 'ok' : 'unknown'}
                  label={
                    stale
                      ? 'Result out of date'
                      : ready
                        ? 'Ready'
                        : `Not ready: ${failing} of 4 checks do not pass`
                  }
                />
              )}
              <button type="button" className="ex-btn" onClick={recheck}>
                <RefreshCw size={14} aria-hidden /> Re-check
              </button>
              {resource.updatedAt !== null && (
                <span className="ex-note">
                  Checked {formatClock(resource.updatedAt)} (
                  {ageText(resource.updatedAt, now)})
                </span>
              )}
            </div>
          </>
        )}
      </section>
      {data && (
        <section className="ex-section" aria-labelledby="ex-writes-h">
          <h2 className="ex-h2" id="ex-writes-h">
            Actions that change state
          </h2>
          <TableWrap label="Actions that change state">
            <table className="ex-table">
              <caption>
                Each action uses its own server-side credential. Present means
                configured, not that the backend accepts it.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Credential</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    'Submit cleanup and operator previews',
                    'EXPUNGE_JOB_WRITE_TOKEN',
                    data.writes.submit,
                  ],
                  [
                    'Cancel a job',
                    'EXPUNGE_JOB_WRITE_TOKEN',
                    data.writes.cancel,
                  ],
                  [
                    'Record an approval decision',
                    'EXPUNGE_APPROVAL_TOKEN',
                    data.writes.approve,
                  ],
                ].map(([action, name, ok]) => (
                  <tr key={String(action)}>
                    <th scope="row">{action}</th>
                    <td>
                      <code className="ex-code">{String(name)}</code>
                    </td>
                    <td>
                      {ok ? (
                        <StatusChip state="ok" label="Credential present" />
                      ) : (
                        <StatusChip
                          state="unavailable"
                          label="Credential missing"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </section>
      )}
      <section className="ex-section" aria-labelledby="ex-worlds-h">
        <h2 className="ex-h2" id="ex-worlds-h">
          Authorized worlds
        </h2>
        <Worlds authorized={data?.authorized.status === 'pass' && !stale} />
      </section>
      {data && (
        <section className="ex-section" aria-labelledby="ex-tel-h">
          <h2 className="ex-h2" id="ex-tel-h">
            Operator telemetry
          </h2>
          <p className="ex-note">{telemetrySentence(data.telemetry)}</p>
        </section>
      )}
    </div>
  );
}
