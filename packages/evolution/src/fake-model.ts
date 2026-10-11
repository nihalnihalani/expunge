// FAKE: a deterministic, labelled test double for the proposer. It reads the packet text with keyword rules, so what
// it proposes depends only on the evidence content it was shown. That makes the trace-informed, score-only and
// wrong-incident arms measurably different without a provider. It is never evidence of model behaviour.
import type { GuardrailAst, HarnessBundle, JsonValue, MutationClass } from '@expunge/contracts';
import type { ModelProposal, ProposalRequest, EvolverModel } from './model.js';

export type FakeMode =
  | 'honest'
  | 'cite_nonexistent'
  | 'bad_shape'
  | 'always_abstain'
  | 'leak_subject'
  | 'noop_rule'
  | 'overstuffed'
  | 'claim_tightening';

type Surface = 'context' | 'guardrails' | 'workflow' | 'tool_policy';
const SURFACE_ORDER: Surface[] = ['context', 'guardrails', 'workflow', 'tool_policy'];
const KEYWORDS: Record<Surface, RegExp> = {
  context: /nested array|array copy|one hop|shallow/,
  guardrails: /without verification|false completion|claimed complete|have been removed/,
  workflow: /frontier left open|retry the discovery/,
  tool_policy: /without owner approval|unapproved|retained record deleted/,
};

export function diagnose(text: string): Surface[] {
  return SURFACE_ORDER.filter((surface) => KEYWORDS[surface].test(text.toLowerCase()));
}

const VERIFY_RULE = (evidenceId: string): GuardrailAst => ({
  ruleId: 'deny_complete_without_verification',
  predicate: {
    op: 'not',
    predicate: {
      op: 'compare',
      comparator: 'eq',
      left: { kind: 'fact', factId: 'verification_status' },
      right: { kind: 'constant', value: 'valid' },
    },
  },
  result: 'deny',
  sourceEvidenceIds: [evidenceId],
  appliesTo: ['complete_cleanup'],
});

interface Built {
  hypothesis: string;
  claimedClass: MutationClass;
  patches: Array<{
    surface: ModelProposal['patches'][number]['surface'];
    path: string;
    after: JsonValue;
    hypothesis: string;
  }>;
}
function build(surface: Surface | 'generic', parent: HarnessBundle, evidenceId: string): Built | null {
  if (surface === 'context') {
    if (parent.contextPolicy.includeNestedArrays && parent.contextPolicy.referenceDepth >= 5) return null;
    return {
      hypothesis:
        'Discovery stopped at one hop and skipped nested array fields, so a nested copy was never reached.',
      claimedClass: 'behavioral',
      patches: [
        {
          surface: 'context',
          path: 'contextPolicy.includeNestedArrays',
          after: true,
          hypothesis: 'The missed copy sat inside a nested array that the context left out.',
        },
        {
          surface: 'context',
          path: 'contextPolicy.referenceDepth',
          after: 5,
          hypothesis: 'The missed copy was more than one reference hop from the subject.',
        },
        {
          surface: 'tool_policy',
          path: 'limits.traversalDepth',
          after: 5,
          hypothesis: 'The traversal limit must allow the deeper discovery the context now asks for.',
        },
      ],
    };
  }
  if (surface === 'guardrails') {
    if (parent.guardrails.some((rule) => rule.ruleId === 'deny_complete_without_verification')) return null;
    return {
      hypothesis:
        'The run reported completion without any verification sweep, which let the missed copy through.',
      claimedClass: 'tightening',
      patches: [
        {
          surface: 'guardrails',
          path: 'guardrails.deny_complete_without_verification',
          after: VERIFY_RULE(evidenceId) as unknown as JsonValue,
          hypothesis: 'Completion must be denied until a valid verification sweep exists.',
        },
      ],
    };
  }
  if (surface === 'workflow') {
    const discover = parent.workflow.nodes.find((node) => node.id === 'discover');
    if (!discover || discover.maxVisits >= 3) return null;
    const graph = structuredClone(parent.workflow);
    graph.nodes = graph.nodes.map((node) =>
      node.id === 'discover'
        ? { ...node, maxVisits: 3, inputBindings: { ...node.inputBindings, frontier: 'discover.output' } }
        : node,
    );
    graph.edges.push({ from: 'discover', to: 'discover', when: 'more_references' });
    return {
      hypothesis:
        'A single discovery call left an open frontier; the run needs a bounded loop to keep expanding it.',
      claimedClass: 'behavioral',
      patches: [
        {
          surface: 'workflow',
          path: 'workflow',
          after: graph as unknown as JsonValue,
          hypothesis: 'Re-enter discovery while references remain, bounded by maxVisits.',
        },
      ],
    };
  }
  if (surface === 'tool_policy') {
    if (
      parent.toolPolicy.prerequisites.some(
        (p) => p.toolId === 'apply_cleanup_batch' && p.requiredArtifact === 'approval_grant',
      )
    )
      return null;
    return {
      hypothesis:
        'A retained record was changed without owner approval; apply must wait for a bound approval grant.',
      claimedClass: 'tightening',
      patches: [
        {
          surface: 'tool_policy',
          path: 'toolPolicy.prerequisites',
          after: [
            ...parent.toolPolicy.prerequisites,
            {
              toolId: 'apply_cleanup_batch',
              requiredArtifact: 'approval_grant',
              binding: 'same_job_same_plan_current_revision',
            },
          ] as unknown as JsonValue,
          hypothesis: 'Require an approval grant before any apply.',
        },
      ],
    };
  }
  // No usable diagnosis (a score-only packet): the only thing a score suggests is to spend less.
  return {
    hypothesis: 'The recorded score is poor; reduce the model-call budget to limit the cost of failing runs.',
    claimedClass: 'tightening',
    patches: [
      {
        surface: 'tool_policy',
        path: 'limits.modelCalls',
        after: Math.max(1, parent.limits.modelCalls - 4),
        hypothesis: 'Fewer model calls per episode bound the cost of a failing run.',
      },
    ],
  };
}

