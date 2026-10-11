import { useRef, useState } from 'react';
import type {
  ArtifactEnvelope,
  CandidateView as CandidateData,
  ExpungeJobSnapshotV2,
} from '../../../shared/expunge';
import { HashChip } from '../components/HashChip';
import { JobFrame } from '../components/JobFrame';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { plural } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResource } from '../hooks/useResource';
import type { ViewMeta, ViewProps } from '../registry';
import { CHANGE_WORD } from '../review/approvalState';
import { ApprovalDialog } from '../review/ApprovalDialog';

export const meta: ViewMeta = {
  id: 'candidate',
  label: 'Candidate',
  routes: ['job'],
  tab: 'candidate',
  scope: 'job',
  order: 30,
};

const MAX_CANDIDATES = 5;

/** Committed approval state in words; the click-side state never appears here. */
export const APPROVAL_COPY: Record<
  ExpungeJobSnapshotV2['approval']['state'],
  string
> = {
  none: 'No approval is requested for this job.',
  pending: 'A decision is owed. The job released its lease and waits.',
  approved:
    'The database recorded an approval. Promotion is a separate committed step.',
  declined: 'The database recorded a decline. The candidate was not promoted.',
  expired: 'The approval expired before a decision. Nothing was promoted.',
  consumed: 'The approval grant was used by a committed promotion.',
  stale:
    'The proposal went stale (the parent or scope changed). It cannot be approved.',
};

function Patch({ patch }: { patch: CandidateData['patches'][number] }) {
  return (
    <li className="ex-patch">
      <p className="ex-patch-head">
        <strong>{patch.surface.replaceAll('_', ' ')}</strong>{' '}
        <code className="ex-code">{patch.path}</code>
      </p>
      <p className="ex-note">Hypothesis: {patch.hypothesis}</p>
      <div className="ex-diff">
        <figure>
          <figcaption>Before (removed)</figcaption>
          <pre>
            <span aria-hidden>− </span>
            {patch.before || '(empty)'}
          </pre>
        </figure>
        <figure>
          <figcaption>After (added)</figcaption>
          <pre>
            <span aria-hidden>+ </span>
            {patch.after || '(empty)'}
          </pre>
        </figure>
      </div>
      <p className="ex-note">
        {plural(patch.sourceEvidenceIds.length, 'source evidence bundle')}
      </p>
    </li>
  );
}

