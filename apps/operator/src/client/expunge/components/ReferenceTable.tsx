import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  GRAPH_NODE_STATES,
  type GraphNode,
  type GraphNodeState,
} from '../../../shared/expunge';
import {
  DEFAULT_QUERY,
  STATE_WORDS,
  queryNodes,
  type GraphIndex,
  type SortKey,
  type TableQuery,
} from '../projection/graphModel';
import { EffectChip, NodeStateChip } from './NodeChips';
import { EmptyState } from './StateViews';
import { TableWrap } from './TableWrap';

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'record', label: 'Record' },
  { key: 'hop', label: 'Hops from subject' },
  { key: 'effect', label: 'Effect' },
  { key: 'state', label: 'State' },
];

/**
 * The semantic table equal to the reference graph: every node, with how it was reached, its
 * committed effect and its state. Sortable, filterable and paginated; selecting a record
 * opens its before/after detail. Large collections are paged, never rendered whole.
 */
export function ReferenceTable({
  index,
  selectedId,
  onSelect,
  pageSize = DEFAULT_QUERY.pageSize,
  preset = null,
}: {
  index: GraphIndex;
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
  pageSize?: number;
  /** Opens with a collection and/or state already filtered (from a grouped mark in the drawing). */
  preset?: { collection?: string; state?: GraphNodeState } | null;
}) {
  const [query, setQuery] = useState<TableQuery>(() => ({
    ...DEFAULT_QUERY,
    pageSize,
    collection: preset?.collection ?? null,
    states: preset?.state ? new Set([preset.state]) : null,
  }));
  const result = useMemo(() => queryNodes(index, query), [index, query]);
  const present = useMemo(
    () =>
      GRAPH_NODE_STATES.filter((state) =>
        index.nodes.some((node) => node.state === state),
      ),
    [index],
  );
  const toggleState = (state: GraphNodeState) =>
    setQuery((current) => {
      const next = new Set(current.states ?? []);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return { ...current, states: next.size === 0 ? null : next, page: 1 };
    });
  const sortBy = (key: SortKey) =>
    setQuery((current) => ({
      ...current,
      sort: key,
      dir: current.sort === key && current.dir === 'asc' ? 'desc' : 'asc',
      page: 1,
    }));
  const ariaSort = (key: SortKey) =>
    query.sort === key
      ? query.dir === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none';
  return (
    <div className="ex-reftable">
      <div className="ex-tools">
        <div
          className="ex-filters"
          role="group"
          aria-label="Filter records by state"
        >
          {present.map((state) => (
            <button
              key={state}
              type="button"
              className="ex-btn ex-filter"
              aria-pressed={query.states?.has(state) ?? false}
              onClick={() => toggleState(state)}
            >
              {STATE_WORDS[state]}
            </button>
          ))}
        </div>
        <div className="ex-fieldrow">
          <label className="ex-label" htmlFor="ex-ref-collection">
            Collection
          </label>
          <select
            id="ex-ref-collection"
            className="ex-input"
            value={query.collection ?? ''}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                collection: event.target.value || null,
                page: 1,
              }))
            }
          >
            <option value="">All collections</option>
            {index.collections.map((collection) => (
              <option key={collection} value={collection}>
                {collection}
              </option>
            ))}
          </select>
          <label className="ex-label" htmlFor="ex-ref-text">
            Find a record
          </label>
          <input
            id="ex-ref-text"
            className="ex-input"
            type="search"
            autoComplete="off"
            value={query.text}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                text: event.target.value,
                page: 1,
              }))
            }
          />
        </div>
      </div>
      {result.total === 0 ? (
        <EmptyState title="No record matches these filters.">
          {index.nodes.length.toLocaleString()} records were discovered; clear a
          filter to see them.
        </EmptyState>
      ) : (
        <TableWrap label="Records reached from the subject">
          <table className="ex-table">
            <caption>
              Showing {(result.start + 1).toLocaleString()} to{' '}
              {(result.start + result.rows.length).toLocaleString()} of{' '}
              {result.total.toLocaleString()} records
              {result.total !== index.nodes.length
                ? ` (filtered from ${index.nodes.length.toLocaleString()})`
                : ''}
              .
            </caption>
            <thead>
              <tr>
                {COLUMNS.slice(0, 2).map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort(column.key)}
                  >
                    <button
                      type="button"
                      className="ex-sort"
                      onClick={() => sortBy(column.key)}
                    >
                      {column.label}
                    </button>
                  </th>
                ))}
                <th scope="col">Reached via</th>
                {COLUMNS.slice(2).map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort(column.key)}
                  >
                    <button
                      type="button"
                      className="ex-sort"
                      onClick={() => sortBy(column.key)}
                    >
                      {column.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((node) => {
                const via = index.reachedVia.get(node.id);
                const parent = via ? index.byId.get(via.from) : undefined;
                return (
                  <tr
                    key={node.id}
                    data-selected={selectedId === node.id ? 'true' : undefined}
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="ex-rowbtn"
                        aria-pressed={selectedId === node.id}
                        onClick={() => onSelect(node)}
                      >
                        {node.label}
                      </button>
                      {node.noExactIdentity && (
                        <div className="ex-note">
                          Namesake: no exact identity match.
                        </div>
                      )}
                    </th>
                    <td className="ex-num">{node.hop}</td>
                    <td>
                      {via ? (
                        <>
                          <span className="ex-data">{via.fieldId}</span>
                          <div className="ex-note">
                            from {parent ? parent.label : via.from}
                          </div>
                        </>
                      ) : (
                        <span className="ex-muted">
                          {node.hop === 0
                            ? 'The subject'
                            : 'No incoming reference recorded'}
                        </span>
                      )}
                    </td>
                    <td>
                      <EffectChip effect={node.effect} />
                    </td>
                    <td>
                      <NodeStateChip state={node.state} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
      {result.pages > 1 && (
        <nav className="ex-pager" aria-label="Record pages">
          <button
            type="button"
            className="ex-btn"
            disabled={result.page <= 1}
            onClick={() =>
              setQuery((current) => ({ ...current, page: result.page - 1 }))
            }
          >
            <ChevronLeft size={14} aria-hidden /> Previous
          </button>
          <span className="ex-num" aria-current="page">
            Page {result.page} of {result.pages}
          </span>
          <button
            type="button"
            className="ex-btn"
            disabled={result.page >= result.pages}
            onClick={() =>
              setQuery((current) => ({ ...current, page: result.page + 1 }))
            }
          >
            Next <ChevronRight size={14} aria-hidden />
          </button>
        </nav>
      )}
    </div>
  );
}
