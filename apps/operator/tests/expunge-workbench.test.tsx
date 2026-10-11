import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoverageStatement } from '../src/client/expunge/components/CoverageStatement';
import { GapBanner } from '../src/client/expunge/components/GapBanner';
import {
  STALE_AFTER_MS,
  availableTabs,
  connectionOf,
} from '../src/client/expunge/components/JobFrame';
import { LimitsStrip } from '../src/client/expunge/components/LimitsStrip';
import { PhaseStepper } from '../src/client/expunge/components/PhaseStepper';
import { initialState } from '../src/client/expunge/projection/reducer';
import JobsHomeView, {
  sortJobs,
} from '../src/client/expunge/views/JobsHomeView';
import WorkbenchView from '../src/client/expunge/views/WorkbenchView';
import type { ExpungeJobListItem } from '../src/shared/expunge';
import { baseSnapshot, phaseStates } from './fixtures/expunge-data';

const route = { name: 'job', jobId: 'job-1', tab: 'workbench' } as const;

describe('PhaseStepper', () => {
  it('shows seven phases with a word for each state and marks the active one', () => {
    const html = renderToStaticMarkup(
      <PhaseStepper states={phaseStates('discover', 2)} phase="discover" />,
    );
    for (const name of [
      'Inspect',
      'Resolve',
      'Discover',
      'Preview',
      'Apply',
      'Verify',
      'Complete',
    ])
      expect(html).toContain(name);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html.match(/Done/g)).toHaveLength(2);
    expect(html).toContain('Active');
    expect(html).toContain('Pending');
    // Phase states use no authority wording or seal.
    expect(html).not.toContain('Committed');
    expect(html).not.toContain('ex-seal');
  });
  it('marks failed phases in words, not only color', () => {
    const states = { ...phaseStates('apply', 4), apply: 'failed' as const };
    expect(
      renderToStaticMarkup(<PhaseStepper states={states} phase="apply" />),
    ).toContain('Failed');
  });
});

describe('LimitsStrip', () => {
  const limits = baseSnapshot('job-1').limits;
  it('reads as text with denominators and never folds unpriced calls into cost', () => {
    const html = renderToStaticMarkup(
      <LimitsStrip limits={{ ...limits, unpricedCalls: 3 }} />,
    );
    expect(html).toContain('4 of 12');
    expect(html).toContain('Model calls');
    expect(html).toContain('Unpriced calls');
    expect(html).toContain('Cost above excludes them');
    expect(html).toContain('aria-hidden');
  });
  it('says so when a limit is reached', () => {
    const html = renderToStaticMarkup(
      <LimitsStrip limits={{ ...limits, toolCalls: { used: 96, cap: 96 } }} />,
    );
    expect(html).toContain('(limit reached)');
    expect(html).toContain('ex-limit--reached');
  });
  it('states that every call is priced only when none is unpriced', () => {
    expect(renderToStaticMarkup(<LimitsStrip limits={limits} />)).toContain(
      'Every call so far has a provider price',
    );
  });
});

describe('CoverageStatement', () => {
  it('names registered collections that were not inspected and keeps completion incomplete', () => {
    const html = renderToStaticMarkup(
      <CoverageStatement snapshot={baseSnapshot('job-1')} />,
    );
    expect(html).toContain('Inspected 3 of 6 registered collections.');
    expect(html).toContain('payments_archive');
    expect(html).toContain('stays incomplete until these are inspected');
  });
  it('flags partial registry discovery and lists limitations', () => {
    const snapshot = baseSnapshot('job-1', {
      coverage: {
        ...baseSnapshot('job-1').coverage,
        completeness: 'partial',
        limitations: ['payments_archive declares no reference fields.'],
        inspectedCollectionIds:
          baseSnapshot('job-1').coverage.registeredCollectionIds,
      },
    });
    const html = renderToStaticMarkup(
      <CoverageStatement snapshot={snapshot} />,
    );
    expect(html).toContain('Registry discovery partial');
    expect(html).toContain('Every registered collection has been inspected.');
    expect(html).toContain('declares no reference fields');
    expect(html).toContain('not a guarantee that every copy');
  });
});

