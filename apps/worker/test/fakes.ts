/**
 * FAKE in-memory job store for dispatcher tests (labeled: not MongoDB). It mirrors JobRepository's
 * claim/renew/checkpoint/yield/finish predicates closely enough to test the dispatcher's protocol use.
 */
import {
  assertJobAccess,
  type ActorContext,
  type Job,
  type JobStatus,
  type JsonValue,
} from '@expunge/contracts';
import { ProtocolError } from '@expunge/mongo';
import type { LeaseBinding, WaitStatus } from '@expunge/runtime';
import type { DispatchJobs, JobResolver } from '../src/index.js';

export class MultiJobStore implements DispatchJobs, JobResolver {
  readonly jobs = new Map<string, Job>();
  readonly calls: Array<{ method: string; jobId: string; args: unknown[] }> = [];
  readonly checkpoints = new Map<string, JsonValue[]>();
  readonly contextInputs = new Map<string, string[]>();
  /** Pass false to model a repository without recordContextInputs (the PARTIAL fallback path). */
  constructor(withContextInputs = true) {
    if (!withContextInputs) (this as { recordContextInputs?: unknown }).recordContextInputs = undefined;
  }
  add(job: Job): Job {
    this.jobs.set(job._id, job);
    return job;
  }
  private rec(method: string, jobId: string, ...args: unknown[]) {
    this.calls.push({ method, jobId, args });
  }
  named(method: string, jobId?: string) {
    return this.calls.filter((c) => c.method === method && (jobId === undefined || c.jobId === jobId));
  }
  private get(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new ProtocolError('JobNotFound');
    return job;
  }
  private live(lease: LeaseBinding): Job {
    const job = this.get(lease.jobId);
    if (
      job.status !== 'running' ||
      job.cancellationRequested ||
      job.lease.ownerId !== lease.ownerId ||
      job.lease.fence !== lease.fence ||
      job.lease.until.getTime() <= Date.now()
    )
      throw new ProtocolError('LostLease');
    return job;
  }
  async resolve(jobId: string): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }
  async readAuthorized(actor: ActorContext, jobId: string): Promise<Job> {
    const job = this.get(jobId);
    assertJobAccess(actor, job);
    return structuredClone(job);
  }
  async claim(actor: ActorContext, jobId: string, ownerId: string, durationMs = 30_000): Promise<Job | null> {
    this.rec('claim', jobId, ownerId);
    const job = this.get(jobId);
    assertJobAccess(actor, job);
    const claimable =
      !job.cancellationRequested &&
      (job.status === 'queued' || (job.status === 'running' && job.lease.until.getTime() <= Date.now()));
    if (!claimable) return null;
    job.status = 'running';
    job.lease = {
      ownerId,
      fence: job.lease.fence + 1,
      until: new Date(Date.now() + durationMs),
      heartbeatAt: new Date(),
    };
    job.attempt += 1;
    return structuredClone(job);
  }
  async renew(_actor: ActorContext, lease: LeaseBinding, durationMs = 30_000): Promise<Job> {
    this.rec('renew', lease.jobId);
    const job = this.live(lease);
    job.lease.until = new Date(Date.now() + durationMs);
    job.lease.heartbeatAt = new Date();
    return structuredClone(job);
  }
  async checkpoint(_actor: ActorContext, lease: LeaseBinding, checkpoint: JsonValue): Promise<void> {
    this.rec('checkpoint', lease.jobId, checkpoint);
    this.live(lease);
    const list = this.checkpoints.get(lease.jobId) ?? [];
    list.push(checkpoint);
    this.checkpoints.set(lease.jobId, list);
    this.get(lease.jobId).checkpoint = checkpoint;
  }
  async recordContextInputs(_actor: ActorContext, lease: LeaseBinding, hashes: string[]): Promise<string[]> {
    this.rec('recordContextInputs', lease.jobId, hashes);
    this.live(lease);
    const list = this.contextInputs.get(lease.jobId) ?? [];
    for (const hash of hashes) if (!list.includes(hash)) list.push(hash);
    this.contextInputs.set(lease.jobId, list);
    return hashes;
  }
  async yield(_actor: ActorContext, lease: LeaseBinding, status: WaitStatus): Promise<void> {
    this.rec('yield', lease.jobId, status);
    const job = this.live(lease);
    job.status = status;
    job.lease.until = new Date(0);
  }
  async finish(
    _actor: ActorContext,
    lease: LeaseBinding,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outputRefs: string[],
  ): Promise<void> {
    this.rec('finish', lease.jobId, status, outputRefs);
    const job = this.get(lease.jobId);
    if (status === 'cancelled') {
      if (!job.cancellationRequested || job.status !== 'running' || job.lease.fence !== lease.fence)
        throw new ProtocolError('LostLease');
    } else this.live(lease);
    job.status = status;
    job.outputRefs = outputRefs;
    job.lease.until = new Date(0);
  }
}
