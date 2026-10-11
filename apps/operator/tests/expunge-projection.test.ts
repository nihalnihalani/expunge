import './fixtures/browser-globals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JobProjectionController,
  MAX_REBOOTSTRAPS,
  PAGE_SIZE,
  failureOf,
  type EventsPage,
  type ProjectionDeps,
} from '../src/client/expunge/projection/controller';
import {
  MAX_EVENTS,
  MAX_STALE_SNAPSHOTS,
  initialState,
  reduce,
  type FailureInfo,
  type JobProjectionState,
} from '../src/client/expunge/projection/reducer';
import {
  EVENT_LABELS,
  describeEvent,
  isTerminal,
  notInspected,
  pollInterval,
} from '../src/client/expunge/projection/selectors';
import {
  PROJECTION_KINDS,
  type ExpungeJobSnapshotV2,
  type ForwardedProjectionEvent,
  type JobStatus,
} from '../src/shared/expunge';
import { baseSnapshot, event, startedPayload } from './fixtures/expunge-data';
import { samplePayloads } from './fixtures/expunge-samples';

const ev = (sequence: number, jobId = 'job-1'): ForwardedProjectionEvent =>
  event(
    jobId,
    sequence,
    'job_started',
    startedPayload,
  ) as ForwardedProjectionEvent;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ev(from + index));
const snap = (
  sequence: number,
  status: JobStatus = 'running',
): ExpungeJobSnapshotV2 => baseSnapshot('job-1', { sequence, status });
const snapIn = (
  sequence: number,
  streamEpoch: string,
  status: JobStatus = 'running',
) => ({ ...snap(sequence, status), streamEpoch }) as ExpungeJobSnapshotV2;
const http = (status: number): FailureInfo => ({
  kind: 'http',
  status,
  code: 'x',
  message: 'm',
});
const transport: FailureInfo = {
  kind: 'transport',
  status: 0,
  code: 'transport',
  message: 'm',
};

