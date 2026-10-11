import './fixtures/browser-globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CommittedSeal } from '../src/client/expunge/components/CommittedSeal';
import { ConnectionBanner } from '../src/client/expunge/components/ConnectionBanner';
import { HashChip } from '../src/client/expunge/components/HashChip';
import { NarrativeBlock } from '../src/client/expunge/components/NarrativeBlock';
import { PendingAcknowledgement } from '../src/client/expunge/components/PendingAcknowledgement';
import {
  CHIP_LABELS,
  StatusChip,
  type ChipState,
} from '../src/client/expunge/components/StatusChip';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../src/client/expunge/components/StateViews';
import { ageText, plural, shortHash } from '../src/client/expunge/format';
import {
  DISCONNECTED_AFTER,
  backoffDelay,
} from '../src/client/expunge/hooks/useResource';
import {
  globalNav,
  jobTabs,
  pickView,
  type ViewModule,
} from '../src/client/expunge/registry';
import {
  formatRoute,
  isExpungeHash,
  parseRoute,
  type ExpungeRoute,
} from '../src/client/expunge/routes';
import {
  ReadinessRows,
  chipFor,
} from '../src/client/expunge/views/ReadinessView';
import type { ExpungeReadiness, ReadinessCheck } from '../src/shared/expunge';

const check = (patch: Partial<ReadinessCheck> = {}): ReadinessCheck => ({
  status: 'pass',
  reason: null,
  missing: [],
  detail: 'ok',
  observedAt: '2026-10-11T09:00:00.000Z',
  ...patch,
});

it('round-trips every route and rejects malformed addresses', () => {
  const routes: ExpungeRoute[] = [
    { name: 'home' },
    { name: 'setup' },
    { name: 'new' },
    { name: 'job', jobId: 'job-1', tab: 'workbench' },
    { name: 'job', jobId: 'job-1', tab: 'receipt' },
    { name: 'lineage', target: 'worker' },
    { name: 'campaign', jobId: 'camp_1' },
    { name: 'privacy', jobId: 'ret-1' },
  ];
  for (const route of routes)
    expect(parseRoute(formatRoute(route))).toEqual(route);
  for (const bad of [
    '#/expunge/jobs/bad id',
    '#/expunge/jobs/job-1/nope',
    '#/expunge/lineage/other',
    '#/expunge/jobs/',
    '#/expunge/setup/extra',
    '#/spaces/abc',
    '',
  ])
    expect(parseRoute(bad).name).toBe('unknown');
  expect(isExpungeHash('#/expunge')).toBe(true);
  expect(isExpungeHash('#/expunged')).toBe(false);
  expect(parseRoute('#/expunge/jobs/%E0%A4%A').name).toBe('unknown');
});

it('backs off with full jitter, capped, and reports disconnected after five failures', () => {
  expect(backoffDelay(1, () => 1)).toBe(1000);
  expect(backoffDelay(3, () => 1)).toBe(4000);
  expect(backoffDelay(6, () => 1)).toBe(30_000);
  expect(backoffDelay(20, () => 1)).toBe(30_000);
  expect(backoffDelay(4, () => 0)).toBe(500);
  expect(DISCONNECTED_AFTER).toBe(5);
});

