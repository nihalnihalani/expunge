import type {
  ArtifactEnvelope,
  CampaignDetailRowView,
  CampaignRowPayload,
  CampaignView as CampaignData,
  ExpungeJobSnapshotV2,
} from '../../../shared/expunge';
import { HashChip } from '../components/HashChip';
import { MetaVerdict } from '../components/MetaVerdict';
import { PageHeading } from '../components/PageHeading';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { TableWrap } from '../components/TableWrap';
import { plural } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResource } from '../hooks/useResource';
import type { ViewMeta, ViewProps } from '../registry';
import { formatRoute } from '../routes';

export const meta: ViewMeta = {
  id: 'campaign',
  label: 'Campaigns',
  routes: ['campaign'],
  scope: 'global',
  order: 50,
};

/** A row result as it may arrive. 'tie' is worded when a backend reports it; anything else is shown as unrecognized. */
export type RowResult = CampaignRowPayload['result'] | 'tie';
export type CampaignRow = Omit<CampaignDetailRowView, 'result'> & {
  result: string;
  /** The incident-level result of the row's two workers, when the backend reports it (a different field from the validity result). */
  incidentOutcome?: string;
  successes?: { a: number; b: number; runs: number };
};

/**
 * The only sentences on this screen that contain the words "gain" or "improve". Everything else
 * is data as recorded; a test strips these and then asserts no gain or improvement wording remains.
 */
export const FIXED_GAIN_SENTENCES = {
  rowsNote:
    'This screen reports rows. It states no gain and no conclusion; a null result stays a null result.',
  noDataWhy:
    'Without it a gain cannot be separated from the harness doing nothing.',
  lede: 'Rows, validity checks and results exactly as recorded. No gain is computed here.',
} as const;
export type CampaignDoc = Omit<CampaignData, 'rows'> & { rows: CampaignRow[] };

export const RESULT_COPY: Record<RowResult, string> = {
  measured: 'Measured: the row produced a result that is recorded as measured.',
  null: 'Null result: no effect was measured. A null result is a result.',
  tie: 'Tie: the arms did not differ.',
  invalid:
    'Invalid: the row did not meet the campaign rules and carries no result.',
};
const known = (value: string): value is RowResult =>
  Object.prototype.hasOwnProperty.call(RESULT_COPY, value);

export interface CampaignSummary {
  recorded: number;
  planned: number;
  missing: number;
  counts: Record<RowResult | 'unrecognized', number>;
  /** Rows whose budget hash differs from the campaign's, or that carry none while the campaign has one. */
  budgetMismatched: string[];
  /** Rows whose W0 reset proof differs from the campaign's, or that carry none while the campaign has one. */
  resetMismatched: string[];
  quarantined: number;
}

/** Pure aggregation; it counts rows and compares recorded hashes. It computes no gain. */
export function summarizeCampaign(view: CampaignDoc): CampaignSummary {
  const counts: CampaignSummary['counts'] = {
    measured: 0,
    null: 0,
    tie: 0,
    invalid: 0,
    unrecognized: 0,
  };
  for (const row of view.rows)
    counts[known(row.result) ? row.result : 'unrecognized'] += 1;
  return {
    recorded: view.rows.length,
    planned: view.plannedRows,
    missing: Math.max(0, view.plannedRows - view.rows.length),
    counts,
    budgetMismatched:
      view.budgetHash === null
        ? []
        : view.rows
            .filter((row) => row.budgetHash !== view.budgetHash)
            .map((row) => row.rowId),
    resetMismatched:
      view.w0ResetProof === null
        ? []
        : view.rows
            .filter((row) => row.w0ResetProof !== view.w0ResetProof)
            .map((row) => row.rowId),
    quarantined: view.quarantined.length,
  };
}

function ControlLine({
  label,
  control,
  why,
}: {
  label: string;
  control: { present: boolean; rowId: string | null };
  why: string;
}) {
  return (
    <li>
      <strong>{label}:</strong>{' '}
      {control.present ? (
        <>
          present
          {control.rowId && (
            <>
              {' '}
              (row <span className="ex-data">{control.rowId}</span>)
            </>
          )}
          .
        </>
      ) : (
        <>
          <StatusChip state="incomplete" label="missing" /> {why}
        </>
      )}
    </li>
  );
}

