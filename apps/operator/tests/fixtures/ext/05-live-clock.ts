/**
 * FIXTURE clock. The shared preview constant carries a fixed 2026-10-11T09:15Z expiry, which is
 * already in the past on a real clock, so the live fixture serves previews valid for 15 minutes
 * from when it starts. Protocol tests that import the constant directly are unaffected.
 */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { preview } from '../expunge-data.js';

export default function liveClock(_state: FixtureState) {
  preview.expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
}
