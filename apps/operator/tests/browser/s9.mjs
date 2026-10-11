import { check, control, newPage, open, shoot } from './common.mjs';

export async function run(browser, cfg) {
  const results = { scans: {} };
  await control(cfg, 'mode', { mode: 'ok' });
  const { page, context } = await newPage(browser, cfg, {
    width: 1440,
    height: 900,
    scheme: 'light',
  });
  const writes = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/expunge') && request.method() !== 'GET')
      writes.push(request.url());
  });
  // Stored TIE.
  await open(page, cfg, '#/expunge/campaigns/job-cancelled');
  await page.waitForSelector('#ex-cp-verdict-h', { timeout: 15000 });
  let text = await page.locator('main').innerText();
  check(/stored verdict: TIE/i.test(text), 'the stored TIE verdict is shown');
  check(
    /cannot be distinguished from noise or from doing nothing/.test(text),
    'TIE is worded per the preregistration',
  );
  check(
    /Ties dropped\s*3/.test(text) && /Sign test p\s*1\.0000/.test(text),
    'ties dropped and p are shown as stored',
  );
  check(
    /this screen did not recompute it/.test(text) ||
      /did not\s+recompute/.test(text.replace(/\n/g, ' ')),
    'the screen says it did not recompute the verdict',
  );
  await shoot(page, cfg, 's9-metaverdict-tie-1440-light');
  // Stored GAIN whose p (0.07) would not satisfy the rule: the stored word is shown, not a derived one.
  await page.goto(`${cfg.base}/#/expunge/campaigns/job-incomplete`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#ex-cp-verdict-h');
  text = await page.locator('main').innerText();
  check(
    /stored verdict: GAIN/i.test(text) && !/stored verdict: TIE/i.test(text),
    'the stored GAIN is shown even though its p does not meet the rule: nothing is recomputed',
  );
  check(
    /Preregistered rule: GAIN if and only if/.test(text),
    'the rule is stated beside the figures',
  );
  await shoot(page, cfg, 's9-metaverdict-gain-1440-light');
  // A hider campaign has no meta verdict section.
  await page.goto(`${cfg.base}/#/expunge/campaigns/job-evidence`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#ex-cp-id-h');
  check(
    (await page.locator('#ex-cp-verdict-h').count()) === 0,
    'a hider campaign shows no preregistered meta verdict section',
  );
  // Evaluation: the gate's stored summary is shown as authoritative and the recount is labeled.
  await page.goto(`${cfg.base}/#/expunge/jobs/job-approval/evaluation`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.ex-candidate');
  text = await page.locator('main').innerText();
  check(
    /stored summary/i.test(text) &&
      /Trigger gain \(training pairs only\):\s*1/.test(text),
    "the gate's stored trigger gain is shown",
  );
  check(
    /Counted from the recorded pairs/.test(text) &&
      /3 pairs improved/.test(text),
    'the recount is labeled and may differ (3 improved versus a stored gain of 1)',
  );
  check(
    /can differ from them/.test(text),
    'the page says the recount can differ from the gate',
  );
  await shoot(page, cfg, 's9-gate-summary-1440-light');
  check(writes.length === 0, 'the verdict screens send no writes');
  await context.close();
  return results;
}
