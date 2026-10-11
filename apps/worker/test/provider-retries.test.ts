import { describe, expect, it } from 'vitest';
import type { Job } from '@expunge/contracts';
import type { RunStats } from '@expunge/runtime';
import { providerRetriesOf } from '../src/episode-port.js';
import { terminalCheckpoint } from '../src/terminal.js';

const stats = (over: Partial<RunStats> = {}): RunStats =>
  ({ endedBy: 'phase_timeout', toolCalls: 0, phases: 1, elapsedMs: 5, release: 'none', ...over }) as RunStats;
const jobWith = (checkpoint: unknown): Job => ({ checkpoint }) as unknown as Job;

describe('provider attempts in the terminal checkpoint and the episode result (FAKE data)', () => {
  it('the terminal checkpoint carries the attempts when the run made provider calls, and nothing otherwise', () => {
    const attempts = { attempts: 2, retriedStatuses: [429], backoffTimeout: true };
    const withAttempts = terminalCheckpoint(stats({ providerAttempts: attempts }), {
      kind: 'finish',
      status: 'failed',
      outputRefs: [],
      reason: 'ModelUnavailable',
    }) as { terminal: Record<string, unknown> };
    expect(withAttempts.terminal.providerAttempts).toEqual(attempts);
    const without = terminalCheckpoint(stats(), {
      kind: 'finish',
      status: 'failed',
      outputRefs: [],
      reason: 'PhaseTimeout',
    }) as { terminal: Record<string, unknown> };
    expect('providerAttempts' in without.terminal).toBe(false);
  });

  it('reads the recorded attempts back field by field, bounded and validated', () => {
    expect(
      providerRetriesOf(
        jobWith({
          terminal: { providerAttempts: { attempts: 3, retriedStatuses: [429, 503], backoffTimeout: true } },
        }),
      ),
    ).toEqual({ attempts: 3, retriedStatuses: [429, 503], backoffTimeout: true });
    // Anything that is not a number or a boolean is dropped, never trusted.
    expect(
      providerRetriesOf(
        jobWith({
          terminal: {
            providerAttempts: {
              attempts: 1,
              retriedStatuses: [429, 'x', 99999, { a: 1 }],
              backoffTimeout: 'yes',
            },
          },
        }),
      ),
    ).toEqual({ attempts: 1, retriedStatuses: [429], backoffTimeout: false });
    for (const bad of [
      null,
      {},
      { terminal: {} },
      { terminal: { providerAttempts: { attempts: -1 } } },
      { terminal: { providerAttempts: 5 } },
    ])
      expect(providerRetriesOf(jobWith(bad))).toBeUndefined();
  });
});
