import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EffectChip,
  NodeStateChip,
} from '../src/client/expunge/components/NodeChips';
import {
  RecordDetailBody,
  RecordInspector,
} from '../src/client/expunge/components/RecordInspector';
import { ReferenceTable } from '../src/client/expunge/components/ReferenceTable';
import {
  readGraph,
  type PageFetcher,
} from '../src/client/expunge/hooks/useGraph';
import {
  DEFAULT_QUERY,
  buildIndex,
  queryNodes,
  recordDetailArtifactId,
} from '../src/client/expunge/projection/graphModel';
import {
  GRAPH_NODE_STATES,
  type GraphPage,
  type RecordDetail,
} from '../src/shared/expunge';
import { hex } from './fixtures/expunge-data';
import { fullGraph } from './fixtures/ext/20-graph';

const complete = fullGraph('complete');
const incomplete = fullGraph('incomplete');
const index = buildIndex(complete.nodes, complete.edges);

describe('graph model', () => {
  it('records how each node was reached and every collection present', () => {
    expect(index.reachedVia.get('n-accounts-acc-01')).toMatchObject({
      fieldId: 'accounts.ownerId',
      from: 'n-customers-7f3a',
    });
    expect(index.reachedVia.has('n-customers-7f3a')).toBe(false);
    expect(index.collections).toEqual([
      'accounts',
      'audit_events',
      'customers',
      'orders',
      'tickets',
    ]);
  });
  it('sorts by hop, state, effect and record with a stable tie-break and flips direction', () => {
    const byHop = queryNodes(index, { ...DEFAULT_QUERY, sort: 'hop' }).rows.map(
      (n) => n.hop,
    );
    expect(byHop).toEqual([...byHop].sort((a, b) => a - b));
    const bad = buildIndex(incomplete.nodes, incomplete.edges);
    const byState = queryNodes(bad, { ...DEFAULT_QUERY, sort: 'state' }).rows;
    expect(byState[0].state).toBe('residual');
    expect(byState.at(-1)?.state).toBe('not_inspected');
    expect(
      queryNodes(bad, { ...DEFAULT_QUERY, sort: 'state', dir: 'desc' }).rows[0]
        .state,
    ).toBe('not_inspected');
    const byEffect = queryNodes(index, {
      ...DEFAULT_QUERY,
      sort: 'effect',
    }).rows;
    expect(byEffect.at(-1)?.effect).toBeNull();
    const again = queryNodes(index, {
      ...DEFAULT_QUERY,
      sort: 'collection',
    }).rows.map((n) => n.id);
    expect(
      queryNodes(index, { ...DEFAULT_QUERY, sort: 'collection' }).rows.map(
        (n) => n.id,
      ),
    ).toEqual(again);
  });
  it('filters by state, collection and text, and pages without losing rows', () => {
    expect(
      queryNodes(index, {
        ...DEFAULT_QUERY,
        states: new Set(['retained']),
      }).rows.every((n) => n.state === 'retained'),
    ).toBe(true);
    expect(
      queryNodes(index, { ...DEFAULT_QUERY, collection: 'orders' }).total,
    ).toBe(5);
    expect(
      queryNodes(index, { ...DEFAULT_QUERY, text: 'ACC-02' }).rows.map(
        (n) => n.recordId,
      ),
    ).toEqual(['acc-02']);
    const pages = Array.from({ length: 3 }, (_, i) =>
      queryNodes(index, { ...DEFAULT_QUERY, pageSize: 5, page: i + 1 }),
    );
    expect(pages[0].pages).toBe(Math.ceil(index.nodes.length / 5));
    expect(pages.flatMap((p) => p.rows).length).toBe(index.nodes.length);
    expect(new Set(pages.flatMap((p) => p.rows.map((n) => n.id))).size).toBe(
      pages.flatMap((p) => p.rows).length,
    );
    // A page past the end is clamped, never empty-by-accident.
    expect(queryNodes(index, { ...DEFAULT_QUERY, page: 99 }).page).toBe(1);
  });
  it('names the detail artifact by a single convention', () => {
    expect(recordDetailArtifactId('n-accounts-acc-01')).toBe(
      'record-detail-n-accounts-acc-01',
    );
  });
});

