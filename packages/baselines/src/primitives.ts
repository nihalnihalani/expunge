// Human-authored primitive vocabulary of the harness search space (spec section 9), disclosed in one place.
//
// The trusted compiler (`@expunge/harness-compiler`) enforces exactly this vocabulary and hashes its source bytes
// into `vocabularyHash`. The gateway builds the guardrail facts below at decision time; a model never supplies
// them. A rule names the tool calls it governs with `appliesTo` (worker tool IDs); constants are numbers,
// booleans and the status enums in the contract only, so a tool ID is never an operand.

/** The nine worker tool IDs frozen in docs/continuity/OWNERSHIP.md item 6. */
export const WORKER_TOOL_IDS = [
  'inspect_scope',
  'resolve_subject',
  'discover_references',
  'preview_cleanup',
  'apply_cleanup_batch',
  'verify_registered_scope',
  'complete_cleanup',
  'inspect_harness',
  'report_diagnostic',
] as const;
export type WorkerToolId = (typeof WORKER_TOOL_IDS)[number];

export type FactType = { kind: 'number' } | { kind: 'boolean' } | { kind: 'enum'; values: readonly string[] };
export interface FactSpec {
  id: string;
  type: FactType;
  /** True when the gateway may legitimately have no value (never discovered, never verified, no batch). */
  nullable: boolean;
  description: string;
}

const BATCH_EFFECT_KINDS = ['delete', 'redact', 'restrict', 'tombstone'] as const;
const STATUS = ['valid', 'invalid'] as const;

/**
 * Facts the trusted gateway builds from committed job state before every tool decision. A null value means
 * "not known at decision time"; the compiler's three-valued semantics treat that as unknown, never as zero.
 */
export const FACT_CATALOG: readonly FactSpec[] = [
  {
    id: 'plan_target_count',
    type: { kind: 'number' },
    nullable: true,
    description: 'Targets in the bound preview plan.',
  },
  {
    id: 'batch_document_count',
    type: { kind: 'number' },
    nullable: true,
    description: 'Documents in the effect batch being decided.',
  },
  {
    id: 'batch_effect_kind',
    type: { kind: 'enum', values: BATCH_EFFECT_KINDS },
    nullable: true,
    description: 'Effect kind of the batch being decided.',
  },
  {
    id: 'batch_policy_status',
    type: { kind: 'enum', values: ['retained', 'eligible'] },
    nullable: true,
    description:
      "'retained' when the batch touches records the owner policy retains; 'eligible' when every record is fully eligible.",
  },
  {
    id: 'frontier_open_count',
    type: { kind: 'number' },
    nullable: true,
    description: 'Unexpanded reference frontier entries (null before any discovery).',
  },
  {
    id: 'discovery_depth',
    type: { kind: 'number' },
    nullable: true,
    description: 'Deepest reference hop reached so far.',
  },
  {
    id: 'array_fields_registered',
    type: { kind: 'number' },
    nullable: true,
    description: 'Registered fields that traverse an array (wildcard paths).',
  },
  {
    id: 'array_fields_inspected',
    type: { kind: 'number' },
    nullable: true,
    description: 'Registered array fields already inspected by this run.',
  },
  {
    id: 'verification_residuals',
    type: { kind: 'number' },
    nullable: true,
    description:
      'Operational residuals of the latest verification sweep at the current world revision (null if none).',
  },
  {
    id: 'verification_status',
    type: { kind: 'enum', values: STATUS },
    nullable: true,
    description: 'Whether the latest verification sweep is valid for the current revision (null if none).',
  },
  {
    id: 'world_revision_fresh',
    type: { kind: 'boolean' },
    nullable: true,
    description: 'True when the bound plan was made at the current world revision.',
  },
  {
    id: 'retry_count',
    type: { kind: 'number' },
    nullable: false,
    description: 'Retries already spent on the current step.',
  },
];
export const FACT_IDS: readonly string[] = FACT_CATALOG.map((fact) => fact.id);

/** Receipt and artifact bindings the gateway resolves per job: status valid | invalid, or null when absent. */
export const BINDING_IDS = [
  'preview_plan',
  'action_receipt',
  'completion_receipt',
  'approval_grant',
] as const;
export const BINDING_STATUSES = STATUS;

/** Comparators the compiler admits per operand type. */
export const COMPARATORS_BY_TYPE = {
  number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
  boolean: ['eq', 'ne'],
  enum: ['eq', 'ne'],
} as const;

/** Enumerated constants a guardrail may compare against (the contract's constant enum, grouped by domain). */
export const ENUM_DOMAINS = {
  status: STATUS,
  batch_effect_kind: BATCH_EFFECT_KINDS,
  batch_policy_status: ['retained', 'eligible'],
} as const;

/** Workflow input bindings: `<nodeId>.output` for a prior node's output, or `job.input` for the admitted job input. */
export const WORKFLOW_INPUT_SOURCES = ['<nodeId>.output', 'job.input'] as const;

/**
 * A node, rule or binding name that contains any of these tokens would address the grader, the approval issuer or
 * the promoter. Tool IDs are already confined to WORKER_TOOL_IDS; this guards the free identifier strings.
 */
export const FORBIDDEN_ROUTE_TOKENS = [
  'grader',
  'evaluator',
  'manifest',
  'issuer',
  'promot',
  'rollback',
  'deploy',
  'held_out',
  'heldout',
  'private',
  'oracle',
] as const;

/** Edit surfaces and what a patch path may name (disclosed with the vocabulary, enforced by the compiler). */
export const PATCH_PATHS = {
  context: [
    'contextPolicy.schemaMode',
    'contextPolicy.includeNestedArrays',
    'contextPolicy.referenceDepth',
    'contextPolicy.lessonRecall',
    'contextPolicy.maxContextTokens',
    'contextPolicy.evidenceFormat',
  ],
  workflow: ['workflow', 'completionPolicy'],
  guardrails: ['guardrails.<ruleId>'],
  tool_policy: ['toolPolicy.grants', 'toolPolicy.prerequisites', 'limits.<limitKey>'],
  plugin: ['pluginArtifacts'],
} as const;
