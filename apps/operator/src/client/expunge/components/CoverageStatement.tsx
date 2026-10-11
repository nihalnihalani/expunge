import type { ExpungeJobSnapshotV2 } from '../../../shared/expunge';
import { notInspected } from '../projection/selectors';
import { StatusChip } from './StatusChip';

/**
 * Always visible in the workbench: what was inspected out of what is registered. A
 * registered-but-uninspected collection is named, so "complete" can never hide a gap.
 */
export function CoverageStatement({
  snapshot,
}: {
  snapshot: ExpungeJobSnapshotV2;
}) {
  const { coverage } = snapshot;
  const missing = notInspected(snapshot);
  const registered = coverage.registeredCollectionIds.length;
  return (
    <div className="ex-coverage">
      <p className="ex-coverage-line">
        <strong>
          Inspected {coverage.inspectedCollectionIds.length} of {registered}{' '}
          registered
          {registered === 1 ? ' collection' : ' collections'}.
        </strong>{' '}
        <StatusChip
          state={coverage.completeness === 'partial' ? 'incomplete' : 'ok'}
          label={`Registry discovery ${coverage.completeness}`}
        />
      </p>
      {missing.length > 0 ? (
        <p className="ex-note">
          Not inspected:{' '}
          {missing.map((name, index) => (
            <span key={name}>
              {index > 0 && ', '}
              <code className="ex-code">{name}</code>
            </span>
          ))}
          . Completion in the registered scope stays incomplete until these are
          inspected.
        </p>
      ) : (
        <p className="ex-note">
          Every registered collection has been inspected.
        </p>
      )}
      {coverage.limitations.length > 0 && (
        <ul className="ex-list ex-note">
          {coverage.limitations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      <p className="ex-note">
        {coverage.discoveredFieldIds.length} registered fields discovered so
        far. Coverage describes the registry, not a guarantee that every copy of
        a subject is registered.
      </p>
    </div>
  );
}
