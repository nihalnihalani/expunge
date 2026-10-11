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

const writes = (page) => {
  const seen = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/expunge') && request.method() !== 'GET')
      seen.push({
        method: request.method(),
        url: request.url(),
        body: request.postData(),
      });
  });
  return seen;
};

function scanChecks(key, scan, results) {
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
}

export async function run(browser, cfg) {
  const results = { scans: {} };
  await control(cfg, 'mode', { mode: 'ok' });

  // ---- Receipt: committed fields, labeled narrative, absence states ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    const sent = writes(page);
    await open(page, cfg, '#/expunge/jobs/job-complete/receipt');
    await page.waitForSelector('#ex-rc-verdict-h', { timeout: 15000 });
    check(
      (await page.title()).includes('Receipt'),
      'receipt view sets its own title',
    );
    check(
      (await page.locator('.ex-seal[data-source-kind="receipt"]').count()) ===
        1,
      'the complete receipt shows exactly one receipt seal',
    );
    const body = await page.locator('main').innerText();
    check(
      /Complete in registered scope/.test(body) &&
        /world revision 215/.test(body),
      'verdict names the registered scope and verified revision',
    );
    check(
      /Pending: the provider has not yet confirmed/.test(body),
      'external erasure is worded exactly as the backend states it (pending)',
    );
    check(
      !/Confirmed by the provider/.test(body),
      'pending erasure is never shown as confirmed',
    );
    check(
      /Backups and exports outside the registry/.test(body),
      'limitations are listed',
    );
    const narrative = page.locator('.ex-narrative');
    check(
      (await narrative.count()) === 1 &&
        /not verified/i.test(await narrative.innerText()),
      'model narrative is in a labeled untrusted block',
    );
    check(
      (await narrative.locator('.ex-seal').count()) === 0,
      'no seal inside the narrative',
    );
    check(
      await page.evaluate(() => {
        const verdict = document.querySelector('#ex-rc-verdict-h');
        const narr = document.querySelector('.ex-narrative');
        return (
          !!verdict &&
          !!narr &&
          !!(
            verdict.compareDocumentPosition(narr) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )
        );
      }),
      'narrative follows the verdict and is outside it',
    );
    check(sent.length === 0, 'viewing a receipt sends no writes');
    await shoot(page, cfg, 's4-receipt-complete-1440-light');
    await page.goto(`${cfg.base}/#/expunge/jobs/job-incomplete/receipt`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('#ex-rc-verdict-h');
    const incomplete = await page.locator('main').innerText();
    check(
      /Incomplete/.test(incomplete) &&
        !/Complete in registered scope/.test(incomplete),
      'an incomplete receipt says incomplete, whatever the narrative claims',
    );
    check(
      /payments_archive/.test(incomplete) && /Not inspected/.test(incomplete),
      'the incomplete receipt names what was not inspected',
    );
    check(
      /everything is clean/.test(incomplete),
      'the narrative claim is visible but labeled',
    );
    await shoot(page, cfg, 's4-receipt-incomplete-1440-light');
    await page.goto(`${cfg.base}/#/expunge/jobs/job-live/receipt`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('text=No completion receipt');
    check(
      (await page.locator('.ex-seal').count()) === 0 &&
        !/Complete in registered scope/.test(
          await page.locator('main').innerText(),
        ),
      'a running job shows no seal and no completion claim',
    );
    await shoot(page, cfg, 's4-receipt-absent-1440-light');
    await context.close();
  }

  // ---- Responsive and theme matrix: receipt and open approval dialog ----
  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      const { page, context } = await newPage(browser, cfg, {
        width,
        height,
        scheme,
      });
      await open(page, cfg, '#/expunge/jobs/job-complete/receipt');
      await page.waitForSelector('#ex-rc-verdict-h');
      await page.waitForTimeout(250);
      scanChecks(
        `receipt-${width}-${scheme}`,
        await page.evaluate(scanFn(), '.ex-root'),
        results,
      );
      await shoot(page, cfg, `s4-receipt-${width}-${scheme}`);
      await page.goto(`${cfg.base}/#/expunge/jobs/job-approval/candidate`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('#ex-appr-h');
      await page.getByRole('button', { name: 'Review proposal' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(250);
      const scan = await page.evaluate(scanFn(), 'dialog');
      scanChecks(
        `approval-${width}-${scheme}`,
        { ...scan, main: 1, h1: 1 },
        results,
      );
      await shoot(page, cfg, `s4-approval-${width}-${scheme}`);
      await context.close();
    }

  // ---- Reduced motion ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1024,
      height: 768,
      scheme: 'light',
      reducedMotion: true,
    });
    await open(page, cfg, '#/expunge/jobs/job-approval/candidate');
    await page.waitForSelector('#ex-appr-h');
    await page.getByRole('button', { name: 'Review proposal' }).click();
    await page.getByRole('dialog').waitFor();
    check(
      (await page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.playState === 'running')
            .length,
      )) === 0,
      'reduced motion: no running animations in the approval dialog',
    );
    await context.close();
  }
  // ---- Candidate and approval dialog: keyboard, containment, Escape, focus return ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    const sent = writes(page);
    await open(page, cfg, '#/expunge/jobs/job-approval/candidate');
    await page.waitForSelector('#ex-appr-h', { timeout: 15000 });
    await page.waitForSelector('.ex-candidate');
    const text = await page.locator('main').innerText();
    check(
      /Before \(removed\)/.test(text) && /After \(added\)/.test(text),
      'the diff carries text cues, not color alone',
    );
    check(
      /claimed behavioral/.test(text),
      'a claimed class that differs from the computed class is flagged',
    );
    check(
      /not evidence of improvement/.test(text),
      'replay is labeled a diagnostic',
    );
    await shoot(page, cfg, 's4-candidate-1440-light');
    const opener = page.getByRole('button', { name: 'Review proposal' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', {
      name: 'Review harness proposal',
    });
    await dialog.waitFor({ timeout: 10000 });
    check(
      (await dialog.getAttribute('aria-modal')) === 'true',
      'the dialog is modal',
    );
    check(
      await page.evaluate(
        () => document.activeElement?.id === 'ex-approval-title',
      ),
      'focus starts on the dialog title',
    );
    await dialog.getByText('computed by the gate').waitFor();
    check(
      (await dialog.innerText()).includes('computed by the gate, not claimed'),
      'the dialog reads the stored descriptor',
    );
    check(sent.length === 0, 'opening the dialog sends no write');
    await shoot(page, cfg, 's4-approval-1440-light');
    // Tab order: Decline first, Approve last; Tab wraps inside.
    const labels = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      labels.push(
        await page.evaluate(() =>
          document.activeElement?.closest('dialog')
            ? document.activeElement.textContent?.trim()
            : 'OUTSIDE',
        ),
      );
    }
    check(
      !labels.includes('OUTSIDE'),
      `Tab never leaves the dialog (${labels.join(' | ').slice(0, 120)})`,
    );
    const decline = labels.indexOf('Decline');
    const approve = labels.indexOf('Approve promotion');
    check(
      decline >= 0 && approve > decline,
      'Decline comes before Approve in the tab order',
    );
    check(
      labels.filter((l) => l === 'Approve promotion').length >= 1,
      'Approve is reachable by keyboard',
    );
    await page.keyboard.press('Shift+Tab');
    check(
      await page.evaluate(() => !!document.activeElement?.closest('dialog')),
      'Shift+Tab stays inside the dialog',
    );
    check(
      await page.evaluate(() => {
        const d = document.querySelector('dialog');
        return d?.matches(':modal');
      }),
      'the page behind is inert (dialog is modal)',
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
    check(sent.length === 0, 'Escape closes without any decision write');
    check(
      await page.evaluate(
        () => document.activeElement?.textContent?.trim() === 'Review proposal',
      ),
      'focus returns to the control that opened the dialog',
    );
    // Open by pointer, decline, and see only the committed state.
    await opener.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Decline' }).click();
    await page.waitForSelector('dialog .ex-pending', { timeout: 10000 });
    const after = await dialog.innerText();
    check(
      /Decline sent/.test(after) && /declined/.test(after),
      'after Decline the dialog shows the database-reported state',
    );
    check(
      !/Promoted/.test(after),
      'the dialog never says promoted from a click',
    );
    check(
      sent.length === 1 &&
        sent[0].method === 'POST' &&
        /\/decision$/.test(sent[0].url),
      'exactly one decision POST was sent',
    );
    const body = JSON.parse(sent[0].body);
    check(
      Object.keys(body).sort().join() === 'decision,descriptorDigest' &&
        body.decision === 'decline',
      'the decision carries only the decision and descriptor digest',
    );
    await shoot(page, cfg, 's4-approval-decided-1440-light');
    await dialog
      .getByRole('button', { name: 'Close without deciding' })
      .click();
    await page.waitForSelector('text=recorded a decline');
    await context.close();
  }

  // ---- Expired and stale proposals: Approve is removed, not disabled ----
  for (const [jobId, word] of [
    ['job-approval-expired', 'expired'],
    ['job-approval-stale', 'stale'],
  ]) {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    const sent = writes(page);
    await open(page, cfg, `#/expunge/jobs/${jobId}/candidate`);
    await page.waitForSelector('#ex-appr-h');
    await page.getByRole('button', { name: /proposal/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog
      .getByText(/Refresh/)
      .first()
      .waitFor();
    check(
      (await dialog
        .getByRole('button', { name: 'Approve promotion' })
        .count()) === 0,
      `${word}: Approve is removed`,
    );
    check(
      (await dialog.getByRole('button', { name: 'Decline' }).count()) === 0,
      `${word}: Decline is removed too`,
    );
    check(
      new RegExp(word, 'i').test(await dialog.innerText()),
      `${word}: the reason is stated`,
    );
    check(
      (await dialog
        .getByRole('button', { name: 'Close without deciding' })
        .count()) === 1,
      `${word}: the dialog can still be closed`,
    );
    check(sent.length === 0, `${word}: no write was sent`);
    await shoot(page, cfg, `s4-approval-${word}-1440-light`);
    await context.close();
  }

  return results;
}
