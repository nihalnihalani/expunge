import { describe, expect, it } from 'vitest';
import type { GuardrailAst, GuardrailPredicate } from '@expunge/contracts';
import {
  TRI_FALSE,
  TRI_TRUE,
  TRI_UNKNOWN,
  decide,
  evaluatePredicate,
  ruleApplies,
  ruleFires,
  type DecisionInput,
} from '../src/index.js';
import { expert } from './helpers.js';

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  toolId: 'apply_cleanup_batch',
  facts: {},
  bindings: {},
  prior: {},
  ...over,
});
const residuals = (
  comparator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  value: number,
): GuardrailPredicate => ({
  op: 'compare',
  comparator,
  left: { kind: 'fact', factId: 'verification_residuals' },
  right: { kind: 'constant', value },
});
const rule = (
  predicate: GuardrailPredicate,
  result: GuardrailAst['result'],
  extra: Partial<GuardrailAst> = {},
): GuardrailAst => ({
  ruleId: 'rule_one',
  predicate,
  result,
  sourceEvidenceIds: [],
  ...extra,
});

describe('three-valued guardrail semantics (documented null table)', () => {
  it('a null, missing or wrongly typed operand makes a comparison unknown, for every comparator', () => {
    for (const comparator of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const) {
      for (const facts of [
        {},
        { verification_residuals: null },
        { verification_residuals: 'three' },
        { verification_residuals: true },
        { verification_residuals: Number.NaN },
      ]) {
        expect(
          evaluatePredicate(residuals(comparator, 3), input({ facts })),
          `${comparator} ${JSON.stringify(facts)}`,
        ).toBe(TRI_UNKNOWN);
      }
    }
  });

  it('known operands compare normally', () => {
    const at = (value: number) => input({ facts: { verification_residuals: value } });
    expect(evaluatePredicate(residuals('eq', 3), at(3))).toBe(TRI_TRUE);
    expect(evaluatePredicate(residuals('eq', 3), at(4))).toBe(TRI_FALSE);
    expect(evaluatePredicate(residuals('ne', 3), at(4))).toBe(TRI_TRUE);
    expect(evaluatePredicate(residuals('lt', 3), at(2))).toBe(TRI_TRUE);
    expect(evaluatePredicate(residuals('lte', 3), at(3))).toBe(TRI_TRUE);
    expect(evaluatePredicate(residuals('gt', 3), at(3))).toBe(TRI_FALSE);
    expect(evaluatePredicate(residuals('gte', 3), at(3))).toBe(TRI_TRUE);
  });

  it('Kleene connectives: false dominates all, true dominates any, not keeps unknown', () => {
    const unknown = residuals('gt', 0);
    const truthy: GuardrailPredicate = {
      op: 'compare',
      comparator: 'eq',
      left: { kind: 'constant', value: 1 },
      right: { kind: 'constant', value: 1 },
    };
    const falsy: GuardrailPredicate = {
      op: 'compare',
      comparator: 'eq',
      left: { kind: 'constant', value: 1 },
      right: { kind: 'constant', value: 2 },
    };
    const i = input();
    expect(evaluatePredicate({ op: 'all', predicates: [unknown, falsy] }, i)).toBe(TRI_FALSE);
    expect(evaluatePredicate({ op: 'all', predicates: [unknown, truthy] }, i)).toBe(TRI_UNKNOWN);
    expect(evaluatePredicate({ op: 'any', predicates: [unknown, truthy] }, i)).toBe(TRI_TRUE);
    expect(evaluatePredicate({ op: 'any', predicates: [unknown, falsy] }, i)).toBe(TRI_UNKNOWN);
    expect(evaluatePredicate({ op: 'not', predicate: unknown }, i)).toBe(TRI_UNKNOWN);
    expect(evaluatePredicate({ op: 'not', predicate: truthy }, i)).toBe(TRI_FALSE);
  });

  it('receipt_valid and prior_effect_count follow the same table', () => {
    const valid: GuardrailPredicate = { op: 'receipt_valid', bindingId: 'preview_plan' };
    expect(evaluatePredicate(valid, input({ bindings: { preview_plan: 'valid' } }))).toBe(TRI_TRUE);
    expect(evaluatePredicate(valid, input({ bindings: { preview_plan: 'invalid' } }))).toBe(TRI_FALSE);
    for (const bindings of [{}, { preview_plan: null }, { preview_plan: 'bogus' }, { preview_plan: 1 }]) {
      expect(evaluatePredicate(valid, input({ bindings }))).toBe(TRI_UNKNOWN);
    }
    const prior: GuardrailPredicate = {
      op: 'prior_effect_count',
      toolId: 'apply_cleanup_batch',
      comparator: 'gte',
      count: 2,
    };
    expect(evaluatePredicate(prior, input({ prior: { apply_cleanup_batch: 2 } }))).toBe(TRI_TRUE);
    expect(evaluatePredicate(prior, input({ prior: { apply_cleanup_batch: 1 } }))).toBe(TRI_FALSE);
    expect(evaluatePredicate(prior, input())).toBe(TRI_UNKNOWN);
  });

  it('rules fire per the table: unknown fires deny and ask, never allow', () => {
    expect(ruleFires('deny', TRI_TRUE)).toBe(true);
    expect(ruleFires('deny', TRI_UNKNOWN)).toBe(true);
    expect(ruleFires('deny', TRI_FALSE)).toBe(false);
    expect(ruleFires('ask', TRI_UNKNOWN)).toBe(true);
    expect(ruleFires('allow', TRI_UNKNOWN)).toBe(false);
    expect(ruleFires('allow', TRI_TRUE)).toBe(true);
    expect(ruleFires('allow', TRI_FALSE)).toBe(false);
  });

  it('severity merges deny > ask > allow and fired ids keep rule order', () => {
    const rules = [
      rule(residuals('gt', 0), 'ask', { ruleId: 'ask_if_residuals' }),
      rule(residuals('gt', 5), 'deny', { ruleId: 'deny_if_many' }),
      rule(residuals('eq', 99), 'deny', { ruleId: 'deny_never' }),
    ];
    const result = (facts: Record<string, unknown>) => decide(rules, input({ facts }), 7).decision;
    expect(result({ verification_residuals: 0 })).toEqual({
      result: 'allow',
      ruleIds: [],
      authorizationRevision: 7,
    });
    expect(result({ verification_residuals: 2 })).toEqual({
      result: 'ask',
      ruleIds: ['ask_if_residuals'],
      authorizationRevision: 7,
    });
    expect(result({ verification_residuals: 6 })).toEqual({
      result: 'deny',
      ruleIds: ['ask_if_residuals', 'deny_if_many'],
      authorizationRevision: 7,
    });
    // Unknown fires the restrictive rules, so the worst of them decides.
    expect(result({}).result).toBe('deny');
    expect(result({}).ruleIds).toEqual(['ask_if_residuals', 'deny_if_many', 'deny_never']);
    expect(decide([], input()).decision).toEqual({ result: 'allow', ruleIds: [], authorizationRevision: 0 });
  });

  it('appliesTo scopes a rule to its tools; absent or empty applies to every call', () => {
    expect(ruleApplies(rule(residuals('gt', 0), 'deny'), 'inspect_scope')).toBe(true);
    expect(ruleApplies(rule(residuals('gt', 0), 'deny', { appliesTo: [] }), 'inspect_scope')).toBe(true);
    expect(
      ruleApplies(rule(residuals('gt', 0), 'deny', { appliesTo: ['apply_cleanup_batch'] }), 'inspect_scope'),
    ).toBe(false);
    expect(
      ruleApplies(
        rule(residuals('gt', 0), 'deny', { appliesTo: ['apply_cleanup_batch'] }),
        'apply_cleanup_batch',
      ),
    ).toBe(true);
  });

  it('the expert-static rule denies apply without a valid plan and touches no other tool', () => {
    const rules = expert().guardrails;
    const withPlan = (toolId: string, plan: unknown) =>
      decide(rules, input({ toolId, bindings: { preview_plan: plan } })).decision.result;
    expect(withPlan('apply_cleanup_batch', 'valid')).toBe('allow');
    expect(withPlan('apply_cleanup_batch', 'invalid')).toBe('deny');
    expect(withPlan('apply_cleanup_batch', null)).toBe('deny');
    for (const toolId of [
      'inspect_scope',
      'resolve_subject',
      'discover_references',
      'preview_cleanup',
      'verify_registered_scope',
      'complete_cleanup',
    ]) {
      expect(withPlan(toolId, null), toolId).toBe('allow');
      expect(withPlan(toolId, 'invalid'), toolId).toBe('allow');
    }
  });
});
