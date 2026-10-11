import type { ExpungeJobSnapshotV2 } from '../../../shared/expunge';
import { formatMicrousd } from '../format';

type Limits = ExpungeJobSnapshotV2['limits'];

interface Row {
  key: string;
  label: string;
  used: number;
  cap: number;
  render: (value: number) => string;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const plain = (value: number) => value.toLocaleString();

/**
 * Counters with their caps, as text first and a bar second. The trusted execution service
 * keeps the real counters; this only displays them. Unpriced calls are a separate count and
 * are never folded into cost as zero.
 */
export function LimitsStrip({ limits }: { limits: Limits }) {
  const rows: Row[] = [
    {
      key: 'modelCalls',
      label: 'Model calls',
      ...limits.modelCalls,
      render: plain,
    },
    {
      key: 'toolCalls',
      label: 'Tool calls',
      ...limits.toolCalls,
      render: plain,
    },
    {
      key: 'scannedDocuments',
      label: 'Documents scanned',
      ...limits.scannedDocuments,
      render: plain,
    },
    {
      key: 'changedDocuments',
      label: 'Documents changed',
      ...limits.changedDocuments,
      render: plain,
    },
    {
      key: 'traversalDepth',
      label: 'Reference depth',
      ...limits.traversalDepth,
      render: plain,
    },
    {
      key: 'graphNodes',
      label: 'Graph nodes',
      ...limits.graphNodes,
      render: plain,
    },
    {
      key: 'graphEdges',
      label: 'Graph edges',
      ...limits.graphEdges,
      render: plain,
    },
    {
      key: 'totalTokens',
      label: 'Tokens',
      ...limits.totalTokens,
      render: plain,
    },
    {
      key: 'costMicrousd',
      label: 'Cost',
      ...limits.costMicrousd,
      render: formatMicrousd,
    },
    {
      key: 'wallTimeMs',
      label: 'Wall time',
      ...limits.wallTimeMs,
      render: seconds,
    },
  ];
  return (
    <div>
      <ul className="ex-limits" aria-label="Resource limits">
        {rows.map((row) => {
          const reached = row.cap > 0 && row.used >= row.cap;
          const width =
            row.cap > 0 ? Math.min(100, (row.used / row.cap) * 100) : 0;
          return (
            <li
              key={row.key}
              className={reached ? 'ex-limit ex-limit--reached' : 'ex-limit'}
            >
              <span className="ex-limit-label">{row.label}</span>
              <span className="ex-limit-value ex-num">
                {row.render(row.used)} of {row.render(row.cap)}
                {reached ? ' (limit reached)' : ''}
              </span>
              <span className="ex-limit-bar" aria-hidden>
                <span
                  className="ex-limit-fill"
                  style={{ inlineSize: `${width}%` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="ex-note">
        Unpriced calls: <span className="ex-num">{limits.unpricedCalls}</span>.{' '}
        {limits.unpricedCalls > 0
          ? 'Cost above excludes them; missing provider prices are not counted as zero cost.'
          : 'Every call so far has a provider price.'}
      </p>
    </div>
  );
}
