/* eslint-disable no-undef -- Node scripts driving a browser; not part of the vitest run. */
/**
 * Shared helpers for the Expunge browser checks (Playwright, driving the installed Chrome).
 * These run against a built operator and the labeled FIXTURE backend. They are inputs to
 * human review, not a WCAG compliance claim.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export const VIEWPORTS = [
  [1440, 900],
  [1024, 768],
  [768, 1024],
  [390, 844],
];
export const THEMES = ['light', 'dark'];

export function config() {
  const base = process.env.EXPUNGE_E2E_BASE ?? 'http://127.0.0.1:4393';
  const tokenFile = process.env.EXPUNGE_E2E_TOKEN_FILE;
  const out = process.env.EXPUNGE_E2E_OUT;
  const fixture = process.env.EXPUNGE_E2E_FIXTURE ?? 'http://127.0.0.1:4320';
  if (!out) throw new Error('Set EXPUNGE_E2E_OUT to the screenshot directory.');
  fs.mkdirSync(out, { recursive: true });
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  return { base, token, out, fixture };
}

export async function launch() {
  return chromium.launch({
    executablePath:
      process.env.EXPUNGE_E2E_CHROME ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
}

export async function newPage(
  browser,
  cfg,
  { width, height, scheme, reducedMotion },
) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    deviceScaleFactor: 1,
  });
  if (cfg.token)
    await context.addInitScript((value) => {
      try {
        sessionStorage.setItem('opendots-token', value);
      } catch {
        // storage unavailable
      }
    }, cfg.token);
  const page = await context.newPage();
  page.on('pageerror', (error) =>
    failures.push(`pageerror: ${error.message.slice(0, 160)}`),
  );
  return { page, context };
}

export const failures = [];
export const notes = [];
export function check(condition, message) {
  if (!condition) failures.push(message);
  else notes.push(`ok: ${message}`);
}

export async function control(cfg, pathName, body) {
  const response = await fetch(`${cfg.fixture}/__fixture/${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return response.json();
}

export async function open(page, cfg, hash = '') {
  await page.goto(`${cfg.base}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(
    hash.startsWith('#/expunge') ? '.ex-root' : '.app',
    {
      timeout: 15000,
    },
  );
}

export async function shoot(page, cfg, name) {
  const file = path.join(cfg.out, `${name}.png`);
  await page.screenshot({ path: file });
  const size = fs.statSync(file).size;
  check(
    size < 500 * 1024,
    `${name}.png is ${Math.round(size / 1024)} KB (< 500 KB)`,
  );
  return file;
}

/** Computed-style scan of the Expunge region: contrast, small text, small targets, overflow, structure. */
export function scanFn() {
  return (sel) => {
    const root = document.querySelector(sel) ?? document.body;
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1]
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const lin = (c) => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c) =>
      0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => {
      const x = lum(a);
      const y = lum(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const visible = (el) => {
      const cs = getComputedStyle(el);
      if (
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        +cs.opacity === 0
      )
        return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const bgOf = (el) => {
      const layers = [];
      let n = el;
      while (n && n.nodeType === 1) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a === 1) break;
        }
        n = n.parentElement;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const name = (el) =>
      el.tagName.toLowerCase() +
      (typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '');
    const fails = new Map();
    const small = new Map();
    let textNodes = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (!t) continue;
      const el = node.parentElement;
      if (
        !el ||
        !visible(el) ||
        el.closest('.ex-sr, [disabled], [aria-disabled="true"]')
      )
        continue;
      textNodes++;
      const cs = getComputedStyle(el);
      const fg0 = parse(cs.color);
      if (!fg0) continue;
      const bg = bgOf(el);
      const fg = over(fg0, bg);
      const r = ratio(fg, bg);
      const px = parseFloat(cs.fontSize);
      const bold = parseInt(cs.fontWeight) >= 700;
      const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
      if (r < need) {
        const key = name(el) + cs.color;
        const e = fails.get(key) ?? {
          sel: name(el),
          ratio: +r.toFixed(2),
          need,
          n: 0,
          sample: t.slice(0, 40),
        };
        e.n++;
        fails.set(key, e);
      }
      if (px < 12) {
        const key = name(el) + px;
        const e = small.get(key) ?? {
          sel: name(el),
          px,
          n: 0,
          sample: t.slice(0, 40),
        };
        e.n++;
        small.set(key, e);
      }
    }
    const targets = [];
    const unnamed = [];
    for (const el of root.querySelectorAll(
      'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])',
    )) {
      if (!visible(el) || el.disabled || el.getAttribute('type') === 'hidden')
        continue;
      const r = el.getBoundingClientRect();
      const label = (
        el.getAttribute('aria-label') ||
        el.textContent ||
        el.getAttribute('title') ||
        (el.labels && el.labels.length ? 'label' : '')
      ).trim();
      if (!label) unnamed.push(name(el));
      if (r.width < 24 || r.height < 24)
        targets.push({
          sel: name(el),
          w: Math.round(r.width),
          h: Math.round(r.height),
          label: label.slice(0, 30),
        });
    }
    return {
      theme: document.documentElement.dataset.theme,
      hOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
      rootWidth: Math.round(root.getBoundingClientRect().width),
      textNodes,
      contrastFails: [...fails.values()],
      smallText: [...small.values()],
      smallTargets: targets,
      unnamed,
      h1: root.querySelectorAll('h1').length,
      main: document.querySelectorAll('main').length,
      title: document.title,
      liveRegions: root.querySelectorAll(
        '[aria-live], [role="status"], [role="alert"]',
      ).length,
    };
  };
}

export function finish(name, results) {
  const summary = { slice: name, failures, okCount: notes.length, results };
  console.log(
    `\n${name}: ${notes.length} checks passed, ${failures.length} failed`,
  );
  for (const message of failures) console.log(`FAIL ${message}`);
  return summary;
}
