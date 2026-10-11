import { describe, it } from 'vitest';

/**
 * LIVE Raindrop user deletion. BLOCKED: no root `.env`, so RAINDROP_QUERY_API_KEY and RAINDROP_PROJECT_ID do not exist.
 * Even with keys this stays skipped unless EXPUNGE_ALLOW_LIVE_ERASURE=1 is set by the human: `POST /v1/deletions/users`
 * has an ORGANIZATION-WIDE effect that this project must not trigger by accident, and the only user id it may send is a
 * synthetic namespaced one that holds no data. Under EXPUNGE_REQUIRE_LIVE_TESTS=1 the missing authorization FAILS the
 * suite rather than skipping, so a skipped run can never pass as proof. Nothing here has ever been executed.
 */
const needed = ['RAINDROP_QUERY_API_KEY', 'RAINDROP_PROJECT_ID', 'EXPUNGE_ALLOW_LIVE_ERASURE'] as const;
const missing = needed.filter((name) => !process.env[name]?.trim());
const requireLive = process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1';

describe('live Raindrop user deletion (BLOCKED until .env and explicit human authorization)', () => {
  if (missing.length > 0 && requireLive)
    it('fails because live tests are required but not configured', () => {
      throw new Error(`BLOCKED: missing ${missing.join(', ')}`);
    });
  else if (missing.length > 0)
    it.skip(`BLOCKED: ${missing.join(', ')} not set; POST /v1/deletions/users is organization-wide`, () =>
      undefined);
  else
    it('a synthetic id: POST acknowledges as pending, GET tracks it, DELETE cancels it and keeps the data', () => {
      throw new Error('not implemented: write it only after the human authorizes a live deletion request');
    });
});
