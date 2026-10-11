import type { FactOperand, GuardrailAst, GuardrailPredicate } from '@expunge/contracts';
import { GUARDRAIL_MAX_DEPTH, GUARDRAIL_MAX_NODES } from '@expunge/contracts';
import { issue, type Issue } from './issues.js';
import {
  compileFiredExpression,
  compilePredicateExpression,
  assertSafeMongoExpression,
  type MongoExpression,
} from './mongo.js';
import {
  decide,
  evaluatePredicate,
  ruleApplies,
  ruleFires,
  walkPredicate,
  type DecisionInput,
  type Tri,
} from './semantics.js';
import {
  BINDING_ID_SET,
  BINDING_STATUS_VALUES,
  FACTS_BY_ID,
  IDENTIFIER_FORMAT,
  TOOL_ID_SET,
  comparatorsFor,
  sameEnumDomain,
  type OperandType,
} from './vocabulary.js';

/** Static type of an operand. A constant string is typed only by membership in the other side's enum domain. */
type Typed =
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'enum-constant'; value: string };

function typeOf(operand: FactOperand, path: string, issues: Issue[]): Typed | null {
  if (operand.kind === 'fact') {
    const fact = FACTS_BY_ID.get(operand.factId);
    if (!fact) {
      issues.push(issue('unknown_fact', path, 'fact is not in the vocabulary'));
      return null;
    }
    return fact.type;
  }
  if (operand.kind === 'binding') {
    if (!BINDING_ID_SET.has(operand.bindingId)) {
      issues.push(issue('unknown_binding', path, 'binding is not in the vocabulary'));
      return null;
    }
    return { kind: 'enum', values: BINDING_STATUS_VALUES };
  }
  if (typeof operand.value === 'number') return { kind: 'number' };
  if (typeof operand.value === 'boolean') return { kind: 'boolean' };
  return { kind: 'enum-constant', value: operand.value };
}

function checkCompare(
  predicate: Extract<GuardrailPredicate, { op: 'compare' }>,
  path: string,
  issues: Issue[],
): void {
  const left = typeOf(predicate.left, `${path}.left`, issues);
  const right = typeOf(predicate.right, `${path}.right`, issues);
  if (!left || !right) return;
  let operandType: OperandType | null = null;
  if (left.kind === 'number' && right.kind === 'number') operandType = left;
  else if (left.kind === 'boolean' && right.kind === 'boolean') operandType = left;
  else if (left.kind === 'enum' && right.kind === 'enum') {
    if (sameEnumDomain(left.values, right.values)) operandType = left;
  } else if (left.kind === 'enum' && right.kind === 'enum-constant') {
    if (left.values.includes(right.value)) operandType = left;
    else {
      issues.push(
        issue('constant_out_of_domain', `${path}.right`, 'constant is not a member of the fact domain'),
      );
      return;
    }
  } else if (left.kind === 'enum-constant' && right.kind === 'enum') {
    if (right.values.includes(left.value)) operandType = right;
    else {
      issues.push(
        issue('constant_out_of_domain', `${path}.left`, 'constant is not a member of the fact domain'),
      );
      return;
    }
  }
  if (!operandType) {
    issues.push(issue('operand_type_mismatch', path, 'operands have incompatible types'));
    return;
  }
  if (!comparatorsFor(operandType).includes(predicate.comparator)) {
    issues.push(issue('comparator_not_allowed', path, 'comparator is not admitted for this operand type'));
  }
}

/** True when the predicate reads a value the gateway may not have: a nullable fact, a binding or prior effects. */
export function dependsOnArtifacts(predicate: GuardrailPredicate): boolean {
  let depends = false;
  walkPredicate(predicate, (node) => {
    if (node.op === 'receipt_valid' || node.op === 'prior_effect_count') depends = true;
    if (node.op === 'compare') {
      for (const operand of [node.left, node.right]) {
        if (operand.kind === 'binding') depends = true;
        if (operand.kind === 'fact' && FACTS_BY_ID.get(operand.factId)?.nullable) depends = true;
      }
    }
  });
  return depends;
}

/** True when at least one leaf reads a fact, binding or prior-effect count (a predicate of constants is degenerate). */
function readsVariables(predicate: GuardrailPredicate): boolean {
  let reads = false;
  walkPredicate(predicate, (node) => {
    if (node.op === 'receipt_valid' || node.op === 'prior_effect_count') reads = true;
    if (node.op === 'compare' && (node.left.kind !== 'constant' || node.right.kind !== 'constant'))
      reads = true;
  });
  return reads;
}

