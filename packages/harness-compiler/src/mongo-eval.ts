// Interpreter for exactly the aggregation operators `mongo.ts` may emit, with MongoDB's semantics for the value
// types involved (numbers, booleans, strings, null, arrays). It lets a replay or a test evaluate a compiled
// expression without a database; a live-database parity run is the check that this interpreter is faithful.
import { MONGO_OPERATOR_WHITELIST, type MongoExpression } from './mongo.js';

type Document = Record<string, unknown>;

const truthy = (value: unknown): boolean =>
  !(value === false || value === null || value === undefined || value === 0);

function lookup(path: string, root: Document): unknown {
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return undefined;
    cursor = (cursor as Document)[part];
  }
  return cursor;
}
const typeName = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'missing';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  return Array.isArray(value) ? 'array' : 'object';
};

export function evaluateMongoExpression(expression: MongoExpression, root: Document): unknown {
  if (typeof expression === 'string')
    return expression.startsWith('$') ? lookup(expression.slice(1), root) : expression;
  if (Array.isArray(expression)) return expression.map((item) => evaluateMongoExpression(item, root));
  if (expression === null || typeof expression !== 'object') return expression;
  const entries = Object.entries(expression as Document);
  if (entries.length !== 1 || !MONGO_OPERATOR_WHITELIST.has(entries[0]![0]))
    throw new Error('UnsupportedMongoExpression');
  const [operator, operand] = entries[0]!;
  const evaluate = (item: unknown): unknown => evaluateMongoExpression(item, root);
  const args = (): unknown[] => (operand as unknown[]).map(evaluate);
  /** Single-operand operators accept the expression bare or wrapped in a one-element list. */
  const single = (): unknown => evaluate(Array.isArray(operand) ? operand[0] : operand);
  switch (operator) {
    case '$literal':
      return operand;
    case '$ifNull': {
      const [value, replacement] = args();
      return value === null || value === undefined ? replacement : value;
    }
    case '$cond': {
      const [condition, then, otherwise] = operand as unknown[];
      return truthy(evaluate(condition)) ? evaluate(then) : evaluate(otherwise);
    }
    case '$eq':
    case '$ne':
    case '$lt':
    case '$lte':
    case '$gt':
    case '$gte': {
      const [left, right] = args();
      if (operator === '$eq') return left === right;
      if (operator === '$ne') return left !== right;
      // Cross-type comparison follows BSON type order in MongoDB; the compiler's kind guards make it unreachable.
      if (typeof left !== typeof right) throw new Error('CrossTypeComparison');
      const a = left as number;
      const b = right as number;
      return operator === '$lt' ? a < b : operator === '$lte' ? a <= b : operator === '$gt' ? a > b : a >= b;
    }
    case '$and':
      return args().every(truthy);
    case '$min':
      return Math.min(...(args() as number[]));
    case '$max':
      return Math.max(...(args() as number[]));
    case '$subtract': {
      const [a, b] = args() as number[];
      return a! - b!;
    }
    case '$isNumber':
      return typeof single() === 'number';
    case '$type':
      return typeName(single());
    case '$in': {
      const [value, list] = args();
      return (list as unknown[]).includes(value);
    }
    case '$concatArrays':
      return (args() as unknown[][]).flat();
    case '$switch': {
      const { branches, default: fallback } = operand as {
        branches: Array<{ case: unknown; then: unknown }>;
        default: unknown;
      };
      for (const branch of branches) if (truthy(evaluate(branch.case))) return evaluate(branch.then);
      return evaluate(fallback);
    }
    default:
      throw new Error('UnsupportedMongoOperator');
  }
}
