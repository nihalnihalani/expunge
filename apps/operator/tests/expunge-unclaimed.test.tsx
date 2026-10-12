import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  UNCLAIMED_AFTER_MS,
  UnclaimedNotice,
  unclaimedMinutes,
} from '../src/client/expunge/components/UnclaimedNotice.js';

// Pure rule over status and updatedAt; no service doubles.
const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

it('shows nothing for a freshly queued job', () => {
  const job = { status: 'queued' as const, updatedAt: at(30_000) };
  expect(unclaimedMinutes(job, NOW)).toBeNull();
  expect(renderToStaticMarkup(<UnclaimedNotice job={job} now={NOW} />)).toBe(
    '',
  );
});

it('stays quiet at exactly the threshold', () => {
  const job = { status: 'queued' as const, updatedAt: at(UNCLAIMED_AFTER_MS) };
  expect(unclaimedMinutes(job, NOW)).toBeNull();
});

it('warns when a queued job has gone unclaimed past the threshold', () => {
  const job = { status: 'queued' as const, updatedAt: at(40 * 60_000) };
  expect(unclaimedMinutes(job, NOW)).toBe(40);
  const html = renderToStaticMarkup(<UnclaimedNotice job={job} now={NOW} />);
  expect(html).toContain('role="note"');
  expect(html).toContain('Not picked up yet:');
  expect(html).toContain('no worker has claimed this job for 40 min.');
  expect(html).toContain('Check that a worker is running for this scope.');
});

it('never warns for a claimed (running) or other non-queued job', () => {
  for (const status of [
    'running',
    'waiting_approval',
    'succeeded',
    'failed',
  ] as const) {
    const job = { status, updatedAt: at(40 * 60_000) };
    expect(unclaimedMinutes(job, NOW)).toBeNull();
    expect(
      renderToStaticMarkup(<UnclaimedNotice job={job} now={NOW} />),
    ).toBe('');
  }
});

it('does not guess from an unreadable timestamp', () => {
  expect(
    unclaimedMinutes({ status: 'queued', updatedAt: 'not-a-date' }, NOW),
  ).toBeNull();
});
