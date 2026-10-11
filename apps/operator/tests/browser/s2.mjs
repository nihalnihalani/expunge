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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(browser, cfg) {
  const results = { scans: {} };
  await control(cfg, 'mode', { mode: 'ok' });

  // ---- Jobs home: list, order, filters, deep links ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg, '#/expunge');
    await page.waitForSelector('.ex-table tbody tr', { timeout: 15000 });
    const ids = await page.locator('.ex-table tbody th a').allInnerTexts();
    check(ids.length >= 7, `jobs list shows the fixture jobs (${ids.length})`);
    check(
      ids[0] === 'job-approval',
      'the job that needs a decision is listed first',
    );
    check(
      (await page.title()) === 'Jobs · Expunge',
      'jobs view sets its own title',
    );
    check(
      (await page.locator('a', { hasText: 'New cleanup' }).count()) >= 1,
      'New cleanup action is present',
    );
    const verdicts = await page
      .locator('.ex-table tbody tr')
      .evaluateAll((rows) =>
        Object.fromEntries(
          rows.map((row) => [
            row.querySelector('th a')?.textContent,
            row.querySelectorAll('td')[4]?.textContent?.trim(),
          ]),
        ),
      );
    check(
      verdicts['job-complete'] === 'Complete in registered scope',
      `the list shows the committed verdict for a complete job (${verdicts['job-complete']})`,
    );
    check(
      verdicts['job-incomplete'] === 'Incomplete in registered scope',
      `the list shows the committed verdict for an incomplete job (${verdicts['job-incomplete']})`,
    );
    check(
      verdicts['job-live'] === 'No receipt committed',
      'a job without a receipt says so rather than showing a verdict',
    );
    await page.getByRole('button', { name: 'Needs your decision' }).click();
    check(
      (await page.locator('.ex-table tbody tr').count()) === 1,
      'the decision filter shows exactly one job',
    );
    check(
      (await page
        .getByRole('button', { name: 'Needs your decision' })
        .getAttribute('aria-pressed')) === 'true',
      'the active filter is exposed with aria-pressed',
    );
    await page.getByRole('button', { name: 'Waiting for evidence' }).click();
    check(
      (await page.locator('.ex-table tbody tr').count()) === 1,
      'the evidence filter shows exactly one job',
    );
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await shoot(page, cfg, 's2-jobs-1440-light');
    // Opening a job moves focus to its heading.
    await page.locator('.ex-table tbody th a', { hasText: 'job-live' }).click();
    await page.waitForSelector('.ex-steps');
    check(
      await page.evaluate(
        () => document.activeElement && document.activeElement.tagName === 'H1',
      ),
      'opening a job moves focus to its heading',
    );
    check(
      (await page.title()).startsWith('Job job-live'),
      'workbench sets a per-job title',
    );
    await context.close();
  }

  // ---- Live workbench: stepper, coverage, limits, feed, live updates, slower polling, no writes ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    const writes = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/expunge') && request.method() !== 'GET')
        writes.push(`${request.method()} ${request.url()}`);
    });
    await open(page, cfg, '#/expunge/jobs/job-live');
    await page.waitForSelector('.ex-steps');
    check(
      (await page.locator('.ex-steps li').count()) === 7,
      'the stepper shows seven phases',
    );
    check(
      (await page.locator('.ex-steps li[aria-current="step"]').count()) === 1,
      'exactly one phase is current',
    );
    check(
      (await page.locator('.ex-steps .ex-step--committed').count()) === 2,
      'two phases are done per the committed snapshot',
    );
    const coverage = await page.locator('.ex-coverage').innerText();
    check(
      /Inspected 3 of 6 registered collections/.test(coverage) &&
        /payments_archive/.test(coverage),
      'coverage names what was not inspected',
    );
    check(
      /4 of 12/.test(await page.locator('.ex-limits').innerText()),
      'limits show used and cap',
    );
    check(
      /#4/.test(await page.locator('.ex-feed').innerText()),
      'the feed starts at the latest committed event',
    );
    check(
      (await page.locator('.ex-seal').count()) === 0,
      'no authority seal on a running job',
    );
    check((await page.locator('h1').count()) === 1, 'one h1 on the workbench');
    await shoot(page, cfg, 's2-workbench-live-1440-light');
    // Advance on the server; the view follows without a reload.
    await control(cfg, 'advance/job-live');
    await page.waitForFunction(
      () => /#5/.test(document.querySelector('.ex-feed')?.innerText ?? ''),
      null,
      { timeout: 8000 },
    );
    check(true, 'a newly committed event appears without reloading');
    check(
      /Inspected 4 of 6/.test(await page.locator('.ex-coverage').innerText()),
      'coverage follows the new snapshot',
    );
    await control(cfg, 'advance/job-live');
    await page.waitForFunction(
      () =>
        document.querySelector('.ex-step--active .ex-step-name')
          ?.textContent === 'Preview',
      null,
      { timeout: 8000 },
    );
    check(true, 'the active phase follows the committed checkpoint');
    await control(cfg, 'advance/job-live');
    await page.waitForFunction(
      () => /Waiting for evidence/.test(document.body.innerText),
      null,
      { timeout: 8000 },
    );
    check(
      (await page
        .locator('.ex-banner', { hasText: 'Waiting for evidence' })
        .count()) >= 1,
      'waiting-evidence state is shown with its explanation',
    );
    await shoot(page, cfg, 's2-state-waiting-evidence-1440-light');
    // Waiting jobs poll every five seconds, not every second.
    let snapshotReads = 0;
    page.on('request', (request) => {
      if (/\/api\/expunge\/jobs\/job-live$/.test(request.url().split('?')[0]))
        snapshotReads++;
    });
    await wait(11000);
    check(
      snapshotReads <= 3 && snapshotReads >= 1,
      `waiting job polls slowly (${snapshotReads} snapshot reads in 11 s)`,
    );
    check(
      writes.length === 0,
      `the view issued no write requests (${writes.length})`,
    );
    await context.close();
  }

  // ---- Reconnect: transport failure, recovery, no duplicates, no re-run ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    const writes = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/expunge') && request.method() !== 'GET')
        writes.push(request.method());
    });
    await open(page, cfg, '#/expunge/jobs/job-complete');
    await page.waitForSelector('.ex-steps');
    await page.route('**/api/expunge/jobs/job-complete**', (route) =>
      route.abort(),
    );
    // The completed job refreshes once after 15 s; force a read with the visibility handler.
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    await page
      .getByRole('status')
      .filter({ hasText: /Retrying|Disconnected/ })
      .first()
      .waitFor({ timeout: 15000 });
    check(true, 'a transport failure shows Retrying or Disconnected');
    await page.waitForFunction(
      () => /Disconnected from the operator/.test(document.body.innerText),
      null,
      { timeout: 45000 },
    );
    const banner = await page
      .locator('[data-connection="disconnected"]')
      .innerText();
    check(
      /keeps running on the server/.test(banner),
      'the disconnected banner says the job keeps running on the server',
    );
    check(
      /Showing committed state from/.test(banner),
      'it says which committed state is still shown',
    );
    check(
      (await page.locator('.ex-steps').count()) === 1,
      'the last good state stays visible while disconnected',
    );
    await shoot(page, cfg, 's2-state-disconnected-1440-light');
    await page.unroute('**/api/expunge/jobs/job-complete**');
    await page.getByRole('button', { name: 'Retry now' }).click();
    await page.waitForFunction(
      () => !document.querySelector('[data-connection]'),
      null,
      { timeout: 8000 },
    );
    check(true, 'Retry now reconnects and the banner clears');
    const feed = await page.locator('.ex-feed-seq').allInnerTexts();
    check(
      new Set(feed).size === feed.length,
      'no committed event is shown twice after reconnecting',
    );
    check(
      writes.length === 0,
      'reconnecting issued no write request (nothing was re-run)',
    );
    await context.close();
  }

  // ---- Backend reset (restored to an earlier committed state) ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg, '#/expunge/jobs/job-approval');
    await page.waitForSelector('.ex-steps');
    await page.waitForFunction(() =>
      /#6/.test(document.querySelector('.ex-feed')?.innerText ?? ''),
    );
    await fetch(`${cfg.fixture}/__fixture/restart`, { method: 'POST' });
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    await page.waitForFunction(
      () => /projection was reset by the backend/.test(document.body.innerText),
      null,
      { timeout: 15000 },
    );
    check(
      true,
      'a projection that moves backwards is reported as a backend reset',
    );
    const seqs = await page.locator('.ex-feed-seq').allInnerTexts();
    check(
      seqs[0] === '#4',
      `the feed matches the backend's current committed state (${seqs[0]})`,
    );
    await shoot(page, cfg, 's2-state-projection-reset-1440-light');
    await context.close();
  }

  // ---- State gallery: one deep link per committed state ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    const cases = [
      ['job-evidence', /Waiting for evidence/, 'evidence'],
      ['job-complete', /Job finished/, 'finished'],
      ['job-incomplete', /payments_archive/, 'incomplete'],
      ['job-failed', /Failed/, 'failed'],
      ['job-cancelled', /Cancelled/, 'cancelled'],
    ];
    for (const [jobId, pattern, name] of cases) {
      await page.goto(`${cfg.base}/#/expunge/jobs/${jobId}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('.ex-steps', { timeout: 10000 });
      check(
        pattern.test(await page.locator('.ex-root').innerText()),
        `${jobId}: shows ${pattern}`,
      );
      if (jobId === 'job-incomplete')
        check(
          (await page
            .locator('.ex-banner', {
              hasText: 'not every registered collection was inspected',
            })
            .count()) === 1,
          'job-incomplete: a finished job with uninspected collections says so beside its status',
        );
      if (jobId === 'job-complete')
        check(
          (await page
            .locator('.ex-banner', {
              hasText: 'not every registered collection was inspected',
            })
            .count()) === 0,
          'job-complete: no gap banner when every collection was inspected',
        );
      await shoot(page, cfg, `s2-state-${name}-1440-light`);
    }
    await page.goto(`${cfg.base}/#/expunge/jobs/job-approval`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('.ex-steps');
    check(
      (await page
        .locator('.ex-banner', { hasText: 'needs your decision' })
        .count()) === 1,
      'job-approval: waiting-approval banner names the decision owed',
    );
    check(
      (await page.locator('.ex-seal').count()) === 0,
      'job-approval: no authority seal is shown for a waiting job',
    );
    await shoot(page, cfg, 's2-state-waiting-approval-1440-light');
    await page.goto(`${cfg.base}/#/expunge/jobs/does-not-exist`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('.ex-state', { timeout: 10000 });
    check(
      /not available from the projection/.test(
        await page.locator('.ex-root').innerText(),
      ),
      'an unknown job says it is not available, not "no data"',
    );
    await shoot(page, cfg, 's2-state-not-found-1440-light');
    await context.close();
  }

  // ---- Responsive and theme matrix with scans ----
  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      for (const [name, hash, ready] of [
        ['jobs', '#/expunge', '.ex-table tbody tr'],
        ['workbench', '#/expunge/jobs/job-incomplete', '.ex-steps'],
      ]) {
        const { page, context } = await newPage(browser, cfg, {
          width,
          height,
          scheme,
        });
        await open(page, cfg, hash);
        await page.waitForSelector(ready, { timeout: 15000 });
        await page.waitForTimeout(400);
        const key = `${name}-${width}-${scheme}`;
        const scan = await page.evaluate(scanFn(), '.ex-root');
        results.scans[key] = scan;
        check(!scan.hOverflow, `${key}: no horizontal page overflow`);
        check(
          scan.contrastFails.length === 0,
          `${key}: no text contrast failures (${JSON.stringify(scan.contrastFails.slice(0, 2))})`,
        );
        check(
          scan.smallText.length === 0,
          `${key}: no text under 12 px (${JSON.stringify(scan.smallText.slice(0, 2))})`,
        );
        check(
          scan.smallTargets.length === 0,
          `${key}: targets are at least 24 x 24 (${JSON.stringify(scan.smallTargets.slice(0, 3))})`,
        );
        check(scan.unnamed.length === 0, `${key}: every control has a name`);
        check(scan.h1 === 1 && scan.main === 1, `${key}: one h1 and one main`);
        const regions = await page.evaluate(() =>
          [...document.querySelectorAll('.ex-tablewrap')].every(
            (el) =>
              el.getAttribute('role') === 'region' &&
              el.getAttribute('tabindex') === '0' &&
              el.getAttribute('aria-label'),
          ),
        );
        check(
          regions,
          `${key}: scrollable table regions are focusable and named`,
        );
        await shoot(page, cfg, `s2-${name}-${width}-${scheme}`);
        await context.close();
      }
    }

  // ---- Reduced motion ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
      reducedMotion: true,
    });
    await open(page, cfg, '#/expunge/jobs/job-approval');
    await page.waitForSelector('.ex-steps');
    const running = await page.evaluate(
      () =>
        document
          .querySelector('.ex-root')
          .getAnimations({ subtree: true })
          .filter((a) => a.playState === 'running').length,
    );
    check(
      running === 0,
      'reduced motion: no running animations on the workbench',
    );
    await context.close();
  }

  // ---- Keyboard: jobs list is operable and focus is visible ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'dark',
    });
    await open(page, cfg, '#/expunge');
    await page.waitForSelector('.ex-table tbody tr');
    await page.locator('.ex-root h1').focus();
    const stops = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          return {
            name: (el.getAttribute('aria-label') || el.textContent || '')
              .trim()
              .slice(0, 24),
            outline:
              cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
            inExpunge: !!el.closest('.ex-root'),
          };
        }),
      );
    }
    const inside = stops.filter((stop) => stop && stop.inExpunge);
    check(
      inside.length >= 8 && inside.every((stop) => stop.outline),
      `keyboard: ${inside.length} Expunge stops all show a 2 px focus outline`,
    );
    await page.keyboard.press('Enter');
    await context.close();
  }

  // ---- Setup-only instance: the jobs list says unavailable and names the configuration ----
  if (process.env.EXPUNGE_E2E_BASE_SETUPONLY) {
    const setupCfg = { ...cfg, base: process.env.EXPUNGE_E2E_BASE_SETUPONLY };
    const { page, context } = await newPage(browser, setupCfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, setupCfg, '#/expunge');
    await page.waitForSelector('.ex-state', { timeout: 15000 });
    const text = await page.locator('.ex-root').innerText();
    check(
      /jobs list is unavailable/.test(text) && /EXPUNGE_DOMAIN_URL/.test(text),
      'setup-only: the jobs list is unavailable and names the missing configuration',
    );
    check(
      (await page.locator('.ex-table').count()) === 0,
      'setup-only: no fake empty jobs table',
    );
    await shoot(page, setupCfg, 's2-state-unavailable-1440-light');
    await context.close();
  }
  return results;
}
