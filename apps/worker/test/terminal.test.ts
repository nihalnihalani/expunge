import type { RunStats } from '@expunge/runtime';
import { describe, expect, it } from 'vitest';
import { decideTerminal, terminalCheckpoint, type ReceiptFact } from '../src/index.js';

const stats = (over: Partial<RunStats> = {}): RunStats => ({
  endedBy: 'finished',
  toolCalls: 2,
  phases: 2,
  elapsedMs: 10,
  release: 'none',
  ...over,
});
const running = {
  status: 'running' as const,
  cancellationRequested: false,
  lease: { ownerId: 'w', fence: 2, until: new Date(Date.now() + 1000), heartbeatAt: new Date() },
};
const complete: ReceiptFact = {
  receiptId: 'r1',
  domainStatus: 'complete_in_registered_scope',
  operationalResiduals: 0,
};

describe('decideTerminal (terminal status comes from committed state, never from the narrative)', () => {
  it('succeeds only with a complete, residual-free committed receipt', () => {
    expect(decideTerminal({ stats: stats(), stored: running, fence: 2, receipt: complete })).toEqual({
      kind: 'finish',
      status: 'succeeded',
      outputRefs: ['r1'],
      reason: 'receipt_committed',
    });
    expect(
      decideTerminal({
        stats: stats(),
        stored: running,
        fence: 2,
        receipt: { ...complete, operationalResiduals: 1 },
      }),
    ).toMatchObject({ status: 'failed', reason: 'incomplete_receipt' });
    expect(
      decideTerminal({
        stats: stats(),
        stored: running,
        fence: 2,
        receipt: { ...complete, domainStatus: 'incomplete' },
      }),
    ).toMatchObject({ status: 'failed' });
  });

  it('fails a run with no receipt, naming why', () => {
    expect(decideTerminal({ stats: stats(), stored: running, fence: 2, receipt: null })).toMatchObject({
      status: 'failed',
      reason: 'NoCompletionReceipt',
    });
    expect(
      decideTerminal({ stats: stats({ endedBy: 'step_limit' }), stored: running, fence: 2, receipt: null }),
    ).toMatchObject({ reason: 'StepLimitReached' });
    expect(
      decideTerminal({
        stats: stats({ endedBy: 'wall_time', errorCode: 'WallTimeExceeded' }),
        stored: running,
        fence: 2,
        receipt: null,
      }),
    ).toMatchObject({ reason: 'WallTimeExceeded' });
  });

  it('never writes after the run released the lease, lost it, or the stored job is already terminal', () => {
    for (const release of ['yielded', 'cancelled'] as const)
      expect(
        decideTerminal({ stats: stats({ release }), stored: running, fence: 2, receipt: complete }),
      ).toEqual({ kind: 'none', reason: 'released_by_run' });
    expect(
      decideTerminal({
        stats: stats({ endedBy: 'lost_lease' }),
        stored: running,
        fence: 2,
        receipt: complete,
      }),
    ).toEqual({ kind: 'none', reason: 'not_ours' });
    expect(
      decideTerminal({ stats: stats(), stored: running, fence: 2, receipt: complete, renewalFailed: true }),
    ).toEqual({ kind: 'none', reason: 'not_ours' });
    expect(
      decideTerminal({
        stats: stats(),
        stored: { ...running, lease: { ...running.lease, fence: 3 } },
        fence: 2,
        receipt: complete,
      }),
    ).toEqual({ kind: 'none', reason: 'not_ours' });
    expect(
      decideTerminal({ stats: stats({ endedBy: 'aborted' }), stored: running, fence: 2, receipt: null }),
    ).toEqual({ kind: 'none', reason: 'released_by_run' });
    // Even a "lost lease" is a normal ending if the committed job is already succeeded (complete_cleanup).
    expect(
      decideTerminal({
        stats: stats({ endedBy: 'lost_lease' }),
        stored: { ...running, status: 'succeeded' },
        fence: 2,
        receipt: complete,
      }),
    ).toEqual({ kind: 'none', reason: 'already_terminal' });
  });

  it('keeps model text out of the terminal checkpoint', () => {
    const action = decideTerminal({
      stats: stats({ narrative: { sha256: 'a'.repeat(64), length: 33 } }),
      stored: running,
      fence: 2,
      receipt: null,
    });
    const json = JSON.stringify(
      terminalCheckpoint(stats({ narrative: { sha256: 'a'.repeat(64), length: 33 } }), action),
    );
    expect(json).toContain('untrustedModelNarrative');
    expect(json).toContain('"length":33');
  });
});