it('picks views and nav from registered modules', () => {
  const mod = (meta: ViewModule['meta']): ViewModule => ({
    default: () => null,
    meta,
  });
  const jobs = mod({
    id: 'jobs',
    label: 'Jobs',
    routes: ['home'],
    scope: 'global',
    order: 10,
    navRoute: { name: 'home' },
    home: 10,
  });
  const setup = mod({
    id: 'setup',
    label: 'Setup',
    routes: ['setup'],
    scope: 'global',
    order: 90,
    navRoute: { name: 'setup' },
    home: 0,
  });
  const wb = mod({
    id: 'wb',
    label: 'Workbench',
    routes: ['job'],
    tab: 'workbench',
    scope: 'job',
    order: 1,
  });
  const rc = mod({
    id: 'rc',
    label: 'Receipt',
    routes: ['job'],
    tab: 'receipt',
    scope: 'job',
    order: 5,
  });
  const all = [setup, rc, jobs, wb];
  expect(pickView(all, { name: 'home' })).toBe(jobs);
  expect(pickView([setup], { name: 'home' })).toBe(setup);
  expect(pickView(all, { name: 'setup' })).toBe(setup);
  expect(pickView(all, { name: 'job', jobId: 'j', tab: 'receipt' })).toBe(rc);
  expect(
    pickView(all, { name: 'job', jobId: 'j', tab: 'evidence' }),
  ).toBeUndefined();
  expect(globalNav(all).map((m) => m.meta.id)).toEqual(['jobs', 'setup']);
  expect(jobTabs(all).map((m) => m.meta.id)).toEqual(['wb', 'rc']);
});

it('renders every chip state with an icon, a word and no authority wording', () => {
  for (const state of Object.keys(CHIP_LABELS) as ChipState[]) {
    const html = renderToStaticMarkup(<StatusChip state={state} />);
    expect(html).toContain(CHIP_LABELS[state]);
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden');
    expect(html).not.toContain('Committed');
    expect(html).not.toContain('ex-seal');
  }
  expect(
    renderToStaticMarkup(<StatusChip state="running" reducedMotion />),
  ).toContain('Running');
  expect(
    renderToStaticMarkup(
      <StatusChip
        state="complete_in_scope"
        label="Complete in registered scope, revision 214"
      />,
    ),
  ).toContain('revision 214');
});

it('never draws the seal without a committed source', () => {
  expect(renderToStaticMarkup(<CommittedSeal source={null} />)).toBe('');
  expect(renderToStaticMarkup(<CommittedSeal source={undefined} />)).toBe('');
  expect(
    renderToStaticMarkup(
      <CommittedSeal source={{ kind: 'receipt', id: '', sequence: 3 }} />,
    ),
  ).toBe('');
  expect(
    renderToStaticMarkup(
      <CommittedSeal source={{ kind: 'receipt', id: 'r1', sequence: -1 }} />,
    ),
  ).toBe('');
  const html = renderToStaticMarkup(
    <CommittedSeal
      source={{ kind: 'receipt', id: 'receipt-0123456789abcdef', sequence: 12 }}
    />,
  );
  expect(html).toContain('Committed');
  expect(html).toContain('event 12');
  expect(html).toContain('receipt-0123456789abcdef');
});

