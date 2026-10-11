// TEST-ONLY seeded generators for parity corpora. Deterministic (mulberry32): a failure reproduces from its seed.
import { BINDING_IDS, FACT_CATALOG, WORKER_TOOL_IDS } from '@expunge/baselines';
import type { FactOperand, GuardrailAst, GuardrailPredicate } from '@expunge/contracts';
import type { DecisionInput } from '../src/index.js';

export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const int = (random: Random, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));

const NUMBER_FACTS = FACT_CATALOG.filter((fact) => fact.type.kind === 'number');
const BOOLEAN_FACTS = FACT_CATALOG.filter((fact) => fact.type.kind === 'boolean');
const ENUM_FACTS = FACT_CATALOG.filter((fact) => fact.type.kind === 'enum');
const COMPARATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
const EQUALITY = ['eq', 'ne'] as const;

function leaf(random: Random): GuardrailPredicate {
  const kind = int(random, 0, 5);
  if (kind === 0) {
    const fact = pick(random, NUMBER_FACTS);
    const right: FactOperand =
      random() < 0.3
        ? { kind: 'fact', factId: pick(random, NUMBER_FACTS).id }
        : { kind: 'constant', value: int(random, 0, 5) };
    return {
      op: 'compare',
      comparator: pick(random, COMPARATORS),
      left: { kind: 'fact', factId: fact.id },
      right,
    };
  }
  if (kind === 1) {
    return {
      op: 'compare',
      comparator: pick(random, EQUALITY),
      left: { kind: 'fact', factId: pick(random, BOOLEAN_FACTS).id },
      right: { kind: 'constant', value: random() < 0.5 },
    };
  }
  if (kind === 2) {
    const fact = pick(random, ENUM_FACTS);
    const domain = fact.type.kind === 'enum' ? fact.type.values : [];
    const left: FactOperand = { kind: 'fact', factId: fact.id };
    const right: FactOperand = { kind: 'constant', value: pick(random, domain) as never };
    const swap = random() < 0.2;
    return {
      op: 'compare',
      comparator: pick(random, EQUALITY),
      left: swap ? right : left,
      right: swap ? left : right,
    };
  }
  if (kind === 3) {
    return {
      op: 'compare',
      comparator: pick(random, EQUALITY),
      left: { kind: 'binding', bindingId: pick(random, BINDING_IDS) },
      right: { kind: 'constant', value: random() < 0.5 ? 'valid' : 'invalid' },
    };
  }
  if (kind === 4) return { op: 'receipt_valid', bindingId: pick(random, BINDING_IDS) };
  return {
    op: 'prior_effect_count',
    toolId: pick(random, WORKER_TOOL_IDS),
    comparator: pick(random, ['eq', 'lt', 'lte', 'gt', 'gte'] as const),
    count: int(random, 0, 3),
  };
}

export function randomPredicate(random: Random, depth = 3): GuardrailPredicate {
  if (depth <= 0 || random() < 0.3) return leaf(random);
  const kind = int(random, 0, 2);
  if (kind === 0) return { op: 'not', predicate: randomPredicate(random, depth - 1) };
  const predicates = Array.from({ length: int(random, 1, 3) }, () => randomPredicate(random, depth - 1));
  return { op: kind === 1 ? 'all' : 'any', predicates };
}

/** A fact value: mostly valid for its type, often null or missing, sometimes of the wrong type. */
function factValue(random: Random, type: (typeof FACT_CATALOG)[number]['type']): unknown {
  const roll = random();
  if (roll < 0.1) return null;
  if (roll < 0.2) return undefined;
  if (roll < 0.34) return pick(random, ['three', true, 7, [1]]);
  if (type.kind === 'number') return random() < 0.2 ? int(random, 0, 10) + 0.5 : int(random, 0, 6);
  if (type.kind === 'boolean') return random() < 0.5;
  return pick(random, type.values);
}
export function randomInput(random: Random): DecisionInput {
  const facts: Record<string, unknown> = {};
  for (const fact of FACT_CATALOG) {
    const value = factValue(random, fact.type);
    if (value !== undefined) facts[fact.id] = value;
  }
  const bindings: Record<string, unknown> = {};
  for (const bindingId of BINDING_IDS) {
    const value = pick(random, ['valid', 'invalid', 'valid', 'invalid', null, undefined, 'bogus', 1]);
    if (value !== undefined) bindings[bindingId] = value;
  }
  const prior: Record<string, unknown> = {};
  for (const toolId of WORKER_TOOL_IDS) {
    const value = pick(random, [0, 1, 2, 3, 4, null, undefined, 'x']);
    if (value !== undefined) prior[toolId] = value;
  }
  return { toolId: pick(random, WORKER_TOOL_IDS), facts, bindings, prior };
}
export function randomRules(random: Random): GuardrailAst[] {
  return Array.from({ length: int(random, 0, 4) }, (_, index) => ({
    ruleId: `generated_rule_${index}`,
    predicate: randomPredicate(random, 2),
    result: pick(random, ['deny', 'ask', 'allow'] as const),
    sourceEvidenceIds: [],
    ...(random() < 0.5
      ? {
          appliesTo: Array.from(
            new Set(Array.from({ length: int(random, 1, 3) }, () => pick(random, WORKER_TOOL_IDS))),
          ),
        }
      : {}),
  }));
}
