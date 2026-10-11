import { useEffect, useState } from 'react';
import { authHeaders } from '../api';

export type TelemetryState = 'disabled' | 'enabled' | 'unknown';

/** Pure copy so it can be tested; the state comes from the server environment. */
export function telemetrySentence(state: TelemetryState) {
  if (state === 'disabled')
    return 'Setup and usage telemetry is disabled by default in this build. To enable it, set EXPUNGE_ALLOW_TELEMETRY=1 in the server environment and restart.';
  if (state === 'enabled')
    return 'Setup and usage metadata is collected. To disable it, set DO_NOT_TRACK=1 in the server environment and restart.';
  return 'The telemetry setting could not be read from the server.';
}

let cached: Promise<TelemetryState> | undefined;
export function readTelemetry(): Promise<TelemetryState> {
  cached ??= fetch('/api/expunge/status', { headers: authHeaders() })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { telemetry?: string } | null) =>
      body?.telemetry === 'disabled' || body?.telemetry === 'enabled'
        ? body.telemetry
        : 'unknown',
    )
    .catch(() => 'unknown' as const)
    .then((state) => {
      // An unreadable answer (401 before the owner token is set, a network error) is not cached,
      // so the next notice that mounts asks the server again (DA-7 TN1).
      if (state === 'unknown') cached = undefined;
      return state;
    });
  return cached;
}
/** Test hook. */
export function resetTelemetryCache() {
  cached = undefined;
}

/**
 * Replaces the shell's static "collected by default" notice with the server's actual
 * state. Kept free of other Expunge imports so the shell does not load the workbench.
 */
export function TelemetryNotice({
  initial = 'unknown',
}: {
  initial?: TelemetryState;
}) {
  const [state, setState] = useState<TelemetryState>(initial);
  useEffect(() => {
    let active = true;
    void readTelemetry().then((value) => {
      if (active) setState(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <p>
      {telemetrySentence(state)}{' '}
      <a
        href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP-TELEMETRY.md"
        target="_blank"
        rel="noreferrer"
      >
        Tracking and opt-out details
      </a>
    </p>
  );
}
