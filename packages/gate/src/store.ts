import type { GateReport } from '@expunge/contracts';
import { fail, requirePrincipal, type MongoService } from '@expunge/mongo';
import { reportDigestOf } from './report.js';

const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
type StoredReport = GateReport & { _id: string };

/**
 * The gate report is written by the grader principal alone and never updated: the collection grants the grader INSERT
 * and nobody UPDATE or REMOVE. Its `_id` is derived from (parent, executable child) so a second report for the same
 * pair cannot exist, whatever its verdict (DA-8 D8-4); the digest is the hash of the stored body, which `promote` and
 * the grant issuer recompute.
 */
export class GateStore {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<StoredReport>('gate_reports');
  }

  async saveReport(report: GateReport): Promise<{ digest: string }> {
    requirePrincipal(this.service, ['grader']);
    if (report.verdict === 'hold') fail('HoldIsNotARecord');
    if (report.reportId !== report.reportId.trim() || !report.reportId) fail('InvalidGateReport');
    try {
      await this.rows.insertOne({ _id: report.reportId, ...report });
    } catch (error) {
      if (isDuplicate(error)) fail('GateReportExists');
      throw error;
    }
    return { digest: reportDigestOf(report) };
  }

  /** The stored report and its digest, recomputed from the stored bytes. Only the principals that consume it. */
  async readReport(reportId: string): Promise<{ report: GateReport; digest: string }> {
    requirePrincipal(this.service, ['approval_issuer', 'promoter', 'projection_reader', 'setup']);
    const found = await this.rows.findOne({ _id: reportId });
    if (!found) fail('GateReportMissing');
    const { _id, ...report } = found;
    if (_id !== reportId || report.reportId !== reportId) fail('GateReportTampered');
    return { report, digest: reportDigestOf(report) };
  }
}
