import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExpungeApiError } from '../src/client/expunge/api';
import { ReadinessProvider } from '../src/client/expunge/readiness';
import { CancelControl } from '../src/client/expunge/components/CancelControl';
import {
  ID_TYPES,
  newRequestKey,
  validateSubject,
} from '../src/client/expunge/lib/subject';
import NewCleanupView, {
  PreviewResult,
  previewStale,
  problemFrom,
} from '../src/client/expunge/views/NewCleanupView';
import { baseSnapshot, preview, world } from './fixtures/expunge-data';

describe('subject validation (exact identity only)', () => {
  it('accepts exactly 24 hex characters for an ObjectId and nothing else', () => {
    expect(validateSubject('objectId', '64b7f3a0c1d2e3f4a5b6c7d8').ok).toBe(
      true,
    );
    for (const bad of [
      '',
      '64b7f3a0c1d2e3f4a5b6c7d',
      '64b7f3a0c1d2e3f4a5b6c7d8a',
      'zzb7f3a0c1d2e3f4a5b6c7d8',
      ' 64b7f3a0c1d2e3f4a5b6c7d8',
    ])
      expect(validateSubject('objectId', bad).ok).toBe(false);
  });
  it('treats strings exactly: spaces are significant, controls and oversize are refused', () => {
    expect(validateSubject('string', ' padded ').ok).toBe(true);
    expect(validateSubject('string', 'x'.repeat(128)).ok).toBe(true);
    expect(validateSubject('string', 'x'.repeat(129)).message).toContain('128');
    expect(validateSubject('string', 'a\u0000b').ok).toBe(false);
    expect(validateSubject('string', '').message).toBe(
      'Enter the exact identifier.',
    );
  });
  it('range-checks 32 and 64 bit integers', () => {
    expect(validateSubject('int', '2147483647').ok).toBe(true);
    expect(validateSubject('int', '2147483648').ok).toBe(false);
    expect(validateSubject('int', '-2147483648').ok).toBe(true);
    expect(validateSubject('int', '-2147483649').ok).toBe(false);
    expect(validateSubject('long', '9223372036854775807').ok).toBe(true);
    expect(validateSubject('long', '9223372036854775808').ok).toBe(false);
    for (const bad of ['1.5', '1e3', 'abc', '--1', '12345678901234567890'])
      expect(validateSubject('long', bad).ok).toBe(false);
  });
  it('offers every identifier type with a hint and makes fresh request keys', () => {
    expect(ID_TYPES.map((item) => item.value)).toEqual([
      'objectId',
      'string',
      'int',
      'long',
    ]);
    expect(ID_TYPES.every((item) => item.hint.length > 10)).toBe(true);
    expect(newRequestKey()).toMatch(/^req-[0-9a-f]{32}$/);
    expect(newRequestKey()).not.toBe(newRequestKey());
  });
});

describe('error to problem mapping', () => {
  const http = (code: string, status: number, missing: string[] = []) =>
    new ExpungeApiError('http', status, code, 'upstream words', missing);
  it('names the missing credential and never echoes upstream text', () => {
    const problem = problemFrom(
      http('write_principal_missing', 503, ['EXPUNGE_JOB_WRITE_TOKEN']),
      'preview',
    );
    expect(problem).toMatchObject({
      kind: 'unavailable',
      missing: ['EXPUNGE_JOB_WRITE_TOKEN'],
    });
    for (const code of [
      'unsupported',
      'conflict',
      'invalid_request',
      'not_found',
      'unauthorized',
      'forbidden',
      'bad_response',
    ])
      expect(
        JSON.stringify(problemFrom(http(code, 400), 'submit')),
      ).not.toContain('upstream words');
  });
  it('maps each closed code to its state', () => {
    expect(problemFrom(http('unsupported', 501), 'preview').kind).toBe(
      'unsupported',
    );
    expect(problemFrom(http('unsupported', 501), 'preview')).toHaveProperty(
      'message',
      expect.stringContaining('job’s own preview phase'),
    );
    expect(problemFrom(http('conflict', 409), 'submit').kind).toBe('stale');
    expect(problemFrom(http('invalid_request', 400), 'preview').kind).toBe(
      'rejected',
    );
    expect(problemFrom(http('forbidden', 502), 'preview').kind).toBe(
      'rejected',
    );
    expect(problemFrom(http('unreachable', 503), 'preview').kind).toBe(
      'unavailable',
    );
    expect(problemFrom(http('bad_response', 502), 'preview')).toMatchObject({
      kind: 'error',
      transport: false,
    });
    expect(
      problemFrom(
        new ExpungeApiError('transport', 0, 'transport', 'x'),
        'submit',
      ),
    ).toMatchObject({ kind: 'error', transport: true });
    expect(problemFrom(new Error('x'), 'submit').kind).toBe('error');
  });
});

