import { describe, expect, it } from 'vitest';
import { defineTool } from '@expunge/vendor-openmuse';
import { z } from 'zod';
import { ExpungeExecutionAgent } from '../src/index.js';
import { FakeChatModel, fakeText, fakeToolCalls } from '../src/testing/index.js';
import {
  ACTOR,
  FakeArtifactReader,
  FakeJobStore,
  FakeToolProvider,
  FixedModelResolver,
  freshLease,
  makeJobFor,
  baseDeps,
  makeBundle,
} from './fakes.js';

function agentFor(script: ConstructorParameters<typeof FakeChatModel>[0], jobOver = {}) {
  const bundle = makeBundle();
  const fake = new FakeChatModel(script);
  const lease = freshLease();
  const deps = baseDeps({
    jobs: new FakeJobStore(makeJobFor(bundle, lease, jobOver)),
    artifacts: new FakeArtifactReader(bundle),
    tools: new FakeToolProvider(() => [
      defineTool({
        name: 'echo',
        description: 'e',
        parameters: z.object({ v: z.number() }),
        execute: async ({ v }) => ({ v }),
      }),
    ]),
    models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
  });
  return { agent: new ExpungeExecutionAgent(deps, { actor: ACTOR, lease }), fake };
}

describe('the AG-UI client pipeline accepts the stream (runAgent applies events, verifies sequencing, updates state)', () => {
  it('applies text, tool and state events to the agent through the real AbstractAgent.runAgent', async () => {
    const { agent } = agentFor([
      fakeToolCalls([
        { name: 'echo', args: { v: 2 } },
        { name: 'AGUISendStateSnapshot', args: { snapshot: { stage: 'verify', harnessHash: 'attacker' } } },
      ]),
      fakeText('finished'),
    ]);
    const result = await agent.clone().runAgent({ runId: 'pipeline-1' });
    expect(result.newMessages.some((m) => m.role === 'tool')).toBe(true);
    expect(result.newMessages.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('applies model state to the client agent only after authority filtering', async () => {
    const { agent } = agentFor([
      fakeToolCalls([
        { name: 'AGUISendStateSnapshot', args: { snapshot: { stage: 'verify', harnessHash: 'attacker' } } },
      ]),
      fakeText('x'),
    ]);
    const clone = agent.clone();
    await clone.runAgent({ runId: 'pipeline-2' });
    expect(clone.state).toEqual({ stage: 'verify' });
  });

  it('surfaces a failed run through onRunErrorEvent with the sanitized code, not model text', async () => {
    const { agent } = agentFor([fakeText('unused')], { cancellationRequested: true });
    const errors: Array<{ code?: string; message: string }> = [];
    const result = await agent
      .clone()
      .runAgent(
        { runId: 'pipeline-3' },
        { onRunErrorEvent: ({ event }) => void errors.push({ code: event.code, message: event.message }) },
      );
    expect(errors).toEqual([{ code: 'JobCancelled', message: 'JobCancelled' }]);
    expect(result.newMessages).toEqual([]);
  });
});
