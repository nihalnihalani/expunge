// One semantics for guardrail predicates, shared by the TypeScript evaluator below and the MongoDB expressions in
// `mongo.ts` (parity-tested on generated corpora).
//
// Three-valued logic. A null or missing operand makes a comparison UNKNOWN; so does a value of the wrong type. The
// connectives are Kleene's strong ones, which are min, max and complement on the chain false < unknown < true.
// A rule FIRES when its predicate is true, or when it is unknown and the rule is restrictive (deny or ask); an
// allow rule fires only on true and, since allow is the default, never changes a decision. This is the documented
// null/missing table:
//
//   predicate      | deny / ask rule | allow rule
//   true           | fires           | fires (inert)
//   unknown        | fires (closed)  | does not fire
//   false          | does not fire   | does not fire
//
// Facts must be canonical JSON: NaN and the infinities never occur, and a non-finite number is unknown here.
import type { FactOperand, GuardrailAst, GuardrailPredicate, PolicyDecision } from '@expunge/contracts';
import { appliesToTool } from '@expunge/baselines';
import { FACTS_BY_ID } from './vocabulary.js';

export const TRI_FALSE = 0 as const;
export const TRI_UNKNOWN = 1 as const;
export const TRI_TRUE = 2 as const;
export type Tri = typeof TRI_FALSE | typeof TRI_UNKNOWN | typeof TRI_TRUE;

/** What the trusted gateway knows when it decides one call. The model never supplies any of it. */
export interface DecisionInput {
  /** The worker tool being decided; `appliesTo` scoping is evaluated against it. */
  toolId: string;
  facts: Readonly<Record<string, unknown>>;
  /** Status of each receipt/artifact binding: 'valid' | 'invalid' | null. */
  bindings: Readonly<Record<string, unknown>>;
  /** Committed effects per tool so far. */
  prior: Readonly<Record<string, unknown>>;
}

type ValueKind = 'number' | 'boolean' | 'string';
const KIND_OF_TYPE = { number: 'number', boolean: 'boolean', enum: 'string' } as const;

/** Statically expected runtime kind of one operand; null when the operand names something outside the vocabulary. */
export function operandKind(operand: FactOperand): ValueKind | null {
  if (operand.kind === 'fact') {
    const fact = FACTS_BY_ID.get(operand.factId);
    return fact ? KIND_OF_TYPE[fact.type.kind] : null;
  }
  if (operand.kind === 'binding') return 'string';
  return typeof operand.value === 'number'
    ? 'number'
    : typeof operand.value === 'boolean'
      ? 'boolean'
      : 'string';
}

function valueOf(operand: FactOperand, input: DecisionInput): unknown {
  if (operand.kind === 'constant') return operand.value;
  const source = operand.kind === 'fact' ? input.facts[operand.factId] : input.bindings[operand.bindingId];
  return source === undefined ? null : source;
}
function hasKind(value: unknown, kind: ValueKind): boolean {
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === kind;
}
function compareValues(comparator: string, left: unknown, right: unknown): boolean {
  switch (comparator) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'lt':
      return (left as number) < (right as number);
    case 'lte':
      return (left as number) <= (right as number);
    case 'gt':
      return (left as number) > (right as number);
    case 'gte':
      return (left as number) >= (right as number);
    default:
      throw new Error('UnknownComparator');
  }
}

/** Evaluates a predicate that the compiler has already validated. Never throws on bad facts: they are unknown. */
export function evaluatePredicate(predicate: GuardrailPredicate, input: DecisionInput): Tri {
  switch (predicate.op) {
    case 'all':
      return Math.min(...predicate.predicates.map((child) => evaluatePredicate(child, input))) as Tri;
    case 'any':
      return Math.max(...predicate.predicates.map((child) => evaluatePredicate(child, input))) as Tri;
    case 'not':
      return (2 - evaluatePredicate(predicate.predicate, input)) as Tri;
    case 'compare': {
      const kinds = [operandKind(predicate.left), operandKind(predicate.right)];
      const left = valueOf(predicate.left, input);
      const right = valueOf(predicate.right, input);
      // Constants are typed by construction; only fact and binding values need a runtime kind check.
      if (kinds[0] === null || kinds[1] === null) return TRI_UNKNOWN;
      if (!hasKind(left, kinds[0]) || !hasKind(right, kinds[1])) return TRI_UNKNOWN;
      return compareValues(predicate.comparator, left, right) ? TRI_TRUE : TRI_FALSE;
    }
    case 'receipt_valid': {
      const status = input.bindings[predicate.bindingId];
      if (status === 'valid') return TRI_TRUE;
      if (status === 'invalid') return TRI_FALSE;
      return TRI_UNKNOWN;
    }
    case 'prior_effect_count': {
      const count = input.prior[predicate.toolId];
      if (!hasKind(count, 'number')) return TRI_UNKNOWN;
      return compareValues(predicate.comparator, count, predicate.count) ? TRI_TRUE : TRI_FALSE;
    }
  }
}

export const SEVERITY = { allow: 0, ask: 1, deny: 2 } as const;
export type Severity = keyof typeof SEVERITY;

/** True when the rule governs the tool being decided (the rule shared with the baselines helper). */
export function ruleApplies(rule: Pick<GuardrailAst, 'appliesTo'>, toolId: string): boolean {
  return appliesToTool(rule, toolId);
}

export function ruleFires(result: Severity, tri: Tri): boolean {
  if (tri === TRI_TRUE) return true;
  return tri === TRI_UNKNOWN && result !== 'allow';
}

export interface RuleOutcome {
  ruleId: string;
  applies: boolean;
  tri: Tri;
  fired: boolean;
}
/**
 * The policy decision for one call: every applicable rule is evaluated, the fired ones are merged by severity
 * (deny > ask > allow) and no fired rule means allow. `authorizationRevision` is the gateway's, not the rules'.
 */
export function decide(
  rules: readonly GuardrailAst[],
  input: DecisionInput,
  authorizationRevision = 0,
): { decision: PolicyDecision; outcomes: RuleOutcome[] } {
  const outcomes: RuleOutcome[] = rules.map((rule) => {
    const applies = ruleApplies(rule, input.toolId);
    const tri = applies ? evaluatePredicate(rule.predicate, input) : TRI_FALSE;
    return { ruleId: rule.ruleId, applies, tri, fired: applies && ruleFires(rule.result, tri) };
  });
  let worst = 0;
  const ruleIds: string[] = [];
  outcomes.forEach((outcome, index) => {
    if (!outcome.fired) return;
    ruleIds.push(outcome.ruleId);
    worst = Math.max(worst, SEVERITY[rules[index]!.result]);
  });
  const result = (Object.keys(SEVERITY) as Severity[]).find((name) => SEVERITY[name] === worst)!;
  return { decision: { result, ruleIds, authorizationRevision }, outcomes };
}

/** Walks every node of a predicate (pre-order). */
export function walkPredicate(
  predicate: GuardrailPredicate,
  visit: (node: GuardrailPredicate, depth: number) => void,
  depth = 0,
): void {
  visit(predicate, depth);
  if (predicate.op === 'all' || predicate.op === 'any') {
    for (const child of predicate.predicates) walkPredicate(child, visit, depth + 1);
  } else if (predicate.op === 'not') {
    walkPredicate(predicate.predicate, visit, depth + 1);
  }
}