/** Pure rendering of one committed candidate artifact. */
export function CandidateDocument({ candidate }: { candidate: CandidateData }) {
  const mismatch = candidate.claimedClass !== candidate.computedClass;
  return (
    <article
      className="ex-candidate"
      aria-label={`Candidate ${candidate.candidateId}`}
    >
      <h3 className="ex-h3">
        <span className="ex-data">{candidate.candidateId}</span>{' '}
        <StatusChip
          state={
            candidate.state.endsWith('rejected')
              ? 'rejected'
              : candidate.state === 'promoted' || candidate.state === 'eligible'
                ? 'ok'
                : candidate.state === 'stale' || candidate.state === 'revoked'
                  ? 'stale'
                  : 'unknown'
          }
          label={candidate.state.replaceAll('_', ' ')}
        />
      </h3>
      <dl className="ex-dl">
        <dt>Target</dt>
        <dd>{candidate.target}</dd>
        <dt>Parent</dt>
        <dd>
          <HashChip value={candidate.parentHash} label="parent hash" />
        </dd>
        <dt>Child</dt>
        <dd>
          <HashChip value={candidate.childHash} label="child hash" />
        </dd>
        <dt>Active parent now</dt>
        <dd>
          {candidate.activeParentHash ? (
            <>
              <HashChip
                value={candidate.activeParentHash}
                label="active parent hash"
              />
              {candidate.activeParentHash !== candidate.parentHash && (
                <>
                  {' '}
                  <StatusChip
                    state="stale"
                    label="differs from tested parent"
                  />
                </>
              )}
            </>
          ) : (
            'Not reported'
          )}
        </dd>
        <dt>Authority class</dt>
        <dd>
          <strong>{candidate.computedClass.replaceAll('_', ' ')}</strong>{' '}
          <span className="ex-note">computed by the gate</span>
          {mismatch && (
            <>
              {' '}
              <StatusChip
                state="fail"
                label={`claimed ${candidate.claimedClass.replaceAll('_', ' ')}`}
              />
            </>
          )}
        </dd>
      </dl>
      <p>{candidate.hypothesis}</p>

      <h4 className="ex-h4">What changes</h4>
      {candidate.flipSet.length > 0 && (
        <ul className="ex-list">
          {candidate.flipSet.map((flip) => (
            <li key={flip.capability}>
              <code className="ex-code">{flip.capability}</code>:{' '}
              {CHANGE_WORD[flip.change]}
            </li>
          ))}
        </ul>
      )}
      {candidate.patches.length === 0 ? (
        <p className="ex-note">No typed patches are recorded.</p>
      ) : (
        <ul className="ex-patches">
          {candidate.patches.map((patch) => (
            <Patch key={`${patch.surface}:${patch.path}`} patch={patch} />
          ))}
        </ul>
      )}

      <h4 className="ex-h4">Compiler and replay</h4>
      <p>
        <StatusChip
          state={candidate.compiler.ok ? 'ok' : 'fail'}
          label={candidate.compiler.ok ? 'Compiled' : 'Compiler rejected'}
        />
      </p>
      {candidate.compiler.messages.length > 0 && (
        <ul className="ex-list ex-note">
          {candidate.compiler.messages.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {candidate.replay ? (
        <p className="ex-note">
          Decision replay (a diagnostic, not evidence of improvement):{' '}
          {candidate.replay.ran ? candidate.replay.summary : 'did not run.'}
        </p>
      ) : (
        <p className="ex-note">No decision replay was recorded.</p>
      )}
      {candidate.reasonCodes.length > 0 && (
        <>
          <h4 className="ex-h4">Reason codes</h4>
          <ul className="ex-list">
            {candidate.reasonCodes.map((code) => (
              <li key={code}>
                <code className="ex-code">{code}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="ex-note">
        {plural(candidate.sourceEvidence.length, 'evidence reference')} support
        this candidate.
      </p>
    </article>
  );
}

function CandidateLoader({ artifactId }: { artifactId: string }) {
  const read = useResource<ArtifactEnvelope<CandidateData>>(
    `/artifacts/${encodeURIComponent(artifactId)}`,
  );
  if (read.status === 'loading') return <Skeleton label="candidate" />;
  if (read.status === 'unavailable')
    return (
      <UnavailableState
        what="The candidate"
        reason={read.error?.message ?? 'The artifact service is not reachable.'}
        onRecheck={read.refresh}
      />
    );
  if (!read.data)
    return (
      <ErrorState
        what="the candidate"
        error={read.error}
        onRetry={read.refresh}
      />
    );
  return <CandidateDocument candidate={read.data.payload} />;
}

function ApprovalSection({
  snapshot,
  onDecided,
}: {
  snapshot: ExpungeJobSnapshotV2;
  onDecided: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { approval } = snapshot;
  return (
    <section className="ex-section" aria-labelledby="ex-appr-h">
      <h2 className="ex-h2" id="ex-appr-h">
        Approval
      </h2>
      <p>{APPROVAL_COPY[approval.state]}</p>
      {approval.proposalId && (
        <>
          <div className="ex-actions">
            <button
              ref={trigger}
              type="button"
              className={
                approval.state === 'pending'
                  ? 'ex-btn ex-btn--primary'
                  : 'ex-btn'
              }
              onClick={() => setOpen(true)}
            >
              {approval.state === 'pending'
                ? 'Review proposal'
                : 'View proposal'}
            </button>
          </div>
          <ApprovalDialog
            proposalId={approval.proposalId}
            open={open}
            onClose={() => setOpen(false)}
            onDecided={onDecided}
          />
        </>
      )}
    </section>
  );
}

export default function CandidatePage({ route }: ViewProps) {
  useDocumentTitle(
    route.name === 'job' ? `Job ${route.jobId} · Candidate` : 'Candidate',
  );
  if (route.name !== 'job') return null;
  return (
    <JobFrame route={route} title={`Job ${route.jobId}`}>
      {(projection) => {
        const snapshot = projection.state.snapshot!;
        const candidates = snapshot.artifacts
          .filter((item) => item.kind === 'candidate')
          .slice(0, MAX_CANDIDATES);
        return (
          <>
            <ApprovalSection
              snapshot={snapshot}
              onDecided={projection.refresh}
            />
            <section className="ex-section" aria-labelledby="ex-cand-h">
              <h2 className="ex-h2" id="ex-cand-h">
                Candidate harness
              </h2>
              {candidates.length === 0 ? (
                <EmptyState title="No candidate for this job.">
                  Cleanup jobs run the pinned harness. A candidate appears here
                  when an improvement job proposes one.
                </EmptyState>
              ) : (
                candidates.map((item) => (
                  <CandidateLoader
                    key={item.artifactId}
                    artifactId={item.artifactId}
                  />
                ))
              )}
            </section>
          </>
        );
      }}
    </JobFrame>
  );
}
