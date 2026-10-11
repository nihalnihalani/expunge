// MongoDB aggregation expressions equivalent to `semantics.ts`. The root document of an evaluation is
// `{ toolId, facts, bindings, prior }`. Every predicate compiles to an expression yielding 0 (false), 1 (unknown)
// or 2 (true), so Kleene's connectives are $min, $max and 2 - x. No JavaScript, $where, $function or $accumulator
// is ever emitted; `assertSafeMongoExpression` enforces the operator whitelist on whatever the compiler produced.
import type { FactOperand, GuardrailAst, GuardrailPredicate } from '@expunge/contracts';
import { operandKind } from './semantics.js';

export type MongoExpression = unknown;

const COMPARATOR_OPERATORS = {
  eq: '$eq',
  ne: '$ne',
  lt: '$lt',
  lte: '$lte',
  gt: '$gt',
  gte: '$gte',
} as const;

/** Operators the compiler may emit. Anything else in an emitted expression is a compiler defect. */
export const MONGO_OPERATOR_WHITELIST: ReadonlySet<string> = new Set([
  '$literal',
  '$ifNull',
  '$cond',
  '$eq',
  '$ne',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$and',
  '$min',
  '$max',
  '$subtract',
  '$isNumber',
  '$type',
  '$switch',
  '$in',
  '$concatArrays',
]);
const FIELD_PATH = /^\$(toolId|(facts|bindings|prior)\.[a-z][a-z0-9_]*)$/;

/** $switch is the one operator whose body is an object of plain keys rather than an operand list. */
function assertSafeSwitch(body: unknown): void {
  const keys = body && typeof body === 'object' ? Object.keys(body) : [];
  if (!keys.length || keys.some((key) => key !== 'branches' && key !== 'default'))
    throw new Error('UnsafeMongoSwitch');
  const { branches, default: fallback } = body as { branches: unknown; default: unknown };
  if (!Array.isArray(branches)) throw new Error('UnsafeMongoSwitch');
  for (const branch of branches) {
    const branchKeys = branch && typeof branch === 'object' ? Object.keys(branch) : [];
    if (branchKeys.length !== 2 || branchKeys.some((key) => key !== 'case' && key !== 'then'))
      throw new Error('UnsafeMongoSwitch');
    assertSafeMongoExpression((branch as { case: unknown }).case);
    assertSafeMongoExpression((branch as { then: unknown }).then);
  }
  assertSafeMongoExpression(fallback);
}

/** Rejects any operator, field path or shape outside what the compiler is allowed to emit. */
export function assertSafeMongoExpression(expression: MongoExpression): void {
  if (typeof expression === 'string') {
    if (expression.startsWith('$') && !FIELD_PATH.test(expression)) throw new Error('UnsafeMongoFieldPath');
    return;
  }
  if (Array.isArray(expression)) {
    expression.forEach(assertSafeMongoExpression);
    return;
  }
  if (expression && typeof expression === 'object') {
    const keys = Object.keys(expression);
    if (keys.length !== 1) throw new Error('UnsafeMongoObjectKey');
    const [key] = keys as [string];
    if (!key.startsWith('$')) throw new Error('UnsafeMongoObjectKey');
    if (!MONGO_OPERATOR_WHITELIST.has(key)) throw new Error(`UnsafeMongoOperator:${key}`);
    const body = (expression as Record<string, unknown>)[key];
    // A $literal body is data, not an expression.
    if (key === '$switch') assertSafeSwitch(body);
    else if (key !== '$literal') assertSafeMongoExpression(body);
  }
}

const reference = (path: string): MongoExpression => ({ $ifNull: [`$${path}`, null] });

function operandExpression(operand: FactOperand): MongoExpression {
  if (operand.kind === 'constant') return { $literal: operand.value };
  return operand.kind === 'fact'
    ? reference(`facts.${operand.factId}`)
    : reference(`bindings.${operand.bindingId}`);
}
function kindGuard(value: MongoExpression, kind: 'number' | 'boolean' | 'string'): MongoExpression {
  if (kind === 'number') return { $isNumber: value };
  return { $eq: [{ $type: value }, kind === 'boolean' ? 'bool' : 'string'] };
}