describe('reading a paged graph artifact', () => {
  const page = (
    nodes: GraphPage['nodes'],
    nextCursor: string | null,
  ): Awaited<ReturnType<PageFetcher>> => ({
    artifactId: 'g',
    kind: 'graph_page',
    jobId: 'job-1',
    committedAtSequence: 1,
    contentHash: null,
    payload: { nodes, edges: [], nextCursor },
  });
  const signal = new AbortController().signal;
  it('follows cursors in order and collapses duplicate ids across pages', async () => {
    const [a, b, c] = complete.nodes;
    const seen: Array<string | null> = [];
    const fetcher: PageFetcher = async (_id, cursor) => {
      seen.push(cursor);
      return cursor === null
        ? page([a, b], 'p2')
        : cursor === 'p2'
          ? page([b, c], 'p3')
          : page([c], null);
    };
    const result = await readGraph('g', fetcher, signal);
    expect(seen).toEqual([null, 'p2', 'p3']);
    expect(result.index.nodes.map((n) => n.id)).toEqual([a.id, b.id, c.id]);
    expect(result.truncated).toBe(false);
  });
  it('stops at the page bound and says it is truncated', async () => {
    let calls = 0;
    const fetcher: PageFetcher = async () =>
      page([complete.nodes[calls]], `p${++calls}`);
    const result = await readGraph('g', fetcher, signal, 3);
    expect(calls).toBe(3);
    expect(result.truncated).toBe(true);
  });
  it('treats a repeating cursor as the end instead of looping', async () => {
    let calls = 0;
    const fetcher: PageFetcher = async () =>
      page([complete.nodes[calls++ % 3]], 'same');
    const result = await readGraph('g', fetcher, signal, 20);
    expect(calls).toBeLessThan(5);
    expect(result.truncated).toBe(false);
  });
});

describe('graph marks and table', () => {
  it('gives every node state and effect an icon and a word', () => {
    for (const state of GRAPH_NODE_STATES) {
      const html = renderToStaticMarkup(<NodeStateChip state={state} />);
      expect(html).toContain('<svg');
      expect(html).toContain('aria-hidden');
      expect(html).toContain('ex-node--' + state);
      expect(html).not.toContain('ex-seal');
    }
    for (const effect of ['delete', 'redact', 'restrict', 'tombstone'] as const)
      expect(renderToStaticMarkup(<EffectChip effect={effect} />)).toContain(
        '<svg',
      );
    expect(renderToStaticMarkup(<EffectChip effect={null} />)).toContain(
      'None',
    );
  });
  it('renders a semantic, sortable, paged table with named controls and no chart-only meaning', () => {
    const html = renderToStaticMarkup(
      <ReferenceTable
        index={index}
        selectedId="n-accounts-acc-01"
        onSelect={() => undefined}
        pageSize={6}
      />,
    );
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Records reached from the subject"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Showing 1 to 6 of 13 records');
    expect(html).toContain('Page 1 of 3');
    expect(html).toContain('accounts.ownerId');
    expect(html).toContain('Namesake: no exact identity match.');
    expect(html).toContain('The subject');
    // Filters only offer states that exist.
    expect(html).toContain('Effect applied');
    expect(html).not.toContain('>Residual<');
  });
});

describe('record inspector', () => {
  const detail: RecordDetail = {
    nodeId: 'n-accounts-acc-01',
    address: {
      collectionId: 'accounts',
      recordId: 'acc-01',
      recordIdBsonType: 'objectId',
    },
    preHash: hex('pre'),
    postHash: hex('post'),
    effect: 'redact',
    fields: [
      {
        path: 'contacts[*]',
        kind: 'array',
        changed: true,
        elements: [
          {
            index: 0,
            outcome: 'preserved',
            display: 'billing contact (retained)',
          },
          { index: 1, outcome: 'removed', display: null },
        ],
      },
      { path: 'ownerEmail', kind: 'scalar', changed: true, display: null },
      { path: 'record', kind: 'unchanged_group', changed: false, count: 9 },
    ],
  };
  it('shows mixed arrays element by element and says what was left alone', () => {
    const html = renderToStaticMarkup(<RecordDetailBody detail={detail} />);
    expect(html).toContain('accounts / acc-01');
    expect(html).toContain('objectId');
    expect(html).toContain('billing contact (retained)');
    expect(html).toContain('aria-label="Removed element 2 of 2"');
    expect(html).toContain('>Removed<');
    expect(html).toContain('>Preserved<');
    expect(html).toContain(
      'Unchanged: 9 fields in this record kept their values.',
    );
    expect(html).toContain('contacts[*]');
  });
  it('never invents a value for a removed element', () => {
    const html = renderToStaticMarkup(<RecordDetailBody detail={detail} />);
    expect(html).not.toContain(
      '(no preview)</span><span class="ex-elem-word">Removed',
    );
  });
  it('says there is no postimage for a removed record', () => {
    expect(
      renderToStaticMarkup(
        <RecordDetailBody detail={{ ...detail, postHash: null }} />,
      ),
    ).toContain('Record removed; no postimage');
  });
  it('loads by a single artifact id and shows a skeleton first', () => {
    const html = renderToStaticMarkup(
      <RecordInspector node={complete.nodes[1]} onClose={() => undefined} />,
    );
    expect(html).toContain('Loading record detail');
    expect(html).toContain('Close record detail');
  });
});
