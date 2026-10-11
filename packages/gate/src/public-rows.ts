import { publicGradeReport, type GradeReport } from '@expunge/grader';
import { requirePrincipal, type MongoService } from '@expunge/mongo';

/**
 * The only per-run rows that leave the evaluator: training pairs, through the grader's public view (counters, truth
 * flags, reason codes, cost, evaluator commitment; never a manifest or poststate hash). Protected and validation
 * pairs exist only inside the report's aggregate. Insert-only, keyed on (campaign, pair, arm, repeat).
 */
export class PublicTrialRows {
  constructor(readonly service: MongoService) {}
  async write(
    campaignId: string,
    grades: ReadonlyArray<{
      pairId: string;
      repeat: number;
      arm: 'parent' | 'candidate';
      grade: GradeReport;
      family: string;
    }>,
  ): Promise<number> {
    requirePrincipal(this.service, ['grader']);
    let written = 0;
    for (const item of grades) {
      const row = {
        campaignId,
        pairId: item.pairId,
        arm: item.arm,
        repeat: item.repeat,
        split: 'train',
        family: item.family,
        report: publicGradeReport(item.grade, 'train'),
        createdAt: new Date(),
      };
      try {
        await this.service.control.collection('public_trial_rows').insertOne(row as never);
        written++;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
      }
    }
    return written;
  }
}
