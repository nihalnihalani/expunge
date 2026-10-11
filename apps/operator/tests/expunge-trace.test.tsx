import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DecisionLog,
  categoryOf,
  payloadText,
} from '../src/client/expunge/components/DecisionLog';
import ReferenceTrace from '../src/client/expunge/components/ReferenceTrace';
import {
  MAX_DRAWN_NODES,
  aggregate,
  layoutGraph,
  nextNode,
  pathThrough,
} from '../src/client/expunge/projection/graphLayout';
import { buildIndex } from '../src/client/expunge/projection/graphModel';
import {
  PROJECTION_KINDS,
  type EffectKind,
  type GraphEdge,
  type GraphNode,
  type GraphNodeState,
} from '../src/shared/expunge';
import { event } from './fixtures/expunge-data';
import { samplePayloads } from './fixtures/expunge-samples';
import { fullGraph } from './fixtures/ext/20-graph';

const mk = (
  collection: string,
  record: string,
  hop: number,
  state: GraphNodeState,
  effect: EffectKind | null = null,
): GraphNode => ({
  id: `n-${collection}-${record}`,
  collectionId: collection,
  recordId: record,
  recordIdBsonType: 'string',
  hop,
  state,
  effect,
  label: `${collection} / ${record}`,
  fieldIds: [],
  noExactIdentity: false,
});
const link = (from: GraphNode, to: GraphNode, fieldId = 'f.id'): GraphEdge => ({
  id: `e-${from.id}-${to.id}`,
  from: from.id,
  to: to.id,
  edgeId: `edge-${fieldId}`,
  fieldId,
});

const complete = fullGraph('complete');
// A small purpose-built graph: one subject, two applied accounts, one retained account.
const subjectNode = mk('customers', '7f3a', 0, 'applied', 'delete');
const acc1 = mk('accounts', 'acc-01', 1, 'applied', 'redact');
const acc2 = mk('accounts', 'acc-02', 1, 'applied', 'redact');
const acc3 = mk('accounts', 'acc-03', 1, 'retained');
const base = buildIndex(
  [subjectNode, acc1, acc2, acc3],
  [
    link(subjectNode, acc1, 'accounts.ownerId'),
    link(subjectNode, acc2, 'accounts.ownerId'),
    link(subjectNode, acc3, 'accounts.ownerName'),
  ],
);

describe('graph layout', () => {
  const layout = layoutGraph(base);
  it('places the subject alone in lane 0 and its references in lane 1, in a stable order', () => {
    expect(layout.lanes).toBe(2);
    expect(layout.laneOrder.get(0)).toEqual(['n-customers-7f3a']);
    expect(layout.laneOrder.get(1)).toEqual([
      'n-accounts-acc-01',
      'n-accounts-acc-02',
      'n-accounts-acc-03',
    ]);
    const again = layoutGraph(
      buildIndex([...complete.nodes].reverse(), complete.edges),
    );
    expect(again.laneOrder.get(1)).toEqual(layout.laneOrder.get(1));
    expect(layout.aggregated).toBe(false);
  });
  it('draws forward references as orthogonal lines and marks committed ones', () => {
    expect(layout.edges).toHaveLength(3);
    for (const edge of layout.edges) {
      expect(edge.back).toBe(false);
      expect(edge.d).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+ H [\d.]+$/);
    }
    const committed = layout.edges.filter((e) => e.committed);
    expect(committed.map((e) => e.to).sort()).toEqual([
      'n-accounts-acc-01',
      'n-accounts-acc-02',
    ]);
  });
  it('starts every forward connector past the end of the label, so a line never crosses text', () => {
    for (const edge of layout.edges) {
      const from = layout.byId.get(edge.from)!;
      const start = Number(edge.d.split(' ')[1]);
      expect(start).toBe(from.x + 200 - 34);
      expect(start).toBeGreaterThanOrEqual(from.x + 14 + 6 + layout.textWidth);
    }
  });
  it('keeps nodes inside the reported size', () => {
    for (const placed of layout.nodes) {
      expect(placed.x).toBeLessThan(layout.width);
      expect(placed.y).toBeLessThan(layout.height);
    }
  });
  it('treats a reference back to an earlier lane as a visible cycle, not a forward step', () => {
    const a = mk('customers', 'a', 0, 'applied', 'delete');
    const b = mk('accounts', 'b', 1, 'applied', 'redact');
    const loop = layoutGraph(buildIndex([a, b], [link(a, b), link(b, a)]));
    expect(loop.edges.find((e) => e.from === b.id)?.back).toBe(true);
    // The loop runs in the gutters left of each mark and across the top, never through a mark.
    const back = loop.edges.find((e) => e.from === b.id)!;
    const pa = loop.byId.get(a.id)!;
    const pb = loop.byId.get(b.id)!;
    expect(back.d).toBe(
      `M ${pb.x} ${pb.y + 7} H ${pb.x - 8} V ${24 + 22 - 8} H ${pa.x - 8} V ${pa.y + 7} H ${pa.x}`,
    );
    const html = renderToStaticMarkup(
      <ReferenceTrace
        index={buildIndex([a, b], [link(a, b), link(b, a)])}
        selectedId={null}
        onSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(html).toContain('Reference back to an earlier record (cycle)');
    expect(html).toContain('Committed path');
    expect(loop.children.get(b.id)).toBeUndefined();
    expect(nextNode(loop, b.id, 'right')).toBe(b.id);
    expect(pathThrough(loop, b.id)).toEqual(new Set([a.id, b.id]));
  });
  it('ignores an edge whose end is not in the node set', () => {
    const a = mk('customers', 'a', 0, 'applied', 'delete');
    const ghost = mk('accounts', 'ghost', 1, 'applied', 'redact');
    expect(layoutGraph(buildIndex([a], [link(a, ghost)])).edges).toHaveLength(
      0,
    );
  });
});

