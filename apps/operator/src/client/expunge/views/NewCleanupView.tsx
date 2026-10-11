import { useEffect, useMemo, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type {
  CleanupPreview,
  EffectKind,
  SubjectIdType,
  WorldSummary,
} from '../../../shared/expunge';
import {
  cleanupReadinessPassed,
  sourceBindingMatchesReadiness,
  sourceBindingsEqual,
  SOURCE_ENVIRONMENTS,
} from '../../../shared/expunge';
import { ExpungeApiError, expungeFetch } from '../api';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { HashChip } from '../components/HashChip';
import { useAnnounce } from '../components/LiveRegion';
import { PageHeading } from '../components/PageHeading';
import { PendingAcknowledgement } from '../components/PendingAcknowledgement';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { SourceScopeNotice } from '../components/SourceScopeNotice';
import { TableWrap } from '../components/TableWrap';
import { formatTime } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { useResource } from '../hooks/useResource';
import { useReadiness } from '../readiness';
import type { ViewMeta, ViewProps } from '../registry';
import { formatRoute } from '../routes';
import {
  ID_TYPES,
  newRequestKey,
  normalizeSubjectValue,
  validateSubject,
} from '../lib/subject';
import { previewStale } from '../lib/preview';
export { previewStale } from '../lib/preview';

export const meta: ViewMeta = {
  id: 'new',
  label: 'New cleanup',
  routes: ['new'],
  scope: 'global',
  order: 20,
  navRoute: { name: 'new' },
};

const EFFECTS: EffectKind[] = ['delete', 'redact', 'restrict', 'tombstone'];

export type Problem =
  | { kind: 'unavailable'; message: string; missing: string[] }
  | { kind: 'unsupported'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'error'; message: string; transport: boolean };

/** Fixed-vocabulary mapping from the operator's closed error codes. Never echoes upstream text. */
export function problemFrom(
  error: unknown,
  action: 'preview' | 'submit',
): Problem {
  if (!(error instanceof ExpungeApiError))
    return { kind: 'error', message: 'The request failed.', transport: false };
  if (error.kind === 'transport')
    return {
      kind: 'error',
      message:
        action === 'submit'
          ? 'The acknowledgment was lost. The job may have been submitted. Reconnect and retry with the same request key to avoid a second job.'
          : 'The preview response was not received. Reconnect and request the preview again.',
      transport: true,
    };
  switch (error.code) {
    case 'source_not_ready':
      return {
        kind: 'unavailable',
        message:
          'Real-source registration, source binding and cleanup permission must be confirmed by the backend. See Setup and readiness.',
        missing: [],
      };
    case 'owner_auth_required':
      return {
        kind: 'unavailable',
        message: `The operator requires its owner access token, so no ${action === 'preview' ? 'preview' : 'job'} was requested. Unlock the workspace with the token.`,
        missing: error.missing,
      };
    case 'write_principal_missing':
      return {
        kind: 'unavailable',
        message: `The operator has no credential for this action, so no ${action === 'preview' ? 'preview' : 'job'} was requested.`,
        missing: error.missing,
      };
    case 'unconfigured':
    case 'unreachable':
    case 'timeout':
    case 'tls_error':
      return {
        kind: 'unavailable',
        message: 'The domain service is not available.',
        missing: error.missing,
      };
    case 'unsupported':
      return {
        kind: 'unsupported',
        message:
          'This backend does not provide effect previews. Scope and eligibility policy are shown above; the job’s own preview phase shows its effects before anything is applied.',
      };
    case 'conflict':
      return {
        kind: 'stale',
        message:
          'The world or the preview changed since you previewed. Preview again before submitting.',
      };
    case 'invalid_request':
      return {
        kind: 'rejected',
        message:
          'The domain service rejected this world or subject. Check the identifier and the world.',
      };
    case 'not_found':
      return {
        kind: 'rejected',
        message: 'This world is no longer available to this owner.',
      };
    case 'unauthorized':
    case 'forbidden':
      return {
        kind: 'rejected',
        message:
          'The domain service rejected this operator’s credential. See Setup and readiness.',
      };
    default:
      return {
        kind: 'error',
        message:
          action === 'submit'
            ? 'Submission could not be confirmed. Check the jobs list, then retry with the same request key; the backend resolves duplicate requests.'
            : 'The domain service could not complete the preview.',
        transport: false,
      };
  }
}

function WorldFacts({ world }: { world: WorldSummary }) {
  return (
    <>
      <SourceScopeNotice binding={world.source} />
      <dl className="ex-dl ex-worldfacts">
        <dt>Scope</dt>
        <dd>
          <span className="ex-data">{world.scopeId}</span>{' '}
          <span className="ex-note">
            scope revision {world.scopeRevision}, world revision{' '}
            {world.worldRevision}, {world.env}
          </span>
        </dd>
        <dt>Registry</dt>
        <dd>
          {world.collectionIds.length} collections, {world.fieldCount} fields,{' '}
          {world.referenceEdgeCount} reference edges
        </dd>
        <dt>Allowed effects</dt>
        <dd>{world.allowedEffectKinds.join(', ')}</dd>
        <dt>Eligibility policy</dt>
        <dd>
          {world.eligibilityPolicyId}{' '}
          <HashChip
            value={world.eligibilityPolicyHash}
            label="eligibility policy hash"
          />
        </dd>
        <dt>Limits</dt>
        <dd className="ex-num">
          scan up to {world.documentLimits.maxScanned.toLocaleString()}, change
          up to {world.documentLimits.maxChanged.toLocaleString()}
        </dd>
        <dt>Discovery</dt>
        <dd>
          <StatusChip
            state={
              world.discoveryCompleteness.kind === 'partial'
                ? 'incomplete'
                : 'ok'
            }
            label={`Registry discovery ${world.discoveryCompleteness.kind}`}
          />
          {world.discoveryCompleteness.limitations.map((text) => (
            <div className="ex-note" key={text}>
              {text}
            </div>
          ))}
        </dd>
      </dl>
    </>
  );
}

export function PreviewResult({ preview }: { preview: CleanupPreview }) {
  return (
    <>
      <SourceScopeNotice binding={preview.source} />
      <div className="ex-banner ex-banner--info" role="note">
        <strong>Operator preview, not the agent&apos;s plan.</strong>
        <span>
          It was computed without a model, under the fixed expert-static
          discovery policy, and it never authorizes an effect. The job&apos;s
          own preview phase and your approvals decide what happens.
        </span>
      </div>
      <dl className="ex-dl">
        <dt>Subject</dt>
        <dd>
          <span className="ex-data">{preview.subject.display}</span>{' '}
          <span className="ex-chip ex-chip--dotted">
            {preview.subject.idType}
          </span>
        </dd>
        <dt>Identity</dt>
        <dd>
          <HashChip
            value={preview.subject.identityHash}
            label="identity hash"
          />
        </dd>
        <dt>Computed at</dt>
        <dd className="ex-num">
          world revision {preview.worldRevision}, scope revision{' '}
          {preview.scopeRevision}; valid until {formatTime(preview.expiresAt)}
        </dd>
      </dl>
      <TableWrap label="Preview by collection">
        <table className="ex-table">
          <caption>
            Exact-identity matches only. A name that looks similar is not a
            match.
          </caption>
          <thead>
            <tr>
              <th scope="col">Collection</th>
              <th scope="col" className="ex-right">
                Exact matches
              </th>
              {EFFECTS.map((effect) => (
                <th scope="col" className="ex-right" key={effect}>
                  {effect}
                </th>
              ))}
              <th scope="col" className="ex-right">
                Retained
              </th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {preview.perCollection.map((row) => (
              <tr key={row.collectionId}>
                <th scope="row" className="ex-data">
                  {row.collectionId}
                </th>
                <td className="ex-right ex-num">{row.exactIdentityMatches}</td>
                {EFFECTS.map((effect) => (
                  <td className="ex-right ex-num" key={effect}>
                    {row.eligibleEffects[effect] ?? 0}
                  </td>
                ))}
                <td className="ex-right ex-num">{row.retained}</td>
                <td>
                  {row.notInspected ? (
                    <StatusChip state="incomplete" label="Not inspected" />
                  ) : (
                    <span className="ex-muted">Inspected</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {preview.limitations.length > 0 && (
        <ul className="ex-list ex-note" aria-label="Preview limitations">
          {preview.limitations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function NewCleanupView({ navigate }: ViewProps) {
  useDocumentTitle('New cleanup');
  const readiness = useReadiness();
  const worlds = useResource<{ worlds: WorldSummary[] }>('/worlds', {
    pollMs: 30_000,
  });
  const announce = useAnnounce();
  const now = useNow(5000);
  const [worldId, setWorldId] = useState<string | null>(null);
  const [idType, setIdType] = useState<SubjectIdType>('objectId');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<
    'editing' | 'previewing' | 'previewed' | 'submitting' | 'submitted'
  >('editing');
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const requestKey = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const list = worlds.data?.worlds ?? [];
  const selected = list.find((world) => world.worldId === worldId);
  // One authorized world is the obvious choice; several need an explicit choice.
  useEffect(() => {
    if (worldId === null && list.length === 1) setWorldId(list[0].worldId);
  }, [list, worldId]);
  // Move focus to the preview once it has rendered, so keyboard and screen reader users land on it.
  useEffect(() => {
    if (phase === 'previewed' && preview) previewHeading.current?.focus();
  }, [phase, preview]);
  const [focusSummary, setFocusSummary] = useState(0);
  // After a failed validation the summary exists only once the error state has rendered.
  useEffect(() => {
    if (focusSummary > 0) summary.current?.focus();
  }, [focusSummary]);
  const validation = validateSubject(idType, value);
  const sentValue = normalizeSubjectValue(idType, value);
  const normalized = validation.ok && sentValue !== value;
  const showErrors = touched && !validation.ok;
  const stale = preview ? previewStale(preview, selected, now) : null;
  const writes = readiness.resource.data?.writes;
  const readinessFresh =
    readiness.resource.updatedAt !== null &&
    now - readiness.resource.updatedAt <= 60_000;
  const cleanupReady =
    readiness.resource.status === 'ok' &&
    readinessFresh &&
    cleanupReadinessPassed(readiness.resource.data) &&
    Boolean(
      selected &&
      (SOURCE_ENVIRONMENTS as readonly string[]).includes(selected.env) &&
      sourceBindingMatchesReadiness(
        selected.source,
        readiness.resource.data?.source,
      ),
    );
  const edit =
    <T,>(setter: (next: T) => void) =>
    (next: T) => {
      setter(next);
      // Any change to the world or subject invalidates the preview: Submit must match what was previewed.
      abort.current?.abort();
      setPreview(null);
      setProblem(null);
      setPhase('editing');
      requestKey.current = null;
    };
  const onPreview = async () => {
    setTouched(true);
    if (!cleanupReady || !worldId || !validation.ok) {
      setFocusSummary((count) => count + 1);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setPhase('previewing');
    setProblem(null);
    try {
      const result = await expungeFetch<CleanupPreview>('/previews', {
        method: 'POST',
        body: { worldId, subject: { idType, value: sentValue } },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (
        !selected ||
        result.worldId !== selected.worldId ||
        !sourceBindingsEqual(result.source, selected.source)
      ) {
        setProblem({
          kind: 'stale',
          message:
            'The preview does not match the selected source registration. Re-check setup and preview again.',
        });
        setPhase('editing');
        return;
      }
      setPreview(result);
      setPhase('previewed');
      requestKey.current = newRequestKey();
      announce('Preview ready. Review it before submitting.');
    } catch (cause) {
      if (controller.signal.aborted) return;
      setProblem(problemFrom(cause, 'preview'));
      setPhase('editing');
    }
  };
  const onSubmit = async () => {
    if (!cleanupReady || !preview || !worldId || stale || !requestKey.current)
      return;
    setPhase('submitting');
    setProblem(null);
    try {
      const result = await expungeFetch<{ jobId: string }>('/jobs', {
        method: 'POST',
        body: {
          requestKey: requestKey.current,
          worldId,
          previewId: preview.previewId,
          subject: { idType, value: sentValue },
        },
      });
      setPhase('submitted');
      announce('Cleanup submitted. Opening the job.');
      // The literal subject is not kept: leave the form state behind with the page.
      setValue('');
      navigate({ name: 'job', jobId: result.jobId, tab: 'workbench' });
    } catch (cause) {
      const next = problemFrom(cause, 'submit');
      setProblem(next);
      // The same request key is kept for a retry, so a retry cannot start a second job.
      setPhase('previewed');
    }
  };
  const unavailableByReadiness =
    readiness.resource.status === 'ok' &&
    readiness.resource.data &&
    readiness.resource.data.configured.status !== 'pass';
  const needsSubmitCredential = writes ? !writes.submit : false;
  const world = useMemo(() => selected, [selected]);
  return (
    <div className="ex-page">
      <PageHeading eyebrow="Expunge" title="New cleanup">
        Choose an authorized source scope and the exact subject to remove. You
        will see the scope, the eligibility policy and a model-free preview of
        effects before anything is submitted.
      </PageHeading>
      <p className="ex-note">
        An isolated snapshot or replay is a copy. Cleaning it verifies that
        copy’s result; it does not erase records in the original source.
      </p>
      {(worlds.status === 'retrying' || worlds.status === 'disconnected') && (
        <ConnectionBanner
          connection={worlds.status}
          attempt={worlds.attempt}
          nextRetryMs={worlds.nextRetryMs}
          updatedAt={worlds.updatedAt}
          now={now}
          onRetry={worlds.refresh}
          detail="Your entries are kept. Submitting is unavailable until the connection returns."
        />
      )}
      {unavailableByReadiness && (
        <UnavailableState
          what="New cleanup"
          reason="The domain service is not configured."
          missing={readiness.resource.data?.configured.missing}
          onRecheck={readiness.recheck}
        />
      )}
      {!cleanupReady && !unavailableByReadiness && (
        <div className="ex-banner ex-banner--warn" role="status">
          <strong>Cleanup blocked.</strong>
          <span>
            The backend must report current source registration and cleanup
            permission, and bind the selected scope to that source. See{' '}
            <a className="ex-link" href={formatRoute({ name: 'setup' })}>
              Setup and readiness
            </a>
            .
          </span>
        </div>
      )}
      {!unavailableByReadiness &&
        worlds.status === 'loading' &&
        !worlds.data && <Skeleton label="authorized worlds" />}
      {worlds.status === 'unavailable' && !worlds.data && (
        <UnavailableState
          what="The world list"
          reason={
            worlds.error?.message ?? 'The domain service is not available.'
          }
          missing={worlds.error?.missing}
          onRecheck={worlds.refresh}
        />
      )}
      {(worlds.status === 'error' || worlds.status === 'not_found') && (
        <ErrorState
          what="authorized worlds"
          error={worlds.error}
          stale={!!worlds.data}
          onRetry={worlds.refresh}
        />
      )}
      {worlds.data && list.length === 0 && (
        <EmptyState title="No world is authorized for this owner.">
          The backend maps the owner to scopes. Ask the operator of the domain
          service to bind this owner to a world.
        </EmptyState>
      )}
      {list.length > 0 && (
        <form
          className="ex-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void onPreview();
          }}
        >
          {showErrors && (
            <div
              ref={summary}
              tabIndex={-1}
              className="ex-banner ex-banner--danger"
              role="alert"
            >
              <strong>Check the subject.</strong>
              <a
                className="ex-link"
                href="#ex-subject-value"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById('ex-subject-value')?.focus();
                }}
              >
                {validation.message}
              </a>
            </div>
          )}
          {touched && !worldId && (
            <div
              ref={summary}
              tabIndex={-1}
              className="ex-banner ex-banner--danger"
              role="alert"
            >
              <strong>Choose a world.</strong>
            </div>
          )}
          <fieldset className="ex-fieldset">
            <legend className="ex-legend">Source scope</legend>
            <p className="ex-note">
              Scopes come from the backend. An unreported source binding cannot
              start cleanup.
            </p>
            {list.map((item) => (
              <label
                className="ex-radio"
                key={item.worldId}
                data-disabled={item.maintenanceMode ? 'true' : undefined}
              >
                <input
                  type="radio"
                  name="world"
                  value={item.worldId}
                  checked={worldId === item.worldId}
                  disabled={item.maintenanceMode}
                  onChange={() => edit(setWorldId)(item.worldId)}
                />
                <span>
                  <strong>{item.label}</strong>
                  <span className="ex-note">
                    {' '}
                    <span className="ex-data">{item.worldId}</span>
                    {item.maintenanceMode
                      ? ' (maintenance mode: not available)'
                      : ''}
                  </span>
                </span>
              </label>
            ))}
            {world && <WorldFacts world={world} />}
          </fieldset>
          <fieldset className="ex-fieldset">
            <legend className="ex-legend">Subject</legend>
            <p className="ex-note">
              Exact identity only. The identifier is typed and matched exactly;
              a similar name or a partial value is never a match. The value
              stays in this page and is not shown again after submitting.
            </p>
            <div className="ex-fieldrow">
              <label className="ex-label" htmlFor="ex-subject-type">
                Identifier type
              </label>
              <select
                id="ex-subject-type"
                className="ex-input"
                value={idType}
                onChange={(event) =>
                  edit(setIdType)(event.target.value as SubjectIdType)
                }
              >
                {ID_TYPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="ex-fieldrow">
              <label className="ex-label" htmlFor="ex-subject-value">
                Exact identifier
              </label>
              <input
                id="ex-subject-value"
                className="ex-input ex-data"
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                value={value}
                aria-invalid={showErrors}
                aria-describedby={`ex-subject-hint${normalized ? ' ex-subject-normalized' : ''}${showErrors ? ' ex-subject-error' : ''}`}
                onBlur={() => setTouched(true)}
                onChange={(event) => edit(setValue)(event.target.value)}
              />
              <p className="ex-note" id="ex-subject-hint">
                {ID_TYPES.find((item) => item.value === idType)?.hint}
              </p>
              {normalized && (
                <p className="ex-note" id="ex-subject-normalized">
                  Sent in lowercase:{' '}
                  <code className="ex-code">{sentValue}</code>
                </p>
              )}
              {showErrors && (
                <p className="ex-fielderror" id="ex-subject-error">
                  {validation.message}
                </p>
              )}
            </div>
          </fieldset>
          <div className="ex-actions">
            <button
              type="submit"
              className="ex-btn"
              disabled={
                phase === 'previewing' ||
                phase === 'submitting' ||
                needsSubmitCredential ||
                !cleanupReady
              }
            >
              {phase === 'previewing'
                ? 'Resolving exact identity'
                : 'Preview effects'}
            </button>
            {phase === 'previewing' && (
              <button
                type="button"
                className="ex-btn ex-btn--quiet"
                onClick={() => {
                  abort.current?.abort();
                  setPhase('editing');
                }}
              >
                Cancel preview
              </button>
            )}
            {needsSubmitCredential && (
              <span className="ex-note">
                Previews and submits need{' '}
                <code className="ex-code">EXPUNGE_JOB_WRITE_TOKEN</code> on the
                server.
              </span>
            )}
          </div>
        </form>
      )}
      {problem && (
        <div
          className={`ex-banner ${problem.kind === 'stale' ? 'ex-banner--warn' : problem.kind === 'rejected' ? 'ex-banner--danger' : 'ex-banner--warn'}`}
          role="alert"
        >
          <strong>
            {problem.kind === 'rejected'
              ? 'Rejected.'
              : problem.kind === 'stale'
                ? 'Out of date.'
                : problem.kind === 'unsupported'
                  ? 'Not provided by this backend.'
                  : problem.kind === 'unavailable'
                    ? 'Unavailable.'
                    : 'Could not complete.'}
          </strong>
          <span>{problem.message}</span>
          {problem.kind === 'unavailable' && problem.missing.length > 0 && (
            <span>
              Set{' '}
              {problem.missing.map((name, index) => (
                <span key={name}>
                  {index > 0 && ', '}
                  <code className="ex-code">{name}</code>
                </span>
              ))}{' '}
              in the server environment.
            </span>
          )}
        </div>
      )}
      {phase === 'previewing' && (
        <p className="ex-note" role="status">
          <StatusChip state="running" label="Resolving exact identity" />{' '}
          Nothing has been submitted.
        </p>
      )}
      {preview &&
        (phase === 'previewed' ||
          phase === 'submitting' ||
          phase === 'submitted') && (
          <section className="ex-section" aria-labelledby="ex-preview-h">
            <h2
              className="ex-h2"
              id="ex-preview-h"
              ref={previewHeading}
              tabIndex={-1}
            >
              Preview
            </h2>
            {preview.perCollection.every(
              (row) => row.exactIdentityMatches === 0,
            ) && (
              <EmptyState title="No record has this exact identity in the registered scope.">
                Nothing would change. This is a legitimate outcome, not an
                error; unregistered paths are not examined.
              </EmptyState>
            )}
            <PreviewResult preview={preview} />
            {stale ? (
              <div className="ex-banner ex-banner--warn" role="status">
                <StatusChip state="stale" />
                <strong>{stale}</strong>
                <span>Submit is removed until you preview again.</span>
                <button
                  type="button"
                  className="ex-btn"
                  onClick={() => void onPreview()}
                >
                  Preview again
                </button>
              </div>
            ) : phase === 'submitted' ? (
              <PendingAcknowledgement>
                Submitted. Opening the job; the database confirms it when it
                commits.
              </PendingAcknowledgement>
            ) : (
              <div className="ex-actions">
                <button
                  type="button"
                  className="ex-btn ex-btn--primary"
                  disabled={
                    phase === 'submitting' ||
                    needsSubmitCredential ||
                    !cleanupReady ||
                    worlds.status === 'disconnected'
                  }
                  onClick={() => void onSubmit()}
                >
                  <Send size={14} aria-hidden />{' '}
                  {phase === 'submitting' ? 'Submitting' : 'Submit cleanup'}
                </button>
                <span className="ex-note">
                  Submitting starts a durable job on the server. It keeps
                  running if you close this tab, and only an explicit cancel
                  stops it.
                </span>
              </div>
            )}
          </section>
        )}
      <p className="ex-note">
        <a className="ex-link" href={formatRoute({ name: 'home' })}>
          Back to jobs
        </a>
      </p>
    </div>
  );
}
