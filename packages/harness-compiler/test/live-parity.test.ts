// LIVE parity: the same predicates and fact sets evaluated by a real MongoDB server (aggregation `$documents`, no
// collection and no credentials of the project) and by the TypeScript evaluator. Skipped unless
// MONGODB_PARITY_URI points at a throwaway local mongod; the skip reason is printed, never silent.
import { describe, expect, it } from 'vitest';
import {
  compileDecisionExpression,
  compilePredicateExpression,
  decide,
  evaluatePredicate,
} from '../src/index.js';
import { randomInput, randomPredicate, randomRules, rng } from './generators.js';

const uri = process.env.MONGODB_PARITY_URI;
if (!uri)
  console.warn('[live-parity] skipped: MONGODB_PARITY_URI is not set (needs a throwaway local mongod)');

const toDocument = (input: ReturnType<typeof randomInput>) => ({
  toolId: input.toolId,
  facts: input.facts,
  bindings: input.bindings,
  prior: input.prior,
});

describe.skipIf(!uri)('live MongoDB parity', () => {
  async function withDb<T>(
    use: (
      aggregate: (documents: object[], addFields: object) => Promise<Array<Record<string, unknown>>>,
    ) => Promise<T>,
  ): Promise<T> {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri!, { serverSelectionTimeoutMS: 5000 });
    try {
      await client.connect();
      const db = client.db('c2_parity');
      return await use((documents, addFields) =>
        db.aggregate([{ $documents: documents }, { $addFields: addFields }]).toArray(),
      );
    } finally {
      await client.close();
    }
  }

  it('the server evaluates 300 generated predicates over 3,600 fact sets exactly as the TypeScript evaluator does', async () => {
    const random = rng(20261011);
    let compared = 0;
    await withDb(async (aggregate) => {
      for (let n = 0; n < 300; n++) {
        const predicate = randomPredicate(random, 4);
        const inputs = Array.from({ length: 12 }, () => randomInput(random));
        const rows = await aggregate(inputs.map(toDocument), {
          truth: compilePredicateExpression(predicate),
        });
        expect(rows).toHaveLength(inputs.length);
        rows.forEach((row, index) => {
          expect(row.truth, `predicate #${n} input #${index}`).toBe(
            evaluatePredicate(predicate, inputs[index]!),
          );
          compared++;
        });
      }
    });
    expect(compared).toBe(3600);
  }, 120_000);

  it('the server computes the same merged decision and fired rule ids for 100 generated rule sets', async () => {
    const random = rng(7);
    let compared = 0;
    await withDb(async (aggregate) => {
      for (let n = 0; n < 100; n++) {
        const rules = randomRules(random);
        const inputs = Array.from({ length: 12 }, () => randomInput(random));
        const expression = compileDecisionExpression(rules);
        const rows = await aggregate(inputs.map(toDocument), {
          result: expression.result,
          ruleIds: expression.ruleIds,
        });
        rows.forEach((row, index) => {
          const { decision } = decide(rules, inputs[index]!);
          expect(row.result, `rules #${n} input #${index}`).toBe(decision.result);
          expect(row.ruleIds).toEqual(decision.ruleIds);
          compared++;
        });
      }
    });
    expect(compared).toBe(1200);
  }, 120_000);
});
