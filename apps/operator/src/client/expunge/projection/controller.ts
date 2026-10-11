import type {
  ExpungeJobSnapshotV2,
  ForwardedProjectionEvent,
} from '../../../shared/expunge';
import { backoffDelay } from '../hooks/useResource';
import {
  initialState,
  reduce,
  type FailureInfo,
  type JobProjectionState,
  type ProjectionAction,
} from './reducer';
import { isTerminal, pollInterval } from './selectors';

export interface EventsPage {
  events: ForwardedProjectionEvent[];
  nextSequence: number;
}

export interface ProjectionDeps {
  fetchSnapshot(
    jobId: string,
    signal: AbortSignal,
  ): Promise<ExpungeJobSnapshotV2>;
  fetchEvents(
    jobId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<EventsPage>;
  now(): number;
  random(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  isHidden(): boolean;
}

export const PAGE_SIZE = 500;
const SLOW_RETRY_MS = 30_000;
const TERMINAL_CONFIRM_MS = 15_000;
const FLUSH_MS = 250;
const MAX_PAGES = 100;

export function failureOf(error: unknown): FailureInfo {
  const e = error as {
    kind?: string;
    status?: number;
    code?: string;
    message?: string;
  };
  return e && e.kind === 'http'
    ? {
        kind: 'http',
        status: e.status ?? 0,
        code: e.code ?? 'error',
        message: e.message ?? 'The request failed.',
      }
    : {
        kind: 'transport',
        status: 0,
        code: 'transport',
        message: 'Could not reach the operator.',
      };
}

/**
 * Keeps one job's projection current: authoritative snapshot plus ordered committed events.
 * Only GETs ever run here, so a reload, a reconnect or a restart can never start, re-run,
 * cancel or approve anything. State is updated eagerly and published to subscribers at most
 * every 250 ms (deliberate update batching).
 */
export class JobProjectionController {
  private state: JobProjectionState;
  private published: JobProjectionState;
  private listeners = new Set<() => void>();
  private timer: unknown;
  private flushTimer: unknown;
  private controller?: AbortController;
  private running = false;
  private needsBootstrap = true;
  private terminalConfirmed = false;
  private attempt = 0;
  private cycling = false;

  constructor(
    readonly jobId: string,
    private readonly deps: ProjectionDeps,
  ) {
    this.state = initialState(jobId);
    this.published = this.state;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.published;
  get subscribers() {
    return this.listeners.size;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }
  stop() {
    this.running = false;
    this.controller?.abort();
    this.deps.clearTimer(this.timer);
    this.deps.clearTimer(this.flushTimer);
    this.flushTimer = undefined;
  }
  /** Read now (visibility regained, back online, user pressed Retry). */
  refresh() {
    if (!this.running) return;
    this.attempt = 0;
    this.terminalConfirmed = false;
    this.schedule(0);
  }

  private apply(action: ProjectionAction) {
    const result = reduce(this.state, action);
    this.state = result.state;
    if (result.needsRebootstrap) this.needsBootstrap = true;
    this.publishSoon();
    return result;
  }
  private publish() {
    this.published = this.state;
    for (const listener of [...this.listeners]) listener();
  }
  private publishSoon() {
    // First data and connection changes are published at once; everything else is batched.
    const urgent =
      this.published.connection !== this.state.connection ||
      (this.published.snapshot === null && this.state.snapshot !== null);
    if (urgent) {
      this.deps.clearTimer(this.flushTimer);
      this.flushTimer = undefined;
      this.publish();
      return;
    }
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.deps.setTimer(() => {
      this.flushTimer = undefined;
      this.publish();
    }, FLUSH_MS);
  }
  private schedule(ms: number) {
    this.deps.clearTimer(this.timer);
    if (!this.running) return;
    this.timer = this.deps.setTimer(() => void this.cycle(), ms);
  }

  private async pageEvents(target: number, signal: AbortSignal) {
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const page = await this.deps.fetchEvents(
        this.jobId,
        this.state.lastSequence,
        signal,
      );
      const result = this.apply({
        type: 'events',
        events: page.events,
        nextSequence: page.nextSequence,
        now: this.deps.now(),
      });
      if (result.needsRebootstrap) return;
      if (page.events.length < PAGE_SIZE && this.state.lastSequence >= target)
        return;
      if (page.events.length === 0) return;
    }
  }

  private async bootstrap(signal: AbortSignal) {
    const snapshot = await this.deps.fetchSnapshot(this.jobId, signal);
    this.needsBootstrap = false;
    this.apply({ type: 'snapshot', snapshot, now: this.deps.now() });
    if (this.needsBootstrap) this.needsBootstrap = false; // a reset is handled by paging from 0 below
    await this.pageEvents(snapshot.sequence, signal);
  }

  private async poll(signal: AbortSignal) {
    const after = this.state.lastSequence;
    const [snapshot, page] = await Promise.all([
      this.deps.fetchSnapshot(this.jobId, signal),
      this.deps.fetchEvents(this.jobId, after, signal),
    ]);
    const first = this.apply({
      type: 'snapshot',
      snapshot,
      now: this.deps.now(),
    });
    if (first.needsRebootstrap) {
      // The backend moved backwards: the page belongs to the old timeline. Re-page from 0 now.
      this.needsBootstrap = false;
      await this.pageEvents(snapshot.sequence, signal);
      return;
    }
    this.apply({
      type: 'events',
      events: page.events,
      nextSequence: page.nextSequence,
      now: this.deps.now(),
    });
    if (this.needsBootstrap) return;
    if (this.state.lastSequence < snapshot.sequence)
      await this.pageEvents(snapshot.sequence, signal);
  }

  private async cycle() {
    if (!this.running || this.cycling) return;
    if (this.deps.isHidden()) {
      // Paused while hidden; the visibility listener calls refresh().
      this.schedule(1000);
      return;
    }
    this.cycling = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      if (this.needsBootstrap) await this.bootstrap(controller.signal);
      else await this.poll(controller.signal);
      if (this.needsBootstrap) {
        this.cycling = false;
        this.schedule(0);
        return;
      }
      this.attempt = 0;
      const status = this.state.snapshot?.status;
      if (!status) return;
      const interval = pollInterval(status);
      if (interval !== null) this.schedule(interval);
      else if (isTerminal(status) && !this.terminalConfirmed) {
        this.terminalConfirmed = true;
        this.schedule(TERMINAL_CONFIRM_MS);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = failureOf(error);
      if (failure.kind === 'transport') {
        this.attempt += 1;
        const delay = backoffDelay(this.attempt, this.deps.random);
        this.apply({
          type: 'failure',
          failure,
          attempt: this.attempt,
          nextRetryMs: delay,
        });
        this.schedule(delay);
      } else {
        this.apply({ type: 'failure', failure, attempt: 0, nextRetryMs: null });
        if (failure.status !== 404) this.schedule(SLOW_RETRY_MS);
      }
    } finally {
      this.cycling = false;
    }
  }
}
