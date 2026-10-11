/** Starts the labeled fixture backend for browser runs: node --import tsx tests/fixtures/run-expunge-fixture.ts */
import { FIXTURE_TOKENS, startFixture } from './expunge-domain-fixture.js';

const port = Number(process.env.EXPUNGE_FIXTURE_PORT ?? 4320);
const running = await startFixture(port);
console.log(
  `Expunge FIXTURE backend (test data, not a live job) at ${running.url}`,
);
console.log(
  `Use EXPUNGE_DOMAIN_URL=${running.url} with the fixture token names ${Object.keys(FIXTURE_TOKENS).join(', ')} from tests/fixtures/expunge-domain-fixture.ts`,
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => void running.close().then(() => process.exit(0)));
