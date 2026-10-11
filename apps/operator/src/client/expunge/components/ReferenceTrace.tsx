import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type {
  EffectKind,
  GraphNode,
  GraphNodeState,
} from '../../../shared/expunge';
import {
  DEFAULT_LAYOUT,
  layoutGraph,
  nextNode,
  pathThrough,
  type Direction,
  type Layout,
  type PlacedNode,
} from '../projection/graphLayout';
import {
  EFFECT_WORDS,
  STATE_WORDS,
  type GraphIndex,
} from '../projection/graphModel';

const ZOOMS = [0.75, 1, 1.25, 1.5];
const S = DEFAULT_LAYOUT.nodeSize;

/** The mark for one record. Shape, fill pattern and glyph carry meaning; color only reinforces it. */
function Mark({
  state,
  effect,
  x,
  y,
}: {
  state: GraphNodeState;
  effect: EffectKind | null;
  x: number;
  y: number;
}) {
  return (
    <g className={`ex-gn ex-gn--${state}`} aria-hidden>
      <rect className="ex-gn-box" x={x} y={y} width={S} height={S} rx={2} />
      {state === 'applied' && effect === 'delete' && (
        <path
          className="ex-gn-glyph"
          d={`M ${x + 3} ${y + 3} L ${x + S - 3} ${y + S - 3} M ${x + S - 3} ${y + 3} L ${x + 3} ${y + S - 3}`}
        />
      )}
      {state === 'applied' && effect === 'redact' && (
        <rect
          className="ex-gn-fill"
          x={x + 2}
          y={y + S / 2 - 2}
          width={S - 4}
          height={4}
        />
      )}
      {state === 'applied' && effect === 'restrict' && (
        <rect
          className="ex-gn-fill"
          x={x + 2}
          y={y + 2}
          width={(S - 4) / 2}
          height={S - 4}
        />
      )}
      {state === 'applied' && effect === 'tombstone' && (
        <path
          className="ex-gn-glyph"
          d={`M ${x + 2} ${y + S - 2} L ${x + S - 2} ${y + 2}`}
        />
      )}
      {state === 'residual' && (
        <path
          className="ex-gn-glyph"
          d={`M ${x + S / 2} ${y + 3} L ${x + S - 3} ${y + S - 3} H ${x + 3} Z`}
        />
      )}
    </g>
  );
}

const laneName = (hop: number) =>
  hop === 0 ? 'Subject' : `${hop} ${hop === 1 ? 'hop' : 'hops'} away`;

const shortId = (id: string) =>
  id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

