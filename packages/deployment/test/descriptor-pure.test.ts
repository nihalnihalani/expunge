import { buildExpertStaticBundle } from '@expunge/baselines';
import { classifyMutation } from '@expunge/harness-compiler';
import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index.js';
import { changeOf } from '../src/descriptor.js';
import { infra } from './support.js';

const expert = () => buildExpertStaticBundle(infra);

describe('flip changes read as what they are (DP-5)', () => {
  const componentsOf = (edit: (bundle: ReturnType<typeof expert>) => void) => {
    const parent = expert();
    const child = structuredClone(parent);
    edit(child);
    return classifyMutation(parent, child).components;
  };

  it('removing a restrictive rule is a widening of authority, never "removed"', () => {
    const [component] = componentsOf((child) => {
      child.guardrails = [];
    });
    expect(component).toMatchObject({ kind: 'authority_expansion', reason: 'restrictive rule removed' });
    expect(changeOf(component!)).toBe('widened');
  });
  it('removing a prerequisite is a widening, never "removed"', () => {
    const [component] = componentsOf((child) => {
      child.toolPolicy.prerequisites = child.toolPolicy.prerequisites.slice(1);
    });
    expect(component).toMatchObject({ kind: 'authority_expansion', reason: 'prerequisite removed' });
    expect(changeOf(component!)).toBe('widened');
  });
  it('an authority expansion is only ever added or widened', () => {
    const edits: Array<(bundle: ReturnType<typeof expert>) => void> = [
      (b) => (b.guardrails = []),
      (b) => (b.toolPolicy.prerequisites = []),
      (b) => (b.completionPolicy = 'model_narrative'),
      (b) => (b.limits.changedDocuments = b.limits.changedDocuments + 1),
      (b) => b.toolPolicy.grants.push('report_diagnostic'),
    ];
    for (const edit of edits)
      for (const component of componentsOf(edit).filter((c) => c.kind === 'authority_expansion'))
        expect(['added', 'widened'], component.reason).toContain(changeOf(component));
  });
  it('non-expanding components keep their own reading', () => {
    const [removed] = componentsOf((child) => {
      child.toolPolicy.grants = child.toolPolicy.grants.slice(1);
    });
    expect(removed).toMatchObject({ kind: 'tightening', reason: 'tool grant removed' });
    expect(changeOf(removed!)).toBe('removed');
  });
});

describe('the package surface (DP-1, DP-8)', () => {
  it('exports neither a fixture switch nor a race hook', () => {
    const names = Object.keys(pkg);
    for (const forbidden of [
      'allowTestFixtures',
      'fixtureFlag',
      'fixturesAllowed',
      'promoteWithHooks',
      'rollbackWithHooks',
      'TEST_FIXTURE_LABEL',
      'insertLabeledAdmitReport',
    ])
      expect(names, forbidden).not.toContain(forbidden);
  });
});
