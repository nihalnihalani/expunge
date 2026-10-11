import { X } from 'lucide-react';
import type {
  ArtifactEnvelope,
  GraphNode,
  RecordDetail,
  RecordElementView,
  RecordFieldView,
} from '../../../shared/expunge';
import { useResource } from '../hooks/useResource';
import { recordDetailArtifactId } from '../projection/graphModel';
import { HashChip } from './HashChip';
import { EffectChip, NodeStateChip } from './NodeChips';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from './StateViews';

const OUTCOME_WORDS: Record<RecordElementView['outcome'], string> = {
  removed: 'Removed',
  preserved: 'Preserved',
  redacted: 'Redacted',
  tombstoned: 'Tombstoned',
  restricted: 'Restricted',
};

/** A removed value is drawn as a solid bar and named in words; the bar alone is never the signal. */
function Element({
  element,
  total,
}: {
  element: RecordElementView;
  total: number;
}) {
  const gone = element.outcome !== 'preserved';
  return (
    <li className={`ex-elem ex-elem--${element.outcome}`}>
      <span className="ex-num ex-elem-index">
        {element.index + 1} of {total}
      </span>
      {gone ? (
        <span
          className="ex-redacted"
          role="img"
          aria-label={`${OUTCOME_WORDS[element.outcome]} element ${element.index + 1} of ${total}`}
        />
      ) : (
        <span className="ex-elem-value">
          {element.display ?? '(no preview)'}
        </span>
      )}
      <span className="ex-elem-word">{OUTCOME_WORDS[element.outcome]}</span>
    </li>
  );
}

function Field({ field }: { field: RecordFieldView }) {
  if (field.kind === 'unchanged_group')
    return (
      <div className="ex-field ex-field--unchanged">
        <p className="ex-muted">
          Unchanged: {(field.count ?? 0).toLocaleString()}{' '}
          {field.count === 1 ? 'field' : 'fields'} in this record kept their
          values.
        </p>
      </div>
    );
  return (
    <div className={`ex-field ${field.changed ? 'ex-field--changed' : ''}`}>
      <p className="ex-field-path">
        <span className="ex-data">{field.path}</span>{' '}
        <span className="ex-note">
          {field.changed ? 'changed' : 'unchanged'}
        </span>
      </p>
      {field.kind === 'array' && field.elements ? (
        <ul className="ex-elems" aria-label={`Elements of ${field.path}`}>
          {field.elements.map((element) => (
            <Element
              key={element.index}
              element={element}
              total={field.elements!.length}
            />
          ))}
        </ul>
      ) : (
        <p>{field.display ?? <span className="ex-muted">(no preview)</span>}</p>
      )}
    </div>
  );
}

/** The detail artifact's content: address, hashes, and field by field what changed. */
export function RecordDetailBody({ detail }: { detail: RecordDetail }) {
  return (
    <>
      <dl className="ex-dl">
        <dt>Address</dt>
        <dd>
          <span className="ex-data">
            {detail.address.collectionId} / {detail.address.recordId}
          </span>{' '}
          <span className="ex-chip ex-chip--dotted">
            {detail.address.recordIdBsonType}
          </span>
        </dd>
        <dt>Before</dt>
        <dd>
          <HashChip value={detail.preHash} label="preimage hash" />
        </dd>
        <dt>After</dt>
        <dd>
          {detail.postHash ? (
            <HashChip value={detail.postHash} label="postimage hash" />
          ) : (
            <span className="ex-muted">Record removed; no postimage</span>
          )}
        </dd>
      </dl>
      <div className="ex-fields">
        {detail.fields.map((field, index) => (
          <Field key={`${field.path}-${index}`} field={field} />
        ))}
      </div>
    </>
  );
}

/**
 * Mixed-record detail: exactly which array elements changed and which were preserved, and the
 * fields that were left alone. Reads one immutable artifact by id; shows nothing it was not given.
 */
export function RecordInspector({
  node,
  onClose,
}: {
  node: GraphNode;
  onClose: () => void;
}) {
  const detail = useResource<ArtifactEnvelope<RecordDetail>>(
    `/artifacts/${encodeURIComponent(recordDetailArtifactId(node.id))}`,
  );
  return (
    <aside className="ex-inspector" aria-labelledby="ex-inspector-h">
      <header className="ex-inspector-head">
        <h3
          className="ex-h3"
          id="ex-inspector-h"
          tabIndex={-1}
          data-ex-inspector
        >
          {node.label}
        </h3>
        <button
          type="button"
          className="ex-btn ex-btn--quiet ex-iconbtn"
          aria-label="Close record detail"
          onClick={onClose}
        >
          <X size={14} aria-hidden />
        </button>
      </header>
      <div className="ex-actions">
        <NodeStateChip state={node.state} />
        <EffectChip effect={node.effect} />
      </div>
      {detail.status === 'loading' && !detail.data && (
        <Skeleton label="record detail" />
      )}
      {detail.status === 'not_found' && (
        <EmptyState title="No before and after detail was committed for this record.">
          The projection shows detail only for records an effect touched or a
          verification flagged.
        </EmptyState>
      )}
      {detail.status === 'unavailable' && (
        <UnavailableState
          what="Record detail"
          reason={detail.error?.message ?? 'The backend did not provide it.'}
          onRecheck={detail.refresh}
        />
      )}
      {detail.status === 'error' && (
        <ErrorState
          what="the record detail"
          error={detail.error}
          onRetry={detail.refresh}
        />
      )}
      {detail.data && <RecordDetailBody detail={detail.data.payload} />}
    </aside>
  );
}
