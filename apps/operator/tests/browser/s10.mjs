import { check, control, newPage, open, shoot } from './common.mjs';

export async function run(browser, cfg) {
  const results = { scans: {} };
  await control(cfg, 'mode', { mode: 'ok' });
  const { page, context } = await newPage(browser, cfg, {
    width: 1440,
    height: 900,
    scheme: 'light',
  });
  await open(page, cfg, '#/expunge/jobs/job-complete');
  await page.waitForSelector('nav[aria-label="Related records"]', {
    timeout: 15000,
  });
  check(
    (await page
      .locator('nav[aria-label="Related records"] a', {
        hasText: 'Privacy and retraction',
      })
      .count()) === 1,
    'a job with a retraction links to it from the job frame',
  );
  check(
    (await page
      .locator('nav[aria-label="Related records"] a', { hasText: 'Campaign' })
      .count()) === 0,
    'a job with no campaign has no Campaign link',
  );
  await shoot(page, cfg, 's10-related-1440-light');
  await page
    .locator('nav[aria-label="Related records"] a', {
      hasText: 'Privacy and retraction',
    })
    .click();
  await page.waitForSelector('#ex-pv-prog-h');
  check(
    page.url().endsWith('#/expunge/privacy/job-complete'),
    'the link opens the privacy record of that job',
  );
  // The Receipt links too.
  await page.goto(`${cfg.base}/#/expunge/jobs/job-complete/receipt`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#ex-rc-ext-h');
  check(
    (await page
      .locator('a', {
        hasText: 'See the retraction and provider deletion record',
      })
      .count()) === 1,
    'the receipt external erasure section links to the retraction record',
  );
  // A job with a campaign.
  await page.goto(`${cfg.base}/#/expunge/jobs/job-evidence`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('nav[aria-label="Related records"]');
  check(
    (await page
      .locator('nav[aria-label="Related records"] a', { hasText: 'Campaign' })
      .count()) === 1,
    'a job with a campaign links to it',
  );
  check(
    (await page
      .locator('nav[aria-label="Related records"] a', { hasText: 'Privacy' })
      .count()) === 0,
    'a job with no retraction has no Privacy link',
  );
  // A job with neither.
  await page.goto(`${cfg.base}/#/expunge/jobs/job-live`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.ex-steps');
  check(
    (await page.locator('nav[aria-label="Related records"]').count()) === 0,
    'a job with neither record shows no related-records nav',
  );
  await context.close();
  return results;
}
