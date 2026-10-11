import type {
  DeploymentVersionView,
  DeploymentView,
  TargetKind,
} from '../../../shared/expunge';
import { HashChip } from '../components/HashChip';
import { PageHeading } from '../components/PageHeading';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { TableWrap } from '../components/TableWrap';
import { formatTime, plural } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResource } from '../hooks/useResource';
import type { ViewMeta, ViewProps } from '../registry';
import { formatRoute } from '../routes';

export const meta: ViewMeta = {
  id: 'lineage',
  label: 'Lineage',
  routes: ['lineage'],
  scope: 'global',
  order: 30,
  navRoute: { name: 'lineage', target: 'worker' },
};

const TARGETS: TargetKind[] = ['worker', 'improver', 'hider'];

/**
 * A refused rollback as the backend would report it. The deployment projection does not carry
 * this yet (held change to the shared type and schema); the view renders it when present and
 * says plainly that nothing is reported when it is absent.
 */
export interface RefusedRollback {
  toHash: string;
  code: 'RollbackNeedsGrant' | 'RollbackClassMissing' | string;
  at: string;
}
export type LineageData = DeploymentView & {
  refusedRollbacks?: RefusedRollback[];
};

export interface PlacedVersion {
  version: DeploymentVersionView;
  depth: number;
}

/**
 * Orders versions as a forest by their recorded parent: roots first (no parent, or a parent that
 * is not in the list), then each node's children in list order. Cycle-safe, and no version is
 * ever dropped.
 */
