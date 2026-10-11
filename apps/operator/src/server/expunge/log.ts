/**
 * Logging that cannot throw and cannot leak. Only fixed fields are written: a route,
 * a job id, a sequence, an event kind and issue paths with codes. Payload values and
 * Error objects are never passed to the console (Node util.inspect regression,
 * nodejs/node#60717, and privacy: payloads can carry personal data).
 */
export interface RejectionLog {
  route: string;
  jobId?: string;
  sequence?: number;
  issues: readonly string[];
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => console.warn(line);
let sink: LogSink = defaultSink;

/** Test hook. Pass undefined to restore the console sink. */
export function setRejectionSink(next?: LogSink) {
  sink = next ?? defaultSink;
}

export function logRejection(entry: RejectionLog): void {
  try {
    const parts = [
      `expunge projection rejected route=${entry.route}`,
      entry.jobId ? `job=${entry.jobId}` : '',
      entry.sequence === undefined ? '' : `sequence=${entry.sequence}`,
      `issues=${entry.issues.slice(0, 12).join(',')}`,
    ].filter(Boolean);
    sink(parts.join(' ').slice(0, 600));
  } catch {
    // A failing logger must never change the response.
  }
}
