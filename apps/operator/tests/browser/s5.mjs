/* eslint-disable no-undef -- Node scripts driving a browser; not part of the vitest run. */
import {
  VIEWPORTS,
  THEMES,
  check,
  control,
  newPage,
  open,
  scanFn,
  shoot,
} from './common.mjs';

export async function run(browser, cfg) {
  const results = { scans: {} };
  await control(cfg, 'mode', { mode: 'ok' });

  // ---- Admitted report with a missing pair, a protected refusal and unpriced calls ----
  {
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
    await open(page, cfg, '#/expunge/jobs/job-approval/evaluation');
    await page.waitForSelector('.ex-candidate', { timeout: 15000 });
    check(
      (await page.title()).includes('Evaluation'),
      'evaluation view sets its own title',
    );
    const text = await page.locator('main').innerText();
    check(
      /gate verdict: admit/i.test(text),
      'the gate verdict is shown in words',
    );
    check(
      /5 of 6 planned pairs recorded/.test(text) && /1 not recorded/.test(text),
      'a planned pair with no row is shown as missing, not dropped',
    );
    check(
      /Protected cases: 1 of 2 regressed/.test(text),
      'protected regressions are counted',
    );
    check(
      /2 calls had no provider price/.test(text) &&
        /not as zero cost/.test(text),
      'unpriced calls are not shown as zero cost',
    );
    check(
      /Expert static harness/.test(text) && /Wrong-incident control/.test(text),
      'control rows are present',
    );
    check(/80%/.test(text), 'a control shows its rate with its counts');
    const firstSplits = await page
      .locator('.ex-tablewrap[aria-label="Paired trial rows"] table')
      .locator('tbody tr')
      .evaluateAll((rows) =>
        rows.map(
          (row) =>
            row.querySelectorAll('td')[0]?.textContent?.trim().split(/\s/)[0],
        ),
      );
    check(
      firstSplits[0] === 'protected' && firstSplits[1] === 'protected',
      'protected cases are listed first',
    );
    check(
      await page.evaluate(() =>
        [...document.querySelectorAll('.ex-tablewrap')].every(
          (wrap) =>
            wrap.getAttribute('role') === 'region' &&
            wrap.tabIndex === 0 &&
            !!wrap.getAttribute('aria-label'),
        ),
      ),
      'every scroll region is a labeled, focusable region',
    );
    check(
      !/Committed\b/.test(await page.locator('.ex-candidate').innerText()),
      'no authority seal claims on an evaluation report',
    );
    check(writes.length === 0, 'viewing an evaluation sends no writes');
    await page.evaluate(() =>
      document
        .querySelector('.ex-candidate')
        ?.scrollIntoView({ block: 'start' }),
    );
    await page.waitForTimeout(100);
    await shoot(page, cfg, 's5-evaluation-admit-1440-light');
    await context.close();
  }

  // ---- Rejected unsafe candidate: reason codes and authority flips ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg, '#/expunge/jobs/job-approval-stale/evaluation');
    await page.waitForSelector('.ex-candidate', { timeout: 15000 });
    const text = await page.locator('main').innerText();
    check(
      /gate verdict: reject/i.test(text),
      'a rejected candidate says reject',
    );
    check(
      /Why it was not admitted/.test(text) &&
        /retention_violation/.test(text) &&
        /untruthful_terminal/.test(text),
      'rejection reason codes are listed',
    );
    check(
      /tool:delete:payments_archive/.test(text),
      'the known authority flip is listed',
    );
    await page.evaluate(() =>
      document
        .querySelector('.ex-candidate')
        ?.scrollIntoView({ block: 'start' }),
    );
    await page.waitForTimeout(100);
    await shoot(page, cfg, 's5-evaluation-reject-1440-light');
    await context.close();
  }

  // ---- A job with no gate report ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg, '#/expunge/jobs/job-live/evaluation');
    await page.waitForSelector('text=No gate report for this job');
    check(
      (await page.locator('.ex-candidate').count()) === 0,
      'no report means an empty state, never placeholder numbers',
    );
    await context.close();
  }

  // ---- Responsive and theme matrix ----
  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      const { page, context } = await newPage(browser, cfg, {
        width,
        height,
        scheme,
      });
      await open(page, cfg, '#/expunge/jobs/job-approval/evaluation');
      await page.waitForSelector('.ex-candidate');
      await page.waitForTimeout(250);
      const key = `evaluation-${width}-${scheme}`;
      const scan = await page.evaluate(scanFn(), '.ex-root');
      results.scans[key] = scan;
      check(!scan.hOverflow, `${key}: no horizontal page overflow`);
      check(
        scan.contrastFails.length === 0,
        `${key}: no text contrast failures (${JSON.stringify(scan.contrastFails.slice(0, 2))})`,
      );
      check(scan.smallText.length === 0, `${key}: no text under 12 px`);
      check(
        scan.smallTargets.length === 0,
        `${key}: targets are at least 24 x 24 (${JSON.stringify(scan.smallTargets.slice(0, 3))})`,
      );
      check(scan.unnamed.length === 0, `${key}: every control has a name`);
      check(scan.h1 === 1 && scan.main === 1, `${key}: one h1 and one main`);
      await page.evaluate(() =>
        document
          .querySelector('.ex-candidate')
          ?.scrollIntoView({ block: 'start' }),
      );
      await page.waitForTimeout(100);
      await shoot(page, cfg, `s5-evaluation-${width}-${scheme}`);
      await context.close();
    }
  return results;
}
