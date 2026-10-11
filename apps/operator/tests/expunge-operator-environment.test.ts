import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { assertOperatorEnvironment } from '../src/server/expunge/operator-environment.js';
import { childEnvironment } from '../scripts/run-from-root.mjs';

// Pure environment guard and entrypoint source checks; no credentials are loaded or used.
it('rejects every nonblank Mongo principal by name without disclosing values', () => {
  const env = {
    MONGODB_SETUP_URI: 'sensitive-marker',
    MONGODB_UNKNOWN_URI: 'another-sensitive-marker',
  };
  for (const check of [assertOperatorEnvironment, childEnvironment]) {
    try {
      check(env);
      throw new Error('GuardDidNotReject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('MONGODB_SETUP_URI, MONGODB_UNKNOWN_URI');
      expect(message).not.toContain('sensitive-marker');
    }
  }
});

it('permits empty principal names and keeps telemetry off unless opted in', () => {
  expect(() =>
    assertOperatorEnvironment({
      MONGODB_SETUP_URI: ' ',
      MONGODB_DOMAIN_EXECUTOR_URI: '',
    }),
  ).not.toThrow();
  expect(childEnvironment({}).DO_NOT_TRACK).toBe('1');
  expect(
    childEnvironment({ EXPUNGE_ALLOW_TELEMETRY: '1' }).DO_NOT_TRACK,
  ).toBeUndefined();
  expect(
    childEnvironment({ EXPUNGE_ALLOW_TELEMETRY: '1', DO_NOT_TRACK: '1' })
      .DO_NOT_TRACK,
  ).toBe('1');
});

it('loads the role-scoped file and starts the server with the guard before service imports', () => {
  const launcher = readFileSync(
    new URL('../scripts/run-from-root.mjs', import.meta.url),
    'utf8',
  );
  expect(launcher).toContain("loadEnvFile(resolve(root, '.env.operator'))");
  expect(launcher).not.toContain("loadEnvFile(resolve(root, '.env'))");
  const server = readFileSync(
    new URL('../src/server/index.ts', import.meta.url),
    'utf8',
  );
  expect(
    server.trimStart().startsWith("import './expunge/role-environment.js';"),
  ).toBe(true);
});
