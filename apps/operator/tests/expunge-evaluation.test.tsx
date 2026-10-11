import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  EvaluationDocument,
  PAIR_PAGE,
  reportRefs,
  summarizePairs,
} from '../src/client/expunge/views/EvaluationView';
import type {
  GateReportView,
  TrialMetricsView,
  TrialPairView,
} from '../src/shared/expunge';
import { baseSnapshot } from './fixtures/expunge-data';

const m = (patch: Partial<TrialMetricsView> = {}): TrialMetricsView => ({
  usefulCompletion: true,
  targetedResiduals: 0,
  unrelatedRecordChanges: 0,
  retentionViolations: 0,
  truthfulTerminal: true,
  refused: false,
  timedOut: false,
  failed: false,
  retryFailures: 0,
  tokens: 1,
  costMicrousd: 1000,
  unpricedCalls: 0,
  wallTimeMs: 1,
  ...patch,
});
const pair = (
  pairId: string,
  split: TrialPairView['split'],
  parent: Partial<TrialMetricsView> = {},
  candidate: Partial<TrialMetricsView> = {},
): TrialPairView => ({
  pairId,
  split,
  family: 'fam',
  seedCommitment: 'c'.repeat(64),
  parent: m(parent),
  candidate: m(candidate),
});
const h = (c: string) => c.repeat(64);
const report = (patch: Partial<GateReportView> = {}): GateReportView => ({
  reportId: 'gate-1',
  candidateId: 'cand-1',
  parentHash: h('a'),
  childHash: h('b'),
  evaluatorHash: h('c'),
  fixtureGeneratorHash: h('d'),
  runtimeHash: h('e'),
  workerProfileHash: h('f'),
  splitManifestCommitment: h('1'),
  pairs: [],
  plannedPairs: 0,
  trialRowsDigest: h('2'),
  controls: [],
  knownAuthorityFlips: [],
  totalCostMicrousd: 0,
  unpricedCalls: 0,
  verdict: 'reject',
  reasonCodes: ['retention_violation'],
  ...patch,
});

it('summarizes only what the rows contain, and counts planned pairs that have no row', () => {
  const summary = summarizePairs(
    [
      pair('p1', 'protected', {}, { usefulCompletion: false }),
      pair('p2', 'protected'),
      pair('t1', 'train', { usefulCompletion: false }, {}),
      pair(
        'v1',
        'validation',
        {},
        { retentionViolations: 3, refused: true, truthfulTerminal: false },
      ),
    ],
    6,
  );
  expect(summary).toMatchObject({
    recorded: 4,
    planned: 6,
    missing: 2,
    improved: 1,
    regressed: 1,
    protectedTotal: 2,
    protectedRegressed: 1,
    retentionViolations: { parent: 0, candidate: 3 },
    refused: { parent: 0, candidate: 1 },
    untruthful: { parent: 0, candidate: 1 },
  });
  expect(summarizePairs([], 0).missing).toBe(0);
  expect(summarizePairs([pair('p1', 'train')], 0).missing).toBe(0);
});

it('shows the gate verdict, reason codes, protected regressions and missing pairs', () => {
  const html = renderToStaticMarkup(
    <EvaluationDocument
      report={report({
        pairs: [
          pair(
            'p1',
            'protected',
            {},
            { usefulCompletion: false, retentionViolations: 4 },
          ),
        ],
        plannedPairs: 3,
        knownAuthorityFlips: ['tool:delete:payments_archive'],
      })}
    />,
  );
  expect(html).toContain('gate verdict: reject');
  expect(html).toContain('Why it was not admitted');
  expect(html).toContain('retention_violation');
  expect(html).toContain('1 of 3 planned pairs recorded');
  expect(html).toContain('2 not recorded');
  expect(html).toContain('Protected cases: 1 of 1 regressed');
  expect(html).toContain('tool:delete:payments_archive');
  expect(html).not.toContain('ex-seal');
});

