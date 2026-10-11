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
    await open(page, cfg, '#/expunge/campaigns/job-evidence');
    await page.waitForSelector('#ex-cp-id-h', { timeout: 15000 });
    check(
      (await page.title()).includes('Campaign'),
      'campaign view sets its own title',
    );
    let text = await page.locator('main').innerText();
    check(/Hider campaign/.test(text), 'a hider campaign is labeled as one');
    check(
      /4 of 4 planned rows recorded/.test(text),
      'all planned rows are recorded',
    );
    check(
      /Equal budgets: all 4 rows carry/.test(text),
      'equal budgets are stated only because every row carries the hash',
    );
    check(
      /W0 reset: all 4 rows carry/.test(text),
      'the W0 reset proof is checked on every row',
    );
    check(
      /Noise control: present/.test(text) &&
        /No-data control: present/.test(text),
      'both controls are shown present',
    );
    check(
      /Measured 2, null 2/.test(text),
      'results are counted as recorded, nulls included',
    );
    check(
      /A null result is a result/.test(text),
      'a null result is worded as a result',
    );
    check(
      /states no gain and no conclusion/.test(text),
      'the screen states no gain',
    );
    check(
      !/gain|improv|\+\d+%/i.test(
        text
          .replace(/\s+/g, ' ')
          .replace(
            'This screen reports rows. It states no gain and no conclusion; a null result stays a null result.',
            ' ',
          )
          .replace(
            'Without it a gain cannot be separated from the harness doing nothing.',
            ' ',
          )
          .replace(
            'Rows, validity checks and results exactly as recorded. No gain is computed here.',
            ' ',
          ),
      ),
      'no gain, improvement or percentage wording appears outside the fixed disclaimer sentences',
    );
    check(
      /Novelty is not part of this projection/.test(text),
      'novelty is stated as not reported',
    );
    check(
      (await page.locator('.ex-seal').count()) === 0,
      'no seal on the campaign view',
    );
    await shoot(page, cfg, 's8-campaign-valid-1440-light');
    await page.goto(`${cfg.base}/#/expunge/campaigns/job-cancelled`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#ex-cp-id-h');
    text = await page.locator('main').innerText();
    check(/Meta campaign/.test(text), 'a meta campaign is labeled as one');
    check(
      /4 of 5 planned rows recorded/.test(text) && /1 not recorded/.test(text),
      'a missing planned row is shown',
    );
    check(
      /Budget mismatch: 1 row/.test(text) && /m-2/.test(text),
      'a row with another budget is named',
    );
    check(
      /W0 reset mismatch: 1 row/.test(text) && /m-3/.test(text),
      'a row without the reset proof is named',
    );
    check(
      /Noise control:\s*missing/i.test(text) &&
        /No-data control:\s*missing/i.test(text),
      'missing controls are shown with their consequence',
    );
    check(
      /unequal_budget/.test(text) && /duplicate_novelty/.test(text),
      'quarantine reason codes are listed',
    );
    check(/invalid/i.test(text), 'an invalid row is shown as invalid');
    check(
      !/Equal budgets: all/.test(text),
      'equal budgets are not claimed for the flawed campaign',
    );
    await shoot(page, cfg, 's8-campaign-flawed-1440-light');
    await page.goto(`${cfg.base}/#/expunge/campaigns/job-live`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('text=No campaign is recorded for this job');
    check(
      (await page.locator('#ex-cp-id-h').count()) === 0,
      'no campaign means an empty state, never placeholder rows',
    );
    check(writes.length === 0, 'the campaign screens send no writes');
    await context.close();
  }

  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      const { page, context } = await newPage(browser, cfg, {
        width,
        height,
        scheme,
      });
      await open(page, cfg, '#/expunge/campaigns/job-cancelled');
      await page.waitForSelector('#ex-cp-rows-h');
      await page.waitForTimeout(250);
      const key = `campaign-${width}-${scheme}`;
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
          .querySelector('#ex-cp-id-h')
          ?.scrollIntoView({ block: 'start' }),
      );
      await page.waitForTimeout(100);
      await shoot(page, cfg, `s8-campaign-${width}-${scheme}`);
      await context.close();
    }
  return results;
}
