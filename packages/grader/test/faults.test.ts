import { describe, expect, it } from 'vitest';
import { createWorldSpec } from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import {
  FaultSession,
  InjectedFault,
  gradeWorld,
  referenceSolve,
  runReferenceWithFaults,
} from '../src/index.js';

describe('bounded deterministic fault/retry simulation', () => {
  it('recovers transient error, interrupted batch and committed-but-unacknowledged actions without repeat effects', () => {
    const spec = createWorldSpec({ family: 'partial_retry', seed: 'faults' });
    const fixture = generateSealedFixture(spec, 'faults');
    const plan = referenceSolve(fixture.world);
    const { session, retryFailures } = runReferenceWithFaults(fixture.world, plan, spec.faults);
    expect(session.counters).toEqual({
      attempts: 10,
      effects: 6,
      replays: 2,
      transientFailures: 1,
      interrupted: 1,
      acknowledgementsLost: 2,
    });
    expect(session.receipts.size).toBe(6);
    expect(retryFailures).toBe(0);
    expect(
      gradeWorld(fixture.manifest, session.world, { terminalStatus: 'complete', retryFailures })
        .usefulCompletion,
    ).toBe(true);
  });
  it('logical replay returns exact prior receipt and rejects changed arguments', () => {
    const spec = createWorldSpec({ family: 'direct_nested', seed: 'idempotency' });
    const fixture = generateSealedFixture(spec, 'idempotency');
    const plan = referenceSolve(fixture.world);
    const session = new FaultSession(fixture.world, {
      partialAcknowledgements: 1,
      interruptAfterEffects: null,
      transientFailures: 0,
    });
    const action = plan.actions[0]!;
    expect(() => session.apply('stable-logical-key', action, plan.exactBindings)).toThrow(InjectedFault);
    const committed = session.receipts.get('stable-logical-key')!;
    expect(session.apply('stable-logical-key', action, plan.exactBindings)).toBe(committed);
    expect(session.counters.effects).toBe(1);
    expect(() =>
      session.apply(
        'stable-logical-key',
        { ...action, effect: action.effect === 'delete' ? 'redact' : 'delete' },
        plan.exactBindings,
      ),
    ).toThrow('IdempotencyConflict');
  });
  it('exhausted retries remain explicit failures and cannot earn useful completion', () => {
    const spec = createWorldSpec({ family: 'partial_retry', seed: 'exhaust' });
    const fixture = generateSealedFixture(spec, 'exhaust');
    const result = runReferenceWithFaults(fixture.world, referenceSolve(fixture.world), spec.faults, 0);
    expect(result.retryFailures).toBeGreaterThan(0);
    const grade = gradeWorld(fixture.manifest, result.session.world, {
      terminalStatus: 'complete',
      retryFailures: result.retryFailures,
    });
    expect(grade.usefulCompletion).toBe(false);
    expect(grade.reasonCodes).toContain('retry_failure');
  });
});
