// DA-3 repro: run teardown releases the lease without waiting for in-flight tools. A tool that does not honor
// the AbortSignal keeps executing after the job is already `cancelled` (lease released) and after
// agent.settled() resolves. Uses the runtime's deterministic fakes; the slow tool stands in for any trusted tool
// doing non-fenced work (vendor call, telemetry, file write).
// Exit 0 = reproduced, 1 = not reproduced, 2 = error.   Run: npx tsx docs/review/repro/rt-tool-outlives.repro.ts
import { z } from '../../../packages/runtime/node_modules/zod/index.js';
import { defineTool } from '@expunge/vendor-openmuse';
import { ExpungeExecutionAgent, FakeChatModel, fakeToolCalls, fakeText } from '../../../packages/runtime/src/index.js';
import {
  ACTOR, FakeArtifactReader, FakeJobStore, FakeToolProvider, FixedModelResolver, LEASE, baseDeps, makeBundle, makeJob, runInput, waitFor,
} from '../../../packages/runtime/test/fakes.js';

try {
  const bundle = makeBundle({ toolPolicy: { grants: ['slow'], prerequisites: [] } });
  const store = new FakeJobStore(makeJob(bundle));
  const timeline: string[] = [];
  const slow = defineTool({
    name: 'slow',
    description: 'slow tool',
    parameters: z.object({}),
    execute: async () => {
      timeline.push('tool:start');
      await new Promise((resolve) => setTimeout(resolve, 600)); // ignores the AbortSignal
      timeline.push(`tool:end(job=${store.job.status})`);
      return { ok: true };
    },
  });
  const fake = new FakeChatModel([fakeToolCalls([{ name: 'slow', args: {} }]), fakeText('done')]);
  const agent = new ExpungeExecutionAgent(
    baseDeps({ jobs: store, artifacts: new FakeArtifactReader(bundle), tools: new FakeToolProvider(() => [slow]), models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }) }),
    { actor: ACTOR, lease: LEASE },
  );
  const sub = agent.run(runInput()).subscribe();
  await waitFor(() => timeline.includes('tool:start'));
  store.job.cancellationRequested = true; // owner cancels while the tool runs
  sub.unsubscribe(); // dispatcher abort path (renewal fails on cancellation)
  const stats = await agent.settled();
  timeline.push(`settled(release=${stats?.release}, job=${store.job.status})`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log(timeline.join(' -> '));
  const reproduced = timeline.indexOf(`settled(release=cancelled, job=cancelled)`) >= 0 && timeline.some((t) => t === 'tool:end(job=cancelled)') && timeline.findIndex((t) => t.startsWith('settled')) < timeline.findIndex((t) => t.startsWith('tool:end'));
  console.log(reproduced ? 'REPRODUCED' : 'NOT REPRODUCED');
  process.exit(reproduced ? 0 : 1);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
