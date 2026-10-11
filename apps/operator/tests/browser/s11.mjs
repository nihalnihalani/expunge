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
    await open(page, cfg, '#/expunge/jobs/job-evidence/evidence');
    await page.waitForSelector('.ex-candidate', { timeout: 15000 });
    check(
      (await page.title()).includes('Evidence'),
      'evidence view sets its own title',
    );
    check(
      (await page
        .locator('nav[aria-label="Job sections"] a', { hasText: 'Evidence' })
        .count()) === 1,
      'the Evidence tab exists and is in the job sections',
    );
    let text = await page.locator('main').innerText();
    check(
      /Waiting for evidence/.test(text) && /pending, not/.test(text),
      'a waiting job says evidence is pending, not clean',
    );
    check(
      /evidence not ready/i.test(text) && /truncated/i.test(text),
      'job-level state: not ready and truncated',
    );
    check(
      /evt_fixture_1/.test(text) &&
        /trace_fixture_1/.test(text) &&
        /sig_fixture_1/.test(text),
      'event, trace and signal ids are shown',
    );
    check(
      /A Raindrop classifier/.test(text) &&
        /The verifier/.test(text) &&
        /The agent reported it about itself/.test(text),
      'origins are distinct',
    );
    check(
      /Truncated/.test(text) && /may be incomplete/.test(text),
      'a truncated bundle says it may be incomplete',
    );
    check(
      /required span/.test(text) &&
        /classifier signal/.test(text) &&
        /this evidence is pending, not clean/.test(text),
      'missing components are named',
    );
    check(
      (await page.locator('.ex-ladder li[data-reached="yes"]').count()) >= 4,
      'the ladder shows how far delivery got',
    );
    check(
      (await page.locator('.ex-ladder li[aria-current="step"]').count()) >= 1,
      'the current ladder step is marked',
    );
    check(
      (await page.locator('a[href*="raindrop"]').count()) === 0,
      'no invented Raindrop URL is shown',
    );
    check(
      (await page.locator('.ex-seal').count()) === 0,
      'no seal on the evidence view',
    );
    check(writes.length === 0, 'viewing evidence sends no writes');
    await shoot(page, cfg, 's11-evidence-partial-1440-light');
    await page.goto(`${cfg.base}/#/expunge/jobs/job-approval/evidence`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('.ex-candidate');
    text = await page.locator('main').innerText();
    check(
      /Read back from Raindrop: every component/.test(text),
      'a complete bundle reaches evidence ready',
    );
    await page.goto(`${cfg.base}/#/expunge/jobs/job-failed/evidence`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('.ex-candidate');
    text = await page.locator('main').innerText();
    check(
      /NOT available/.test(text) && /not a clean result/.test(text),
      'a dead-lettered bundle says the evidence is not available',
    );
    check(
      /terminal event/.test(text) && /5 retry attempts/.test(text),
      'dead letter shows what is missing and the retries',
    );
    await shoot(page, cfg, 's11-evidence-deadletter-1440-light');
    await page.goto(`${cfg.base}/#/expunge/jobs/job-live/evidence`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('text=No evidence bundle for this job');
    check(
      (await page.locator('.ex-candidate').count()) === 0,
      'no bundle means an empty state, not placeholder evidence',
    );
    await context.close();
  }
  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      const { page, context } = await newPage(browser, cfg, {
        width,
        height,
        scheme,
      });
      await open(page, cfg, '#/expunge/jobs/job-evidence/evidence');
      await page.waitForSelector('.ex-candidate');
      await page.waitForTimeout(250);
      const key = `evidence-${width}-${scheme}`;
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
          .querySelector('#ex-ev-sum-h')
          ?.scrollIntoView({ block: 'start' }),
      );
      await page.waitForTimeout(100);
      await shoot(page, cfg, `s11-evidence-${width}-${scheme}`);
      await context.close();
    }
  return results;
}
