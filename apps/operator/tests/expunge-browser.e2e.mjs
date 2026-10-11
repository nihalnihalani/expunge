/* eslint-disable no-undef -- Node scripts driving a browser; not part of the vitest run. */
/**
 * Browser verification runner for the Expunge workflow.
 *   EXPUNGE_E2E_OUT=<dir> [EXPUNGE_E2E_BASE EXPUNGE_E2E_TOKEN_FILE EXPUNGE_E2E_FIXTURE] \
 *     node tests/expunge-browser.e2e.mjs s1
 * Not collected by vitest (the file name has no .test). Requires a built operator pointed at the
 * labeled fixture backend (tests/fixtures/run-expunge-fixture.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, failures, finish, launch } from './browser/common.mjs';

const slice = process.argv[2];
if (!slice)
  throw new Error('Usage: node tests/expunge-browser.e2e.mjs <slice>');
const cfg = config();
const browser = await launch();
try {
  const module = await import(`./browser/${slice}.mjs`);
  const results = await module.run(browser, cfg);
  const summary = finish(slice, results);
  fs.writeFileSync(
    path.join(cfg.out, `results-${slice}.json`),
    JSON.stringify(summary, null, 1),
  );
} finally {
  await browser.close();
}
process.exitCode = failures.length ? 1 : 0;