/** What is written beside a mark; the full label stays in the accessible name and the table. */
function drawLabel(placed: PlacedNode, aggregated: boolean, max: number) {
  const { node } = placed;
  const text = aggregated
    ? node.label
    : `${node.collectionId} / ${shortId(node.recordId)}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describe(placed: PlacedNode, layout: Layout) {
  const { node, count } = placed;
  const refs = layout.children.get(node.id)?.length ?? 0;
  const parts = [node.label];
  if (count > 1) parts.push(`${count} records`);
  parts.push(`state ${STATE_WORDS[node.state]}`);
  if (node.effect) parts.push(`effect ${EFFECT_WORDS[node.effect]}`);
  parts.push(`${refs} ${refs === 1 ? 'reference' : 'references'} onward`);
  parts.push(
    `${placed.lane} ${placed.lane === 1 ? 'hop' : 'hops'} from the subject`,
  );
  return parts.join(', ');
}

export interface ReferenceTraceProps {
  index: GraphIndex;
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
  onClear: () => void;
  /** Aggregated groups have no record detail; selecting one filters the table instead. */
  onGroup?: (group: { collection: string; state: GraphNodeState }) => void;
}

/**
 * The reference graph: lanes by hop distance, records as marks, references as orthogonal
 * lines. Committed effects form the one seal-colored path. Everything drawn is also in the
 * table. Keyboard: one tab stop; arrows move along references; Enter opens the record.
 */
export default function ReferenceTrace({
  index,
  selectedId,
  onSelect,
  onClear,
  onGroup,
}: ReferenceTraceProps) {
  const [zoom, setZoom] = useState(1);
  const [help, setHelp] = useState(false);
  const layout = useMemo(
    () =>
      layoutGraph(index, {
        ...DEFAULT_LAYOUT,
        laneWidth: Math.round(DEFAULT_LAYOUT.laneWidth * zoom),
        rowHeight: Math.round(DEFAULT_LAYOUT.rowHeight * zoom),
      }),
    [index, zoom],
  );
  const subjectId =
    layout.laneOrder.get(0)?.[0] ?? layout.nodes[0]?.node.id ?? null;
  const [focusId, setFocusId] = useState<string | null>(subjectId);
  const [hover, setHover] = useState<string | null>(null);
  const refs = useRef(new Map<string, SVGGElement>());
  const previous = useRef(new Map<string, GraphNodeState>());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // Mark records whose state changed since the last read, so a new committed effect is noticed once.
  useEffect(() => {
    const changed = new Set<string>();
    for (const placed of layout.nodes) {
      const before = previous.current.get(placed.node.id);
      if (before !== undefined && before !== placed.node.state)
        changed.add(placed.node.id);
    }
    previous.current = new Map(
      layout.nodes.map((placed) => [placed.node.id, placed.node.state]),
    );
    setFresh(changed);
  }, [layout]);
  const active = hover ?? focusId ?? selectedId;
  const keep = useMemo(
    () =>
      active && layout.byId.has(active) ? pathThrough(layout, active) : null,
    [active, layout],
  );
  const move = useCallback(
    (from: string, direction: Direction) => {
      const target = nextNode(layout, from, direction);
      setFocusId(target);
      refs.current.get(target)?.focus();
    },
    [layout],
  );
  const choose = (placed: PlacedNode) => {
    if (layout.aggregated && onGroup)
      onGroup({
        collection: placed.node.collectionId,
        state: placed.node.state,
      });
    else onSelect(placed.node);
  };
  if (layout.nodes.length === 0) return null;
  const applied = layout.nodes.filter((p) => p.node.state === 'applied').length;
  const summary = `Reference graph: ${index.nodes.length} records in ${index.collections.length} collections across ${layout.lanes} ${layout.lanes === 1 ? 'lane' : 'lanes'}; ${applied} with an applied effect${layout.aggregated ? '; grouped by collection and state because it is large' : ''}.`;
  const legend = [...new Set(layout.nodes.map((p) => p.node.state))];
  const effects = [
    ...new Set(
      layout.nodes
        .filter((p) => p.node.state === 'applied' && p.node.effect)
        .map((p) => p.node.effect as EffectKind),
    ),
  ];
  const hasBack = layout.edges.some((edge) => edge.back);
  const hasCommitted = layout.edges.some((edge) => edge.committed);
  return (
    <div className="ex-trace">
      <div className="ex-trace-bar">
        <p className="ex-note">{summary}</p>
        <div className="ex-actions" role="group" aria-label="Drawing controls">
          <button
            type="button"
            className="ex-btn ex-iconbtn"
            aria-label="Zoom out"
            disabled={zoom <= ZOOMS[0]}
            onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])}
          >
            <Minus size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="ex-btn ex-iconbtn"
            aria-label="Zoom in"
            disabled={zoom >= ZOOMS[ZOOMS.length - 1]}
            onClick={() =>
              setZoom(
                ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)],
              )
            }
          >
            <Plus size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="ex-btn ex-iconbtn"
            aria-label="Reset zoom"
            disabled={zoom === 1}
            onClick={() => setZoom(1)}
          >
            <RotateCcw size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="ex-btn"
            aria-expanded={help}
            aria-controls="ex-trace-help"
            onClick={() => setHelp((value) => !value)}
          >
            Keyboard help
          </button>
        </div>
      </div>
      <div id="ex-trace-help" className="ex-trace-help" hidden={!help}>
        <p className="ex-note">
          The graph is one tab stop. Right arrow follows a reference forward,
          Left arrow goes back, Up and Down move between records in the same
          lane, Home goes to the subject, End to the last record with an applied
          effect, Enter or Space opens the record, Escape closes it. The table
          view has the same records.
        </p>
      </div>
      <div
        className="ex-trace-scroll"
        role="region"
        aria-label="Reference graph drawing (scrollable)"
        tabIndex={0}
      >
        <svg
          className="ex-trace-svg"
          width={layout.width}
          height={layout.height}
          role="group"
          aria-label={summary}
          focusable="false"
        >
          <g aria-hidden>
            {layout.laneLabels.map((lane) => (
              <text
                key={lane.x}
                className="ex-glane"
                x={lane.x}
                y={DEFAULT_LAYOUT.pad - 4}
              >
                {laneName(lane.hop)}
              </text>
            ))}
            {layout.edges.map((edge) => (
              <path
                key={edge.id}
                d={edge.d}
                className={`ex-edge${edge.committed ? ' ex-edge--committed' : ''}${edge.back ? ' ex-edge--back' : ''}${keep && !(keep.has(edge.from) && keep.has(edge.to)) ? ' ex-edge--dim' : ''}`}
              />
            ))}
          </g>
          {layout.nodes.map((placed) => {
            const { node } = placed;
            const dim = keep !== null && !keep.has(node.id);
            return (
              <g
                key={node.id}
                ref={(element) => {
                  if (element) refs.current.set(node.id, element);
                  else refs.current.delete(node.id);
                }}
                className={`ex-gnode${dim ? ' ex-gnode--dim' : ''}${fresh.has(node.id) ? ' ex-gnode--fresh' : ''}`}
                role="button"
                tabIndex={focusId === node.id ? 0 : -1}
                aria-label={describe(placed, layout)}
                aria-pressed={selectedId === node.id}
                onFocus={() => setFocusId(node.id)}
                onMouseEnter={() => setHover(node.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => choose(placed)}
                onKeyDown={(event) => {
                  const keys: Record<string, Direction> = {
                    ArrowRight: 'right',
                    ArrowLeft: 'left',
                    ArrowUp: 'up',
                    ArrowDown: 'down',
                    Home: 'home',
                    End: 'end',
                  };
                  if (keys[event.key]) {
                    event.preventDefault();
                    move(node.id, keys[event.key]);
                  } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    choose(placed);
                  } else if (event.key === 'Escape') {
                    onClear();
                  } else if (event.key === '?') {
                    setHelp((value) => !value);
                  }
                }}
              >
                <rect
                  className="ex-gn-hit"
                  x={placed.x - 4}
                  y={placed.y - 5}
                  width={layout.textWidth + S + 8}
                  height={S + 10}
                />
                <rect
                  className="ex-gn-focus"
                  x={placed.x - 3}
                  y={placed.y - 3}
                  width={S + 6}
                  height={S + 6}
                  rx={4}
                />
                <title>{node.label}</title>
                <Mark
                  state={node.state}
                  effect={node.effect}
                  x={placed.x}
                  y={placed.y}
                />
                {selectedId === node.id && (
                  <rect
                    className="ex-gn-selected"
                    x={placed.x - 5}
                    y={placed.y - 5}
                    width={S + 10}
                    height={S + 10}
                    rx={5}
                  />
                )}
                <text
                  className="ex-gtext"
                  x={placed.x + S + 6}
                  y={placed.y + S - 2}
                >
                  {drawLabel(
                    placed,
                    layout.aggregated,
                    Math.max(8, Math.floor(layout.textWidth / 6.2)),
                  )}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="ex-legend" aria-label="Legend">
        {legend.map((state) => (
          <li key={state}>
            <svg width={S + 4} height={S + 4} aria-hidden focusable="false">
              <Mark
                state={state}
                effect={state === 'applied' ? 'redact' : null}
                x={2}
                y={2}
              />
            </svg>{' '}
            {STATE_WORDS[state]}
          </li>
        ))}
        {effects.map((effect) => (
          <li key={effect}>
            <svg width={S + 4} height={S + 4} aria-hidden focusable="false">
              <Mark state="applied" effect={effect} x={2} y={2} />
            </svg>{' '}
            {EFFECT_WORDS[effect]}
          </li>
        ))}
        {hasCommitted && (
          <li>
            <span
              className="ex-legend-line ex-legend-line--committed"
              aria-hidden
            />{' '}
            Committed path
          </li>
        )}
        {hasBack && (
          <li>
            <span className="ex-legend-line ex-legend-line--back" aria-hidden />{' '}
            Reference back to an earlier record (cycle)
          </li>
        )}
      </ul>
    </div>
  );
}
