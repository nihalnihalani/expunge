import type { Document } from 'mongodb';
import { sameScope, type Candidate, type ScopeKey } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

/**
 * What the proposer may write: a candidate without the gate's verdict. `computedClass` and the lifecycle `state`
 * beyond `proposed` are never proposer input; the gate writes its classification into the gate report, and
 * promotion reads only that.
 */
export type CandidateProposal = Omit<Candidate, 'computedClass' | 'state'>;
export type StoredCandidateProposal = CandidateProposal & { _id: string; state: 'proposed' };

export class CandidateRepository {
  constructor(readonly service: MongoService) {}

  private get collection() {
    return this.service.control.collection<StoredCandidateProposal & Document>('candidates');
  }

  /** Inserts a proposal. A proposal that already carries a class or a non-initial state is refused. */
  async propose(proposal: CandidateProposal): Promise<StoredCandidateProposal> {
    requirePrincipal(this.service, ['proposer', 'setup']);
    const untrusted = proposal as Record<string, unknown>;
    if ('computedClass' in untrusted || ('state' in untrusted && untrusted.state !== 'proposed'))
      fail('ProposerCannotClassify');
    const stored: StoredCandidateProposal = { ...proposal, _id: proposal.candidateId, state: 'proposed' };
    await this.collection.insertOne(stored);
    return stored;
  }

  async read(key: ScopeKey, candidateId: string): Promise<StoredCandidateProposal> {
    const row = await this.collection.findOne({ candidateId, ...candidateScope(key) });
    if (!row) fail('CandidateNotFound');
    if (!sameScope(row.actor, key)) fail('UnauthorizedCandidate');
    return row;
  }
}
function candidateScope(key: ScopeKey): Record<string, string> {
  const scope = scopeFilter(key);
  return { 'actor.tenantId': scope.tenantId, 'actor.env': scope.env, 'actor.scopeId': scope.scopeId };
}
