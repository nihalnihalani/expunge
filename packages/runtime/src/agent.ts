import { AbstractAgent } from '@ag-ui/client';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { RuntimeError } from './errors.js';
import type { ExecutionBinding, ExecutionDependencies, RunStats } from './ports.js';
import { RunSession } from './session.js';

type Trusted = { readonly deps: ExecutionDependencies; readonly binding: ExecutionBinding };

/**
 * Process-wide single-run guard per lease (job, owner, fence). CopilotKit clones the registered agent for every
 * request, and clones share the frozen lease binding, so a per-instance flag would let two requests drive two
 * model loops under one fence. The key is removed only after the run's teardown and lease release have settled.
 */
const activeLeases = new Set<string>();
const leaseKey = (lease: ExecutionBinding['lease']) =>
  `${lease.jobId}\u0000${lease.ownerId}\u0000${lease.fence}`;

function freezeTrusted(deps: ExecutionDependencies, binding: ExecutionBinding): Trusted {
  return Object.freeze({
    deps: Object.freeze({ ...deps }),
    binding: Object.freeze({
      actor: Object.freeze({ ...binding.actor }),
      lease: Object.freeze({ ...binding.lease }),
    }),
  });
}

/**
 * The durable execution agent. It is an `AbstractAgent` from @ag-ui/client (pinned 0.0.59):
 * `run(input)` returns an RxJS `Observable<BaseEvent>` (node_modules/@ag-ui/client/dist/index.d.mts,
 * `abstract run(input: RunAgentInput): Observable<BaseEvent>`), NOT an async generator.
 *
 * Trusted dependencies and the job/lease binding are constructor arguments held in one frozen object.
 * `AbstractAgent.clone()` rebuilds an instance with `Object.create(prototype)` and copies only base
 * fields, so subclass state would be lost; `clone()` below grafts the same frozen object onto the copy
 * and `run()` fails closed if it is ever missing. The wrapped OpenMuse/TanStack inner agent is built
 * INSIDE `run` from the stored job and its pinned bundle, never from client input.
 */
export class ExpungeExecutionAgent extends AbstractAgent {
  private trusted?: Trusted;
  private active?: RunSession;
  private lastSettled?: Promise<RunStats>;

  constructor(deps: ExecutionDependencies, binding: ExecutionBinding) {
    super({ agentId: 'expunge-execution', description: 'Durable Expunge cleanup worker' });
    this.trusted = freezeTrusted(deps, binding);
  }

  override clone(): ExpungeExecutionAgent {
    const cloned = super.clone() as ExpungeExecutionAgent;
    cloned.trusted = this.trusted;
    cloned.active = undefined;
    cloned.lastSettled = undefined;
    return cloned;
  }

  /** The job this agent is bound to (for tests and the dispatcher). */
  get jobId(): string {
    return this.requireTrusted().binding.lease.jobId;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const { deps, binding } = this.requireTrusted();
    const key = leaseKey(binding.lease);
    if (this.active || activeLeases.has(key)) throw new RuntimeError('RunAlreadyActive');
    return new Observable<BaseEvent>((subscriber) => {
      // Re-checked at subscription: two run() calls made before either subscribed must not both start.
      if (activeLeases.has(key)) {
        subscriber.error(new RuntimeError('RunAlreadyActive'));
        return undefined;
      }
      activeLeases.add(key);
      const session = new RunSession(deps, binding, input, subscriber);
      this.active = session;
      void session.start();
      return () => {
        session.teardown();
        this.lastSettled = session.settled;
        void session.settled.finally(() => activeLeases.delete(key));
        if (this.active === session) this.active = undefined;
      };
    });
  }

  override abortRun(): void {
    this.active?.abort();
  }

  /** Resolves after the last run's teardown and lease release have finished. */
  async settled(): Promise<RunStats | undefined> {
    return this.lastSettled;
  }

  private requireTrusted(): Trusted {
    if (!this.trusted) throw new RuntimeError('ExecutionDependenciesMissing');
    return this.trusted;
  }
}
