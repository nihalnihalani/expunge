import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contentHash } from '@expunge/contracts';
import {
  ACCEPTANCE_LIMITS,
  appliesToTool,
  BINDING_IDS,
  FACT_CATALOG,
  FACT_IDS,
  PROVISIONAL_COST_CEILING_MICROUSD,
  WORKFLOW_GRAPH_CAPS,
  buildExpertStaticBundle,
  buildW0Bundle,
  DISCLOSED_PRIMITIVES,
  OWNER_EPISODE_LIMITS,
  WORKER_TOOL_IDS,
  type InfrastructureHashes,
} from '../src/index.js';

// Test-only infrastructure hashes. Real values are frozen in PREREGISTRATION.md from committed artifacts.
const testHashes: InfrastructureHashes = {
  runtimeAdapterHash: contentHash({ test: 'runtime' }, 'test-fixture'),
  compilerHash: contentHash({ test: 'compiler' }, 'test-fixture'),
  vocabularyHash: contentHash({ test: 'vocabulary' }, 'test-fixture'),
  authorityFloorHash: contentHash({ test: 'floor' }, 'test-fixture'),
  eligibilityPolicyHash: contentHash({ test: 'eligibility' }, 'test-fixture'),
  sourceEligibilityPolicyHash: contentHash({ test: 'source-eligibility' }, 'test-fixture'),
};

