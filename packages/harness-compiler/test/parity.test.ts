import { describe, expect, it } from 'vitest';
import {
  MONGO_OPERATOR_WHITELIST,
  assertSafeMongoExpression,
  compileDecisionExpression,
  compileFiredExpression,
  compileGuardrails,
  compilePredicateExpression,
  decide,
  evaluateMongoExpression,
  evaluatePredicate,
  validateGuardrails,
  walkPredicate,
} from '../src/index.js';
import { randomInput, randomPredicate, randomRules, rng } from './generators.js';

const document = (input: ReturnType<typeof randomInput>) => ({
  toolId: input.toolId,
  facts: input.facts,
  bindings: input.bindings,
  prior: input.prior,
});
const INPUTS_PER_CASE = 12;

describe('Mongo expression versus TypeScript evaluator parity (labelled interpreter of the emitted operator subset)', () => {
  it('agrees on the three-valued truth of 400 generated predicates over 4,800 fact sets', () => {
    const random = rng(20261011);
    let comparisons = 0;
    const kinds = new Set<string>();
    for (let n = 0; n < 400; n++) {
      const predicate = randomPredicate(random, 4);
      walkPredicate(predicate, (node) => kinds.add(node.op));
      const expression = compilePredicateExpression(predicate);
      assertSafeMongoExpression(expression);
      for (let m = 0; m < INPUTS_PER_CASE; m++) {
        const input = randomInput(random);
        expect(evaluateMongoExpression(expression, document(input)), `predicate #${n} input #${m}`).toBe(
          evaluatePredicate(predicate, input),
        );
        comparisons++;
      }
    }
    expect(comparisons).toBe(4800);
    expect([...kinds].sort()).toEqual([
      'all',
      'any',
      'compare',
      'not',
      'prior_effect_count',
      'receipt_valid',
    ]);
  });

  it('agrees on firing, scoping and the merged decision of 150 generated rule sets', () => {
    const random = rng(7);
    let rulesTested = 0;
    const decisions = new Set<string>();
    for (let n = 0; n < 150; n++) {
      const rules = randomRules(random);
      const expression = compileDecisionExpression(rules);
      assertSafeMongoExpression(expression.result);
      assertSafeMongoExpression(expression.ruleIds);
      const compiled = compileGuardrails(rules);
      for (let m = 0; m < INPUTS_PER_CASE; m++) {
        const input = randomInput(random);
        const { decision } = decide(rules, input);
        decisions.add(decision.result);
        expect(evaluateMongoExpression(expression.result, document(input)), `rules #${n} input #${m}`).toBe(
          decision.result,
        );
        expect(evaluateMongoExpression(expression.ruleIds, document(input))).toEqual(decision.ruleIds);
        rules.forEach((rule, index) => {
          expect(evaluateMongoExpression(compileFiredExpression(rule), document(input))).toBe(
            compiled[index]!.fires(input),
          );
          rulesTested++;
        });
      }
    }
    expect(rulesTested).toBeGreaterThan(1000);
    expect([...decisions].sort()).toEqual(['allow', 'ask', 'deny']);
  });

  it('every generated predicate is statically valid and typed by the vocabulary', () => {
    const random = rng(99);
    for (let n = 0; n < 200; n++) {
      const rule = {
        ruleId: 'generated_rule',
        predicate: randomPredicate(random, 4),
        result: 'deny' as const,
        sourceEvidenceIds: [],
        appliesTo: ['apply_cleanup_batch'],
      };
      expect(
        validateGuardrails([rule]).map((entry) => entry.code),
        `#${n}`,
      ).toEqual([]);
    }
  });
});

describe('emitted expressions stay inside the operator whitelist', () => {
  it('rejects JavaScript, accumulators, unknown operators and arbitrary field paths', () => {
    for (const bad of [
      { $where: 'true' },
      { $function: { body: 'x', args: [], lang: 'js' } },
      { $accumulator: {} },
      { $expr: 1 },
      '$$ROOT',
      '$secret.value',
      '$facts.x.y',
      { $cond: [{ $regex: ['a', 'b'] }, 1, 0] },
      { notAnOperator: 1 },
    ]) {
      expect(() => assertSafeMongoExpression(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() =>
      assertSafeMongoExpression({ $cond: [{ $eq: ['$facts.retry_count', { $literal: '$$ROOT' }] }, 2, 0] }),
    ).not.toThrow();
    expect(MONGO_OPERATOR_WHITELIST.has('$where')).toBe(false);
    expect(MONGO_OPERATOR_WHITELIST.has('$function')).toBe(false);
  });

  it('a rule id or tool id can never become an expression (literals are wrapped)', () => {
    const rules = [
      {
        ruleId: 'deny_all_pending',
        predicate: randomPredicate(rng(3), 2),
        result: 'deny' as const,
        sourceEvidenceIds: [],
        appliesTo: ['apply_cleanup_batch'],
      },
    ];
    const text = JSON.stringify(compileDecisionExpression(rules));
    expect(text).toContain('{"$literal":"deny_all_pending"}');
    expect(text).toContain('{"$literal":["apply_cleanup_batch"]}');
  });
});
