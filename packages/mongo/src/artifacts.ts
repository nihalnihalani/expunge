import type { ClientSession, Collection } from 'mongodb';
import {
  contentHash,
  validateHarnessBundle,
  type ArtifactEnvelope,
  type HarnessBundle,
  type ScopeKey,
} from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

export class ArtifactRepository {
  readonly collection: Collection<ArtifactEnvelope>;
  constructor(readonly service: MongoService) {
    this.collection = service.control.collection<ArtifactEnvelope>('artifacts');
  }
  async insert(payload: HarnessBundle, sourceBlobIds: string[] = []): Promise<ArtifactEnvelope> {
    requirePrincipal(this.service, ['proposer', 'promoter', 'fixture_builder', 'setup']);
    validateHarnessBundle(payload);
    const envelope: ArtifactEnvelope = {
      _id: contentHash(payload),
      payload,
      createdAt: new Date(),
      sourceBlobIds,
    };
    const existing = await this.collection.findOne({ _id: envelope._id });
    if (existing) {
      this.verify(existing);
      return existing;
    }
    try {
      await this.collection.insertOne(envelope);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
      const raced = await this.collection.findOne({ _id: envelope._id });
      if (!raced) throw error;
      this.verify(raced);
      return raced;
    }
    return envelope;
  }
  verify(envelope: ArtifactEnvelope): void {
    validateHarnessBundle(envelope.payload);
    if (contentHash(envelope.payload) !== envelope._id) fail('ArtifactHashMismatch');
  }
  async read(hash: string, session?: ClientSession): Promise<ArtifactEnvelope> {
    const envelope = await this.collection.findOne({ _id: hash }, { session });
    if (!envelope) fail('ArtifactNotFound');
    this.verify(envelope);
    return envelope;
  }
  /**
   * The artifact, if it is currently permitted for this scope. With a `session` the eligibility row is read in that
   * transaction's snapshot, so a revocation that lands before the transaction commits conflicts with it instead of
   * slipping past a read made outside it.
   */
  async readPermitted(key: ScopeKey, hash: string, session?: ClientSession): Promise<ArtifactEnvelope> {
    const permission = await this.service.control
      .collection('artifact_eligibility')
      .findOne({ ...scopeFilter(key), artifactHash: hash, state: 'permitted' }, { session });
    if (!permission) fail('ArtifactIneligible');
    return this.read(hash, session);
  }
}