/** Static validation of every guardrail rule against the vocabulary. Collects all issues. */
export function validateGuardrails(rules: readonly GuardrailAst[]): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  let totalNodes = 0;
  rules.forEach((rule, index) => {
    const where = `guardrails[${index}]`;
    if (!IDENTIFIER_FORMAT.test(rule.ruleId))
      issues.push(issue('identifier_format', `${where}.ruleId`, 'rule id is not a lowercase identifier'));
    if (seen.has(rule.ruleId))
      issues.push(issue('rule_id_duplicate', `${where}.ruleId`, 'rule id is used twice'));
    seen.add(rule.ruleId);
    // The default is allow and fired rules merge by maximum severity, so an allow rule can never change a decision.
    if (rule.result === 'allow')
      issues.push(issue('inert_allow_rule', where, 'an allow rule cannot change any decision'));
    if (rule.appliesTo) {
      if (new Set(rule.appliesTo).size !== rule.appliesTo.length)
        issues.push(issue('applies_to_duplicate', `${where}.appliesTo`, 'tool listed twice'));
      rule.appliesTo.forEach((toolId, toolIndex) => {
        if (!TOOL_ID_SET.has(toolId))
          issues.push(
            issue(
              'applies_to_unknown_tool',
              `${where}.appliesTo[${toolIndex}]`,
              'tool is not in the vocabulary',
            ),
          );
      });
    }
    let depthExceeded = false;
    walkPredicate(rule.predicate, (node, depth) => {
      totalNodes++;
      if (depth > GUARDRAIL_MAX_DEPTH) depthExceeded = true;
      if (node.op === 'compare') checkCompare(node, `${where}.predicate`, issues);
      if (node.op === 'receipt_valid' && !BINDING_ID_SET.has(node.bindingId)) {
        issues.push(issue('unknown_binding', `${where}.predicate`, 'binding is not in the vocabulary'));
      }
      if (node.op === 'prior_effect_count' && !TOOL_ID_SET.has(node.toolId)) {
        issues.push(issue('unknown_tool', `${where}.predicate`, 'tool is not in the vocabulary'));
      }
    });
    if (depthExceeded)
      issues.push(issue('guardrail_depth', `${where}.predicate`, 'predicate is nested too deeply'));
    if (!readsVariables(rule.predicate))
      issues.push(
        issue('constant_predicate', `${where}.predicate`, 'predicate reads no fact, binding or effect count'),
      );
    // A restrictive rule over a value that does not exist yet fires on every earlier call: scope it to a tool.
    if (
      rule.result !== 'allow' &&
      (!rule.appliesTo || rule.appliesTo.length === 0) &&
      dependsOnArtifacts(rule.predicate)
    ) {
      issues.push(
        issue(
          'unscoped_artifact_rule',
          where,
          'a restrictive rule over receipts, effects or nullable facts must set appliesTo',
        ),
      );
    }
  });
  if (totalNodes > GUARDRAIL_MAX_NODES)
    issues.push(issue('guardrail_nodes', 'guardrails', 'too many predicate nodes'));
  return issues;
}

export interface CompiledRule {
  ruleId: string;
  result: GuardrailAst['result'];
  appliesTo: readonly string[];
  sourceEvidenceIds: readonly string[];
  /** Three-valued truth expression (0, 1, 2) over `{ toolId, facts, bindings, prior }`. */
  mongoTruth: MongoExpression;
  /** Boolean expression: governs this tool and fires. */
  mongoFired: MongoExpression;
  evaluate(input: DecisionInput): Tri;
  fires(input: DecisionInput): boolean;
}

/** Compiles validated rules. Throws if an emitted expression leaves the operator whitelist (a compiler defect). */
export function compileGuardrails(rules: readonly GuardrailAst[]): CompiledRule[] {
  return rules.map((rule) => {
    const mongoTruth = compilePredicateExpression(rule.predicate);
    const mongoFired = compileFiredExpression(rule);
    assertSafeMongoExpression(mongoTruth);
    assertSafeMongoExpression(mongoFired);
    return {
      ruleId: rule.ruleId,
      result: rule.result,
      appliesTo: [...(rule.appliesTo ?? [])],
      sourceEvidenceIds: [...rule.sourceEvidenceIds],
      mongoTruth,
      mongoFired,
      evaluate: (input) => evaluatePredicate(rule.predicate, input),
      fires: (input) =>
        ruleApplies(rule, input.toolId) && ruleFires(rule.result, evaluatePredicate(rule.predicate, input)),
    };
  });
}

export { decide };
