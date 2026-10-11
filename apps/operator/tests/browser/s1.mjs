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
  const results = {};
  await control(cfg, 'mode', { mode: 'ok' });

  // Default view, deep link, titles, landmarks, focus management, skip link (1440 light).
  // A configured domain opens Expunge by default, at a deep-linkable address.
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg);
    await page.waitForSelector('.ex-root h1', { timeout: 15000 });
    check(
      page.url().endsWith('#/expunge'),
      'configured domain opens Expunge by default and the address is deep-linkable',
    );
    await context.close();
  }
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg, '#/expunge/setup');
    await page.waitForSelector('.ex-root h1', { timeout: 15000 });
    check(
      (await page.title()) === 'Setup and readiness · Expunge',
      'document.title is per-view',
    );
    check(
      (await page.locator('main').count()) === 1,
      'exactly one main landmark on the Expunge view',
    );
    check(
      (await page.locator('h1').count()) === 1,
      'exactly one h1 on the Expunge view',
    );
    await page
      .waitForSelector('.ex-banner:has-text("Fixture backend")', {
        timeout: 8000,
      })
      .catch(() => undefined);
    await page
      .waitForSelector('.ex-table tbody tr td:nth-child(2) .ex-chip', {
        timeout: 8000,
      })
      .catch(() => undefined);
    check(
      (await page
        .locator('.ex-banner', { hasText: 'Fixture backend' })
        .count()) === 1,
      'fixture backend banner is shown',
    );
    const rows = await page.locator('.ex-table tbody tr').count();
    check(rows >= 4, `readiness table lists the four checks (rows: ${rows})`);
    const chips = await page
      .locator('.ex-table tbody tr td:nth-child(2)')
      .allInnerTexts();
    check(
      chips.slice(0, 4).every((text) => /Pass/.test(text)),
      'all four checks read Pass against a healthy fixture',
    );
    check(
      (await page.locator('.ex-root .ex-seal').count()) === 0,
      'no authority seal appears on the readiness view',
    );
    // Skip link: first focusable, visible on focus, moves focus to main.
    await page.evaluate(
      () => document.activeElement && document.activeElement.blur(),
    );
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => {
      const el = document.activeElement;
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent.trim(),
        visible: r.left >= 0 && r.width > 0,
      };
    });
    check(
      skip.text === 'Skip to main content' && skip.visible,
      'the first Tab stop is a visible skip link',
    );
    await page.keyboard.press('Enter');
    check(
      await page.evaluate(
        () =>
          document.activeElement && document.activeElement.tagName === 'MAIN',
      ),
      'activating the skip link focuses main',
    );
    // Telemetry notice reflects the server state.
    await page
      .getByRole('button', { name: 'Settings & setup' })
      .first()
      .click();
    await page.waitForSelector('[role=dialog]');
    await page
      .waitForFunction(
        () =>
          /disabled by default/.test(
            document.querySelector('[role=dialog]').innerText,
          ),
        null,
        { timeout: 5000 },
      )
      .catch(() => undefined);
    const dialogText = await page.locator('[role=dialog]').innerText();
    check(
      /disabled by default/.test(dialogText) &&
        /EXPUNGE_ALLOW_TELEMETRY=1/.test(dialogText),
      'settings dialog states telemetry is disabled by default and how to enable it',
    );
    await page.keyboard.press('Escape');
    // Reload keeps the address and the view.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ex-root h1');
    check(
      page.url().endsWith('#/expunge/setup'),
      'reload keeps the Expunge address',
    );
    await page.goto(`${cfg.base}/#/expunge/setup`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('.ex-root h1');
    check(
      (await page.locator('.ex-root h1').innerText()).startsWith(
        'Setup and readiness',
      ),
      'deep link to #/expunge/setup renders the setup view',
    );
    // Back from Expunge to the bare page returns to the chat view.
    await page.goBack();
    await page.waitForTimeout(400);
    await context.close();
  }

  // State matrix (1440 light): healthy, down, unauthorized, evidence never proven, dead letters.
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
    });
    await open(page, cfg, '#/expunge/setup');
    await page.waitForSelector('.ex-root h1');
    const states = [
      ['ok', /Pass/, 'ready'],
      ['down', /Unavailable/, 'down'],
      ['unauthorized', /Rejected/, 'unauthorized'],
      ['unbound', /Rejected/, 'unbound'],
      ['evidence_never', /Waiting for evidence/, 'evidence-never-proven'],
      ['evidence_dead_letter', /Failed/, 'evidence-dead-letter'],
    ];
    for (const [mode, pattern, name] of states) {
      await control(cfg, 'mode', { mode });
      await page.getByRole('button', { name: 'Re-check' }).click();
      await page.waitForTimeout(700);
      const text = await page.locator('.ex-table').first().innerText();
      check(pattern.test(text), `${mode}: readiness table shows ${pattern}`);
      if (mode === 'down')
        check(
          !/Pass\s*\n?.*Reachable/.test(text) && /Not evaluated/.test(text),
          'down: downstream checks read Not evaluated, never Pass',
        );
      await shoot(page, cfg, `s1-state-${name}-1440-light`);
    }
    await control(cfg, 'mode', { mode: 'ok' });
    // The operator caches readiness for 5 s; flush it so later pages see the healthy state.
    await page.evaluate(async (token) => {
      await fetch('/api/expunge/readiness?fresh=1', {
        headers: { Authorization: `Bearer ${token}` },
      });
    }, cfg.token);
    await context.close();
  }

  // Responsive and theme matrix with scans.
  results.scans = {};
  for (const scheme of THEMES)
    for (const [width, height] of VIEWPORTS) {
      const { page, context } = await newPage(browser, cfg, {
        width,
        height,
        scheme,
      });
      await open(page, cfg, '#/expunge/setup');
      await page.waitForSelector('.ex-root h1');
      await page.waitForSelector(
        '.ex-table tbody tr td:nth-child(2) .ex-chip',
        { timeout: 10000 },
      );
      await page.waitForTimeout(500);
      const key = `${width}-${scheme}`;
      const scan = await page.evaluate(scanFn(), '.ex-root');
      results.scans[key] = scan;
      check(!scan.hOverflow, `${key}: no horizontal page overflow`);
      check(
        scan.contrastFails.length === 0,
        `${key}: no text contrast failures (${JSON.stringify(scan.contrastFails.slice(0, 2))})`,
      );
      check(
        scan.smallText.length === 0,
        `${key}: no text under 12 px inside Expunge (${JSON.stringify(scan.smallText.slice(0, 2))})`,
      );
      check(
        scan.smallTargets.length === 0,
        `${key}: every Expunge target is at least 24 x 24 (${JSON.stringify(scan.smallTargets.slice(0, 3))})`,
      );
      check(scan.unnamed.length === 0, `${key}: every control has a name`);
      check(scan.h1 === 1 && scan.main === 1, `${key}: one h1 and one main`);
      const regions = await page.evaluate(() =>
        [...document.querySelectorAll('.ex-tablewrap')].map((el) => ({
          role: el.getAttribute('role'),
          tabindex: el.getAttribute('tabindex'),
          label: el.getAttribute('aria-label'),
        })),
      );
      check(
        regions.length >= 2 &&
          regions.every(
            (r) => r.role === 'region' && r.tabindex === '0' && r.label,
          ),
        `${key}: scrollable table regions are focusable and named (${regions.length})`,
      );
      // Dark tokens resolved from the explicit block, not a generated flip.
      const ink = await page.evaluate(() => {
        const raw = getComputedStyle(document.querySelector('.ex-root'))
          .getPropertyValue('--ex-ink')
          .trim();
        // The production minifier may serialize rgb() tokens as hex; compare as channels.
        const hex = raw.match(/^#([0-9a-f]{6})$/i);
        if (hex)
          return [0, 2, 4]
            .map((i) => parseInt(hex[1].slice(i, i + 2), 16))
            .join(' ');
        return (raw.match(/\d+/g) || []).slice(0, 3).join(' ');
      });
      check(
        ink === (scheme === 'dark' ? '236 235 232' : '29 31 36'),
        `${key}: --ex-ink resolves to the verified ${scheme} value (${ink})`,
      );
      await shoot(page, cfg, `s1-readiness-${width}-${scheme}`);
      await context.close();
    }

  // Reduced motion: no running animations on the readiness view.
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'light',
      reducedMotion: true,
    });
    await open(page, cfg, '#/expunge/setup');
    await page.waitForSelector('.ex-root h1');
    const animations = await page.evaluate(
      () =>
        document
          .querySelector('.ex-root')
          .getAnimations({ subtree: true })
          .filter((a) => a.playState === 'running').length,
    );
    check(
      animations === 0,
      'reduced motion: no running animations inside Expunge',
    );
    await context.close();
  }

  // Keyboard: every Expunge control reachable in order, visible focus indicator.
  {
    const { page, context } = await newPage(browser, cfg, {
      width: 1440,
      height: 900,
      scheme: 'dark',
    });
    await open(page, cfg, '#/expunge/setup');
    await page.waitForSelector('.ex-root h1');
    await page.locator('.ex-root h1').focus();
    const stops = [];
    for (let i = 0; i < 14; i++) {
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
      inside.length > 0 && inside.every((stop) => stop.outline),
      `keyboard: ${inside.length} Expunge stops all show a 2 px focus outline (dark)`,
    );
    results.keyboardStops = inside.map((stop) => stop.name);
    await context.close();
  }

  // Setup-only operator (no domain service configured): optional second instance.
  if (process.env.EXPUNGE_E2E_BASE_SETUPONLY) {
    const setupCfg = { ...cfg, base: process.env.EXPUNGE_E2E_BASE_SETUPONLY };
    for (const scheme of THEMES) {
      const { page, context } = await newPage(browser, setupCfg, {
        width: 1440,
        height: 900,
        scheme,
      });
      await open(page, setupCfg, '#/expunge/setup');
      await page.waitForSelector(
        '.ex-table tbody tr td:nth-child(2) .ex-chip',
        { timeout: 10000 },
      );
      const text = await page.locator('.ex-root').innerText();
      check(
        /Setup-only/.test(text) &&
          /EXPUNGE_DOMAIN_URL/.test(text) &&
          /EXPUNGE_INTERNAL_TOKEN/.test(text),
        `setup-only (${scheme}): says setup-only and names the missing configuration`,
      );
      check(
        !/\bPass\b/.test(await page.locator('.ex-table').first().innerText()),
        `setup-only (${scheme}): no check reads Pass`,
      );
      check(
        (await page
          .locator('.ex-root', { hasText: 'Not evaluated' })
          .count()) === 1,
        `setup-only (${scheme}): downstream checks read Not evaluated`,
      );
      await shoot(page, setupCfg, `s1-setup-only-1440-${scheme}`);
      await context.close();
    }
  }
  return results;
}
