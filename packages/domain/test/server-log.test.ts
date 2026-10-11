import { describe, expect, it } from 'vitest';
import { listenDomainService, type DomainService } from '../src/index.js';

describe('domain service HTTP listener errors', () => {
  it('answers a generic 500 and logs only the error name and code, never the message or stack', async () => {
    const secret = 'mongodb://user:password@host/db';
    const throwing: DomainService = {
      handle: async () => {
        throw Object.assign(new TypeError(`connect failed to ${secret}`), { code: 'ECONNREFUSED' });
      },
    };
    const logged: Array<Record<string, unknown>> = [];
    const listener = await listenDomainService(throwing, { port: 0, log: (entry) => logged.push(entry) });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/anything`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal' });
    } finally {
      await listener.close();
    }
    expect(logged).toEqual([{ event: 'domain_service_error', name: 'TypeError', code: 'ECONNREFUSED' }]);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
  it('logs a non-Error throw by type and omits an absent code', async () => {
    const throwing: DomainService = {
      handle: async () => {
        throw 'plain string with a secret';
      },
    };
    const logged: Array<Record<string, unknown>> = [];
    const listener = await listenDomainService(throwing, { port: 0, log: (entry) => logged.push(entry) });
    try {
      expect((await fetch(`http://127.0.0.1:${listener.port}/x`)).status).toBe(500);
    } finally {
      await listener.close();
    }
    expect(logged).toEqual([{ event: 'domain_service_error', name: 'string' }]);
  });
});
