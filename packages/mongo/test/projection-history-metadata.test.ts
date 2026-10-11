import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, PROJECTION_EVENT_KINDS, type ScopeKey } from '@expunge/contracts';
import { PROJECTION_SAMPLES } from '../../contracts/test/projection-samples.js';
import {
  captureProjectionEventInput,
  decodeStoredProjectionEvent,
  type ProjectionEventInput,
} from '../src/events.js';

// Operational projection metadata only. No business data, store doubles or acceptance evidence is created.
const scope: ScopeKey = { tenantId: 'tenant', env: 'staging', scopeId: 'scope' };
const eventInput = (): ProjectionEventInput => ({
  eventId: 'event',
  jobId: 'job',
  runId: 'run',
  artifactIds: ['artifact'],
  kind: 'trial_completed',
  payload: { reportId: null, candidateId: 'candidate', pairId: 'pair', family: 'family', verdict: null },
});
const envelope = () => ({
  ...scope,
  ...eventInput(),
  _id: 'event',
  sequence: 7,
  createdAt: new Date('2026-10-11T00:00:00.000Z'),
});
const legacyTrial = () => ({
  ...envelope(),
  payload: { ...eventInput().payload, split: 'protected', parentUseful: true, candidateUseful: false },
});
const campaign = () => ({
  ...envelope(),
  kind: 'campaign_row_committed',
  payload: {
    campaignId: 'campaign',
    manifestHash: 'a'.repeat(64),
    kind: 'meta',
    rowId: 'row',
    result: 'measured',
  },
});

describe('stored projection history allowlist', () => {
  it.each(PROJECTION_EVENT_KINDS)('strictly decodes current %s metadata', (kind) => {
    const result = decodeStoredProjectionEvent({ ...envelope(), kind, payload: PROJECTION_SAMPLES[kind] });
    expect(result.kind).toBe(kind);
    expect(result.payload).toEqual(PROJECTION_SAMPLES[kind]);
  });
  it.each(ENVIRONMENTS)('preserves the explicit %s environment', (env) => {
    expect(decodeStoredProjectionEvent({ ...envelope(), env }).env).toBe(env);
  });
  it.each(['train', 'protected', 'validation', 'final'])('minimizes a complete legacy %s trial', (split) => {
    const input = legacyTrial();
    input.payload.split = split;
    const result = decodeStoredProjectionEvent(input, { scope, jobId: 'job' });
    expect(result.payload).toEqual(eventInput().payload);
    expect(result).toMatchObject({
      ...scope,
      eventId: 'event',
      jobId: 'job',
      runId: 'run',
      artifactIds: ['artifact'],
      sequence: 7,
    });
    expect(result.createdAt).toEqual(input.createdAt);
    expect(result.createdAt).not.toBe(input.createdAt);
    expect(result).not.toHaveProperty('_id');
    expect(input.payload).toHaveProperty('split', split);
  });
  it.each([true, false])('minimizes a legacy boolean campaign flag (%s)', (admitted) => {
    const input = campaign();
    expect(
      decodeStoredProjectionEvent({ ...input, payload: { ...input.payload, admitted } }).payload,
    ).toEqual(input.payload);
  });
  it.each(['split', 'parentUseful', 'candidateUseful'])(
    'refuses a partial legacy trial missing %s',
    (key) => {
      const input = legacyTrial();
      const payload: Record<string, unknown> = { ...input.payload };
      delete payload[key];
      expect(() => decodeStoredProjectionEvent({ ...input, payload })).toThrow(
        'UnsupportedProjectionHistory',
      );
    },
  );
  it.each([
    { split: 'unknown' },
    { split: null },
    { split: new String('train') },
    { parentUseful: 1 },
    { candidateUseful: 'false' },
  ])('refuses malformed legacy trial types %#', (override) => {
    const input = legacyTrial();
    expect(() =>
      decodeStoredProjectionEvent({ ...input, payload: { ...input.payload, ...override } }),
    ).toThrow('UnsupportedProjectionHistory');
  });
  it.each([null, 1, 'false', {}])('refuses malformed campaign admission %#', (admitted) => {
    const input = campaign();
    expect(() => decodeStoredProjectionEvent({ ...input, payload: { ...input.payload, admitted } })).toThrow(
      'UnsupportedProjectionHistory',
    );
  });
  it.each(['fixtureId', 'outcome', 'outcomes', 'useful', 'extra'])(
    'refuses unrecognized history payload field %s',
    (key) => {
      const input = legacyTrial();
      expect(() =>
        decodeStoredProjectionEvent({
          ...input,
          payload: { ...input.payload, [key]: 'unrecognized-metadata' },
        }),
      ).toThrow('InvalidProjectionHistoryPayload');
    },
  );
  it('validates remaining fields after legacy minimization', () => {
    const input = legacyTrial();
    expect(() =>
      decodeStoredProjectionEvent({ ...input, payload: { ...input.payload, verdict: 'invalid' } }),
    ).toThrow('InvalidProjectionHistoryPayload');
  });
  it.each([
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { createdAt: '2026-10-11T00:00:00.000Z' },
    { createdAt: new Date(Number.NaN) },
    { _id: 'other-event' },
    { env: 'unknown' },
    { eventId: '' },
    { kind: 'unknown' },
    { artifactIds: [null] },
    { artifactIds: new Array(1) },
    { artifactIds: Array.from({ length: 257 }, () => 'artifact') },
    { extra: 'unrecognized-metadata' },
  ])('refuses malformed full-envelope metadata %#', (override) => {
    expect(() => decodeStoredProjectionEvent({ ...envelope(), ...override })).toThrow(
      'InvalidProjectionHistoryEnvelope',
    );
  });
  it('requires exact stored scope and job rather than accepting an adjacent stream', () => {
    expect(() =>
      decodeStoredProjectionEvent(envelope(), { scope: { ...scope, scopeId: 'other-scope' } }),
    ).toThrow('InvalidProjectionHistoryScope');
    expect(() => decodeStoredProjectionEvent(envelope(), { scope, jobId: 'other-job' })).toThrow(
      'InvalidProjectionHistoryScope',
    );
  });
  it('rejects an invalid row without skipping its sequence and exposes only a safe refusal code', () => {
    const rows = [
      envelope(),
      { ...envelope(), sequence: 8, payload: { ...eventInput().payload, extra: 'unrecognized-metadata' } },
      { ...envelope(), sequence: 9 },
    ];
    try {
      rows.map((row) => decodeStoredProjectionEvent(row));
      throw new Error('MissingRefusal');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'ProtocolError',
        code: 'InvalidProjectionHistoryPayload',
        message: 'InvalidProjectionHistoryPayload',
      });
    }
  });
});

