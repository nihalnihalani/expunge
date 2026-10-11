import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { contrast, darkTheme } from '../src/build/dark-theme';

// DESIGN.md rules R1 to R4 and the verified contrast table, enforced against the real stylesheets
// and the real dark-theme plugin the shell builds with.
const dir = fileURLToPath(
  new URL('../src/client/expunge/css', import.meta.url),
);
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.css'))
  .sort();
const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const parse = (name: string) => postcss.parse(read(name));
const DARK = ":root[data-theme='dark'] .ex-root";

function* rules(node: postcss.Container): Generator<Rule> {
  for (const child of node.nodes ?? []) {
    if (child.type === 'rule') yield child;
    else if (
      child.type === 'atrule' &&
      !/keyframes$/.test((child as AtRule).name)
    )
      yield* rules(child as AtRule);
  }
}
function* declarations(node: postcss.Container): Generator<Declaration> {
  for (const child of node.nodes ?? []) {
    if (child.type === 'decl') yield child;
    else if ('nodes' in child && child.nodes)
      yield* declarations(child as postcss.Container);
  }
}

describe('expunge stylesheets', () => {
  it('exist and are non-empty', () => {
    expect(files).toContain('00-tokens.css');
    expect(files).toContain('10-base.css');
  });

  it('R1: every selector is scoped under .ex-root', () => {
    for (const name of files)
      for (const rule of rules(parse(name)))
        for (const selector of rule.selectors)
          expect(selector, `${name}: ${selector}`).toMatch(
            /^(\.ex-root|:root\[data-theme='dark'\] \.ex-root)(?![\w-])/,
          );
  });

  it('R2: no hex, white or black literal in any declaration', () => {
    for (const name of files)
      for (const decl of declarations(parse(name))) {
        expect(decl.value, `${name}: ${decl.prop}`).not.toMatch(
          /#[0-9a-fA-F]{3,8}\b/,
        );
        expect(decl.value, `${name}: ${decl.prop}`).not.toMatch(
          /\b(white|black)\b/i,
        );
      }
  });

  it('R3: no prefers-color-scheme query anywhere', () => {
    for (const name of files)
      parse(name).walkAtRules((atRule) =>
        expect(`${atRule.name} ${atRule.params}`, name).not.toMatch(
          /prefers-color-scheme/,
        ),
      );
  });

  it('R4: component rules take colors only from tokens', () => {
    for (const name of files.filter((file) => !file.startsWith('00-')))
      for (const decl of declarations(parse(name))) {
        if (decl.prop.startsWith('--')) continue;
        expect(decl.value, `${name}: ${decl.prop}`).not.toMatch(
          /\b(rgb|rgba|hsl|hsla|hwb|oklch|oklab|color-mix)\(/,
        );
      }
  });

  it('the shell dark-theme plugin adds nothing to the token file and only .ex-root twins elsewhere', async () => {
    const run = async (name: string) =>
      (await postcss([darkTheme()]).process(read(name), { from: undefined }))
        .root;
    const tokens = await run('00-tokens.css');
    expect([...rules(tokens)].map((rule) => rule.selector)).toEqual([
      '.ex-root',
      DARK,
    ]);
    for (const name of files.filter((file) => !file.startsWith('00-'))) {
      const out = await run(name);
      for (const rule of rules(out))
        if (rule.selector.startsWith(":root[data-theme='dark']"))
          expect(rule.selector, name).toMatch(
            /^:root\[data-theme='dark'\] \.ex-root(?![\w-])/,
          );
    }
  });
});

type Tokens = Record<string, string>;
function tokenBlock(selector: string): Tokens {
  const out: Tokens = {};
  for (const rule of rules(parse('00-tokens.css')))
    if (rule.selector === selector)
      rule.walkDecls((decl) => {
        const match = decl.value.match(/^rgb\((\d+) (\d+) (\d+)\)$/);
        if (match)
          out[decl.prop.replace(/^--ex-/, '')] =
            '#' +
            [match[1], match[2], match[3]]
              .map((part) => Number(part).toString(16).padStart(2, '0'))
              .join('');
      });
  return out;
}

describe('verified contrast pairs, recomputed from the shipped tokens', () => {
  const light = tokenBlock('.ex-root');
  const dark = tokenBlock(DARK);
  const text: Array<[string, string]> = [];
  for (const fg of ['ink', 'ink2', 'ink3'])
    for (const bg of [
      'canvas',
      'surface',
      'raised',
      'sunken',
      'narrative',
      'seal-subtle',
    ])
      text.push([fg, bg]);
  for (const bg of ['canvas', 'surface', 'sunken'])
    text.push(['seal-text', bg]);
  text.push(['seal-ink', 'seal'], ['seal-text', 'seal-subtle']);
  for (const state of ['success', 'warning', 'danger', 'neutral'])
    text.push([state, `${state}-bg`], [state, 'surface'], [state, 'canvas']);
  const ui: Array<[string, string]> = [
    ['rule-strong', 'surface'],
    ['rule-strong', 'canvas'],
    ['rule-strong', 'sunken'],
    ['ink', 'surface'],
    ['ink', 'canvas'],
    ['ink', 'seal-subtle'],
    ['ink', 'danger-bg'],
    ['seal', 'surface'],
    ['seal', 'canvas'],
    ['success', 'surface'],
    ['warning', 'surface'],
    ['danger', 'surface'],
  ];
  it('parses both token blocks completely', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(22);
  });
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('text pairs meet 4.5:1 (%s)', (_name, tokens) => {
    for (const [fg, bg] of text)
      expect(
        contrast(tokens[fg], tokens[bg]),
        `${fg} on ${bg}`,
      ).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('non-text pairs meet 3:1 (%s)', (_name, tokens) => {
    for (const [fg, bg] of ui)
      expect(
        contrast(tokens[fg], tokens[bg]),
        `${fg} on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
  });
});