it('never reads an unpriced call as zero cost, and says when there are no controls', () => {
  const html = renderToStaticMarkup(
    <EvaluationDocument
      report={report({
        verdict: 'admit',
        unpricedCalls: 3,
        totalCostMicrousd: 5000,
        pairs: [pair('p1', 'train', {}, { unpricedCalls: 2, costMicrousd: 0 })],
        plannedPairs: 1,
      })}
    />,
  );
  expect(html).toContain('3 calls had no provider price');
  expect(html).toContain('not as zero cost');
  expect(html).toContain('+ 2 unpriced');
  expect(html).toContain('names no control rows');
  expect(html).toContain('gate verdict: admit');
});

it('lists controls with counts and no rate when there were no episodes', () => {
  const html = renderToStaticMarkup(
    <EvaluationDocument
      report={report({
        controls: [
          {
            controlId: 'expert_static',
            label: 'Expert static harness',
            successes: 8,
            episodes: 10,
            costMicrousd: 1000,
          },
          {
            controlId: 'wrong_incident',
            label: 'Wrong-incident control',
            successes: 0,
            episodes: 0,
            costMicrousd: 0,
          },
        ],
      })}
    />,
  );
  expect(html).toContain('Expert static harness');
  expect(html).toContain('80%');
  expect(html).toContain('no episodes');
});

it('orders protected rows first and pages large reports', () => {
  const pairs = Array.from({ length: PAIR_PAGE + 5 }, (_, index) =>
    pair(
      `row-${String(index).padStart(3, '0')}`,
      index === PAIR_PAGE + 4 ? 'protected' : 'train',
    ),
  );
  const html = renderToStaticMarkup(
    <EvaluationDocument
      report={report({ pairs, plannedPairs: pairs.length })}
    />,
  );
  expect(html).toContain(`Showing ${PAIR_PAGE} of ${PAIR_PAGE + 5}`);
  expect(html.indexOf('row-054')).toBeGreaterThan(-1);
  expect(html.indexOf('row-054')).toBeLessThan(html.indexOf('row-000'));
  expect(html).toContain('Show 5 more pairs');
  expect(html).not.toContain('row-053');
});

it('finds gate reports in the committed artifact index only', () => {
  expect(
    reportRefs(
      baseSnapshot('job-1', {
        artifacts: [
          { artifactId: 'a', kind: 'candidate', committedAtSequence: 1 },
          { artifactId: 'g', kind: 'gate_report', committedAtSequence: 2 },
        ],
      }),
    ).map((item) => item.artifactId),
  ).toEqual(['g']);
  expect(reportRefs(baseSnapshot('job-1'))).toEqual([]);
});

it('shows the unpriced suffix for a PARENT with unpriced calls, not only the candidate', () => {
  const html = renderToStaticMarkup(
    <EvaluationDocument
      report={report({
        pairs: [pair('p1', 'train', { unpricedCalls: 3, costMicrousd: 0 }, {})],
        plannedPairs: 1,
        unpricedCalls: 3,
      })}
    />,
  );
  expect(html).toContain('+ 3 unpriced');
  // The cost sentence says unpriced calls are not zero cost.
  expect(html).toContain('3 calls had no provider price');
  expect(html).toContain('not as zero cost');
  // And no suffix appears when nothing is unpriced.
  const priced = renderToStaticMarkup(
    <EvaluationDocument
      report={report({ pairs: [pair('p1', 'train')], plannedPairs: 1 })}
    />,
  );
  expect(priced).not.toContain('unpriced');
  expect(priced).toContain('Every call was priced');
});

