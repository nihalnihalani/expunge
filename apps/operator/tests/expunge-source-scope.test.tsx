import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SourceScopeNotice } from '../src/client/expunge/components/SourceScopeNotice.js';

// Fixed copy and semantic rendering only; no business records, receipts or service doubles.
it('does not infer original-source erasure from an absent target', () => {
  const html = renderToStaticMarkup(<SourceScopeNotice />);
  expect(html).toContain('role="note"');
  expect(html).toContain('Source target unreported.');
  expect(html).toContain('cannot establish erasure of the original source');
});

it('limits isolated snapshot and replay results to the copy', () => {
  const html = renderToStaticMarkup(
    <SourceScopeNotice sourceKind="isolated_replay" />,
  );
  expect(html).toContain('Isolated snapshot / replay.');
  expect(html).toContain('only to that copy');
  expect(html).toContain('does not erase the original source');
});

it('requires source effects and independent read-back for operational completion', () => {
  const html = renderToStaticMarkup(
    <SourceScopeNotice sourceKind="original" />,
  );
  expect(html).toContain('committed source effects and independent read-back');
  expect(html).not.toContain('source erased');
});

it('escapes source identifiers and exposes the full registration hash accessibly', () => {
  const html = renderToStaticMarkup(
    <SourceScopeNotice
      binding={{
        sourceId: '<script>identifier</script>',
        sourceKind: 'isolated_replay',
        registrationHash: 'a'.repeat(64),
        registrationRevision: 1,
        policyRevision: 2,
        authorizationRevision: 3,
      }}
    />,
  );
  expect(html).toContain('&lt;script&gt;identifier&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('Copy full source registration hash');
  expect(html).toContain('a'.repeat(64));
});
