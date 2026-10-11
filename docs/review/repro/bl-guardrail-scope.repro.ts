// DA-2 repro: the expert-static guardrail cannot be scoped to the tool it is named after, and the expert
// workflow declares more tool visits than the owner tool-call ceiling it is bound to.
// Exit 0 = reproduced (B1 and B2), 1 = not reproduced, 2 = error.
// Run: npx tsx docs/review/repro/bl-guardrail-scope.repro.ts
import { readFileSync } from 'node:fs';
import { validateHarnessBundle } from '@expunge/contracts';
import { OWNER_EPISODE_LIMITS, buildExpertStaticBundle } from '../../../packages/baselines/src/index.js';

const H = 'a'.repeat(64);
const hashes = { runtimeAdapterHash: H, compilerHash: H, vocabularyHash: H, authorityFloorHash: H, eligibilityPolicyHash: H, sourceEligibilityPolicyHash: H };
const out: Array<[string, boolean, string]> = [];
try {
  const expert = buildExpertStaticBundle(hashes);
  const rule = expert.guardrails.find((g) => g.ruleId === 'deny_apply_without_valid_plan')!;
  const predicateText = JSON.stringify(rule.predicate);
  // B1a: the rule's predicate names no tool, so as typed it applies to every call (inspect/resolve/discover/preview
  // run before any preview plan exists and would all be denied).
  const unscoped = !/apply|tool/i.test(predicateText);
  // B1b: the contract cannot express a tool-scoped rule: tool IDs are not an admitted constant.
  let scopedAccepted = 'accepted';
  try {
    validateHarnessBundle({ ...expert, guardrails: [{ ...rule, predicate: { op: 'all', predicates: [
      { op: 'compare', comparator: 'eq', left: { kind: 'fact', factId: 'tool.id' }, right: { kind: 'constant', value: 'apply_cleanup_batch' } },
      rule.predicate,
    ] } }] } as never);
  } catch (error) {
    scopedAccepted = `rejected (${(error as Error).message.split('\n')[0]!.slice(0, 60)})`;
  }
  out.push(['B1 expert guardrail is global; a tool-scoped form is rejected by the contract', unscoped && scopedAccepted !== 'accepted', `predicate=${predicateText}; scoped variant ${scopedAccepted}`]);

  // B2: declared workflow visits exceed the owner tool-call ceiling.
  const visits = expert.workflow.nodes.reduce((sum, n) => sum + n.maxVisits, 0);
  out.push(['B2 expert sum(maxVisits) exceeds limits.toolCalls', visits > expert.limits.toolCalls, `sum(maxVisits)=${visits} toolCalls=${expert.limits.toolCalls}`]);

  // INFO: limits labelled "from ACCEPTANCE.md" that ACCEPTANCE.md does not state.
  const acceptance = readFileSync(new URL('../../expunge/ACCEPTANCE.md', import.meta.url), 'utf8');
  const unsourced = ['graphNodes', 'graphEdges', 'maxCostMicrousd'].filter((k) => !acceptance.includes(String(OWNER_EPISODE_LIMITS[k as keyof typeof OWNER_EPISODE_LIMITS])));
  console.log(`INFO owner limits not stated in ACCEPTANCE.md: ${unsourced.map((k) => `${k}=${OWNER_EPISODE_LIMITS[k as keyof typeof OWNER_EPISODE_LIMITS]}`).join(', ')}`);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
for (const [id, ok, detail] of out) console.log(`${ok ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${id} :: ${detail}`);
process.exit(out.every(([, ok]) => ok) ? 0 : 1);
