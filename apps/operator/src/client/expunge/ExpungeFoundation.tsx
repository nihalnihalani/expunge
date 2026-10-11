import { useEffect, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { ExpungeFoundationStatus } from '../../shared/expunge';

/** Initial navigation seam. B3 owns the committed job/review workbench. */
export function ExpungeFoundation() {
  const [status, setStatus] = useState<ExpungeFoundationStatus>();
  const [error, setError] = useState('');
  const refresh = () =>
    api<ExpungeFoundationStatus>('/expunge/status')
      .then((value) => {
        setStatus(value);
        setError('');
      })
      .catch((value: unknown) =>
        setError(
          value instanceof Error
            ? value.message
            : 'Could not read Expunge status.',
        ),
      );
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <main className="main-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">EXPUNGE</span>
          <h1>Cleanup workbench</h1>
          <p>
            Follow database cleanup jobs, evidence and stored human reviews.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh Expunge status"
          onClick={() => void refresh()}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <section className="task-detail-card">
        <Database size={22} />
        <h2>
          {status?.domain === 'configured'
            ? 'Domain connection configured'
            : 'Connect the domain service'}
        </h2>
        <p>
          {status?.domain === 'configured'
            ? 'The operator is ready to request committed job projections. Service connectivity and cleanup readiness are checked when a job is loaded.'
            : 'The operator shell is running. A trusted domain service is required to submit jobs and read committed results.'}
        </p>
        <p className="muted">
          Cleanup status and approvals come from the domain service. A completed
          chat turn does not complete a cleanup job.
        </p>
      </section>
    </main>
  );
}