export function CampaignDocument({ view }: { view: CampaignDoc }) {
  const summary = summarizeCampaign(view);
  return (
    <>
      <section className="ex-section" aria-labelledby="ex-cp-id-h">
        <h2 className="ex-h2" id="ex-cp-id-h">
          {view.kind === 'hider' ? 'Hider campaign' : 'Meta campaign'}
        </h2>
        <dl className="ex-dl">
          <dt>Campaign</dt>
          <dd className="ex-data">{view.campaignId}</dd>
          <dt>Manifest</dt>
          <dd>
            <HashChip value={view.manifestHash} label="manifest hash" />
          </dd>
          <dt>W0 reset proof</dt>
          <dd>
            {view.w0ResetProof ? (
              <code className="ex-code">{view.w0ResetProof}</code>
            ) : (
              <>
                <StatusChip state="incomplete" label="not recorded" /> Rows
                cannot be attributed to a clean baseline.
              </>
            )}
          </dd>
          <dt>Budget envelope</dt>
          <dd>
            {view.budgetHash ? (
              <HashChip value={view.budgetHash} label="budget hash" />
            ) : (
              <>
                <StatusChip state="incomplete" label="not recorded" /> Equal
                budgets cannot be shown.
              </>
            )}
          </dd>
        </dl>
      </section>

      <section className="ex-section" aria-labelledby="ex-cp-valid-h">
        <h2 className="ex-h2" id="ex-cp-valid-h">
          Validity
        </h2>
        <ul className="ex-list">
          <li>
            {summary.recorded} of {summary.planned} planned rows recorded.
            {summary.missing > 0 && (
              <>
                {' '}
                <StatusChip
                  state="incomplete"
                  label={`${summary.missing} not recorded`}
                />
              </>
            )}
          </li>
          <li>
            {view.budgetHash === null
              ? 'Equal budgets: not shown (no budget envelope recorded).'
              : summary.recorded === 0
                ? 'Equal budgets: no rows recorded yet, so nothing is compared.'
                : summary.budgetMismatched.length === 0
                  ? `Equal budgets: ${summary.recorded === 1 ? 'the 1 row carries' : `all ${summary.recorded} rows carry`} the campaign's budget hash.`
                  : `Budget mismatch: ${plural(summary.budgetMismatched.length, 'row')} ${summary.budgetMismatched.length === 1 ? 'does' : 'do'} not carry the campaign's budget hash (${summary.budgetMismatched.join(', ')}).`}
          </li>
          <li>
            {view.w0ResetProof === null
              ? 'W0 reset: not shown (no proof recorded).'
              : summary.recorded === 0
                ? 'W0 reset: no rows recorded yet, so nothing is compared.'
                : summary.resetMismatched.length === 0
                  ? `W0 reset: ${summary.recorded === 1 ? 'the 1 row carries' : `all ${summary.recorded} rows carry`} the campaign's reset proof.`
                  : `W0 reset mismatch: ${plural(summary.resetMismatched.length, 'row')} ${summary.resetMismatched.length === 1 ? 'does' : 'do'} not carry the campaign's reset proof (${summary.resetMismatched.join(', ')}).`}
          </li>
          <ControlLine
            label="Noise control"
            control={view.noiseControl}
            why="Without it a difference cannot be separated from noise."
          />
          <ControlLine
            label="No-data control"
            control={view.noDataControl}
            why={FIXED_GAIN_SENTENCES.noDataWhy}
          />
        </ul>
        <p className="ex-note">
          Novelty is not part of this projection, so no novelty claim is made
          here.
        </p>
      </section>

      {view.kind === 'meta' && (
        <section className="ex-section" aria-labelledby="ex-cp-verdict-h">
          <h2 className="ex-h2" id="ex-cp-verdict-h">
            Preregistered verdict
          </h2>
          <MetaVerdict verdict={view.metaVerdict} />
        </section>
      )}

      <section className="ex-section" aria-labelledby="ex-cp-rows-h">
        <h2 className="ex-h2" id="ex-cp-rows-h">
          Rows and results
        </h2>
        <p>
          Measured {summary.counts.measured}, null {summary.counts.null}
          {summary.counts.tie > 0 ? `, tie ${summary.counts.tie}` : ''}, invalid{' '}
          {summary.counts.invalid}
          {summary.counts.unrecognized > 0
            ? `, not recognized ${summary.counts.unrecognized}`
            : ''}
          .
        </p>
        <p className="ex-note">{FIXED_GAIN_SENTENCES.rowsNote}</p>
        {view.rows.length === 0 ? (
          <p className="ex-note">No rows are recorded.</p>
        ) : (
          <TableWrap label="Campaign rows">
            <table className="ex-table">
              <caption className="ex-sr">Campaign rows</caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Result</th>
                  <th scope="col">Incident outcome</th>
                  <th scope="col">Admitted</th>
                  <th scope="col">W0 reset proof</th>
                  <th scope="col">Budget</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.rowId}>
                    <th scope="row" className="ex-data">
                      {row.rowId}
                    </th>
                    <td>
                      <StatusChip
                        state={
                          row.result === 'measured'
                            ? 'ok'
                            : row.result === 'invalid'
                              ? 'fail'
                              : 'unknown'
                        }
                        label={
                          known(row.result) ? row.result : 'not recognized'
                        }
                      />{' '}
                      <span className="ex-note">
                        {known(row.result)
                          ? RESULT_COPY[row.result]
                          : 'This build does not recognize this result, so it is not interpreted.'}
                      </span>
                    </td>
                    <td>
                      {row.incidentOutcome === undefined
                        ? 'not reported'
                        : row.incidentOutcome}
                      {row.successes && (
                        <span className="ex-note">
                          {' '}
                          (workers {row.successes.a} and {row.successes.b} of{' '}
                          {row.successes.runs} runs)
                        </span>
                      )}
                    </td>
                    <td>
                      {row.admitted === undefined
                        ? 'not reported'
                        : row.admitted
                          ? 'yes'
                          : 'no'}
                    </td>
                    <td className="ex-data">{row.w0ResetProof ?? 'none'}</td>
                    <td>
                      {row.budgetHash ? (
                        <>
                          <HashChip
                            value={row.budgetHash}
                            label="row budget hash"
                          />
                          {view.budgetHash &&
                            row.budgetHash !== view.budgetHash && (
                              <>
                                {' '}
                                <StatusChip
                                  state="fail"
                                  label="differs from campaign"
                                />
                              </>
                            )}
                        </>
                      ) : (
                        'none'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <section className="ex-section" aria-labelledby="ex-cp-q-h">
        <h2 className="ex-h2" id="ex-cp-q-h">
          Quarantined rows
        </h2>
        {view.quarantined.length === 0 ? (
          <p className="ex-note">No row is quarantined.</p>
        ) : (
          <ul className="ex-list">
            {view.quarantined.map((item) => (
              <li key={item.rowId}>
                <span className="ex-data">{item.rowId}</span>:{' '}
                {item.reasonCodes.length === 0
                  ? 'no reason recorded'
                  : item.reasonCodes.map((code, index) => (
                      <span key={code}>
                        {index > 0 && ', '}
                        <code className="ex-code">{code}</code>
                      </span>
                    ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Body({ jobId }: { jobId: string }) {
  const job = useResource<ExpungeJobSnapshotV2>(
    `/jobs/${encodeURIComponent(jobId)}`,
  );
  const ref = job.data?.artifacts.find((item) => item.kind === 'campaign');
  const read = useResource<ArtifactEnvelope<CampaignDoc>>(
    ref ? `/artifacts/${encodeURIComponent(ref.artifactId)}` : null,
  );
  if (job.status === 'loading') return <Skeleton label="campaign" />;
  if (job.status === 'not_found')
    return (
      <EmptyState title="This job is not available from the projection." />
    );
  if (job.status === 'unavailable')
    return (
      <UnavailableState
        what="The campaign"
        reason={job.error?.message ?? 'The domain service is not reachable.'}
        onRecheck={job.refresh}
      />
    );
  if (!job.data)
    return (
      <ErrorState what="the job" error={job.error} onRetry={job.refresh} />
    );
  if (!ref)
    return (
      <EmptyState title="No campaign is recorded for this job.">
        Nothing is shown in its place.
      </EmptyState>
    );
  if (read.status === 'loading') return <Skeleton label="campaign" />;
  if (!read.data)
    return (
      <ErrorState
        what="the campaign"
        error={read.error}
        onRetry={read.refresh}
      />
    );
  return <CampaignDocument view={read.data.payload} />;
}

export default function CampaignPage({ route }: ViewProps) {
  const jobId = route.name === 'campaign' ? route.jobId : '';
  useDocumentTitle(`Campaign · ${jobId}`);
  if (route.name !== 'campaign') return null;
  return (
    <div className="ex-page">
      <nav aria-label="Breadcrumb" className="ex-crumbs">
        <a className="ex-link" href={formatRoute({ name: 'home' })}>
          Jobs
        </a>
        <span aria-hidden> / </span>
        <a
          className="ex-link ex-data"
          href={formatRoute({ name: 'job', jobId, tab: 'workbench' })}
        >
          {jobId}
        </a>
      </nav>
      <PageHeading eyebrow="Expunge" title="Hider and meta campaigns">
        {FIXED_GAIN_SENTENCES.lede}
      </PageHeading>
      <Body key={jobId} jobId={jobId} />
    </div>
  );
}
