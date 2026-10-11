import type { SourceBindingView } from '../../../shared/expunge';
import { HashChip } from './HashChip';

/** Fixed copy for an authoritative source target. An absent binding never implies original-source erasure. */
export const SOURCE_SCOPE_COPY = {
  original:
    'This scope targets the owner’s original registered source. Operational completion requires committed source effects and independent read-back within that scope.',
  isolated_replay:
    'This scope targets an isolated snapshot or replay copy. Its cleanup result applies only to that copy and does not erase the original source.',
  unknown:
    'The backend has not reported a source target for this scope. This result cannot establish erasure of the original source.',
} as const;

export function SourceScopeNotice({
  sourceKind,
  binding,
}: {
  sourceKind?: 'original' | 'isolated_replay' | null;
  binding?: SourceBindingView;
}) {
  const kind = binding?.sourceKind ?? sourceKind ?? 'unknown';
  return (
    <div className="ex-banner ex-banner--info ex-source-scope" role="note">
      <strong>
        {kind === 'original'
          ? 'Original source.'
          : kind === 'isolated_replay'
            ? 'Isolated snapshot / replay.'
            : 'Source target unreported.'}
      </strong>
      <span>{SOURCE_SCOPE_COPY[kind]}</span>
      {binding && (
        <dl className="ex-dl">
          <dt>Source</dt>
          <dd className="ex-data">{binding.sourceId}</dd>
          <dt>Registration</dt>
          <dd>
            <HashChip
              value={binding.registrationHash}
              label="source registration hash"
            />
          </dd>
          <dt>Bound revisions</dt>
          <dd className="ex-num">
            registration {binding.registrationRevision} · policy{' '}
            {binding.policyRevision} · authorization{' '}
            {binding.authorizationRevision}
          </dd>
        </dl>
      )}
    </div>
  );
}
