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
    // Failed closed, closure incomplete, provider still working.
    await open(page, cfg, '#/expunge/privacy/job-complete');
    await page.waitForSelector('#ex-pv-prog-h', { timeout: 15000 });
    check(
      (await page.title()).includes('Privacy'),
      'privacy view sets its own title',
    );
    let text = await page.locator('main').innerText();
    check(/Failed closed/.test(text), 'a fail-closed retraction says so');
    check(
      /derivation closure not complete/.test(text) &&
        /known so far, not a complete list/.test(text),
      'an incomplete closure is not presented as a full list',
    );
    check(
      /Not checked, so no claim is made about retained bytes/.test(text),
      'an unrun retained-bytes check makes no claim',
    );
    check(
      /The provider is processing the request/.test(text),
      'the provider state is worded as the backend states it',
    );
    check(
      !/Provider completion time/.test(text),
      'no completion time is shown for an in-progress request',
    );
    check(
      (await page
        .locator('table caption', { hasText: 'Each row reads' })
        .count()) === 1,
      'derivation edges are a table',
    );
    check(
      /derived from/.test(text) && /source deleted/.test(text),
      'edge relations are in words',
    );
    check(
      (await page.locator('.ex-seal').count()) === 0,
      'no seal on the privacy view',
    );
    await shoot(page, cfg, 's7-privacy-failclosed-1440-light');
    // Completed with the provider completion time.
    await page.goto(`${cfg.base}/#/expunge/privacy/job-incomplete`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#ex-pv-er-h');
    text = await page.locator('main').innerText();
    check(
      /Provider completion time/.test(text) &&
        /derivation closure complete/.test(text),
      'a completed request shows the provider completion time',
    );
    check(
      !/Failed closed/.test(text),
      'a clean retraction is not marked failed closed',
    );
    await shoot(page, cfg, 's7-privacy-complete-1440-light');
    // Completed without a completion time is not claimed.
    await page.goto(`${cfg.base}/#/expunge/privacy/job-failed`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#ex-pv-er-h');
    text = await page.locator('main').innerText();
    check(
      /Not shown as complete/.test(text) &&
        !/Provider completion time/.test(text),
      'completed without a provider completion time is not shown as complete',
    );
    await shoot(page, cfg, 's7-privacy-nocompletiontime-1440-light');
    // A job with no retraction.
    await page.goto(`${cfg.base}/#/expunge/privacy/job-live`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('text=No retraction is recorded for this job');
    check(
      (await page.locator('#ex-pv-prog-h').count()) === 0,
      'no retraction means an empty state, not placeholder progress',
    );
    // Unknown job.
    await page.goto(`${cfg.base}/#/expunge/privacy/does-not-exist`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('text=not available from the projection');
    check(writes.length === 0, 'the privacy screens send no writes');
    await context.close();
  }

  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      const { page, context } = await newPage(browser, cfg, {
        width,
        height,
        scheme,
      });
      await open(page, cfg, '#/expunge/privacy/job-complete');
      await page.waitForSelector('#ex-pv-er-h');
      await page.waitForTimeout(250);
      const key = `privacy-${width}-${scheme}`;
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
          .querySelector('#ex-pv-prog-h')
          ?.scrollIntoView({ block: 'start' }),
      );
      await page.waitForTimeout(100);
      await shoot(page, cfg, `s7-privacy-${width}-${scheme}`);
      await context.close();
    }
  return results;
}