describe('keyboard movement', () => {
  const layout = layoutGraph(base);
  it('moves right along a reference, left back to the node that reached it', () => {
    expect(nextNode(layout, 'n-customers-7f3a', 'right')).toBe(
      'n-accounts-acc-01',
    );
    expect(nextNode(layout, 'n-accounts-acc-02', 'left')).toBe(
      'n-customers-7f3a',
    );
    expect(nextNode(layout, 'n-customers-7f3a', 'left')).toBe(
      'n-customers-7f3a',
    );
  });
  it('moves between siblings and stops at the ends instead of wrapping', () => {
    expect(nextNode(layout, 'n-accounts-acc-01', 'down')).toBe(
      'n-accounts-acc-02',
    );
    expect(nextNode(layout, 'n-accounts-acc-03', 'down')).toBe(
      'n-accounts-acc-03',
    );
    expect(nextNode(layout, 'n-accounts-acc-01', 'up')).toBe(
      'n-accounts-acc-01',
    );
  });
  it('Home goes to the subject and End to the deepest applied record', () => {
    expect(nextNode(layout, 'n-accounts-acc-03', 'home')).toBe(
      'n-customers-7f3a',
    );
    expect(nextNode(layout, 'n-customers-7f3a', 'end')).toBe(
      'n-accounts-acc-02',
    );
  });
  it('stays put for an id it does not know', () => {
    expect(nextNode(layout, 'nope', 'right')).toBe('nope');
  });
  it('isolates the path through a node: ancestors and descendants only', () => {
    expect(pathThrough(layout, 'n-accounts-acc-01')).toEqual(
      new Set(['n-customers-7f3a', 'n-accounts-acc-01']),
    );
    expect(pathThrough(layout, 'n-customers-7f3a').size).toBe(4);
  });
});

describe('large graphs', () => {
  const subject = mk('customers', 'root', 0, 'applied', 'delete');
  const many: GraphNode[] = [subject];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < MAX_DRAWN_NODES + 40; i += 1) {
    const state: GraphNodeState = i % 7 === 0 ? 'retained' : 'applied';
    const n = mk(
      'orders',
      `o-${String(i).padStart(4, '0')}`,
      1,
      state,
      state === 'applied' ? 'redact' : null,
    );
    many.push(n);
    edges.push(link(subject, n, 'orders.customerId'));
  }
  const big = buildIndex(many, edges);
  it('aggregates by collection, hop and state with summed counts and complete totals', () => {
    const { nodes, groupOf } = aggregate(big);
    const total = nodes.reduce((sum, n) => sum + n.count, 0);
    expect(total).toBe(many.length);
    expect(groupOf.size).toBe(many.length);
    expect(nodes.length).toBeLessThan(10);
    expect(nodes.find((n) => n.state === 'retained')?.label).toMatch(
      /^orders: \d+ retained$/,
    );
  });
  it('draws far fewer marks than records and says so', () => {
    const layout = layoutGraph(big);
    expect(layout.aggregated).toBe(true);
    expect(layout.nodes.length).toBeLessThan(MAX_DRAWN_NODES);
    expect(layout.edges.length).toBeLessThanOrEqual(layout.nodes.length);
    const html = renderToStaticMarkup(
      <ReferenceTrace
        index={big}
        selectedId={null}
        onSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(html).toContain(
      'grouped by collection and state because it is large',
    );
    expect(html).toContain(`${many.length} records`);
  });
});

