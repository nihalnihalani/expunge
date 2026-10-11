import { contentHash, type GateReport, type JsonValue } from '@expunge/contracts';
import { fail } from './client.js';

/**
 * What a grant must say, derived from the stored gate report. The report is written by the grader principal and
 * hashed by its own content, so none of these values is supplied by the request that spends the grant.
 */
export type GrantBinding = {
  proposalId: string;
  parentHash: string;
  childHash: string;
  gateReportId: string;
  gateReportDigest: string;
  flipSetDigest: string;
  approvedDescriptor: JsonValue;
};

/** Digest of the known authority flips of a candidate, order-insensitive. */
export function deriveFlipSetDigest(flips: readonly string[]): string {
  return contentHash({ flips: [...flips].sort() }, 'flip-set');
}
/** The authority change a human approves: the class, the exact artifact transition and the flips. */
export function deriveApprovedDescriptor(report: GateReport): JsonValue {
  if (!report.computedClass) fail('GateReportClassMissing');
  return {
    computedClass: report.computedClass,
    parentHash: report.parentHash,
    childHash: report.childHash,
    flips: [...report.knownAuthorityFlips].sort(),
  };
}
/** The full expected grant binding for a stored, admitting gate report. `digest` is the report's own digest. */
export function deriveGrantBinding(report: GateReport, digest: string): GrantBinding {
  return {
    proposalId: report.candidateId,
    parentHash: report.parentHash,
    childHash: report.childHash,
    gateReportId: report.reportId,
    gateReportDigest: digest,
    flipSetDigest: deriveFlipSetDigest(report.knownAuthorityFlips),
    approvedDescriptor: deriveApprovedDescriptor(report),
  };
}
/** Canonical equality: BSON field order must not decide whether a descriptor matches. */
export function sameDescriptor(left: JsonValue, right: JsonValue): boolean {
  return contentHash(left, 'approved-descriptor') === contentHash(right, 'approved-descriptor');
}