export function createLabeledFakeEvolverModel(mode: FakeMode = 'honest'): EvolverModel {
  return {
    id: `FAKE-deterministic-evolver:${mode}`,
    kind: 'fake',
    async propose(request: ProposalRequest): Promise<unknown> {
      if (mode === 'bad_shape') return { abstain: false, hypothesis: 5, patches: 'nope' };
      if (mode === 'always_abstain')
        return {
          abstain: true,
          reason: 'the fake always abstains',
          hypothesis: '',
          claimedClass: 'behavioral',
          patches: [],
        };
      const text = JSON.stringify(request.evidence.items);
      const matching = diagnose(text);
      const surface: Surface | 'generic' = matching.length
        ? matching[request.branchIndex % matching.length]!
        : 'generic';
      const evidenceId =
        request.evidence.citableIds.find((id) => id.startsWith('evt')) ?? request.evidence.citableIds[0]!;
      const built = build(surface, request.parent, evidenceId);
      if (!built)
        return {
          abstain: true,
          reason: 'the evidence supports no new edit on this surface',
          hypothesis: '',
          claimedClass: 'behavioral',
          patches: [],
        };
      const cite = mode === 'cite_nonexistent' ? ['evt_does_not_exist'] : [evidenceId];
      let patches = built.patches.map((patch) => ({ ...patch, sourceEvidenceIds: cite }));
      if (mode === 'leak_subject') {
        patches = patches.map((patch) => ({
          ...patch,
          hypothesis: `${patch.hypothesis} See syn_subject_0123456789abcdef0123.`,
        }));
      }
      if (mode === 'noop_rule') {
        const never = {
          ...VERIFY_RULE(evidenceId),
          ruleId: 'deny_when_retry_huge',
          predicate: {
            op: 'compare',
            comparator: 'gt',
            left: { kind: 'fact', factId: 'retry_count' },
            right: { kind: 'constant', value: 100 },
          },
        };
        patches = [
          {
            surface: 'guardrails',
            path: 'guardrails.deny_when_retry_huge',
            after: never as unknown as JsonValue,
            hypothesis: 'A guard for runaway retries.',
            sourceEvidenceIds: cite,
          },
        ];
      }
      if (mode === 'overstuffed') {
        patches = [
          ...patches,
          {
            surface: 'tool_policy',
            path: 'limits.toolCalls',
            after: 11,
            hypothesis: 'Shave one tool call off the budget.',
            sourceEvidenceIds: cite,
          },
          {
            surface: 'tool_policy',
            path: 'limits.wallTimeMs',
            after: 100000,
            hypothesis: 'Shorten the wall clock a little.',
            sourceEvidenceIds: cite,
          },
          {
            surface: 'tool_policy',
            path: 'limits.totalTokens',
            after: 20000,
            hypothesis: 'Trim the token allowance a little.',
            sourceEvidenceIds: cite,
          },
        ];
      }
      return {
        abstain: false,
        hypothesis: built.hypothesis,
        claimedClass: mode === 'claim_tightening' ? 'tightening' : built.claimedClass,
        patches,
      };
    },
  };
}