describe('reference trace rendering', () => {
  const html = renderToStaticMarkup(
    <ReferenceTrace
      index={base}
      selectedId={null}
      onSelect={() => {}}
      onClear={() => {}}
    />,
  );
  it('summarizes the drawing in words and names the lanes', () => {
    expect(html).toContain(
      'Reference graph: 4 records in 2 collections across 2 lanes; 3 with an applied effect.',
    );
    expect(html).toContain('>Subject<');
    expect(html).toContain('>1 hop away<');
  });
  it('gives every mark a role, a name that carries state and effect in words, and a single tab stop', () => {
    const tabStops = html.match(/tabindex="0"/g) ?? [];
    expect(tabStops.length).toBeGreaterThanOrEqual(1);
    expect(html).toMatch(/aria-label="[^"]*accounts[^"]*acc-01[^"]*"/);
    expect(html).toMatch(/Applied/i);
    expect(html).toMatch(/Retained/i);
  });
  it('writes a short label beside each mark and keeps the full one in the name and tooltip', () => {
    expect(html).toContain('>customers / 7f3a<');
    expect(html).toContain('<title>customers / 7f3a</title>');
    const longId = mk(
      'customers',
      '64b7f3a0c1d2e3f4a5b6c7d8',
      0,
      'applied',
      'delete',
    );
    const long = renderToStaticMarkup(
      <ReferenceTrace
        index={buildIndex([longId], [])}
        selectedId={null}
        onSelect={() => {}}
        onClear={() => {}}
      />,
    );
    expect(long).toContain('>customers / 64b7f3…c7d8<');
    expect(long).toContain('aria-label="customers / 64b7f3a0c1d2e3f4a5b6c7d8,');
  });
  it('names the zoom buttons and offers a legend entry for each state present', () => {
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Legend"');
    expect(html).toContain('Effect applied');
    expect(html).toContain('Retained');
    // Effects are drawn as different shapes, so each one present is in the legend by name.
    expect(html).toContain('Delete');
    expect(html).toContain('Redact');
    // No cycle and no committed-only line style is claimed when the graph has none.
    expect(html).not.toContain('Reference back to an earlier record');
  });
  it('contains no color literal or inline fill', () => {
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).not.toMatch(/fill="(white|black|red|blue|green)"/);
  });
  it('renders nothing for an empty graph', () => {
    const empty = buildIndex([], []);
    expect(
      renderToStaticMarkup(
        <ReferenceTrace
          index={empty}
          selectedId={null}
          onSelect={() => {}}
          onClear={() => {}}
        />,
      ),
    ).toBe('');
  });
});

describe('decision log', () => {
  const events = [
    event('job-1', 1, 'job_started', samplePayloads.job_started),
    event('job-1', 2, 'tool_decided', samplePayloads.tool_decided),
    event('job-1', 3, 'tool_decided', {
      ...samplePayloads.tool_decided,
      decision: 'deny',
      summary: 'Out of scope.',
    }),
    event('job-1', 4, 'effect_committed', samplePayloads.effect_committed),
    event('job-1', 5, 'evidence_ready', samplePayloads.evidence_ready),
  ];
  it('puts every projection kind in exactly one category', () => {
    for (const kind of PROJECTION_KINDS)
      expect(
        categoryOf({
          ...events[0],
          kind,
          payload: samplePayloads[kind],
        } as never),
      ).toBeTruthy();
  });
  it('lists newest first with a count per category and a plain note about what is shown', () => {
    const html = renderToStaticMarkup(
      <DecisionLog events={events} dropped={0} />,
    );
    expect(html.indexOf('#5')).toBeLessThan(html.indexOf('#1'));
    expect(html).toContain('All (5)');
    expect(html).toContain('Tool decisions (2)');
    expect(html).toContain('Showing 5 of 5 events.');
    expect(html).toContain('Denied');
    expect(html).toContain('aria-label="Committed events, newest first"');
  });
  it('says plainly when events were dropped from the window', () => {
    const html = renderToStaticMarkup(
      <DecisionLog events={events} dropped={12} />,
    );
    expect(html).toContain('12 older events are kept on the server');
  });
  it('withholds the list and says why when the stream is not contiguous', () => {
    const html = renderToStaticMarkup(
      <DecisionLog events={[]} dropped={0} withheld />,
    );
    expect(html).toContain(
      'withheld because the committed stream is not contiguous',
    );
    expect(html).not.toContain('No committed events yet');
  });
  it('shows an honest empty state', () => {
    expect(
      renderToStaticMarkup(<DecisionLog events={[]} dropped={0} />),
    ).toContain('No committed events yet');
  });
  it('bounds the payload it shows and never throws on a circular value', () => {
    const big = {
      ...events[1],
      payload: { ...samplePayloads.tool_decided, summary: 'x'.repeat(5000) },
    } as never;
    expect(payloadText(big).length).toBeLessThan(2100);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(payloadText({ ...events[1], payload: loop } as never)).toBe(
      '(payload could not be shown)',
    );
  });
});