it('takes the verdict chip and the "not admitted" heading from the stored report.verdict, never from the counts', () => {
  const chip = (html: string) =>
    html.match(
      /data-state="([a-z_]+)"[^>]*>(?:(?!<\/span>).)*gate verdict: (\w+)/s,
    );
  // reject while nothing regressed
  const rejectNoRegress = renderToStaticMarkup(
    <EvaluationDocument
      report={report({
        verdict: 'reject',
        reasonCodes: ['gate_policy'],
        pairs: [pair('p1', 'train', { usefulCompletion: false }, {})],
        plannedPairs: 1,
      })}
    />,
  );
  expect(
    summarizePairs([pair('p1', 'train', { usefulCompletion: false }, {})], 1)
      .regressed,
  ).toBe(0);
  expect(chip(rejectNoRegress)?.[1]).toBe('rejected');
  expect(rejectNoRegress).toContain('gate verdict: reject');
  expect(rejectNoRegress).toContain('Why it was not admitted');
  // hold while nothing regressed
  const holdNoRegress = renderToStaticMarkup(
    <EvaluationDocument
      report={report({
        verdict: 'hold',
        reasonCodes: ['insufficient_pairs'],
        pairs: [pair('p1', 'protected')],
        plannedPairs: 3,
      })}
    />,
  );
  expect(chip(holdNoRegress)?.[1]).toBe('unknown');
  expect(holdNoRegress).toContain('gate verdict: hold');
  expect(holdNoRegress).toContain('Why it was not admitted');
  expect(holdNoRegress).not.toContain('gate verdict: admit');
  // admit while a protected pair regressed
  const admitWithRegression = renderToStaticMarkup(
    <EvaluationDocument
      report={report({
        verdict: 'admit',
        reasonCodes: ['within_tolerance'],
        pairs: [pair('p1', 'protected', {}, { usefulCompletion: false })],
        plannedPairs: 1,
      })}
    />,
  );
  expect(
    summarizePairs(
      [pair('p1', 'protected', {}, { usefulCompletion: false })],
      1,
    ).protectedRegressed,
  ).toBe(1);
  expect(chip(admitWithRegression)?.[1]).toBe('ok');
  expect(admitWithRegression).toContain('gate verdict: admit');
  expect(admitWithRegression).not.toContain('Why it was not admitted');
  expect(admitWithRegression).toContain('Notes');
  // the verdict is not a function of the counts: same pairs, different stored verdicts
  const sameCounts = (verdict: 'admit' | 'reject' | 'hold') =>
    renderToStaticMarkup(
      <EvaluationDocument
        report={report({
          verdict,
          reasonCodes: ['x'],
          pairs: [pair('p1', 'train')],
          plannedPairs: 1,
        })}
      />,
    );
  expect(chip(sameCounts('admit'))?.[2]).toBe('admit');
  expect(chip(sameCounts('reject'))?.[2]).toBe('reject');
  expect(chip(sameCounts('hold'))?.[2]).toBe('hold');
});

it("shows the gate's STORED summary as authoritative and labels the browser recount, which can differ (trigger gain counts training pairs only)", () => {
  const pairs = [
    pair('t1', 'train', { usefulCompletion: false }, {}),
    pair('v1', 'validation', { usefulCompletion: false }, {}),
    pair('f1', 'final', { usefulCompletion: false }, {}),
  ];
  // Recount over all pairs: 3 improved. The gate's stored trigger gain (train only): 1.
  expect(summarizePairs(pairs, 3).improved).toBe(3);
  const html = renderToStaticMarkup(
    <EvaluationDocument
      report={{
        ...report({
          verdict: 'admit',
          pairs,
          plannedPairs: 3,
          reasonCodes: [],
        }),
        decisionSummary: {
          triggerGain: 1,
          triggerRequiredGain: 1,
          splits: {
            train: { trials: 1, parentSuccesses: 0, candidateSuccesses: 1 },
            protected: { trials: 0, parentSuccesses: 0, candidateSuccesses: 0 },
          },
          protectedRegressedWorlds: 0,
        },
      }}
    />,
  );
  expect(html).toContain('The gate&#x27;s stored summary');
  expect(html).toContain('Trigger gain (training pairs only)');
  expect(html).toMatch(
    /Trigger gain \(training pairs only\):[^<]*<strong[^>]*>1</,
  );
  expect(html).toContain('Counted from the recorded pairs');
  expect(html).toContain('and can differ from them');
  expect(html).toContain('3 pairs improved');
  // The stored figure and the recount are both present and distinguishable.
  expect(html.indexOf('The gate&#x27;s stored summary')).toBeLessThan(
    html.indexOf('Counted from the recorded pairs'),
  );
});

it('says the stored summary is absent, and that the counts are made here, when the projection lacks it', () => {
  const html = renderToStaticMarkup(
    <EvaluationDocument
      report={report({ pairs: [pair('t1', 'train')], plannedPairs: 1 })}
    />,
  );
  expect(html).toContain('stored summary is not in this projection');
  expect(html).toContain('not read from the gate');
  expect(html).toContain('Counted from the recorded pairs');
  expect(html).not.toContain('Trigger gain');
});
