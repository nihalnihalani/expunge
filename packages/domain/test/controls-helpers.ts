import type { HarnessBundle, ResourceLimits, WorkflowGraph } from '@expunge/contracts';
import type { ToolContext } from '@expunge/runtime';
import { RunContext, type ToolRuntime, type WorkerToolId } from '../src/index.js';
import {
  createGatewayControls,
  type CallAdmission,
  type CallOutcome,
  type GatewayControls,
} from '../src/controls.js';
import { bundles, type OpenRun, type Rig, type Seeded } from './rig.js';

/** The expert-static bundle with its limits or workflow replaced, so a test can pin a small ceiling. */
export function expertWith(change: {
  limits?: Partial<ResourceLimits>;
  workflow?: (graph: WorkflowGraph) => WorkflowGraph;
  guardrails?: HarnessBundle['guardrails'];
}): HarnessBundle {
  const base = bundles.expert();
  return {
    ...base,
    limits: { ...base.limits, ...change.limits },
    workflow: change.workflow ? change.workflow(structuredClone(base.workflow)) : base.workflow,
    guardrails: [...base.guardrails, ...(change.guardrails ?? [])],
  };
}

/** Sets one node's `maxVisits`. */
export const withMaxVisits =
  (nodeId: string, maxVisits: number) =>
  (graph: WorkflowGraph): WorkflowGraph => ({
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, maxVisits } : node)),
  });

export type Held = { run: OpenRun; rt: ToolRuntime; controls: GatewayControls; context: ToolContext };

/** The controls and the tool runtime of a run, as the gateway builds them for the session holding `context`. */
export async function hold(rig: Rig, run: OpenRun, context: ToolContext = run.context): Promise<Held> {
  return { run, rt: await RunContext.open(rig.domain, context), controls: createGatewayControls(), context };
}

/** Another worker takes the lease: the old holder is released and the next claim bumps the fence. */
export async function takeOver(
  rig: Rig,
  seeded: Seeded,
  run: OpenRun,
  from: ToolContext,
  ownerId: string,
): Promise<ToolContext> {
  await rig.domain.jobs.release(seeded.actor, from.lease);
  const job = await rig.domain.jobs.claim(seeded.actor, run.jobId, ownerId, 120_000);
  if (!job) throw new Error('takeover claim failed');
  return { ...from, job, lease: { jobId: run.jobId, ownerId, fence: job.lease.fence } };
}

export type Step = [tool: WorkerToolId, outcome: CallOutcome];

/** Runs `begin` then `end` for each step, the way the gateway does for a call that ran. */
export async function walk(held: Held, steps: readonly Step[]): Promise<CallAdmission[]> {
  const admissions: CallAdmission[] = [];
  for (const [toolId, outcome] of steps) {
    const admission = await held.controls.begin(held.rt, { toolId, documentsToChange: 0 });
    await held.controls.end(held.rt, { toolId, callNumber: admission.callNumber, outcome });
    admissions.push(admission);
  }
  return admissions;
}

/** The first calls of a normal run, up to and including preview. */
export const PLANNING: readonly Step[] = [
  ['inspect_scope', 'success'],
  ['resolve_subject', 'success'],
  ['discover_references', 'success'],
  ['preview_cleanup', 'success'],
];