describe('projection reducer', () => {
  it('applies a snapshot as authoritative aggregate state', () => {
    const { state } = reduce(initialState('job-1'), {
      type: 'snapshot',
      snapshot: snap(3),
      now: 10,
    });
    expect(state.connection).toBe('live');
    expect(state.snapshot?.sequence).toBe(3);
    expect(state.updatedAt).toBe(10);
  });

  it('applies ordered events and deduplicates by sequence', () => {
    let state = initialState('job-1');
    state = reduce(state, {
      type: 'events',
      events: range(1, 3),
      nextSequence: 3,
      now: 1,
    }).state;
    expect(state.lastSequence).toBe(3);
    const again = reduce(state, {
      type: 'events',
      events: range(2, 5),
      nextSequence: 5,
      now: 2,
    });
    expect(again.state.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    const repeat = reduce(again.state, {
      type: 'events',
      events: range(1, 5),
      nextSequence: 5,
      now: 3,
    });
    expect(repeat.state).toBe(again.state);
    expect(repeat.needsRebootstrap).toBe(false);
  });

  it('never skips a gap: it drops the window and asks to re-read from the start', () => {
    let state = reduce(initialState('job-1'), {
      type: 'events',
      events: range(1, 3),
      nextSequence: 3,
      now: 1,
    }).state;
    const gap = reduce(state, {
      type: 'events',
      events: range(5, 6),
      nextSequence: 6,
      now: 2,
    });
    expect(gap.needsRebootstrap).toBe(true);
    expect(gap.state.notice).toBe('gap');
    expect(gap.state.events).toEqual([]);
    expect(gap.state.lastSequence).toBe(0);
    // A hole inside one page is a gap too.
    state = initialState('job-1');
    const inner = reduce(state, {
      type: 'events',
      events: [ev(1), ev(3)],
      nextSequence: 3,
      now: 1,
    });
    expect(inner.needsRebootstrap).toBe(true);
  });

  it('deduplicates a repeated event inside one page instead of calling it a gap', () => {
    const page = reduce(initialState('job-1'), {
      type: 'events',
      events: [ev(1), ev(2), ev(2), ev(3)],
      nextSequence: 3,
      now: 1,
    });
    expect(page.needsRebootstrap).toBe(false);
    expect(page.state.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(page.state.notice).toBeNull();
    // Already-applied events repeated alongside new ones are dropped the same way.
    const next = reduce(page.state, {
      type: 'events',
      events: [ev(3), ev(4), ev(4)],
      nextSequence: 4,
      now: 2,
    });
    expect(next.state.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(next.needsRebootstrap).toBe(false);
  });

  it('treats a different event claiming an already-seen sequence as a conflict, and an unsorted page as a gap', () => {
    const other = event('job-1', 2, 'job_started', startedPayload, [
      'a-different-artifact',
    ]) as ForwardedProjectionEvent;
    const conflicting = { ...other, eventId: 'evt-other-2' };
    const conflict = reduce(initialState('job-1'), {
      type: 'events',
      events: [ev(1), ev(2), conflicting],
      nextSequence: 2,
      now: 1,
    });
    expect(conflict.needsRebootstrap).toBe(true);
    expect(conflict.state.notice).toBe('gap');
    expect(conflict.state.events).toEqual([]);
    const unsorted = reduce(initialState('job-1'), {
      type: 'events',
      events: [ev(1), ev(3), ev(2)],
      nextSequence: 3,
      now: 1,
    });
    expect(unsorted.needsRebootstrap).toBe(true);
    expect(unsorted.state.events).toEqual([]);
  });

  it('keeps a newer snapshot when an older one arrives (DA-7 R1)', () => {
    let state = reduce(initialState('job-1'), {
      type: 'events',
      events: range(1, 10),
      nextSequence: 10,
      now: 1,
    }).state;
    state = reduce(state, {
      type: 'snapshot',
      snapshot: snap(12, 'succeeded'),
      now: 2,
    }).state;
    const lagging = reduce(state, {
      type: 'snapshot',
      snapshot: snap(11, 'running'),
      now: 3,
    });
    expect(lagging.needsRebootstrap).toBe(false);
    expect(lagging.state.notice).toBeNull();
    expect(lagging.state.snapshot?.sequence).toBe(12);
    expect(lagging.state.snapshot?.status).toBe('succeeded');
    expect(lagging.state.events).toHaveLength(10);
    // A snapshot older than the event cursor but not older than the one shown is no reset either.
    const behindCursor = reduce(
      reduce(initialState('job-1'), {
        type: 'events',
        events: range(1, 6),
        nextSequence: 6,
        now: 1,
      }).state,
      { type: 'snapshot', snapshot: snap(3), now: 2 },
    );
    expect(behindCursor.state.notice).toBeNull();
    expect(behindCursor.needsRebootstrap).toBe(false);
    expect(behindCursor.state.events).toHaveLength(6);
  });

  it('treats repeated older snapshots with no epoch as a restored backend', () => {
    let state = reduce(initialState('job-1'), {
      type: 'snapshot',
      snapshot: snap(10),
      now: 1,
    }).state;
    for (let index = 1; index < MAX_STALE_SNAPSHOTS; index++) {
      const result = reduce(state, {
        type: 'snapshot',
        snapshot: snap(8),
        now: 2,
      });
      expect(result.needsRebootstrap).toBe(false);
      state = result.state;
    }
    const reset = reduce(state, {
      type: 'snapshot',
      snapshot: snap(8),
      now: 3,
    });
    expect(reset.needsRebootstrap).toBe(true);
    expect(reset.state.notice).toBe('reset');
    expect(reset.state.snapshot?.sequence).toBe(8);
    expect(
      reduce(reset.state, { type: 'clear_notice' }).state.notice,
    ).toBeNull();
    // An ordinary refresh clears the streak.
    const fresh = reduce(state, {
      type: 'snapshot',
      snapshot: snap(10),
      now: 4,
    });
    expect(fresh.state.staleStreak).toBe(0);
  });

  it('resets when the stream epoch changes, even if the new history moved past the cursor (DA-7 R2)', () => {
    let state = reduce(initialState('job-1'), {
      type: 'snapshot',
      snapshot: snapIn(5, 'epoch-a'),
      now: 1,
    }).state;
    state = reduce(state, {
      type: 'events',
      events: range(1, 5),
      nextSequence: 5,
      epoch: 'epoch-a',
      now: 1,
    }).state;
    expect(state.epoch).toBe('epoch-a');
    const restored = reduce(state, {
      type: 'snapshot',
      snapshot: snapIn(7, 'epoch-b'),
      now: 2,
    });
    expect(restored.needsRebootstrap).toBe(true);
    expect(restored.state.notice).toBe('reset');
    expect(restored.state.events).toEqual([]);
    expect(restored.state.epoch).toBe('epoch-b');
    expect(restored.state.snapshot?.sequence).toBe(7);
    const repaged = reduce(restored.state, {
      type: 'events',
      events: range(1, 7),
      nextSequence: 7,
      epoch: 'epoch-b',
      now: 3,
    });
    expect(repaged.state.events.map((e) => e.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(repaged.state.notice).toBe('reset');
  });

  it('discards an events page from another epoch', () => {
    const state = reduce(
      reduce(initialState('job-1'), {
        type: 'snapshot',
        snapshot: snapIn(2, 'epoch-a'),
        now: 1,
      }).state,
      {
        type: 'events',
        events: range(1, 2),
        nextSequence: 2,
        epoch: 'epoch-a',
        now: 1,
      },
    ).state;
    const other = reduce(state, {
      type: 'events',
      events: range(3, 4),
      nextSequence: 4,
      epoch: 'epoch-b',
      now: 2,
    });
    expect(other.needsRebootstrap).toBe(true);
    expect(other.state.events).toEqual([]);
    expect(other.state.notice).toBe('reset');
  });

  it('refuses a retained sequence that returns with a different eventId', () => {
    const state = reduce(initialState('job-1'), {
      type: 'events',
      events: range(1, 5),
      nextSequence: 5,
      now: 1,
    }).state;
    const altered = { ...ev(3), eventId: 'evt-from-another-history' };
    const result = reduce(state, {
      type: 'events',
      events: [altered, ev(6)],
      nextSequence: 6,
      now: 2,
    });
    expect(result.needsRebootstrap).toBe(true);
    expect(result.state.notice).toBe('gap');
    expect(result.state.events).toEqual([]);
    // The identical event repeated is harmless.
    const same = reduce(state, {
      type: 'events',
      events: [ev(3)],
      nextSequence: 5,
      now: 2,
    });
    expect(same.needsRebootstrap).toBe(false);
    expect(same.state.events).toHaveLength(5);
  });

  it('bounds the in-memory window and counts what it dropped', () => {
    const many = range(1, MAX_EVENTS + 25);
    const { state } = reduce(initialState('job-1'), {
      type: 'events',
      events: many,
      nextSequence: MAX_EVENTS + 25,
      now: 1,
    });
    expect(state.events).toHaveLength(MAX_EVENTS);
    expect(state.dropped).toBe(25);
    expect(state.events[0].sequence).toBe(26);
    expect(state.lastSequence).toBe(MAX_EVENTS + 25);
  });

  it('maps failures to the connection vocabulary', () => {
    const at = (failure: FailureInfo, attempt = 0) =>
      reduce(initialState('job-1'), {
        type: 'failure',
        failure,
        attempt,
        nextRetryMs: 1000,
      }).state.connection;
    expect(at(transport, 1)).toBe('retrying');
    expect(at(transport, 4)).toBe('retrying');
    expect(at(transport, 5)).toBe('disconnected');
    expect(at(http(404))).toBe('not_found');
    expect(at(http(503))).toBe('unavailable');
    expect(at(http(501))).toBe('unavailable');
    expect(at(http(502))).toBe('error');
    expect(at(http(400))).toBe('error');
  });

  it('keeps the last good snapshot and events across a failure', () => {
    let state = reduce(initialState('job-1'), {
      type: 'snapshot',
      snapshot: snap(2),
      now: 1,
    }).state;
    state = reduce(state, {
      type: 'events',
      events: range(1, 2),
      nextSequence: 2,
      now: 1,
    }).state;
    const failed = reduce(state, {
      type: 'failure',
      failure: transport,
      attempt: 1,
      nextRetryMs: 500,
    }).state;
    expect(failed.snapshot?.sequence).toBe(2);
    expect(failed.events).toHaveLength(2);
    expect(failed.connection).toBe('retrying');
  });
});

describe('projection selectors', () => {
  it('describes every committed event kind with fixed words and no leaked values', () => {
    for (const kind of PROJECTION_KINDS) {
      const text = describeEvent({
        ...ev(1),
        kind,
        payload: samplePayloads[kind],
      } as ForwardedProjectionEvent);
      expect(text.length, kind).toBeGreaterThan(5);
      expect(text, kind).not.toMatch(/undefined|\[object|NaN/);
      expect(EVENT_LABELS[kind], kind).toBeTruthy();
    }
    expect(
      describeEvent({
        ...ev(1),
        kind: 'unknown_kind',
        originalKind: 'future_kind',
        payload: {},
      } as ForwardedProjectionEvent),
    ).toContain('future_kind');
  });

  it('knows terminal states, poll intervals and uninspected collections', () => {
    expect(
      isTerminal('succeeded') &&
        isTerminal('failed') &&
        isTerminal('cancelled'),
    ).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(pollInterval('running')).toBe(1000);
    expect(pollInterval('queued')).toBe(1000);
    expect(pollInterval('waiting_approval')).toBe(5000);
    expect(pollInterval('succeeded')).toBeNull();
    expect(notInspected(snap(1))).toEqual([
      'tickets',
      'audit_events',
      'payments_archive',
    ]);
  });
});

describe('JobProjectionController', () => {
  const now = 1_000_000;
  let hidden = false;
  let snapshots: Array<ExpungeJobSnapshotV2 | Error>;
  let pages: Array<(after: number) => EventsPage | Error>;
  const calls: string[] = [];
  const deps = (): ProjectionDeps => ({
    async fetchSnapshot() {
      calls.push('snapshot');
      const next = snapshots.length > 1 ? snapshots.shift()! : snapshots[0];
      if (next instanceof Error) throw next;
      return next;
    },
    async fetchEvents(_job, after) {
      calls.push(`events:${after}`);
      const make = pages.length > 1 ? pages.shift()! : pages[0];
      const result = make(after);
      if (result instanceof Error) throw result;
      return result;
    },
    now: () => now,
    random: () => 1,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    isHidden: () => hidden,
  });
  const apiError = (status: number) =>
    Object.assign(new Error('x'), { kind: 'http', status, code: 'c' });
  const transportError = () =>
    Object.assign(new Error('x'), {
      kind: 'transport',
      status: 0,
      code: 'transport',
    });
  const eventsAfter =
    (upTo: number) =>
    (after: number): EventsPage => ({
      events: range(after + 1, Math.min(upTo, after + PAGE_SIZE)),
      nextSequence: Math.min(upTo, after + PAGE_SIZE),
    });
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    hidden = false;
    snapshots = [snap(3)];
    pages = [eventsAfter(3)];
  });
  afterEach(() => vi.useRealTimers());
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('bootstraps from the snapshot, then pages events forward in 500s', async () => {
    snapshots = [snap(600)];
    pages = [eventsAfter(600)];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(300);
    const state = controller.getSnapshot();
    expect(state.connection).toBe('live');
    expect(state.events).toHaveLength(600);
    expect(state.lastSequence).toBe(600);
    expect(calls).toEqual(['snapshot', 'events:0', 'events:500']);
    controller.stop();
  });

  it('polls a running job every second, applying only new events', async () => {
    snapshots = [snap(3), snap(5), snap(5)];
    pages = [eventsAfter(3), eventsAfter(5), eventsAfter(5)];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(300);
    expect(controller.getSnapshot().lastSequence).toBe(3);
    await settle(1300);
    const state = controller.getSnapshot();
    expect(state.lastSequence).toBe(5);
    expect(state.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    controller.stop();
  });

  it('polls waiting jobs every 5 seconds and confirms a terminal job once after 15 seconds', async () => {
    snapshots = [snap(3, 'waiting_evidence')];
    const waiting = new JobProjectionController('job-1', deps());
    waiting.start();
    await settle(300);
    calls.length = 0;
    await settle(4000);
    expect(calls).toEqual([]);
    await settle(1500);
    expect(calls.filter((c) => c === 'snapshot')).toHaveLength(1);
    waiting.stop();

    calls.length = 0;
    snapshots = [snap(3, 'succeeded')];
    const finished = new JobProjectionController('job-1', deps());
    finished.start();
    await settle(300);
    calls.length = 0;
    await settle(14_000);
    expect(calls).toEqual([]);
    await settle(1500);
    expect(calls.filter((c) => c === 'snapshot')).toHaveLength(1);
    await settle(60_000);
    expect(calls.filter((c) => c === 'snapshot')).toHaveLength(1);
    finished.stop();
  });

  it('backs off through retrying to disconnected, then recovers without duplicating events', async () => {
    snapshots = [snap(3)];
    pages = [eventsAfter(3)];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(300);
    expect(controller.getSnapshot().lastSequence).toBe(3);
    snapshots = [transportError() as never];
    pages = [() => transportError() as never];
    await settle(1100);
    expect(controller.getSnapshot().connection).toBe('retrying');
    await settle(60_000);
    const down = controller.getSnapshot();
    expect(down.connection).toBe('disconnected');
    expect(down.attempt).toBeGreaterThanOrEqual(5);
    // Last good data stays.
    expect(down.snapshot?.sequence).toBe(3);
    expect(down.events).toHaveLength(3);
    snapshots = [snap(4)];
    pages = [eventsAfter(4)];
    controller.refresh();
    await settle(400);
    const back = controller.getSnapshot();
    expect(back.connection).toBe('live');
    expect(back.attempt).toBe(0);
    expect(back.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    controller.stop();
  });

  it('re-pages from the start when the backend epoch changes, and says so', async () => {
    snapshots = [snapIn(6, 'epoch-a')];
    pages = [(after) => ({ ...eventsAfter(6)(after), streamEpoch: 'epoch-a' })];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(300);
    expect(controller.getSnapshot().lastSequence).toBe(6);
    snapshots = [snapIn(8, 'epoch-b')];
    pages = [(after) => ({ ...eventsAfter(8)(after), streamEpoch: 'epoch-b' })];
    await settle(1300);
    const state = controller.getSnapshot();
    expect(state.notice).toBe('reset');
    expect(state.epoch).toBe('epoch-b');
    expect(state.snapshot?.sequence).toBe(8);
    expect(state.events.map((e) => e.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    controller.stop();
  });

  it('never skips a gap: it re-bootstraps and ends with every event', async () => {
    snapshots = [snap(3), snap(6), snap(6)];
    // The poll page jumps from 3 to 6 (missing 4 and 5); the re-bootstrap returns the full run.
    pages = [
      eventsAfter(3),
      () => ({ events: range(6, 6), nextSequence: 6 }),
      eventsAfter(6),
    ];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(300);
    await settle(1500);
    await settle(1500);
    const state = controller.getSnapshot();
    expect(state.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.lastSequence).toBe(6);
    controller.stop();
  });

  it('re-reads a persistent head gap a bounded number of times, then reports it and slows down', async () => {
    snapshots = [snap(6)];
    // The backend never returns events 1 to 3: every page starts at 4.
    pages = [() => ({ events: range(4, 6), nextSequence: 6 })];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(20_000);
    const snapshotReads = calls.filter((call) => call === 'snapshot').length;
    // One first read plus at most MAX_REBOOTSTRAPS re-reads and the one that gives up.
    expect(snapshotReads).toBeLessThanOrEqual(MAX_REBOOTSTRAPS + 1);
    const state = controller.getSnapshot();
    expect(state.connection).toBe('error');
    expect(state.failure?.code).toBe('projection_inconsistent');
    expect(state.failure?.message).toMatch(/not contiguous/);
    expect(state.events).toEqual([]);
    // The snapshot stays authoritative and readable.
    expect(state.snapshot?.sequence).toBe(6);
    // Afterwards it only tries every 30 seconds.
    calls.length = 0;
    await settle(25_000);
    expect(calls).toEqual([]);
    await settle(6000);
    expect(calls.filter((call) => call === 'snapshot')).toHaveLength(1);
    controller.stop();
  });

  it('makes a bounded number of requests over a long time against a broken stream', async () => {
    snapshots = [snap(6)];
    pages = [
      // An unsorted page is not trusted either.
      () => ({
        events: [ev(1), ev(3), ev(2), ev(4), ev(5), ev(6)],
        nextSequence: 6,
      }),
    ];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(120_000);
    // Without the cap this was hundreds of requests per second; with it: the early re-reads
    // plus about one read every 30 seconds.
    expect(calls.length).toBeLessThan(30);
    controller.stop();
  });

  it('heals when the stream becomes contiguous, and the user can retry at once', async () => {
    snapshots = [snap(6)];
    let broken = true;
    pages = [
      (after) =>
        broken
          ? { events: range(4, 6), nextSequence: 6 }
          : eventsAfter(6)(after),
    ];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(20_000);
    expect(controller.getSnapshot().connection).toBe('error');
    broken = false;
    controller.refresh();
    await settle(300);
    const state = controller.getSnapshot();
    expect(state.connection).toBe('live');
    expect(state.failure).toBeNull();
    expect(state.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    controller.stop();
  });

  it('recovers from a one-off duplicate inside a page without any re-read', async () => {
    snapshots = [snap(3)];
    pages = [() => ({ events: [ev(1), ev(2), ev(2), ev(3)], nextSequence: 3 })];
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(300);
    const state = controller.getSnapshot();
    expect(state.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(state.notice).toBeNull();
    expect(calls.filter((call) => call === 'snapshot')).toHaveLength(1);
    controller.stop();
  });

  it('stops retrying a missing job and surfaces unavailable and error without hammering', async () => {
    snapshots = [apiError(404) as never];
    const missing = new JobProjectionController('job-1', deps());
    missing.start();
    await settle(300);
    expect(missing.getSnapshot().connection).toBe('not_found');
    calls.length = 0;
    await settle(120_000);
    expect(calls).toEqual([]);
    missing.stop();

    snapshots = [apiError(503) as never];
    const unavailable = new JobProjectionController('job-1', deps());
    unavailable.start();
    await settle(300);
    expect(unavailable.getSnapshot().connection).toBe('unavailable');
    calls.length = 0;
    await settle(29_000);
    expect(calls).toEqual([]);
    await settle(2000);
    expect(calls.length).toBeGreaterThan(0);
    unavailable.stop();
  });

  it('pauses while the tab is hidden and resumes on refresh', async () => {
    hidden = true;
    const controller = new JobProjectionController('job-1', deps());
    controller.start();
    await settle(5000);
    expect(calls).toEqual([]);
    hidden = false;
    controller.refresh();
    await settle(300);
    expect(calls).toContain('snapshot');
    expect(controller.getSnapshot().connection).toBe('live');
    controller.stop();
  });

  it('publishes the first snapshot at once and batches the rest to 250 ms', async () => {
    snapshots = [snap(3), snap(4), snap(5)];
    pages = [eventsAfter(3), eventsAfter(4), eventsAfter(5)];
    const controller = new JobProjectionController('job-1', deps());
    let published = 0;
    controller.subscribe(() => {
      published += 1;
    });
    controller.start();
    await settle(1);
    expect(controller.getSnapshot().snapshot).not.toBeNull();
    const first = published;
    expect(first).toBeGreaterThanOrEqual(1);
    await settle(1100);
    // Several internal updates (snapshot and events) were published as at most one per window.
    expect(published - first).toBeLessThanOrEqual(2);
    controller.stop();
  });

  it('only ever reads: the controller has no write dependency', () => {
    const keys = Object.keys(deps());
    expect(keys.sort()).toEqual([
      'clearTimer',
      'fetchEvents',
      'fetchSnapshot',
      'isHidden',
      'now',
      'random',
      'setTimer',
    ]);
  });

  it('classifies failures from the shell and API error shapes', () => {
    expect(failureOf(apiError(404))).toMatchObject({
      kind: 'http',
      status: 404,
    });
    expect(failureOf(transportError())).toMatchObject({ kind: 'transport' });
    expect(failureOf(new TypeError('x'))).toMatchObject({ kind: 'transport' });
    expect(failureOf(undefined)).toMatchObject({ kind: 'transport' });
  });
});

describe('state sanity', () => {
  it('starts bootstrapping with nothing authoritative', () => {
    const state: JobProjectionState = initialState('job-1');
    expect(state.snapshot).toBeNull();
    expect(state.connection).toBe('bootstrapping');
  });
});
