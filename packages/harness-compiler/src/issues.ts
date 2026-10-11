/** Stable rejection vocabulary. The compiler reports codes and paths, never echoes caller-supplied text. */
export const REJECTION_CODES = [
  // structure and identity
  'schema_invalid',
  'infrastructure_hash_mismatch',
  'parent_hash_mismatch',
  'immutable_field_changed',
  'identifier_format',
  // guardrails
  'rule_id_duplicate',
  'inert_allow_rule',
  'applies_to_unknown_tool',
  'applies_to_duplicate',
  'guardrail_depth',
  'guardrail_nodes',
  'unknown_fact',
  'unknown_binding',
  'unknown_tool',
  'operand_type_mismatch',
  'comparator_not_allowed',
  'constant_out_of_domain',
  'constant_predicate',
  'unscoped_artifact_rule',
  // workflow
  'workflow_reference_invalid',
  'workflow_tool_not_granted',
  'workflow_duplicate_transition',
  'workflow_unreachable_node',
  'workflow_terminal_unreachable',
  'workflow_dead_end',
  'workflow_unbounded_loop',
  'workflow_graph_limit',
  'workflow_visit_budget',
  'workflow_forbidden_route',
  'workflow_input_binding_invalid',
  // tool policy and limits
  'duplicate_grant',
  'floor_violation',
  'duplicate_prerequisite',
  'prerequisite_deadlock',
  'prerequisite_unsatisfiable',
  'limits_exceed_owner',
  'limits_degenerate',
  'context_exceeds_limits',
  // edits, evidence and classification
  'no_change',
  'patch_path_invalid',
  'patch_path_duplicate',
  'patch_surface_mismatch',
  'patch_before_mismatch',
  'patch_after_mismatch',
  'no_op_patch',
  'unexplained_change',
  'edit_budget_exceeded',
  'hypothesis_missing',
  'evidence_missing',
  'evidence_not_found',
  'evidence_not_permitted',
  'evidence_not_in_bundle',
  'authority_expansion_unflagged',
  // literals, shortcuts, plugins, replay
  'subject_literal',
  'task_literal',
  'hidden_test_shortcut',
  'plugin_unverifiable',
  'plugin_source_compiled_mismatch',
  'plugin_abi_mismatch',
  'replay_corpus_missing',
  'no_op_rule',
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface Issue {
  code: RejectionCode;
  /** Where in the bundle or patch set: a dotted path built from vocabulary names and indexes only. */
  path: string;
  /** Short fixed description; never contains bundle text, so a rejection cannot echo a literal. */
  message: string;
}
export const issue = (code: RejectionCode, path: string, message: string): Issue => ({ code, path, message });
