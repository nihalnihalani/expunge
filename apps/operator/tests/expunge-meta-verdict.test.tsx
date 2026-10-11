import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  MetaVerdict,
  RULE_COPY,
  VERDICT_COPY,
} from '../src/client/expunge/components/MetaVerdict';
import { parseArtifact } from '../src/server/expunge/schemas';
import type { MetaVerdictView } from '../src/shared/expunge';

const esc = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#x27;');
const verdict = (patch: Partial<MetaVerdictView> = {}): MetaVerdictView => ({
  verdict: 'tie',
  incidents: 8,
  wins: 3,
  losses: 2,
  ties: 3,
  p: 1,
  net: 1,
  noiseNet: 2,
  noDataNet: 1,
  ...patch,
});
const render = (v: MetaVerdictView | undefined) =>
  renderToStaticMarkup(<MetaVerdict verdict={v} />);

it('says no verdict is recorded when the artifact carries none, and states no gain, loss or tie', () => {
  const html = render(undefined);
  expect(html).toContain('No preregistered verdict recorded');
  expect(html).not.toMatch(/GAIN|LOSS|TIE/);
});

it('words TIE per the preregistration and shows every stored figure', () => {
  const html = render(verdict());
  expect(VERDICT_COPY.tie).toBe(
    'TIE: the difference cannot be distinguished from noise or from doing nothing.',
  );
  expect(html).toContain('stored verdict: TIE');
  expect(html).toContain(
    'cannot be distinguished from noise or from doing nothing',
  );
  expect(html).toContain('0.0000'.replace('0.0000', '1.0000'));
  expect(html).toContain('Ties dropped');
  expect(html).toContain('+1');
  expect(html).toContain('Noise');
  expect(html).toContain('No-data net');
  expect(html).toContain(esc(RULE_COPY));
  expect(html).toContain('this screen did not');
  expect(html).toContain('A tie or a null result is an acceptable outcome');
});

it('shows the STORED verdict, never one derived from the numbers', () => {
  // Numbers that would satisfy GAIN under the rule, stored as TIE: the stored word wins.
  const stored = render(
    verdict({
      verdict: 'tie',
      p: 0.01,
      net: 6,
      noiseNet: 1,
      noDataNet: 0,
      wins: 7,
      losses: 1,
    }),
  );
  expect(stored).toContain('stored verdict: TIE');
  expect(stored).not.toContain('stored verdict: GAIN');
  // Numbers that would be a TIE, stored as GAIN: still the stored word.
  const other = render(
    verdict({ verdict: 'gain', p: 0.9, net: 0, wins: 1, losses: 1 }),
  );
  expect(other).toContain('stored verdict: GAIN');
  expect(other).not.toContain('stored verdict: TIE');
  const loss = render(
    verdict({ verdict: 'loss', net: -5, p: 0.02, wins: 1, losses: 6 }),
  );
  expect(loss).toContain('stored verdict: LOSS');
  expect(loss).toContain('-5');
  expect(loss).toContain(esc(VERDICT_COPY.loss));
});

it('accepts the stored verdict through the campaign schema, with negative nets, and rejects malformed ones', () => {
  const base = {
    campaignId: 'c1',
    kind: 'meta',
    manifestHash: 'a'.repeat(64),
    plannedRows: 0,
    w0ResetProof: null,
    budgetHash: null,
    rows: [],
    quarantined: [],
    noiseControl: { present: false, rowId: null },
    noDataControl: { present: false, rowId: null },
  };
  const parse = (metaVerdict: unknown) =>
    parseArtifact({
      artifactId: 'c1',
      kind: 'campaign',
      jobId: 'job-1',
      committedAtSequence: 1,
      contentHash: null,
      payload: {
        ...base,
        ...(metaVerdict === undefined ? {} : { metaVerdict }),
      },
    });
  expect(
    (parse(undefined).payload as { metaVerdict?: unknown }).metaVerdict,
  ).toBeUndefined();
  expect(
    (
      parse(verdict({ net: -3, noDataNet: -1 })).payload as {
        metaVerdict: MetaVerdictView;
      }
    ).metaVerdict.net,
  ).toBe(-3);
  for (const bad of [
    { ...verdict(), verdict: 'maybe' },
    { ...verdict(), p: 1.5 },
    { ...verdict(), p: -0.1 },
    { ...verdict(), wins: -1 },
    { ...verdict(), net: 1.5 },
    { ...verdict(), p: 'x' },
  ])
    expect(() => parse(bad)).toThrow();
  // Unknown fields are stripped, not forwarded.
  const stripped = parse({ ...verdict(), score: 99 }).payload as {
    metaVerdict: Record<string, unknown>;
  };
  expect(stripped.metaVerdict.score).toBeUndefined();
});

it('shows a negative noise net with its sign and uses the amended rule text', () => {
  const html = render(verdict({ noiseNet: -2 }));
  expect(html).toContain('Noise net (I0 against I0, same incidents)');
  expect(html).toContain('-2');
  expect(html).toContain(esc('net > |noiseNet|'));
  expect(html).not.toContain('noiseMaxAbsNet');
  expect(html).toContain('The unit is the incident');
});

it('accepts the gate decision summary through the gate_report schema (signed trigger gain, partial splits) and strips unknown fields', () => {
  const report = {
    reportId: 'g1',
    candidateId: 'c1',
    parentHash: 'a'.repeat(64),
    childHash: 'b'.repeat(64),
    evaluatorHash: 'c'.repeat(64),
    fixtureGeneratorHash: 'd'.repeat(64),
    runtimeHash: 'e'.repeat(64),
    workerProfileHash: 'f'.repeat(64),
    splitManifestCommitment: '1'.repeat(64),
    pairs: [],
    plannedPairs: 0,
    trialRowsDigest: '2'.repeat(64),
    controls: [],
    knownAuthorityFlips: [],
    totalCostMicrousd: 0,
    unpricedCalls: 0,
    verdict: 'reject',
    reasonCodes: [],
  };
  const parse = (decisionSummary?: unknown) =>
    parseArtifact({
      artifactId: 'g1',
      kind: 'gate_report',
      jobId: null,
      committedAtSequence: 1,
      contentHash: null,
      payload: {
        ...report,
        ...(decisionSummary === undefined ? {} : { decisionSummary }),
      },
    }).payload as { decisionSummary?: Record<string, unknown> };
  expect(parse().decisionSummary).toBeUndefined();
  const stored = parse({
    triggerGain: -1,
    triggerRequiredGain: 1,
    splits: { train: { trials: 4, parentSuccesses: 3, candidateSuccesses: 2 } },
    protectedRegressedWorlds: 0,
    secret: 'x',
  });
  expect(stored.decisionSummary?.triggerGain).toBe(-1);
  expect(stored.decisionSummary?.secret).toBeUndefined();
  expect(() =>
    parse({
      triggerGain: 1.5,
      triggerRequiredGain: 1,
      splits: {},
      protectedRegressedWorlds: 0,
    }),
  ).toThrow();
  expect(() =>
    parse({
      triggerGain: 1,
      triggerRequiredGain: 1,
      splits: {
        nonsense: { trials: 1, parentSuccesses: 0, candidateSuccesses: 0 },
      },
      protectedRegressedWorlds: 0,
    }),
  ).toThrow();
});
