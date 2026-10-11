import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const resource = vi.hoisted(() => ({
  state: { status: 'loading' } as Record<string, unknown>,
}));
vi.mock('../src/client/expunge/hooks/useResource', () => ({
  useResource: () => ({ ...resource.state, refresh: () => undefined }),
}));
import LineageView, {
  LineageDocument,
  placeVersions,
  testedAgainstOtherParent,
  type LineageData,
} from '../src/client/expunge/views/LineageView';
import type { DeploymentVersionView } from '../src/shared/expunge';

const h = (c: string) => c.repeat(64);
const version = (
  hash: string,
  parentHash: string | null,
  patch: Partial<DeploymentVersionView> = {},
): DeploymentVersionView => ({
  hash,
  parentHash,
  testedParentHash: parentHash,
  authorityClass: 'behavioral',
  state: 'previous',
  promotion: null,
  rollback: null,
  ...patch,
});
const data = (patch: Partial<LineageData> = {}): LineageData => ({
  target: 'worker',
  activeHash: h('c'),
  revision: 4,
  scopeRevision: 4,
  authorizationRevision: 2,
  initialBundleHash: h('a'),
  versions: [
    version(h('a'), null, { authorityClass: null }),
    version(h('b'), h('a'), {
      promotion: {
        promotionId: 'promo-1',
        gateReportId: 'gate-1',
        consumedGrantId: null,
        at: '2026-10-11T08:00:00.000Z',
      },
    }),
    version(h('c'), h('b'), {
      state: 'active',
      testedParentHash: h('a'),
      authorityClass: 'authority_expansion',
      promotion: {
        promotionId: 'promo-2',
        gateReportId: 'gate-2',
        consumedGrantId: 'grant-1',
        at: '2026-10-11T09:00:00.000Z',
      },
    }),
    version(h('d'), h('b'), {
      state: 'rolled_back',
      rollback: {
        promotionId: 'rollback-1',
        toHash: h('b'),
        reason: 'regression',
        at: '2026-10-11T09:30:00.000Z',
      },
    }),
  ],
  rejected: [
    {
      candidateId: 'cand-x',
      childHash: h('e'),
      reasonCodes: ['retention_violation'],
    },
  ],
  ...patch,
});

it('places every version under its recorded parent and never drops one, even in a cycle', () => {
  const placed = placeVersions(data().versions);
  expect(placed.map((item) => item.version.hash)).toEqual([
    h('a'),
    h('b'),
    h('c'),
    h('d'),
  ]);
  expect(placed.map((item) => item.depth)).toEqual([0, 1, 2, 2]);
  const cycle = placeVersions([
    version(h('x'), h('y')),
    version(h('y'), h('x')),
  ]);
  expect(cycle.map((item) => item.version.hash).sort()).toEqual([
    h('x'),
    h('y'),
  ]);
  expect(placeVersions([])).toEqual([]);
  // A parent that is not in the list makes the version a root, not a lost row.
  expect(placeVersions([version(h('z'), h('missing'))])).toHaveLength(1);
});

it('flags a version tested against a parent other than the one it names', () => {
  const [, , c] = data().versions;
  expect(testedAgainstOtherParent(c)).toBe(true);
  expect(testedAgainstOtherParent(version(h('b'), h('a')))).toBe(false);
  expect(testedAgainstOtherParent(version(h('a'), null))).toBe(false);
});

it('renders promotions with grant ids, rollback receipts, rejected candidates and a table alternative', () => {
  const html = renderToStaticMarkup(<LineageDocument data={data()} />);
  expect(html).toContain('promo-2');
  expect(html).toContain('gate-2');
  expect(html).toContain('grant-1');
  expect(html).toContain('differs from its parent');
  expect(html).toContain('rollback-1');
  expect(html).toContain('regression');
  expect(html).toContain('rolled back');
  expect(html).toContain('retention_violation');
  expect(html).toContain('Version table');
  expect(html).toContain('Same versions as a table');
  expect(html).toContain('none used (no grant required');
  expect(html).not.toContain('ex-seal');
});

it('is honest about refused rollbacks: absent field means not reported, present shows the code', () => {
  const absent = renderToStaticMarkup(<LineageDocument data={data()} />);
  expect(absent).toContain('does not report refused rollbacks');
  expect(absent).toContain('not a statement that none happened');
  const none = renderToStaticMarkup(
    <LineageDocument data={data({ refusedRollbacks: [] })} />,
  );
  expect(none).toContain('No refused rollback is recorded');
  const refused = renderToStaticMarkup(
    <LineageDocument
      data={data({
        refusedRollbacks: [
          {
            toHash: h('a'),
            code: 'RollbackNeedsGrant',
            at: '2026-10-11T09:50:00.000Z',
          },
        ],
      })}
    />,
  );
  expect(refused).toContain('RollbackNeedsGrant');
  expect(refused).toContain('no grant was bound');
  expect(refused).toContain('refused');
  expect(refused).not.toContain('does not report');
});

it('shows an empty version list plainly', () => {
  const html = renderToStaticMarkup(
    <LineageDocument data={data({ versions: [], rejected: [] })} />,
  );
  expect(html).toContain('No versions are recorded for this target');
  expect(html).toContain('No rejected candidate is recorded');
});

it('the Lineage PAGE (not only the document) renders no authority seal, in every data state', () => {
  const route = { name: 'lineage', target: 'worker' } as const;
  const page = () =>
    renderToStaticMarkup(
      <LineageView route={route} navigate={() => undefined} />,
    );
  resource.state = {
    status: 'ok',
    data: data(),
    error: undefined,
    updatedAt: 1,
  };
  const loaded = page();
  expect(loaded).toContain('Lineage: worker');
  expect(loaded).toContain('Version lineage');
  expect(loaded).not.toContain('ex-seal');
  for (const state of [
    { status: 'loading' },
    { status: 'not_found', error: { message: 'x' } },
    { status: 'unavailable', error: { message: 'x' } },
    {
      status: 'error',
      error: {
        message: 'x',
        kind: 'http',
        status: 500,
        code: 'c',
        missing: [],
      },
    },
  ]) {
    resource.state = state;
    const html = page();
    expect(html).not.toContain('ex-seal');
    expect(html).toContain('Lineage: worker');
  }
  // The page words a promotion without any Committed badge.
  resource.state = {
    status: 'ok',
    data: data(),
    error: undefined,
    updatedAt: 1,
  };
  expect(page()).not.toContain('Committed');
});
