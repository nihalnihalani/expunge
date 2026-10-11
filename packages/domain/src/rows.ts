import type { DomainAddress, EffectKind } from '@expunge/contracts';

export type SubjectIdType = 'objectId' | 'string' | 'int' | 'long';
export type SubjectInput = { idType: SubjectIdType; value: string };

/** A record the run found, how far from the subject it is, and why it is in scope. */
export type SelectedRecord = {
  address: DomainAddress;
  hop: number;
  /** 'subject', 'evidence:<fieldId>' or 'edge:<edgeId>:<direction>'. */
  via: string;
};

/** What `resolve_subject` established; read by every later step, never recomputed from the (possibly deleted) root. */
export type ResolutionPayload = {
  root: { address: DomainAddress; rev: number };
  /**
   * Typed keys (`s:` string, `o:` ObjectId, `l:` Long, `n:` number) the run can act on: the root key and every identity
   * value its context policy lets it see. The BSON type is part of the key, so a string and an ObjectId never match.
   */
  bindings: string[];
  /** Registered field ids the bindings were read from. */
  fromFieldIds: string[];
  /**
   * The subject's full exact identity over every registered content field, whatever the run could see. Gateway
   * private: it is never returned to the model. Verification measures completion against it, so a run that could
   * not see a field still cannot call the subject cleaned while that field holds the subject's identity.
   */
  identityBindings: string[];
  /**
   * Every record in the subject's reach under the OWNER's widest policy (all registered fields, both directions, the
   * floor's depth), computed before any effect. Gateway private. Verification measures completion against it, so a
   * run whose own discovery was shallow cannot be told it finished while a record in reach was never handled.
   */
  closure: Array<{ address: DomainAddress; hop: number }>;
  /** The closure was cut by a limit and is a lower bound: no completion may be claimed against it. */
  closureTruncated: boolean;
};
export type DiscoveryPayload = {
  /** Deepest hop explored so far, in either direction. */
  depth: number;
  /** Hops walked so far in each direction; each direction is capped on its own. */
  depths: { outgoing: number; incoming: number };
  selected: SelectedRecord[];
  /**
   * Node keys of the records explored last, per direction; the next expansion starts here. A record reached walking
   * one way continues only that way, so a chain never turns back through a record the subject does not own.
   */
  frontiers: { outgoing: string[]; incoming: string[] };
  /** Frontier records that still have unexplored neighbours (more references exist). */
  frontierOpen: number;
  truncated: boolean;
  scannedDocuments: number;
  /** Visible array fields the run has searched so far. */
  inspectedArrayFieldIds: string[];
};
export type ScopeSelectionPayload = { fieldIds: string[] };

export type PlanTarget = {
  address: DomainAddress;
  effect: EffectKind;
  /** The record version the plan was made against. */
  expectedRev: number;
  hop: number;
  via: string;
};
export type RetainedRecord = {
  address: DomainAddress;
  reason: 'policy_mismatch' | 'effect_not_allowed' | 'missing_metadata';
};
export type PlanBatch = { ordinal: number; effect: EffectKind; targets: PlanTarget[] };

export type SweepStatus = 'valid' | 'invalid';
/**
 * `binding`: a registered field still holds the subject's exact value. `unprocessed`: a record in reach still lacks its
 * effect. `unclassified`: a record in reach carries no eligibility metadata, so the owner policy cannot say what to do.
 */
export type Residual = {
  address: DomainAddress;
  fieldId: string;
  reason: 'binding' | 'unprocessed' | 'unclassified';
};

/**
 * One row per tool call a job has made, written by the gateway controls before the decision. Rows are insert-only and
 * durable across sessions and takeovers, so the Nth call of a job is the same call whoever holds the lease.
 */
export type CallPayload = {
  toolId: string;
  /** 1-based position among all calls of the job. */
  callNumber: number;
  /** 1-based position among the calls to this tool. */
  toolCallNumber: number;
  /** Documents the call asks to change (an apply batch's size; 0 for every other tool). */
  documentsToChange: number;
};
/** The workflow position after a call: the node that call matched and how often each node has been visited. */
export type WorkflowPayload = {
  nodeId: string | null;
  callNumber: number;
  outcome: string;
  visits: Record<string, number>;
};
