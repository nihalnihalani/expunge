import { useEffect, useSyncExternalStore } from 'react';
import { expungeFetch } from '../api';
import type {
  ExpungeJobSnapshotV2,
  ForwardedProjectionEvent,
} from '../../../shared/expunge';
import {
  JobProjectionController,
  type EventsPage,
  type ProjectionDeps,
} from './controller';
import type { JobProjectionState } from './reducer';

export const browserDeps: ProjectionDeps = {
  fetchSnapshot: (jobId, signal) =>
    expungeFetch<ExpungeJobSnapshotV2>(`/jobs/${encodeURIComponent(jobId)}`, {
      signal,
    }),
  fetchEvents: (jobId, after, signal) =>
    expungeFetch<{ events: ForwardedProjectionEvent[]; nextSequence: number }>(
      `/jobs/${encodeURIComponent(jobId)}/events?afterSequence=${after}&limit=500`,
      { signal },
    ) as Promise<EventsPage>,
  now: () => Date.now(),
  random: Math.random,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  isHidden: () => typeof document !== 'undefined' && document.hidden,
};

interface Entry {
  controller: JobProjectionController;
  refs: number;
  release?: ReturnType<typeof setTimeout>;
  detach?: () => void;
}
const registry = new Map<string, Entry>();
/** Grace period so switching job tabs reuses the projection instead of re-reading it. */
const KEEP_MS = 5000;

function entryFor(jobId: string, deps: ProjectionDeps) {
  let entry = registry.get(jobId);
  if (!entry) {
    entry = { controller: new JobProjectionController(jobId, deps), refs: 0 };
    registry.set(jobId, entry);
  }
  return entry;
}

export function acquire(jobId: string, deps: ProjectionDeps = browserDeps) {
  const entry = entryFor(jobId, deps);
  entry.refs += 1;
  clearTimeout(entry.release);
  if (entry.refs === 1) {
    entry.controller.start();
    const wake = () => {
      if (!document.hidden) entry.controller.refresh();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    entry.detach = () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }
  return entry.controller;
}

export function release(jobId: string) {
  const entry = registry.get(jobId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  entry.release = setTimeout(() => {
    entry.controller.stop();
    entry.detach?.();
    registry.delete(jobId);
  }, KEEP_MS);
}

/** Test hook. */
export function resetRegistry() {
  for (const entry of registry.values()) {
    entry.controller.stop();
    entry.detach?.();
    clearTimeout(entry.release);
  }
  registry.clear();
}

export interface JobProjection {
  state: JobProjectionState;
  refresh: () => void;
}

/** Subscribes a view to one job's projection. Shared across tabs of the same job. */
export function useJobProjection(jobId: string): JobProjection {
  const controller = entryFor(jobId, browserDeps).controller;
  useEffect(() => {
    acquire(jobId);
    return () => release(jobId);
  }, [jobId]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { state, refresh: () => controller.refresh() };
}
