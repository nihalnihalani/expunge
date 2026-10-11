import { describe, expect, it } from 'vitest';
import { ExpungeExecutionAgent, FakeChatModel } from '../src/index.js';
import {
  ACTOR,
  FakeArtifactReader,
  FakeJobStore,
  FakeToolProvider,
  FixedModelResolver,
  freshLease,
  makeJobFor,
  baseDeps,
  collect,
  makeBundle,
  runInput,
} from './fakes.js';

describe('provider usage', () => {
  it('is carried on RUN_FINISHED and reported in the run stats (recorded, not yet enforced against totalTokens)', async () => {
    const bundle = makeBundle();
    const lease = freshLease();
    const fake = new FakeChatModel([
      {
        parts: [{ kind: 'text', text: 'ok' }],
        usage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 },
      },
    ]);
    const agent = new ExpungeExecutionAgent(
      baseDeps({
        jobs: new FakeJobStore(makeJobFor(bundle, lease)),
        artifacts: new FakeArtifactReader(bundle),
        tools: new FakeToolProvider(() => []),
        models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
      }),
      { actor: ACTOR, lease },
    );
    const events = await collect(agent.run(runInput()));
    const stats = await agent.settled();
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(stats?.usage).toEqual([{ inputTokens: 11, outputTokens: 5, totalTokens: 16 }]);
  });
});
