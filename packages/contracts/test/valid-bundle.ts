import type { HarnessBundle } from '../src/index.js';

/** Shared minimal valid bundle for protocol tests. A plain module so importing it registers no tests. */
export function validBundle(): HarnessBundle {
  const hash = 'a'.repeat(64);
  return {
    contractVersion: 1,
    target: 'worker',
    parentHash: null,
    contextPolicy: {
      schemaMode: 'selected_fields',
      includeNestedArrays: false,
      referenceDepth: 0,
      lessonRecall: { mode: 'exact', topK: 0, moduleIds: [] },
      sourceEligibilityPolicyHash: hash,
      maxContextTokens: 2000,
      evidenceFormat: 'trace_and_score',
    },
    workflow: {
      entryNodeId: 'inspect',
      nodes: [{ id: 'inspect', toolId: 'inspect_schema', inputBindings: { job: 'job.id' }, maxVisits: 1 }],
      edges: [],
      terminalNodeIds: ['inspect'],
    },
    guardrails: [],
    toolPolicy: { grants: ['inspect_schema'], prerequisites: [] },
    completionPolicy: 'verified_receipt',
    pluginArtifacts: [],
    limits: {
      modelCalls: 12,
      toolCalls: 12,
      scannedDocuments: 500,
      changedDocuments: 100,
      traversalDepth: 5,
      graphNodes: 500,
      graphEdges: 1000,
      wallTimeMs: 120000,
      totalTokens: 24000,
      maxCostMicrousd: 1000000,
    },
    evidence: [],
    runtimeAdapterHash: hash,
    compilerHash: hash,
    vocabularyHash: hash,
    authorityFloorHash: hash,
    eligibilityPolicyHash: hash,
  };
}