describe('jobs list', () => {
  const item = (
    jobId: string,
    status: ExpungeJobListItem['status'],
    updatedAt: string,
  ): ExpungeJobListItem => ({
    jobId,
    kind: 'cleanup',
    status,
    sequence: 1,
    updatedAt,
  });
  it('puts jobs that need a decision first, then the newest', () => {
    const sorted = sortJobs([
      item('old', 'running', '2026-10-11T08:00:00.000Z'),
      item('new', 'running', '2026-10-11T09:00:00.000Z'),
      item('ask', 'waiting_approval', '2026-10-11T07:00:00.000Z'),
    ]);
    expect(sorted.map((job) => job.jobId)).toEqual(['ask', 'new', 'old']);
  });
  it('renders a loading skeleton, never an empty-looking table, before data arrives', () => {
    const html = renderToStaticMarkup(
      <JobsHomeView route={{ name: 'home' }} navigate={() => undefined} />,
    );
    expect(html).toContain('Loading jobs');
    expect(html).toContain('New cleanup');
    expect(html).not.toContain('<table');
  });
});

describe('workbench frame', () => {
  it('renders a skeleton until the authoritative snapshot arrives', () => {
    const html = renderToStaticMarkup(
      <WorkbenchView route={route} navigate={() => undefined} />,
    );
    expect(html).toContain('Loading job');
    expect(html).not.toContain('Phase');
    expect(html).not.toContain('ex-seal');
  });
  it('registers only the tabs whose views exist', () => {
    expect(availableTabs()).toEqual([
      'workbench',
      'candidate',
      'evaluation',
      'receipt',
    ]);
  });
  it('decides the connection banner from transport state and freshness', () => {
    const live = baseSnapshot('job-1');
    const state = (patch: object) => ({
      ...initialState('job-1'),
      snapshot: live,
      updatedAt: 1000,
      connection: 'live' as const,
      ...patch,
    });
    expect(connectionOf(state({}), 1000 + 1000)).toBe('live');
    expect(connectionOf(state({}), 1000 + STALE_AFTER_MS + 1)).toBe('stale');
    // Terminal jobs do not go stale: nothing more is expected.
    expect(
      connectionOf(
        state({ snapshot: { ...live, status: 'succeeded' } }),
        1000 + STALE_AFTER_MS * 5,
      ),
    ).toBe('live');
    expect(connectionOf(state({ connection: 'retrying' }), 2000)).toBe(
      'retrying',
    );
    expect(connectionOf(state({ connection: 'disconnected' }), 2000)).toBe(
      'disconnected',
    );
    expect(connectionOf(state({ connection: 'unavailable' }), 2000)).toBe(
      'unavailable',
    );
  });
});

describe('GapBanner', () => {
  it('warns when a finished job left registered collections uninspected', () => {
    const html = renderToStaticMarkup(
      <GapBanner snapshot={baseSnapshot('job-1', { status: 'succeeded' })} />,
    );
    expect(html).toContain('not every registered collection was inspected');
    expect(html).toContain('payments_archive');
    expect(html).toContain('Only a committed receipt states the verdict');
  });
  it('says nothing for running jobs or complete coverage', () => {
    expect(
      renderToStaticMarkup(<GapBanner snapshot={baseSnapshot('job-1')} />),
    ).toBe('');
    const complete = baseSnapshot('job-1', {
      status: 'succeeded',
      coverage: {
        ...baseSnapshot('job-1').coverage,
        inspectedCollectionIds:
          baseSnapshot('job-1').coverage.registeredCollectionIds,
      },
    });
    expect(renderToStaticMarkup(<GapBanner snapshot={complete} />)).toBe('');
  });
});
