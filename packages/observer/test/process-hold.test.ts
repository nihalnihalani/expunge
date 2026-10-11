import { describe, expect, it, vi } from 'vitest';
import { EvidenceProcess, type OutboxDispatcher } from '../src/index.js';

/** The per-batch freshness gate: nothing is dispatched or scanned unless `holdUnless` answers true right now. */
const fakeDispatcher = () => {
  let remaining = 2;
  const runOnce = vi.fn(async () =>
    remaining-- > 0 ? ({ operationId: 'op', result: 'evidence_ready', attained: [] } as never) : null,
  );
  return { dispatcher: { runOnce } as unknown as OutboxDispatcher, runOnce };
};

describe('EvidenceProcess holdUnless', () => {
  it('drains normally when the gate answers true, asking before each drain call', async () => {
    const { dispatcher, runOnce } = fakeDispatcher();
    const gate = vi.fn(async () => true);
    const process = new EvidenceProcess({ dispatcher, holdUnless: gate });
    expect(await process.drain()).toHaveLength(2);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledTimes(3);
  });
  it('sends nothing when the gate answers false or throws, and logs the hold', async () => {
    for (const gate of [async () => false, async () => Promise.reject(new Error('boom'))]) {
      const { dispatcher, runOnce } = fakeDispatcher();
      const log = vi.fn();
      const process = new EvidenceProcess({ dispatcher, holdUnless: gate, log });
      expect(await process.drain()).toEqual([]);
      expect(runOnce).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('held') }),
      );
    }
  });
  it('without a gate behaves as before', async () => {
    const { dispatcher } = fakeDispatcher();
    expect(await new EvidenceProcess({ dispatcher }).drain()).toHaveLength(2);
  });
});
