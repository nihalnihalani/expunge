import { EventType, type BaseEvent } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { filterModelStateEvent, stripProtectedKeys } from '../src/index.js';

const delta = (ops: unknown[]) => ({ type: EventType.STATE_DELTA, delta: ops }) as unknown as BaseEvent;
const snapshot = (value: unknown) =>
  ({ type: EventType.STATE_SNAPSHOT, snapshot: value }) as unknown as BaseEvent;

describe('stripProtectedKeys', () => {
  it('removes authority-shaped keys at any depth, case-insensitively, and reports their paths', () => {
    const { value, removed } = stripProtectedKeys({
      ok: 1,
      HarnessHash: 'h',
      nested: { jobId: 'j', keep: [{ TenantId: 't', n: 2 }] },
    });
    expect(value).toEqual({ ok: 1, nested: { keep: [{ n: 2 }] } });
    expect(removed.sort()).toEqual(['/HarnessHash', '/nested/jobId', '/nested/keep/0/TenantId'].sort());
  });
  it('passes primitives and arrays through', () => {
    expect(stripProtectedKeys(5)).toEqual({ value: 5, removed: [] });
    expect(stripProtectedKeys([1, { status: 'x' }]).value).toEqual([1, {}]);
  });
});

describe('filterModelStateEvent', () => {
  it('drops operations on protected pointers, including escaped segments and move/copy sources', () => {
    const { event, removed } = filterModelStateEvent(
      delta([
        { op: 'replace', path: '/harnessHash', value: 'x' },
        { op: 'add', path: '/ui/Binding/harnessHash', value: 'x' },
        { op: 'add', path: '/a~1b/receipt', value: 1 },
        { op: 'add', path: '/copy', from: '/lease/fence' },
        { op: 'replace', path: '/progress', value: { jobId: 'steal', done: true } },
      ]),
    );
    expect((event as unknown as { delta: unknown[] }).delta).toEqual([
      { op: 'replace', path: '/progress', value: { done: true } },
    ]);
    expect(removed).toContain('/harnessHash');
    expect(removed).toContain('/ui/Binding/harnessHash');
    expect(removed).toContain('/a~1b/receipt');
    expect(removed).toContain('/copy');
  });
  it('drops the whole event when nothing safe remains or the delta is malformed', () => {
    expect(
      filterModelStateEvent(delta([{ op: 'replace', path: '/completion/status', value: 'done' }])).event,
    ).toBeNull();
    expect(filterModelStateEvent(delta([{ op: 'replace', path: '', value: {} }])).event).toBeNull();
    expect(
      filterModelStateEvent({ type: EventType.STATE_DELTA, delta: 'oops' } as unknown as BaseEvent).event,
    ).toBeNull();
  });
  it('filters snapshots and leaves other event types untouched', () => {
    const filtered = filterModelStateEvent(snapshot({ harnessHash: 'x', actor: {}, progress: 3 }));
    expect((filtered.event as unknown as { snapshot: unknown }).snapshot).toEqual({ progress: 3 });
    const other = { type: EventType.TEXT_MESSAGE_CHUNK, delta: 'hi' } as unknown as BaseEvent;
    expect(filterModelStateEvent(other)).toEqual({ event: other, removed: [] });
  });
});
