import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import {
  describeExpungeConfig,
  telemetryState,
} from '../src/server/expunge/config.js';
import { childEnvironment } from '../scripts/run-from-root.mjs';
import {
  TelemetryNotice,
  telemetrySentence,
} from '../src/client/expunge/TelemetryNotice';
import type { Config } from '../src/server/research.js';

const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
afterEach(() => stores.splice(0).forEach((store) => store.close()));

it('turns operator telemetry off unless EXPUNGE_ALLOW_TELEMETRY=1 (default branch)', () => {
  const input = { PATH: '/bin', OPENAI_API_KEY: 'x' };
  const output = childEnvironment(input);
  expect(output.DO_NOT_TRACK).toBe('1');
  expect(output.PATH).toBe('/bin');
  expect(input).not.toHaveProperty('DO_NOT_TRACK');
  // Any value other than exactly 1 does not opt in.
  for (const value of ['', '0', 'true', 'yes'])
    expect(
      childEnvironment({ EXPUNGE_ALLOW_TELEMETRY: value }).DO_NOT_TRACK,
    ).toBe('1');
});

it('leaves telemetry to upstream defaults only when explicitly allowed (opt-in branch)', () => {
  expect(
    childEnvironment({ EXPUNGE_ALLOW_TELEMETRY: '1' }).DO_NOT_TRACK,
  ).toBeUndefined();
  // An explicit opt-out always stays in force.
  expect(
    childEnvironment({ EXPUNGE_ALLOW_TELEMETRY: '1', DO_NOT_TRACK: '1' })
      .DO_NOT_TRACK,
  ).toBe('1');
  expect(
    childEnvironment({
      EXPUNGE_ALLOW_TELEMETRY: '1',
      COPILOTKIT_TELEMETRY_DISABLED: 'true',
    }).COPILOTKIT_TELEMETRY_DISABLED,
  ).toBe('true');
});

it('reports the server telemetry state with the same rule upstream applies', () => {
  expect(telemetryState({})).toBe('enabled');
  expect(telemetryState({ DO_NOT_TRACK: '1' })).toBe('disabled');
  expect(telemetryState({ DO_NOT_TRACK: 'true' })).toBe('disabled');
  expect(telemetryState({ COPILOTKIT_TELEMETRY_DISABLED: '1' })).toBe(
    'disabled',
  );
  expect(telemetryState({ COPILOTKIT_TELEMETRY_SAMPLE_RATE: '0' })).toBe(
    'disabled',
  );
  expect(telemetryState({ DO_NOT_TRACK: '0' })).toBe('enabled');
  // The wrapper's output, fed back in, reads as disabled.
  expect(telemetryState(childEnvironment({}))).toBe('disabled');
  expect(
    telemetryState(childEnvironment({ EXPUNGE_ALLOW_TELEMETRY: '1' })),
  ).toBe('enabled');
});

it('serves the state on the status route', async () => {
  for (const [env, expected] of [
    [{ DO_NOT_TRACK: '1' }, 'disabled'],
    [{}, 'enabled'],
  ] as const) {
    const store = new Store(':memory:');
    stores.push(store);
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      expungeConfig: describeExpungeConfig(env),
    });
    const body = await (await app.request('/api/expunge/status')).json();
    expect(body.telemetry).toBe(expected);
  }
});

it('states the setting and how to change it, never a static "collected by default"', () => {
  expect(telemetrySentence('disabled')).toContain('disabled by default');
  expect(telemetrySentence('disabled')).toContain('EXPUNGE_ALLOW_TELEMETRY=1');
  expect(telemetrySentence('enabled')).toContain('DO_NOT_TRACK=1');
  expect(telemetrySentence('enabled')).not.toContain('by default');
  expect(telemetrySentence('unknown')).toContain('could not be read');
  const html = renderToStaticMarkup(<TelemetryNotice initial="disabled" />);
  expect(html).toContain('disabled by default');
  expect(html).toContain('Tracking and opt-out details');
});
