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

const SUBJECT = '64b7f3a0c1d2e3f4a5b6c7d8';
const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function fillAndPreview(page, value = SUBJECT) {
  await page.getByLabel('Exact identifier').fill(value);
  await page.getByRole('button', { name: 'Preview effects' }).click();
}

export async function run(browser, cfg) {
  const results = { scans: {} };
  await control(cfg, 'mode', { mode: 'ok' });

  // ---- New cleanup: form, validation, preview, submit ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    const writes = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/expunge') && request.method() !== 'GET')
        writes.push({
          method: request.method(),
          path: new URL(request.url()).pathname,
          body: request.postData(),
        });
    });
    await open(page, cfg, '#/expunge/new');
    await page.waitForSelector('form.ex-form', { timeout: 15000 });
    check(
      (await page.title()) === 'New cleanup · Expunge',
      'new cleanup sets its own title',
    );
    check(
      (await page.locator('legend').allInnerTexts()).join() === 'World,Subject',
      'the form has World and Subject fieldsets with legends',
    );
    check(
      (await page.locator('input[type=radio]:checked').count()) === 1,
      'the only authorized world is selected by default',
    );
    check(
      /Eligibility policy/.test(
        await page.locator('.ex-worldfacts').innerText(),
      ),
      'the selected world shows scope and eligibility facts',
    );
    check(
      (await page
        .getByLabel('Exact identifier')
        .getAttribute('autocomplete')) === 'off',
      'the identifier field disables autocomplete',
    );
    check(
      (await page.getByLabel('Exact identifier').getAttribute('type')) ===
        'text',
      'the identifier is plain text, not a password field',
    );
    // Validation never calls the backend.
    await page.getByRole('button', { name: 'Preview effects' }).click();
    await page.waitForSelector('[role=alert]');
    check(
      /Enter the exact identifier/.test(
        await page.locator('[role=alert]').first().innerText(),
      ),
      'an empty identifier shows an error summary',
    );
    check(
      await page.evaluate(
        () =>
          document.activeElement &&
          document.activeElement.getAttribute('role') === 'alert',
      ),
      'focus moves to the error summary',
    );
    check(
      (await page
        .getByLabel('Exact identifier')
        .getAttribute('aria-invalid')) === 'true',
      'the invalid field is marked aria-invalid',
    );
    check(
      /Error:|Enter the exact identifier/.test(
        await page.locator('.ex-fielderror').innerText(),
      ),
      'the field error is linked and worded',
    );
    await page.getByLabel('Exact identifier').fill('not-an-id');
    await page.getByRole('button', { name: 'Preview effects' }).click();
    check(
      /24 hexadecimal/.test(await page.locator('.ex-fielderror').innerText()),
      'a malformed ObjectId names the rule',
    );
    check(
      writes.filter((w) => w.path.endsWith('/previews')).length === 0,
      'no preview request was sent for invalid input',
    );
    await shoot(page, cfg, 's3-new-validation-1440-light');
    // A valid preview.
    await fillAndPreview(page);
    await page.waitForSelector('#ex-preview-h', { timeout: 10000 });
    const previews = writes.filter((w) => w.path.endsWith('/previews'));
    check(previews.length === 1, 'exactly one preview request was sent');
    check(
      JSON.stringify(Object.keys(JSON.parse(previews[0].body)).sort()) ===
        '["subject","worldId"]',
      'the preview request carries only world and subject (no tenant, actor or role)',
    );
    check(
      await page.evaluate(
        () =>
          document.activeElement &&
          document.activeElement.id === 'ex-preview-h',
      ),
      'focus moves to the preview heading',
    );
    const text = await page.locator('.ex-root').innerText();
    check(
      /Operator preview, not the agent.s plan/.test(text),
      'the preview is labeled an operator preview',
    );
    check(
      /never authorizes an effect/.test(text),
      'it says it never authorizes an effect',
    );
    check(!text.includes(SUBJECT), 'the literal subject is never shown back');
    check(
      (await page.locator('.ex-table tbody tr').count()) === 4 &&
        /Not inspected/.test(text),
      'per-collection matches are shown and an uninspected collection is flagged',
    );
    check(
      (await page.getByRole('button', { name: 'Submit cleanup' }).count()) ===
        1,
      'Submit appears only after a preview',
    );
    check(
      /keeps running if you close this tab/.test(text),
      'the submit consequence is stated',
    );
    await shoot(page, cfg, 's3-new-preview-1440-light');
    // Editing the subject invalidates the preview.
    await page.getByLabel('Exact identifier').fill(SUBJECT + '0');
    check(
      (await page.getByRole('button', { name: 'Submit cleanup' }).count()) ===
        0 && (await page.locator('#ex-preview-h').count()) === 0,
      'changing the subject removes the preview and Submit',
    );
    await fillAndPreview(page, SUBJECT);
    await page.waitForSelector('#ex-preview-h');
    // Submit: a failed transport keeps the same request key, so a retry cannot start a second job.
    let first = true;
    await page.route('**/api/expunge/jobs', (route) => {
      if (route.request().method() === 'POST' && first) {
        first = false;
        return route.abort();
      }
      return route.continue();
    });
    await page.getByRole('button', { name: 'Submit cleanup' }).click();
    await page.waitForSelector(
      '[role=alert]:has-text("Could not reach the operator")',
      { timeout: 8000 },
    );
    check(true, 'a lost submit says nothing was sent and offers a retry');
    check(
      (await page.getByRole('button', { name: 'Submit cleanup' }).count()) ===
        1,
      'Submit stays available for the retry',
    );
    await page.getByRole('button', { name: 'Submit cleanup' }).click();
    await page.waitForURL(/#\/expunge\/jobs\/job-new-\d+/, { timeout: 10000 });
    const submits = writes.filter(
      (w) => w.path.endsWith('/jobs') && w.method === 'POST',
    );
    check(
      submits.length === 2,
      `the retry was a second request for the same submit (${submits.length})`,
    );
    const keys = submits.map((w) => JSON.parse(w.body).requestKey);
    check(
      keys[0] === keys[1] && /^req-/.test(keys[0]),
      'both attempts carried the same requestKey',
    );
    check(
      JSON.stringify(Object.keys(JSON.parse(submits[1].body)).sort()) ===
        '["previewId","requestKey","subject","worldId"]',
      'the submit body has exactly the allowed fields',
    );
    await page.waitForSelector('.ex-steps', { timeout: 10000 });
    check(
      /Queued/.test(await page.locator('.ex-root').innerText()),
      'the new job opens in its committed queued state',
    );
    const created = await (
      await fetch(`${cfg.fixture}/internal/projection/jobs`, {
        headers: {
          Authorization: 'Bearer fixture-read-token-0123456789abcdef',
        },
      })
    ).json();
    check(
      created.items.filter((item) => item.jobId.startsWith('job-new-'))
        .length === 1,
      'exactly one job exists after the retried submit',
    );
    await context.close();
  }

  // ---- Problem states, driven by stubbed operator answers ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg, '#/expunge/new');
    await page.waitForSelector('form.ex-form');
    const cases = [
      [
        '501',
        json({ error: 'x', code: 'unsupported' }, 501),
        /does not provide effect previews/,
        'unsupported',
      ],
      [
        'write principal',
        json(
          {
            error: 'x',
            code: 'write_principal_missing',
            missing: ['EXPUNGE_JOB_WRITE_TOKEN'],
          },
          503,
        ),
        /EXPUNGE_JOB_WRITE_TOKEN/,
        'write-principal',
      ],
      [
        '400',
        json({ error: 'x', code: 'invalid_request' }, 400),
        /rejected this world or subject/,
        'rejected',
      ],
      [
        '502 credential',
        json({ error: 'x', code: 'unauthorized' }, 502),
        /rejected this operator/,
        'credential-rejected',
      ],
    ];
    for (const [label, reply, pattern, name] of cases) {
      await page.route('**/api/expunge/previews', (route) =>
        route.fulfill(reply),
      );
      await fillAndPreview(page);
      await page.waitForSelector('[role=alert]:not(:empty)', { timeout: 5000 });
      await page.waitForFunction(
        (source) =>
          new RegExp(source).test(document.querySelector('.ex-root').innerText),
        pattern.source,
      );
      check(true, `preview ${label}: shows ${pattern}`);
      check(
        (await page.locator('#ex-preview-h').count()) === 0,
        `preview ${label}: no preview and no Submit are shown`,
      );
      await shoot(page, cfg, `s3-new-state-${name}-1440-light`);
      await page.unroute('**/api/expunge/previews');
    }
    // An expired preview removes Submit and offers Preview again.
    await page.route('**/api/expunge/previews', async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({
        response: real,
        json: { ...body, expiresAt: '2020-01-01T00:00:00.000Z' },
      });
    });
    await fillAndPreview(page);
    await page.waitForSelector('#ex-preview-h');
    check(
      /This preview has expired/.test(
        await page.locator('.ex-root').innerText(),
      ),
      'an expired preview says so',
    );
    check(
      (await page.getByRole('button', { name: 'Submit cleanup' }).count()) ===
        0,
      'an expired preview has no Submit',
    );
    check(
      (await page.getByRole('button', { name: 'Preview again' }).count()) === 1,
      'it offers Preview again',
    );
    await shoot(page, cfg, 's3-new-state-stale-1440-light');
    await page.unroute('**/api/expunge/previews');
    // A preview with no exact matches is a legitimate result, not an error.
    await page.route('**/api/expunge/previews', async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      await route.fulfill({
        response: real,
        json: {
          ...body,
          perCollection: body.perCollection.map((row) => ({
            ...row,
            exactIdentityMatches: 0,
            eligibleEffects: {},
            retained: 0,
          })),
        },
      });
    });
    await fillAndPreview(page, '64b7f3a0c1d2e3f4a5b6c7d9');
    await page.waitForSelector('#ex-preview-h');
    check(
      /No record has this exact identity/.test(
        await page.locator('.ex-root').innerText(),
      ),
      'zero exact matches is stated as a legitimate outcome',
    );
    await shoot(page, cfg, 's3-new-state-no-match-1440-light');
    await page.unroute('**/api/expunge/previews');
    // A stale submit (409) asks to preview again.
    await fillAndPreview(page);
    await page.waitForSelector('#ex-preview-h');
    await page.route('**/api/expunge/jobs', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill(json({ error: 'x', code: 'conflict' }, 409))
        : route.continue(),
    );
    await page.getByRole('button', { name: 'Submit cleanup' }).click();
    await page.waitForFunction(() =>
      /changed since you previewed/.test(
        document.querySelector('.ex-root').innerText,
      ),
    );
    check(true, 'a 409 on submit says the preview is out of date');
    await context.close();
  }

  // ---- Responsive and theme matrix on the form with a preview shown ----
  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      const { page, context } = await newPage(browser, cfg, {
        width,
        height,
        scheme,
      });
      await open(page, cfg, '#/expunge/new');
      await page.waitForSelector('form.ex-form', { timeout: 15000 });
      await fillAndPreview(page);
      await page.waitForSelector('#ex-preview-h', { timeout: 10000 });
      await page.waitForTimeout(300);
      const key = `new-${width}-${scheme}`;
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
      const targets = scan.smallTargets;
      check(
        targets.length === 0,
        `${key}: targets are at least 24 x 24 (${JSON.stringify(targets.slice(0, 3))})`,
      );
      check(scan.unnamed.length === 0, `${key}: every control has a name`);
      check(scan.h1 === 1 && scan.main === 1, `${key}: one h1 and one main`);
      await shoot(page, cfg, `s3-new-${width}-${scheme}`);
      await context.close();
    }

  // ---- Keyboard: the whole form is operable without a pointer ----
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'dark',
    });
    await open(page, cfg, '#/expunge/new');
    await page.waitForSelector('form.ex-form');
    await page.getByLabel('Identifier type').focus();
    await page.keyboard.press('Tab');
    check(
      await page.evaluate(
        () =>
          document.activeElement &&
          document.activeElement.id === 'ex-subject-value',
      ),
      'Tab moves from the type to the identifier field',
    );
    await page.keyboard.type(SUBJECT);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#ex-preview-h', { timeout: 10000 });
    check(true, 'Enter in the identifier field requests the preview');
    const outline = await page.evaluate(() => {
      const el = document.querySelector('#ex-subject-value');
      el.focus();
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    });
    check(outline, 'the identifier field shows a 2 px focus outline');
    await context.close();
  }

  // ---- Setup-only operator: New cleanup is unavailable and names the configuration ----
  if (process.env.EXPUNGE_E2E_BASE_SETUPONLY) {
    const setupCfg = { ...cfg, base: process.env.EXPUNGE_E2E_BASE_SETUPONLY };
    const { page, context } = await newPage(browser, setupCfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, setupCfg, '#/expunge/new');
    await page.waitForSelector('.ex-state', { timeout: 15000 });
    const text = await page.locator('.ex-root').innerText();
    check(
      /New cleanup is unavailable/.test(text) &&
        /EXPUNGE_DOMAIN_URL/.test(text),
      'setup-only: New cleanup is unavailable and names the missing configuration',
    );
    check(
      (await page.locator('form.ex-form').count()) === 0,
      'setup-only: no form that cannot work',
    );
    await shoot(page, setupCfg, 's3-new-state-unavailable-1440-light');
    await context.close();
  }
  return results;
}