describe('baseline harness bundles', () => {
  it('W0 validates and documents its incomplete discovery policy', () => {
    const w0 = buildW0Bundle(testHashes);
    expect(w0.contextPolicy.includeNestedArrays).toBe(false);
    expect(w0.contextPolicy.referenceDepth).toBe(1);
    expect(w0.completionPolicy).toBe('model_narrative');
    expect(w0.workflow.nodes.map((n) => n.toolId)).not.toContain('verify_registered_scope');
    expect(w0.toolPolicy.grants).not.toContain('verify_registered_scope');
  });

  it('expert-static validates, verifies before completion and renders only committed receipts', () => {
    const expert = buildExpertStaticBundle(testHashes);
    expect(expert.contextPolicy.schemaMode).toBe('all_registered_fields');
    expect(expert.contextPolicy.includeNestedArrays).toBe(true);
    expect(expert.contextPolicy.referenceDepth).toBe(5);
    expect(expert.completionPolicy).toBe('verified_receipt');
    const verifyNode = expert.workflow.nodes.find((n) => n.toolId === 'verify_registered_scope');
    expect(verifyNode).toBeDefined();
    expect(expert.workflow.edges).toContainEqual({ from: 'verify', to: 'complete', when: 'success' });
    expect(expert.workflow.edges).toContainEqual({
      from: 'verify',
      to: 'discover',
      when: 'verification_failed',
    });
    expect(expert.toolPolicy.prerequisites.map((p) => p.toolId)).toEqual(
      expect.arrayContaining(['apply_cleanup_batch', 'verify_registered_scope', 'complete_cleanup']),
    );
  });

  it('both bundles stay within the owner episode limits and the frozen tool vocabulary', () => {
    for (const bundle of [buildW0Bundle(testHashes), buildExpertStaticBundle(testHashes)]) {
      for (const key of Object.keys(OWNER_EPISODE_LIMITS) as Array<keyof typeof OWNER_EPISODE_LIMITS>) {
        expect(bundle.limits[key]).toBeLessThanOrEqual(OWNER_EPISODE_LIMITS[key]);
      }
      for (const nodeDef of bundle.workflow.nodes) expect(WORKER_TOOL_IDS).toContain(nodeDef.toolId);
      for (const grant of bundle.toolPolicy.grants) expect(WORKER_TOOL_IDS).toContain(grant);
      expect(bundle.workflow.nodes.length).toBeLessThanOrEqual(OWNER_EPISODE_LIMITS.graphNodes);
      expect(bundle.workflow.edges.length).toBeLessThanOrEqual(OWNER_EPISODE_LIMITS.graphEdges);
    }
  });

  it('bundle hashes bind to the infrastructure hashes and differ between W0 and expert', () => {
    const w0 = contentHash(buildW0Bundle(testHashes));
    const expert = contentHash(buildExpertStaticBundle(testHashes));
    expect(w0).not.toBe(expert);
    const otherRuntime = contentHash(
      buildW0Bundle({ ...testHashes, runtimeAdapterHash: contentHash({ other: 1 }, 'test-fixture') }),
    );
    expect(otherRuntime).not.toBe(w0);
    // Deterministic: building twice yields the same hash.
    expect(contentHash(buildW0Bundle(testHashes))).toBe(w0);
  });

  it('rejects malformed infrastructure hashes instead of producing a bundle', () => {
    expect(() => buildW0Bundle({ ...testHashes, compilerHash: 'not-a-hash' })).toThrow();
  });

  it('discloses the human-authored primitive vocabulary', () => {
    expect(DISCLOSED_PRIMITIVES.workerTools).toEqual(WORKER_TOOL_IDS);
    expect(DISCLOSED_PRIMITIVES.guardrailOps).toContain('receipt_valid');
  });

  it('both bundles declare visit bounds consistent with the frozen 12-phase tool-call budget (DA-2 E4)', () => {
    for (const bundle of [buildW0Bundle(testHashes), buildExpertStaticBundle(testHashes)]) {
      const visits = bundle.workflow.nodes.reduce((sum, nodeDef) => sum + nodeDef.maxVisits, 0);
      expect(visits).toBeLessThanOrEqual(bundle.limits.toolCalls);
    }
    const expert = buildExpertStaticBundle(testHashes);
    expect(
      Object.fromEntries(expert.workflow.nodes.map((nodeDef) => [nodeDef.id, nodeDef.maxVisits])),
    ).toEqual({
      inspect: 1,
      resolve: 1,
      discover: 3,
      preview: 1,
      apply: 3,
      verify: 2,
      complete: 1,
    });
  });

  it('workflow size is bounded by graphNodes/graphEdges, not by reference-traversal limits (DA-2 B5)', () => {
    for (const bundle of [buildW0Bundle(testHashes), buildExpertStaticBundle(testHashes)]) {
      expect(bundle.workflow.nodes.length).toBeLessThanOrEqual(bundle.limits.graphNodes);
      expect(bundle.workflow.edges.length).toBeLessThanOrEqual(bundle.limits.graphEdges);
    }
  });

  it('the expert guardrail is scoped to apply_cleanup_batch and applies to no other tool (DA-2 E3)', () => {
    const expert = buildExpertStaticBundle(testHashes);
    const rule = expert.guardrails.find((candidate) => candidate.ruleId === 'deny_apply_without_valid_plan')!;
    expect(rule.appliesTo).toEqual(['apply_cleanup_batch']);
    for (const toolId of WORKER_TOOL_IDS)
      expect(appliesToTool(rule, toolId), toolId).toBe(toolId === 'apply_cleanup_batch');
    // The predicate names a receipt binding that exists in the disclosed vocabulary.
    expect(JSON.stringify(rule.predicate)).toContain('preview_plan');
    expect(BINDING_IDS).toContain('preview_plan');
    expect(appliesToTool({}, 'inspect_scope')).toBe(true);
    expect(appliesToTool({ appliesTo: [] }, 'inspect_scope')).toBe(true);
  });

  it('discloses the fact and binding vocabulary the compiler admits (DA-2 B4)', () => {
    expect(DISCLOSED_PRIMITIVES.guardrailFacts).toBe(FACT_CATALOG);
    expect(DISCLOSED_PRIMITIVES.guardrailBindings).toEqual(BINDING_IDS);
    expect(FACT_IDS).toEqual(expect.arrayContaining(['verification_residuals', 'array_fields_inspected']));
    expect(new Set(FACT_IDS).size).toBe(FACT_IDS.length);
    for (const fact of FACT_CATALOG) expect(fact.id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(DISCLOSED_PRIMITIVES.guardrailNullSemantics).toMatch(/three-valued/);
    expect(DISCLOSED_PRIMITIVES.guardrailComparators.number).toContain('lt');
    expect(DISCLOSED_PRIMITIVES.guardrailComparators.enum).toEqual(['eq', 'ne']);
  });

  it('attributes owner limits honestly: ACCEPTANCE.md fixes some, the lead sets the rest (DA-2 B3)', () => {
    const acceptance = readFileSync(new URL('../../../docs/expunge/ACCEPTANCE.md', import.meta.url), 'utf8');
    for (const text of [
      '12 model/tool phases',
      '120 seconds',
      '24,000 total token cap',
      '500 domain documents',
      'five reference hops',
    ]) {
      expect(acceptance, text).toContain(text);
    }
    expect(ACCEPTANCE_LIMITS).toMatchObject({
      modelCalls: 12,
      toolCalls: 12,
      wallTimeMs: 120_000,
      totalTokens: 24_000,
    });
    // These three are lead-set owner maxima: nothing in ACCEPTANCE.md states them.
    for (const value of [
      WORKFLOW_GRAPH_CAPS.graphNodes,
      WORKFLOW_GRAPH_CAPS.graphEdges,
      PROVISIONAL_COST_CEILING_MICROUSD,
    ]) {
      expect(acceptance.includes(String(value)), String(value)).toBe(false);
    }
    expect(OWNER_EPISODE_LIMITS).toEqual({
      ...ACCEPTANCE_LIMITS,
      ...WORKFLOW_GRAPH_CAPS,
      maxCostMicrousd: PROVISIONAL_COST_CEILING_MICROUSD,
    });
  });
});
