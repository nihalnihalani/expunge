// DA-2 repro: the expert-static guardrail must be scoped to apply_cleanup_batch (checked through `appliesTo` and the
// compiler's `decide`), and the expert workflow must not declare more tool visits than its tool-call ceiling.
// Exit 0 = reproduced (B1 and B2), 1 = not reproduced, 2 = error.
// Run: npx tsx docs/review/repro/bl-guardrail-scope.repro.ts
import { readFileSync } from 'node:fs';
import { decide } from '../../../packages/harness-compiler/src/index.js';
import {
  OWNER_EPISODE_LIMITS,
  WORKER_TOOL_IDS,
  appliesToTool,
  buildExpertStaticBundle,
} from '../../../packages/baselines/src/index.js';

const H = 'a'.repeat(64);
const hashes = {
  runtimeAdapterHash: H,
  compilerHash: H,
  vocabularyHash: H,
  authorityFloorHash: H,
  eligibilityPolicyHash: H,
  sourceEligibilityPolicyHash: H,
};
const out: Array<[string, boolean, string]> = [];
try {
  const expert = buildExpertStaticBundle(hashes);
  const rule = expert.guardrails.find((g) => g.ruleId === 'deny_apply_without_valid_plan')!;
  // B1 (updated for the `appliesTo` scope the owner added): the rule must apply to apply_cleanup_batch only, and
  // the compiler's decision procedure must deny no other tool, whatever the preview_plan binding status.
  const scopedTo = WORKER_TOOL_IDS.filter((toolId) => appliesToTool(rule, toolId));
  const deniedElsewhere: string[] = [];
  for (const toolId of WORKER_TOOL_IDS)
    for (const status of [null, 'invalid', 'valid']) {
      const { decision } = decide([rule], {
        toolId,
        facts: {},
        bindings: { preview_plan: status },
        prior: {},
      });
      if (decision.result === 'deny' && toolId !== 'apply_cleanup_batch')
        deniedElsewhere.push(`${toolId}/${String(status)}`);
    }
  const global = scopedTo.length !== 1 || scopedTo[0] !== 'apply_cleanup_batch' || deniedElsewhere.length > 0;
  out.push([
    'B1 expert guardrail applies beyond apply_cleanup_batch',
    global,
    `appliesTo=${JSON.stringify(scopedTo)}; denied for other tools=${JSON.stringify(deniedElsewhere)}`,
  ]);

  // B2: declared workflow visits exceed the owner tool-call ceiling.
  const visits = expert.workflow.nodes.reduce((sum, n) => sum + n.maxVisits, 0);
  out.push([
    'B2 expert sum(maxVisits) exceeds limits.toolCalls',
    visits > expert.limits.toolCalls,
    `sum(maxVisits)=${visits} toolCalls=${expert.limits.toolCalls}`,
  ]);

  // INFO: limits labelled "from ACCEPTANCE.md" that ACCEPTANCE.md does not state.
  const acceptance = readFileSync(new URL('../../expunge/ACCEPTANCE.md', import.meta.url), 'utf8');
  const unsourced = ['graphNodes', 'graphEdges', 'maxCostMicrousd'].filter(
    (k) => !acceptance.includes(String(OWNER_EPISODE_LIMITS[k as keyof typeof OWNER_EPISODE_LIMITS])),
  );
  console.log(
    `INFO owner limits not stated in ACCEPTANCE.md: ${unsourced.map((k) => `${k}=${OWNER_EPISODE_LIMITS[k as keyof typeof OWNER_EPISODE_LIMITS]}`).join(', ')}`,
  );
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
for (const [id, ok, detail] of out)
  console.log(`${ok ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${id} :: ${detail}`);
process.exit(out.every(([, ok]) => ok) ? 0 : 1);
