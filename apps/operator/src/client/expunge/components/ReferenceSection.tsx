import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type {
  ExpungeJobSnapshotV2,
  GraphNode,
  GraphNodeState,
} from '../../../shared/expunge';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useGraph } from '../hooks/useGraph';
import { useAnnounce } from './LiveRegion';
import { RecordInspector } from './RecordInspector';
import { ReferenceTable } from './ReferenceTable';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from './StateViews';

// The drawing is a separate chunk, loaded the first time it is shown.
const ReferenceTrace = lazy(() => import('./ReferenceTrace'));

type View = 'table' | 'graph';
const KEY = 'ex-reference-view';
const read = (): View | null => {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'table' || value === 'graph' ? value : null;
  } catch {
    return null;
  }
};
const write = (view: View) => {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // A remembered view is a convenience; the page works without storage.
  }
};

/** Wide containers open on the drawing; narrow ones and anyone who chose the table open on the table. */
export const GRAPH_MIN_WIDTH = 1000;

/**
 * The reference graph: a table and a drawing of the same records, plus the record inspector.
 * The table is complete on its own and is first in the DOM; the toggle remembers the choice.
 * It reloads when the committed snapshot moves.
 */
export function ReferenceSection({
  snapshot,
}: {
  snapshot: ExpungeJobSnapshotV2;
}) {
  const graph = useGraph(snapshot.graph.artifactId, snapshot.sequence);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [chosen, setChosen] = useState<View | null>(read);
  const [preset, setPreset] = useState<{
    collection: string;
    state: GraphNodeState;
    key: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(rootRef, 1200);
  const announce = useAnnounce();
  const view: View = chosen ?? (width >= GRAPH_MIN_WIDTH ? 'graph' : 'table');
  // Keep the inspector pointed at the fresh node after a reload; close it if the node is gone.
  useEffect(() => {
    if (!selected || !graph.index) return;
    const fresh = graph.index.byId.get(selected.id);
    if (!fresh) setSelected(null);
    else if (fresh !== selected) setSelected(fresh);
  }, [graph.index, selected]);
  if (!snapshot.graph.artifactId)
    return (
      <EmptyState title="No references discovered yet.">
        The graph appears here once the job has discovered records that
        reference the subject.
      </EmptyState>
    );
  if (graph.status === 'loading' && !graph.index)
    return <Skeleton label="reference graph" />;
  if (graph.status === 'unavailable')
    return (
      <UnavailableState
        what="The reference graph"
        reason={graph.error?.message ?? 'The backend did not provide it.'}
        onRecheck={graph.refresh}
      />
    );
  if (graph.status === 'not_found')
    return (
      <EmptyState title="The graph artifact is not available from the projection.">
        The snapshot names a graph that the backend could not return.
      </EmptyState>
    );
  if (graph.status === 'error' && !graph.index)
    return (
      <ErrorState
        what="the reference graph"
        error={graph.error ?? undefined}
        onRetry={graph.refresh}
      />
    );
  if (!graph.index) return null;
  const choose = (next: View) => {
    setChosen(next);
    write(next);
  };
  const open = (node: GraphNode) => {
    setSelected(node);
    announce(`Record detail opened for ${node.label}.`);
  };
  return (
    <div className="ex-refsection" ref={rootRef}>
      {graph.truncated && (
        <div className="ex-banner ex-banner--warn" role="note">
          <strong>The graph is larger than this view reads.</strong>
          <span>
            Only the first pages were loaded; the counts above come from the
            committed snapshot.
          </span>
        </div>
      )}
      <div className="ex-viewtoggle" role="group" aria-label="Reference view">
        <button
          type="button"
          className="ex-btn"
          aria-pressed={view === 'table'}
          onClick={() => choose('table')}
        >
          Table
        </button>
        <button
          type="button"
          className="ex-btn"
          aria-pressed={view === 'graph'}
          onClick={() => choose('graph')}
        >
          Graph
        </button>
      </div>
      <div className={selected ? 'ex-refgrid ex-refgrid--open' : 'ex-refgrid'}>
        {view === 'table' ? (
          <ReferenceTable
            key={preset?.key ?? 0}
            index={graph.index}
            selectedId={selected?.id ?? null}
            onSelect={open}
            preset={preset}
          />
        ) : (
          <Suspense fallback={<Skeleton label="reference drawing" />}>
            <ReferenceTrace
              index={graph.index}
              selectedId={selected?.id ?? null}
              onSelect={open}
              onClear={() => setSelected(null)}
              onGroup={(group) => {
                setPreset({ ...group, key: (preset?.key ?? 0) + 1 });
                choose('table');
              }}
            />
          </Suspense>
        )}
        {selected && (
          <RecordInspector
            key={selected.id}
            node={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}
