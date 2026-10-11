// DA-3 repro: a clone shares the frozen lease binding but not the "one active run" guard, so the original and a
// clone (or two clones, which is what CopilotKit runtime 1.75.0 makes per request: agents[agentId].clone()) can run
// the same job under the same lease fence at the same time. Uses the runtime's own deterministic test fakes.
// Exit 0 = reproduced (two concurrent model loops for one lease), 1 = not reproduced, 2 = error.
// Run: npx tsx docs/review/repro/rt-clone-concurrency.repro.ts
import { ExpungeExecutionAgent, FakeChatModel, fakeHang } from '../../../packages/runtime/src/index.js';
import {
  ACTOR,
  FakeArtifactReader,
  FakeJobStore,
  FakeToolProvider,
  FixedModelResolver,
  LEASE,
  baseDeps,
  makeBundle,
  makeJob,
  runInput,
  waitFor,
} from '../../../packages/runtime/test/fakes.js';

try {
  const bundle = makeBundle();
  const fake = new FakeChatModel([fakeHang(), fakeHang()]);
  const deps = baseDeps({
    jobs: new FakeJobStore(makeJob(bundle)),
    artifacts: new FakeArtifactReader(bundle),
    tools: new FakeToolProvider(() => []),
    models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
  });
  const original = new ExpungeExecutionAgent(deps, { actor: ACTOR, lease: LEASE });
  const first = original.run(runInput()).subscribe();
  await waitFor(() => fake.calls.length === 1);
  let secondStarted = false;
  let refused = '';
  try {
    const second = original.clone().run(runInput({ runId: 'run-2' })).subscribe();
    await waitFor(() => fake.calls.length === 2, 1500);
    secondStarted = true;
    second.unsubscribe();
  } catch (error) {
    refused = (error as Error).message;
  }
  first.unsubscribe();
  await original.settled();
  console.log(`model calls in flight for lease ${LEASE.jobId}/fence ${LEASE.fence}: ${fake.calls.length}${refused ? `; clone refused: ${refused}` : ''}`);
  console.log(secondStarted ? 'REPRODUCED' : 'NOT REPRODUCED');
  process.exit(secondStarted ? 0 : 1);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