describe('preview staleness', () => {
  const at = (iso: string) => Date.parse(iso);
  it('is stale when expired, when the world or scope moved, or in maintenance mode', () => {
    expect(
      previewStale(preview, world, at('2026-10-11T09:00:00.000Z')),
    ).toBeNull();
    expect(previewStale(preview, world, at('2026-10-11T09:20:00.000Z'))).toBe(
      'This preview has expired.',
    );
    expect(
      previewStale(
        preview,
        { ...world, worldRevision: 215 },
        at('2026-10-11T09:01:00.000Z'),
      ),
    ).toBe('The world changed since this preview.');
    expect(
      previewStale(
        preview,
        { ...world, scopeRevision: 5 },
        at('2026-10-11T09:01:00.000Z'),
      ),
    ).toBe('The world changed since this preview.');
    expect(
      previewStale(
        preview,
        { ...world, maintenanceMode: true },
        at('2026-10-11T09:01:00.000Z'),
      ),
    ).toBe('The world is in maintenance mode.');
    expect(
      previewStale(preview, undefined, at('2026-10-11T09:01:00.000Z')),
    ).toBe('The world is no longer listed.');
  });
});

describe('preview rendering', () => {
  it('labels the operator preview and shows exact matches per collection, flagging what was not inspected', () => {
    const html = renderToStaticMarkup(<PreviewResult preview={preview} />);
    expect(html).toContain('Operator preview, not the agent&#x27;s plan.');
    expect(html).toContain('never authorizes an effect');
    expect(html).toContain('Exact-identity matches only');
    expect(html).toContain('payments_archive');
    expect(html).toContain('Not inspected');
    expect(html).toContain(preview.subject.display);
    // The literal subject never appears: only the masked display and the identity hash.
    expect(html).not.toMatch(/64b7f3a0/);
  });
});

describe('new cleanup view', () => {
  it('starts as a skeleton, not a form with fake worlds', () => {
    const html = renderToStaticMarkup(
      <ReadinessProvider>
        <NewCleanupView route={{ name: 'new' }} navigate={() => undefined} />
      </ReadinessProvider>,
    );
    expect(html).toContain('Loading authorized worlds');
    expect(html).not.toContain('Preview effects');
    expect(html).not.toContain('Submit cleanup');
  });
});

describe('cancel control', () => {
  it('offers a deliberate two-step cancel for a running job only', () => {
    const running = renderToStaticMarkup(
      <CancelControl snapshot={baseSnapshot('job-1')} />,
    );
    expect(running).toContain('Cancel cleanup');
    expect(running).not.toContain('Keep running');
  });
  it('shows nothing for finished jobs or once cancellation is already requested', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const)
      expect(
        renderToStaticMarkup(
          <CancelControl snapshot={baseSnapshot('job-1', { status })} />,
        ),
      ).toBe('');
    expect(
      renderToStaticMarkup(
        <CancelControl
          snapshot={baseSnapshot('job-1', {
            cancellation: {
              requested: true,
              requestedAt: '2026-10-11T09:00:00.000Z',
            },
          })}
        />,
      ),
    ).toBe('');
  });
});
