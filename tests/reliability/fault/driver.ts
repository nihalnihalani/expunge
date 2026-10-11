/**
 * Parent-side control of a fault-injected worker process: spawn it, read its event stream, wait for named points,
 * resume a stopped one (SIGCONT) or kill it (SIGKILL).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildConfig, ChildEvent } from './protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHILD = path.join(ROOT, 'tests/reliability/fault/worker-child.ts');

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export class ChildWorker {
  readonly events: ChildEvent[] = [];
  readonly exited: Promise<Exit>;
  private exitValue: Exit | undefined;
  private stderrTail = '';
  private buffer = '';

  constructor(
    private readonly proc: ChildProcess,
    readonly config: ChildConfig,
  ) {
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line) as { event?: unknown };
          if (typeof parsed.event === 'string') this.events.push(parsed as ChildEvent);
        } catch {
          // a product log line that is not one of ours
        }
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-1500);
    });
    this.exited = new Promise((resolve) =>
      proc.once('exit', (code, signal) => {
        this.exitValue = { code, signal };
        resolve(this.exitValue);
      }),
    );
  }

  get pid(): number {
    return this.proc.pid!;
  }
  get hasExited(): boolean {
    return this.exitValue !== undefined;
  }
  get diagnostics(): string {
    return this.stderrTail;
  }
  /** Names of the points reached so far, in order (with repeats). */
  get points(): string[] {
    return this.events.flatMap((e) => (e.event === 'point' ? [e.name] : []));
  }
  result() {
    return this.events.find((e): e is Extract<ChildEvent, { event: 'result' }> => e.event === 'result');
  }
  effects() {
    return this.events.filter((e): e is Extract<ChildEvent, { event: 'effect' }> => e.event === 'effect');
  }

  async waitForPoint(name: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.points.includes(name)) return;
      if (this.hasExited && !this.points.includes(name)) {
        throw new Error(
          `worker ${this.config.workerId} exited before reaching ${name}: ${JSON.stringify(this.exitValue)} points=${this.points.join(',')} events=${JSON.stringify(this.events.filter((e) => e.event !== 'point')).slice(0, 600)} stderr=${this.stderrTail.slice(-300)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(
      `timed out waiting for point ${name} in ${this.config.workerId}; saw ${this.points.join(',')}`,
    );
  }
  async waitForExit(timeoutMs = 30_000): Promise<Exit> {
    const timer = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `worker ${this.config.workerId} did not exit in time; points=${this.points.join(',')}; events=${JSON.stringify(this.events.filter((e) => e.event !== 'point')).slice(0, 600)}; stderr=${this.stderrTail.slice(-1400)}`,
            ),
          ),
        timeoutMs,
      ),
    );
    return Promise.race([this.exited, timer]);
  }
  cont(): void {
    process.kill(this.pid, 'SIGCONT');
  }
  kill(): void {
    if (!this.hasExited) {
      try {
        process.kill(this.pid, 'SIGCONT');
      } catch {
        // already gone
      }
      this.proc.kill('SIGKILL');
    }
  }
}

export function spawnWorker(config: ChildConfig): ChildWorker {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: ROOT,
    env: { ...process.env, RELI_CONFIG: JSON.stringify(config), NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new ChildWorker(proc, config);
}
