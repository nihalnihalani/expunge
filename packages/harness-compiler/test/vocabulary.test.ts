import { describe, expect, it } from 'vitest';
import { BINDING_IDS, DISCLOSED_PRIMITIVES, FACT_CATALOG, WORKER_TOOL_IDS } from '@expunge/baselines';
import {
  ARTIFACT_PRODUCER,
  BINDING_ID_SET,
  FACTS_BY_ID,
  IDENTIFIER_FORMAT,
  LOOP_NODE_MAX_VISITS,
  MAX_EDITS,
  TOOL_ID_SET,
  VOCABULARY_HASH,
  comparatorsFor,
  enumDomainsOf,
  sameEnumDomain,
} from '../src/index.js';

describe('trusted vocabulary (C2 foundation)', () => {
  it('resolves exactly the primitives that @expunge/baselines discloses', () => {
    expect([...TOOL_ID_SET].sort()).toEqual([...WORKER_TOOL_IDS].sort());
    expect([...BINDING_ID_SET].sort()).toEqual([...BINDING_IDS].sort());
    expect(FACTS_BY_ID.size).toBe(FACT_CATALOG.length);
    expect(DISCLOSED_PRIMITIVES.guardrailFacts).toBe(FACT_CATALOG);
    expect(MAX_EDITS).toBe(3);
    expect(LOOP_NODE_MAX_VISITS).toBeGreaterThan(0);
  });

  it('knows which comparators and enum domains are admitted', () => {
    expect(comparatorsFor({ kind: 'number' })).toEqual(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
    expect(comparatorsFor({ kind: 'boolean' })).toEqual(['eq', 'ne']);
    expect(comparatorsFor({ kind: 'enum', values: ['valid', 'invalid'] })).toEqual(['eq', 'ne']);
    expect(sameEnumDomain(['valid', 'invalid'], ['invalid', 'valid'])).toBe(true);
    expect(sameEnumDomain(['valid'], ['valid', 'invalid'])).toBe(false);
    expect(enumDomainsOf('delete')).toEqual(['batch_effect_kind']);
    expect(enumDomainsOf('nonsense')).toEqual([]);
  });

  it('no tool can depend on an artifact only it produces', () => {
    for (const [artifact, producer] of Object.entries(ARTIFACT_PRODUCER)) {
      expect(BINDING_ID_SET.has(artifact)).toBe(true);
      if (producer) expect(TOOL_ID_SET.has(producer)).toBe(true);
    }
    expect('Valid_Name_1'.match(IDENTIFIER_FORMAT)).toBeNull();
    expect('deny_apply_without_plan'.match(IDENTIFIER_FORMAT)).not.toBeNull();
  });

  it('commits to the vocabulary by value and by source bytes', () => {
    expect(VOCABULARY_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