/** Expression for the three-valued truth (0, 1, 2) of a validated predicate. */
export function compilePredicateExpression(predicate: GuardrailPredicate): MongoExpression {
  switch (predicate.op) {
    case 'all':
    case 'any': {
      const children = predicate.predicates.map(compilePredicateExpression);
      if (children.length === 1) return children[0];
      return predicate.op === 'all' ? { $min: children } : { $max: children };
    }
    case 'not':
      return { $subtract: [2, compilePredicateExpression(predicate.predicate)] };
    case 'compare': {
      const operator = COMPARATOR_OPERATORS[predicate.comparator];
      const left = operandExpression(predicate.left);
      const right = operandExpression(predicate.right);
      const outcome = { $cond: [{ [operator]: [left, right] }, 2, 0] };
      const guards = [
        ...(predicate.left.kind === 'constant' ? [] : [kindGuard(left, operandKind(predicate.left)!)]),
        ...(predicate.right.kind === 'constant' ? [] : [kindGuard(right, operandKind(predicate.right)!)]),
      ];
      if (!guards.length) return outcome;
      return { $cond: [guards.length === 1 ? guards[0] : { $and: guards }, outcome, 1] };
    }
    case 'receipt_valid': {
      const status = reference(`bindings.${predicate.bindingId}`);
      return {
        $switch: {
          branches: [
            { case: { $eq: [status, 'valid'] }, then: 2 },
            { case: { $eq: [status, 'invalid'] }, then: 0 },
          ],
          default: 1,
        },
      };
    }
    case 'prior_effect_count': {
      const count = reference(`prior.${predicate.toolId}`);
      const operator = COMPARATOR_OPERATORS[predicate.comparator];
      return {
        $cond: [
          { $isNumber: count },
          { $cond: [{ [operator]: [count, { $literal: predicate.count }] }, 2, 0] },
          1,
        ],
      };
    }
  }
}

function applicability(rule: GuardrailAst): MongoExpression | null {
  if (!rule.appliesTo || rule.appliesTo.length === 0) return null;
  return { $in: ['$toolId', { $literal: [...rule.appliesTo] }] };
}

/** Boolean expression: the rule governs this call and its predicate fires it (see the table in semantics.ts). */
export function compileFiredExpression(rule: GuardrailAst): MongoExpression {
  const truth = compilePredicateExpression(rule.predicate);
  const condition = rule.result === 'allow' ? { $eq: [truth, 2] } : { $gte: [truth, 1] };
  const applies = applicability(rule);
  return applies ? { $and: [applies, condition] } : condition;
}

const SEVERITY_WEIGHT = { allow: 0, ask: 1, deny: 2 } as const;

/** `{ result, ruleIds }` expressions equivalent to `decide(rules, input)`: deny > ask > allow, fired ids in rule order. */
export function compileDecisionExpression(rules: readonly GuardrailAst[]): {
  result: MongoExpression;
  ruleIds: MongoExpression;
} {
  const severity: MongoExpression = rules.length
    ? {
        $max: [
          0,
          ...rules.map((rule) => ({
            $cond: [compileFiredExpression(rule), SEVERITY_WEIGHT[rule.result], -1],
          })),
        ],
      }
    : 0;
  return {
    result: {
      $switch: {
        branches: [
          { case: { $eq: [severity, 2] }, then: 'deny' },
          { case: { $eq: [severity, 1] }, then: 'ask' },
        ],
        default: 'allow',
      },
    },
    ruleIds: {
      $concatArrays: rules.length
        ? rules.map((rule) => ({ $cond: [compileFiredExpression(rule), [{ $literal: rule.ruleId }], []] }))
        : [[]],
    },
  };
}
