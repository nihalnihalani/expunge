import type { Document } from 'mongodb';
import { fail, requirePrincipal, type MongoService } from './client.js';

export type WakeAcceptance = { accepted: true } | { accepted: false; duplicate: true };
type WakeRow = { _id: string; commandId: string; jobId: string; acceptedAt: Date };

/**
 * Wake-command deduplication. A wake command only says "look at this job"; the claim and its fence decide what
 * happens. Recording each command id once keeps a redelivered command from waking a worker twice. A TTL index on
 * `acceptedAt` is housekeeping only: an expired id may be accepted again, which is harmless for an idempotent wake.
 */
export class WakeCommandRepository {
  constructor(readonly service: MongoService) {}

  private get rows() {
    return this.service.control.collection<WakeRow & Document>('wake_commands');
  }

  async accept(command: { jobId: string; commandId: string }): Promise<WakeAcceptance> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    const { jobId, commandId } = command;
    if (!jobId || !commandId || jobId.length > 256 || commandId.length > 256) fail('InvalidWakeCommand');
    try {
      await this.rows.insertOne({ _id: commandId, commandId, jobId, acceptedAt: new Date() });
      return { accepted: true };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000)
        return { accepted: false, duplicate: true };
      throw error;
    }
  }
}