export function placeVersions(
  versions: DeploymentVersionView[],
): PlacedVersion[] {
  const byHash = new Map(versions.map((item) => [item.hash, item]));
  const children = new Map<string, DeploymentVersionView[]>();
  const roots: DeploymentVersionView[] = [];
  for (const item of versions) {
    if (item.parentHash && byHash.has(item.parentHash))
      children.set(item.parentHash, [
        ...(children.get(item.parentHash) ?? []),
        item,
      ]);
    else roots.push(item);
  }
  const placed: PlacedVersion[] = [];
  const seen = new Set<string>();
  const visit = (item: DeploymentVersionView, depth: number) => {
    if (seen.has(item.hash)) return;
    seen.add(item.hash);
    placed.push({ version: item, depth });
    for (const child of children.get(item.hash) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // Anything left is part of a cycle; show it rather than lose it.
  for (const item of versions) visit(item, 0);
  return placed;
}

const STATE_CHIP = {
  active: 'ok',
  rolled_back: 'stale',
} as const;

/** True when the version was tested against a parent other than the one it names. */
export const testedAgainstOtherParent = (item: DeploymentVersionView) =>
  item.testedParentHash !== null && item.testedParentHash !== item.parentHash;

function VersionNode({ placed }: { placed: PlacedVersion }) {
  const { version, depth } = placed;
  return (
    <li
      className="ex-lin-node"
      data-state={version.state}
      style={{ marginInlineStart: `${Math.min(depth, 6) * 20}px` }}
    >
      <p className="ex-lin-head">
        <HashChip value={version.hash} label="version hash" />{' '}
        {version.state === 'previous' ? (
          <span className="ex-note">previous</span>
        ) : (
          <StatusChip
            state={STATE_CHIP[version.state]}
            label={version.state.replaceAll('_', ' ')}
          />
        )}
        {version.authorityClass && (
          <span className="ex-note">
            {' '}
            class {version.authorityClass.replaceAll('_', ' ')}
          </span>
        )}
      </p>
      <dl className="ex-dl ex-lin-dl">
        <dt>Parent</dt>
        <dd>
          {version.parentHash ? (
            <HashChip value={version.parentHash} label="parent hash" />
          ) : (
            'None (initial bundle)'
          )}
        </dd>
        <dt>Tested against</dt>
        <dd>
          {version.testedParentHash ? (
            <>
              <HashChip
                value={version.testedParentHash}
                label="tested parent hash"
              />
              {testedAgainstOtherParent(version) && (
                <>
                  {' '}
                  <StatusChip state="stale" label="differs from its parent" />
                </>
              )}
            </>
          ) : (
            'Not tested (not a promoted candidate)'
          )}
        </dd>
        {version.promotion && (
          <>
            <dt>Promotion</dt>
            <dd>
              <span className="ex-data">{version.promotion.promotionId}</span>{' '}
              <span className="ex-note">
                gate report{' '}
                <span className="ex-data">
                  {version.promotion.gateReportId}
                </span>
                , grant{' '}
                {version.promotion.consumedGrantId ? (
                  <span className="ex-data">
                    {version.promotion.consumedGrantId}
                  </span>
                ) : (
                  'none used (no grant required for this class)'
                )}
                , {formatTime(version.promotion.at)}
              </span>
            </dd>
          </>
        )}
        {version.rollback && (
          <>
            <dt>Rollback receipt</dt>
            <dd>
              <span className="ex-data">{version.rollback.promotionId}</span>{' '}
              <span className="ex-note">
                moved the pointer to{' '}
                <HashChip
                  value={version.rollback.toHash}
                  label="rollback target hash"
                />
                , {formatTime(version.rollback.at)}. Reason:{' '}
                {version.rollback.reason}
              </span>
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

export function LineageDocument({ data }: { data: LineageData }) {
  const placed = placeVersions(data.versions);
  return (
    <>
      <section className="ex-section" aria-labelledby="ex-lin-active-h">
        <h2 className="ex-h2" id="ex-lin-active-h">
          Active version
        </h2>
        <dl className="ex-dl">
          <dt>Target</dt>
          <dd>{data.target}</dd>
          <dt>Active</dt>
          <dd>
            <HashChip value={data.activeHash} label="active hash" />{' '}
            <span className="ex-note">pointer revision {data.revision}</span>
          </dd>
          <dt>Initial bundle</dt>
          <dd>
            <HashChip
              value={data.initialBundleHash}
              label="initial bundle hash"
            />
          </dd>
          <dt>Scope</dt>
          <dd className="ex-note">
            scope revision {data.scopeRevision}, authorization revision{' '}
            {data.authorizationRevision}
          </dd>
        </dl>
      </section>

      <section className="ex-section" aria-labelledby="ex-lin-chain-h">
        <h2 className="ex-h2" id="ex-lin-chain-h">
          Version lineage
        </h2>
        <p className="ex-note">
          {plural(data.versions.length, 'version')}, arranged by recorded
          parent; indentation shows a branch. Every field below is read from the
          deployment record. The table after it has the same rows.
        </p>
        {placed.length === 0 ? (
          <p className="ex-note">No versions are recorded for this target.</p>
        ) : (
          <ol className="ex-lin-chain" aria-label="Versions by parent">
            {placed.map((item) => (
              <VersionNode key={item.version.hash} placed={item} />
            ))}
          </ol>
        )}
        <TableWrap label="Version table">
          <table className="ex-table">
            <caption>Same versions as a table.</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">State</th>
                <th scope="col">Parent</th>
                <th scope="col">Tested against</th>
                <th scope="col">Class</th>
                <th scope="col">Promotion</th>
                <th scope="col">Grant</th>
                <th scope="col">Rollback</th>
              </tr>
            </thead>
            <tbody>
              {data.versions.map((item) => (
                <tr key={item.hash}>
                  <th scope="row">
                    <HashChip value={item.hash} label="version hash" />
                  </th>
                  <td>{item.state.replaceAll('_', ' ')}</td>
                  <td>
                    {item.parentHash ? (
                      <HashChip value={item.parentHash} label="parent hash" />
                    ) : (
                      'none'
                    )}
                  </td>
                  <td>
                    {item.testedParentHash ? (
                      <HashChip
                        value={item.testedParentHash}
                        label="tested parent hash"
                      />
                    ) : (
                      'not tested'
                    )}
                  </td>
                  <td>
                    {item.authorityClass?.replaceAll('_', ' ') ?? 'unknown'}
                  </td>
                  <td className="ex-data">
                    {item.promotion?.promotionId ?? 'none'}
                  </td>
                  <td className="ex-data">
                    {item.promotion?.consumedGrantId ??
                      (item.promotion ? 'none used' : 'none')}
                  </td>
                  <td className="ex-data">
                    {item.rollback?.promotionId ?? 'none'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="ex-section" aria-labelledby="ex-lin-rej-h">
        <h2 className="ex-h2" id="ex-lin-rej-h">
          Rejected candidates
        </h2>
        {data.rejected.length === 0 ? (
          <p className="ex-note">
            No rejected candidate is recorded for this target.
          </p>
        ) : (
          <ul className="ex-list">
            {data.rejected.map((item) => (
              <li key={item.candidateId}>
                <span className="ex-data">{item.candidateId}</span>{' '}
                <HashChip value={item.childHash} label="rejected child hash" />:{' '}
                {item.reasonCodes.map((code, index) => (
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

      <section className="ex-section" aria-labelledby="ex-lin-rb-h">
        <h2 className="ex-h2" id="ex-lin-rb-h">
          Rollback
        </h2>
        <p className="ex-note">
          A rollback moves the pointer to a version that was active before. One
          that would expand authority needs a bound grant, and a rollback with
          no grant to bind is refused rather than widening authority. This
          screen can request none.
        </p>
        {data.refusedRollbacks === undefined ? (
          <p className="ex-note">
            This projection does not report refused rollbacks, so none is shown;
            that is not a statement that none happened.
          </p>
        ) : data.refusedRollbacks.length === 0 ? (
          <p className="ex-note">No refused rollback is recorded.</p>
        ) : (
          <ul className="ex-list">
            {data.refusedRollbacks.map((item) => (
              <li key={`${item.toHash}:${item.at}`}>
                <StatusChip state="rejected" label="refused" />{' '}
                <code className="ex-code">{item.code}</code> for a rollback to{' '}
                <HashChip value={item.toHash} label="refused rollback target" />
                , {formatTime(item.at)}.
                {item.code === 'RollbackNeedsGrant' &&
                  ' The reverse transition would expand authority and no grant was bound.'}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Keyed by target so one target's data is never shown under another's heading. */
export default function LineageView({ route }: ViewProps) {
  if (route.name !== 'lineage') return null;
  return <LineagePage key={route.target} target={route.target} />;
}

function LineagePage({ target }: { target: TargetKind }) {
  useDocumentTitle(`Lineage · ${target}`);
  const read = useResource<LineageData>(`/deployments/${target}`);
  return (
    <div className="ex-page">
      <PageHeading eyebrow="Expunge" title={`Lineage: ${target}`}>
        Which harness version is active, what it descends from, what it was
        tested against, and what was promoted or rolled back.
      </PageHeading>
      <nav aria-label="Lineage targets">
        <ul className="ex-tabs">
          {TARGETS.map((item) => (
            <li key={item}>
              <a
                href={formatRoute({ name: 'lineage', target: item })}
                aria-current={item === target ? 'page' : undefined}
              >
                {item}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {read.status === 'loading' && <Skeleton label="lineage" />}
      {read.status === 'not_found' && (
        <EmptyState title={`No deployment for ${target}.`}>
          Nothing has been deployed for this target, so there is no lineage to
          show.
        </EmptyState>
      )}
      {read.status === 'unavailable' && (
        <UnavailableState
          what="Lineage"
          reason={
            read.error?.message ?? 'The deployment service is not reachable.'
          }
          onRecheck={read.refresh}
        />
      )}
      {(read.status === 'error' ||
        read.status === 'retrying' ||
        read.status === 'disconnected') &&
        !read.data && (
          <ErrorState
            what="the lineage"
            error={read.error}
            onRetry={read.refresh}
          />
        )}
      {read.data && <LineageDocument data={read.data} />}
    </div>
  );
}
