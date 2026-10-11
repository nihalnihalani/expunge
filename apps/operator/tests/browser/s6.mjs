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
    await open(page, cfg, '#/expunge/lineage/worker');
    await page.waitForSelector('.ex-lin-chain', { timeout: 15000 });
    check(
      (await page.title()).includes('Lineage'),
      'lineage view sets its own title',
    );
    check(
      (await page
        .locator('nav[aria-label="Expunge sections"] a', { hasText: 'Lineage' })
        .count()) === 1,
      'Lineage is in the Expunge navigation',
    );
    const text = await page.locator('main').innerText();
    check(
      (await page.locator('.ex-lin-node').count()) === 4,
      'every recorded version is a node',
    );
    check(
      /promo-2/.test(text) && /grant-proposal-1/.test(text),
      'a promotion shows its gate report and consumed grant id',
    );
    check(
      /none used \(no grant required/.test(text),
      'a promotion without a grant says so',
    );
    check(
      /differs from its parent/i.test(text),
      'a version tested against another parent is flagged',
    );
    check(
      /rollback-1/.test(text) && /regression on protected rows/.test(text),
      'the rollback receipt shows its reason',
    );
    check(
      /retention_violation/.test(text),
      'rejected candidates list their reason codes',
    );
    check(
      (await page
        .locator('table caption', { hasText: 'Same versions as a table' })
        .count()) === 1,
      'a table alternative has the same versions',
    );
    check(
      (await page.locator('table tbody tr').count()) >= 4,
      'the table lists every version',
    );
    check(
      /RollbackNeedsGrant/.test(text) ||
        /does not report refused rollbacks/.test(text),
      'refused rollbacks are shown if reported, or stated as not reported',
    );
    check(
      !/Rolled back successfully|rollback succeeded/i.test(text),
      'no rollback is claimed from this screen',
    );
    check(writes.length === 0, 'the lineage screen sends no writes');
    check(
      (await page
        .locator('button', { hasText: /rollback|promote|approve/i })
        .count()) === 0,
      'there is no rollback, promote or approve control',
    );
    await shoot(page, cfg, 's6-lineage-worker-1440-light');
    await page.getByRole('link', { name: 'improver' }).click();
    await page.waitForSelector('text=No deployment for improver');
    check(
      (await page.locator('.ex-lin-node').count()) === 0,
      'a target with no deployment shows an empty state, not invented versions',
    );
    await page.getByRole('link', { name: 'hider' }).click();
    await page.waitForSelector('.ex-lin-node');
    check(
      (await page.locator('.ex-lin-node').count()) === 1,
      'the hider target shows its single initial bundle',
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
      await open(page, cfg, '#/expunge/lineage/worker');
      await page.waitForSelector('.ex-lin-chain');
      await page.waitForTimeout(250);
      const key = `lineage-${width}-${scheme}`;
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
          .querySelector('.ex-lin-chain')
          ?.scrollIntoView({ block: 'start' }),
      );
      await page.waitForTimeout(100);
      await shoot(page, cfg, `s6-lineage-${width}-${scheme}`);
      await context.close();
    }
  return results;
}
