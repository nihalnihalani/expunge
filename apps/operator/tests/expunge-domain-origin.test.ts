import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { describeExpungeConfig } from '../src/server/expunge/config.js';
import {
  domainOrigin,
  DOMAIN_REDIRECT_POLICY,
} from '../src/server/expunge/domain-origin.js';
import {
  expungeDomainFromEnv,
  HttpExpungeDomainService,
} from '../src/server/expunge/domain-service.js';

// Pure configuration/constructor checks. No transport is invoked and no credential is loaded.
const config = (origin: string) => ({
  EXPUNGE_DOMAIN_URL: origin,
  OWNER_ID: 'metadata-owner',
  EXPUNGE_INTERNAL_TOKEN: 'configuration-grammar-marker-only',
});

it.each([
  'https://domain.invalid',
  'https://domain.invalid:8443/',
  'http://127.0.0.1:4310',
  'http://localhost:4310/',
  'http://[::1]:4310',
])('applies the same safe-origin policy to %s', (origin) => {
  expect(domainOrigin(origin)).not.toBe(null);
  expect(describeExpungeConfig(config(origin)).configured.status).toBe('pass');
  expect(
    () =>
      new HttpExpungeDomainService(
        origin,
        { readToken: config(origin).EXPUNGE_INTERNAL_TOKEN },
        'metadata-owner',
      ),
  ).not.toThrow();
  expect(expungeDomainFromEnv(config(origin))).toBeInstanceOf(
    HttpExpungeDomainService,
  );
});

it.each([
  'http://domain.invalid',
  'http://localhost.domain.invalid',
  'http://127.0.0.2',
  'http://2130706433',
  'https://user:password@domain.invalid',
  'https://@domain.invalid',
  'https://domain.invalid/path',
  'https://domain.invalid/path/..',
  'https://domain.invalid?query=1',
  'https://domain.invalid?',
  'https://domain.invalid#fragment',
  'https://domain.invalid#',
  'https://domain.invalid\\path',
  'file:///tmp/domain',
  'ftp://domain.invalid',
  'not-an-origin',
])(
  'refuses unsafe origin grammar consistently without revealing it: %s',
  (origin) => {
    expect(domainOrigin(origin)).toBe(null);
    expect(describeExpungeConfig(config(origin)).configured.status).toBe(
      'fail',
    );
    for (const construct of [
      () =>
        new HttpExpungeDomainService(
          origin,
          { readToken: config(origin).EXPUNGE_INTERNAL_TOKEN },
          'metadata-owner',
        ),
      () => expungeDomainFromEnv(config(origin)),
    ]) {
      try {
        construct();
        throw new Error('OriginWasAccepted');
      } catch (error) {
        expect((error as Error).message).toBe(
          'EXPUNGE_DOMAIN_URL must be an HTTPS or explicit loopback HTTP origin.',
        );
        expect((error as Error).message).not.toContain('password');
      }
    }
  },
);

it('does not invent a missing owner binding', () => {
  const env = { ...config('https://domain.invalid'), OWNER_ID: ' ' };
  expect(describeExpungeConfig(env).configured.missing).toContain('OWNER_ID');
  expect(() => expungeDomainFromEnv(env)).toThrow(
    'requires a service token and owner binding',
  );
  expect(expungeDomainFromEnv({})).toBeUndefined();
});

it('retains redirect refusal on the credential-bearing call path', () => {
  expect(DOMAIN_REDIRECT_POLICY).toBe('error');
  const source = readFileSync(
    new URL('../src/server/expunge/domain-service.ts', import.meta.url),
    'utf8',
  );
  expect(source).toContain('redirect: DOMAIN_REDIRECT_POLICY');
});
