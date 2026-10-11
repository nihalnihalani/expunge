import { z } from 'zod';
import type { ToolRuntime } from '../runtime.js';

export const inspectHarnessInput = z.object({}).strict();

/**
 * The run's own pinned harness, read from the stored bundle: how it is allowed to behave, not how any other run did.
 * It carries no evidence payloads, no authority floor internals and nothing from the private database.
 */
export async function inspectHarness(rt: ToolRuntime) {
  const bundle = rt.bundle;
  return {
    harnessHash: rt.run.harnessHash,
    target: bundle.target,
    completionPolicy: bundle.completionPolicy,
    contextPolicy: {
      schemaMode: bundle.contextPolicy.schemaMode,
      includeNestedArrays: bundle.contextPolicy.includeNestedArrays,
      referenceDepth: bundle.contextPolicy.referenceDepth,
    },
    limits: bundle.limits,
    toolGrants: [...bundle.toolPolicy.grants],
    prerequisites: bundle.toolPolicy.prerequisites.map((entry) => ({
      toolId: entry.toolId,
      requiredArtifact: entry.requiredArtifact,
    })),
    workflow: {
      entryNodeId: bundle.workflow.entryNodeId,
      nodes: bundle.workflow.nodes.map((node) => ({
        id: node.id,
        toolId: node.toolId,
        maxVisits: node.maxVisits,
      })),
      edges: bundle.workflow.edges.map((edge) => ({ from: edge.from, to: edge.to, when: edge.when })),
      terminalNodeIds: [...bundle.workflow.terminalNodeIds],
    },
    guardrails: bundle.guardrails.map((rule) => ({
      ruleId: rule.ruleId,
      result: rule.result,
      appliesTo: rule.appliesTo ?? [],
    })),
    evidenceRefCount: bundle.evidence.length,
  };
}
