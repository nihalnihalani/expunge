import { describe, expect, it } from 'vitest';
import type { ExportSuppression } from '@expunge/observer';
import { ErasureService, type DeletionProvider } from '../src/index.js';
import { FakeErasureStore, ORG, SCOPE } from './fakes.js';

/** FAKE provider: nothing reaches Raindrop. Shows the ErasureService is the suppression source the outbox dispatcher takes. */
const provider: DeletionProvider = {
  organizationId: () => 'org-1',
  requestUserDeletion: async () => {
    throw new Error('not used');
  },
  getDeletion: async () => {
    throw new Error('not used');
  },
  cancelPendingUserDeletion: async () => {
    throw new Error('not used');
  },
};

describe('ErasureService as the observer dispatcher export suppression (FAKE provider, in-memory store)', () => {
  it('satisfies ExportSuppression structurally and reports an open erasure as suppressed until released', async () => {
    const service = new ErasureService({ store: new FakeErasureStore(), provider });
    const suppression: ExportSuppression = service;
    await service.create(SCOPE, {
      requestKey: 'req-1',
      providerOrganizationId: 'org-1',
      requester: 'privacy-officer@example.invalid',
      regulation: 'other',
      namespacedUserIds: ['u_00000000000000000000000000000a01'],
    });
    expect((await suppression.suppressedUserIds(ORG)).has('u_00000000000000000000000000000a01')).toBe(true);
    await service.releaseExportSuppression(SCOPE, 'req-1');
    expect((await suppression.suppressedUserIds(ORG)).size).toBe(0);
  });
});