it('keeps seal markup inside CommittedSeal only', () => {
  const root = fileURLToPath(new URL('../src/client/expunge', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const offenders = walk(root).filter(
    (file) =>
      /\.(tsx?|css)$/.test(file) &&
      !file.endsWith('CommittedSeal.tsx') &&
      !file.endsWith('10-base.css') &&
      /(?<![-\w])ex-seal/.test(readFileSync(file, 'utf8')),
  );
  expect(offenders).toEqual([]);
});

it('keeps a pending acknowledgement neutral and model narrative visibly labeled', () => {
  const pending = renderToStaticMarkup(<PendingAcknowledgement />);
  expect(pending).toContain('waiting for the database to confirm');
  expect(pending).not.toContain('Committed');
  expect(pending).not.toContain('ex-seal');
  const narrative = renderToStaticMarkup(
    <NarrativeBlock text="All records were deleted." replayed />,
  );
  expect(narrative).toContain('Model narrative, not verified');
  expect(narrative).toContain('replayed from a recorded run');
  expect(narrative).toContain('All records were deleted.');
  expect(narrative).not.toContain('ex-chip');
  expect(narrative).not.toContain('role="status"');
});

it('renders connection, empty, error, unavailable and loading states honestly', () => {
  expect(renderToStaticMarkup(<ConnectionBanner connection="live" />)).toBe('');
  const retrying = renderToStaticMarkup(
    <ConnectionBanner connection="retrying" attempt={2} nextRetryMs={4000} />,
  );
  expect(retrying).toContain('Retrying (attempt 2, next in 4 s)');
  const down = renderToStaticMarkup(
    <ConnectionBanner
      connection="disconnected"
      updatedAt={Date.UTC(2026, 9, 11, 9)}
      now={Date.UTC(2026, 9, 11, 9, 5)}
      onRetry={() => undefined}
    />,
  );
  expect(down).toContain('Disconnected');
  expect(down).toContain('Retry now');
  expect(down).toContain('5 min ago');
  expect(renderToStaticMarkup(<EmptyState title="Nothing yet" />)).toContain(
    'Nothing yet',
  );
  expect(renderToStaticMarkup(<ErrorState what="readiness" stale />)).toContain(
    'older than this failure',
  );
  const unavailable = renderToStaticMarkup(
    <UnavailableState
      what="Submit"
      reason="No credential."
      missing={['EXPUNGE_JOB_WRITE_TOKEN']}
    />,
  );
  expect(unavailable).toContain('EXPUNGE_JOB_WRITE_TOKEN');
  expect(unavailable).toContain('is unavailable');
  expect(renderToStaticMarkup(<Skeleton label="jobs" />)).toContain(
    'aria-busy="true"',
  );
});

it('never shows a pass for a check that was not evaluated, and says Checking while loading', () => {
  const loading = renderToStaticMarkup(<ReadinessRows loading />);
  expect(loading).toContain('Checking');
  expect(loading).not.toContain('Pass');
  const data = {
    configured: check({
      status: 'fail',
      reason: 'env_missing',
      missing: ['EXPUNGE_DOMAIN_URL'],
      detail: 'missing',
    }),
    reachable: check({
      status: 'unknown',
      reason: null,
      detail: 'Not evaluated: x',
    }),
    authorized: check({ status: 'unknown', reason: null }),
    evidenceReady: check({ status: 'unknown', reason: null }),
  } as unknown as ExpungeReadiness;
  const html = renderToStaticMarkup(
    <ReadinessRows data={data} loading={false} />,
  );
  expect(html).toContain('EXPUNGE_DOMAIN_URL');
  expect(html).toContain('Not evaluated');
  expect(html).not.toContain('>Pass<');
});

it('maps readiness reasons to the state family the vocabulary prescribes', () => {
  expect(chipFor(check())).toBe('ok');
  expect(chipFor(check({ status: 'unknown' }))).toBe('unknown');
  for (const reason of ['unauthorized', 'forbidden', 'scope_unbound'] as const)
    expect(chipFor(check({ status: 'fail', reason }))).toBe('rejected');
  for (const reason of [
    'env_missing',
    'connect_refused',
    'timeout',
    'tls_error',
    'http_5xx',
    'evidence_unconfigured',
  ] as const)
    expect(chipFor(check({ status: 'fail', reason }))).toBe('unavailable');
  expect(
    chipFor(check({ status: 'fail', reason: 'evidence_never_proven' })),
  ).toBe('waiting_evidence');
  expect(chipFor(check({ status: 'fail', reason: 'evidence_stale' }))).toBe(
    'stale',
  );
  expect(
    chipFor(check({ status: 'fail', reason: 'evidence_dead_letter' })),
  ).toBe('failed');
});

it('keeps identifiers copyable and the full value available to assistive technology', () => {
  const full = 'a'.repeat(64);
  const html = renderToStaticMarkup(
    <HashChip value={full} label="receipt hash" />,
  );
  expect(html).toContain(shortHash(full));
  expect(html).toContain(full);
  expect(html).toContain('Copy full receipt hash');
});

it('formats ages and plurals', () => {
  expect(ageText(0, 30_000)).toBe('30 s ago');
  expect(ageText(0, 180_000)).toBe('3 min ago');
  expect(plural(1, 'record')).toBe('1 record');
  expect(plural(2, 'record')).toBe('2 records');
});
