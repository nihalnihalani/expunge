import { expect, it } from 'vitest';
import {
  OperatorStartupConfigError,
  operatorStartupConfigFromEnv,
} from '../src/server/expunge/startup-config.js';

// Pure numeric/configuration metadata only. No role file, database, listener or service is opened.
const configured = {
  OWNER_ID: 'metadata-owner',
  HOST: '127.0.0.1',
  PORT: '4310',
  DATABASE_PATH: 'data/operator.sqlite',
};
const cwd = '/operator';

it('turns blank scaffold network/storage settings into labelled local defaults', () => {
  const value = operatorStartupConfigFromEnv(
    { OWNER_ID: 'metadata-owner', HOST: '', PORT: ' ', DATABASE_PATH: '' },
    cwd,
  );
  expect(value).toMatchObject({
    host: '127.0.0.1',
    port: 4310,
    databasePath: '/operator/data/opendots.sqlite',
    ownerId: 'metadata-owner',
    localDefaults: ['HOST', 'PORT', 'DATABASE_PATH'],
  });
});

it('uses stable absolute incidental storage and preserves explicit settings', () => {
  const value = operatorStartupConfigFromEnv(configured, cwd);
  expect(value.localDefaults).toEqual([]);
  expect(value.databasePath).toBe('/operator/data/operator.sqlite');
  expect(
    operatorStartupConfigFromEnv(
      { ...configured, DATABASE_PATH: '/persistent/operator.sqlite' },
      cwd,
    ).databasePath,
  ).toBe('/persistent/operator.sqlite');
});

it.each(['0', '-1', '65536', '1.5', '1e3', 'NaN', 'Infinity', '0x10'])(
  'refuses invalid port %s by name only',
  (PORT) => {
    expect(() =>
      operatorStartupConfigFromEnv({ ...configured, PORT }, cwd),
    ).toThrow('PORT:invalid');
  },
);

it.each(['1', '65535'])(
  'allows explicitly configured port boundary %s',
  (PORT) => {
    expect(
      operatorStartupConfigFromEnv({ ...configured, PORT }, cwd).port,
    ).toBe(Number(PORT));
  },
);

it.each([
  ':memory:',
  'file:memory?mode=memory',
  'data/',
  '.',
  '..',
  'data/\0private',
  'data/\nprivate',
])('refuses ephemeral or invalid storage grammar', (DATABASE_PATH) => {
  expect(() =>
    operatorStartupConfigFromEnv({ ...configured, DATABASE_PATH }, cwd),
  ).toThrow('DATABASE_PATH:invalid');
});

it('requires a supplied owner identity and never invents a default', () => {
  for (const OWNER_ID of [undefined, '', ' '])
    expect(() =>
      operatorStartupConfigFromEnv({ ...configured, OWNER_ID }, cwd),
    ).toThrow('OWNER_ID:missing');
  expect(() =>
    operatorStartupConfigFromEnv(
      { ...configured, OWNER_ID: 'metadata\nowner' },
      cwd,
    ),
  ).toThrow('OWNER_ID:invalid');
});

it('requires owner authentication for every non-loopback bind', () => {
  for (const HOST of [
    '0.0.0.0',
    '::',
    'operator.invalid',
    'localhost.operator.invalid',
  ])
    expect(() =>
      operatorStartupConfigFromEnv({ ...configured, HOST }, cwd),
    ).toThrow('OWNER_TOKEN:required_for_external_bind');
  expect(
    operatorStartupConfigFromEnv(
      {
        ...configured,
        HOST: '0.0.0.0',
        OWNER_TOKEN: 'configuration-grammar-marker-only',
      },
      cwd,
    ).host,
  ).toBe('0.0.0.0');
});

it('returns only named configuration failures, including malformed hosts and working directory', () => {
  try {
    operatorStartupConfigFromEnv(
      {
        ...configured,
        HOST: 'credential@invalid',
        PORT: 'private-marker',
        OWNER_ID: '',
      },
      'relative-directory',
    );
    throw new Error('InvalidStartupWasAccepted');
  } catch (error) {
    expect(error).toBeInstanceOf(OperatorStartupConfigError);
    expect((error as OperatorStartupConfigError).problems).toEqual([
      'HOST:invalid',
      'PORT:invalid',
      'working_directory:invalid',
      'OWNER_ID:missing',
      'OWNER_TOKEN:required_for_external_bind',
    ]);
    expect((error as Error).message).not.toContain('private-marker');
    expect((error as Error).message).not.toContain('credential@invalid');
  }
});