describe('current producer capture and decoder route closure', () => {
  it('does not grant legacy compatibility to a current producer', () => {
    const { _id: _ignoredId, sequence: _ignoredSequence, createdAt: _ignoredAt, ...input } = legacyTrial();
    const { tenantId: _ignoredTenant, env: _ignoredEnv, scopeId: _ignoredScope, ...event } = input;
    expect(() => captureProjectionEventInput(scope, event as ProjectionEventInput)).toThrow(
      'InvalidProjectionHistoryPayload',
    );
  });
  it('captures deep current payload arrays, artifact IDs and scope independently of later caller mutation', () => {
    const input: ProjectionEventInput = {
      ...eventInput(),
      kind: 'tool_decided',
      payload: {
        stepId: 'step',
        phase: 'preview',
        toolId: 'preview_cleanup',
        decision: 'ask',
        ruleIds: ['rule'],
        summary: 'Preview requires approval',
      },
    };
    const mutableScope = { ...scope };
    const captured = captureProjectionEventInput(mutableScope, input);
    mutableScope.scopeId = 'other-scope';
    input.artifactIds.push('other-artifact');
    input.payload.ruleIds.push('other-rule');
    Object.assign(input.payload, { split: 'protected' });
    expect(captured.scope).toEqual(scope);
    expect(captured.event.artifactIds).toEqual(['artifact']);
    expect(captured.event.payload).toMatchObject({ ruleIds: ['rule'] });
    expect(captured.event.payload).not.toHaveProperty('split');
  });
  it('all stored delivery routes decode, with append capture and stream decoding preceding their awaits', () => {
    const source = ts.createSourceFile(
      'events.ts',
      readFileSync(new URL('../src/events.ts', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const methods = new Map<string, ts.MethodDeclaration>();
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) methods.set(node.name.getText(source), node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const calls = (name: string): ts.CallExpression[] => {
      const result: ts.CallExpression[] = [];
      const visitCalls = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) result.push(node);
        ts.forEachChild(node, visitCalls);
      };
      visitCalls(methods.get(name)!);
      return result;
    };
    for (const name of ['append', 'read', 'receiptReference', 'consume']) {
      expect(
        calls(name).some((call) => call.expression.getText(source) === 'decodeStoredProjectionEvent'),
        name,
      ).toBe(true);
    }
    expect(calls('readPage').some((call) => call.expression.getText(source) === 'this.read')).toBe(true);
    const capture = calls('append').find(
      (call) => call.expression.getText(source) === 'captureProjectionEventInput',
    )!;
    const awaits: ts.AwaitExpression[] = [];
    const collectAwaits = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node)) awaits.push(node);
      ts.forEachChild(node, collectAwaits);
    };
    collectAwaits(methods.get('append')!);
    expect(capture.getStart(source)).toBeLessThan(Math.min(...awaits.map((node) => node.getStart(source))));
    const streamCalls = calls('consume');
    const decode = streamCalls.find(
      (call) => call.expression.getText(source) === 'decodeStoredProjectionEvent',
    )!;
    const deliver = streamCalls.find((call) => call.expression.getText(source) === 'onEvent')!;
    const advance = streamCalls.find((call) => call.expression.getText(source) === 'offsets.updateOne')!;
    expect(decode.getStart(source)).toBeLessThan(deliver.getStart(source));
    expect(deliver.getStart(source)).toBeLessThan(advance.getStart(source));
  });
});
