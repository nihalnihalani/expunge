import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import { captureMcpTools, mcpCapabilities } from '../src/index.js';

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
});

describe('captureMcpTools (against the FAKE MCP server)', () => {
  const fake = new FakeRaindrop();
  beforeEach(async () => {
    await fake.start();
  });
  afterEach(async () => {
    fake.reset();
    await fake.stop();
  });

  it('captures the authenticated tools/list and pins it by hash, sorted by name', async () => {
    fake.mcpTools = [tool('get_issue'), tool('list_issues'), tool('get_issue_events')];
    const capture = await captureMcpTools({
      apiKey: fake.keys().queryKey,
      url: fake.mcpUrl,
      now: () => new Date('2026-06-02T00:00:00Z'),
    });
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') return;
    expect(capture.tools.map((t) => t.name)).toEqual(['get_issue', 'get_issue_events', 'list_issues']);
    expect(capture.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.capturedAt).toBe('2026-06-02T00:00:00.000Z');
    const again = await captureMcpTools({ apiKey: fake.keys().queryKey, url: fake.mcpUrl });
    expect(again.status === 'captured' && again.schemaHash).toBe(capture.schemaHash);
  });

  it('schema hash changes when a tool schema changes', async () => {
    fake.mcpTools = [tool('list_issues')];
    const a = await captureMcpTools({ apiKey: fake.keys().queryKey, url: fake.mcpUrl });
    fake.mcpTools = [
      { ...tool('list_issues'), inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    ];
    const b = await captureMcpTools({ apiKey: fake.keys().queryKey, url: fake.mcpUrl });
    expect(a.status === 'captured' && b.status === 'captured' && a.schemaHash !== b.schemaHash).toBe(true);
  });

  it('reports unavailable/auth for a wrong key and never throws', async () => {
    const capture = await captureMcpTools({ apiKey: 'wrong-key', url: fake.mcpUrl });
    expect(capture).toMatchObject({ status: 'unavailable', reason: 'auth' });
  });

  it('reports unavailable/transport when the server is down', async () => {
    fake.mcpStatus = 503;
    const capture = await captureMcpTools({ apiKey: fake.keys().queryKey, url: fake.mcpUrl });
    expect(capture.status).toBe('unavailable');
  });

  it('reports unavailable when the account has no tools capability', async () => {
    fake.mcpTools = null;
    const capture = await captureMcpTools({ apiKey: fake.keys().queryKey, url: fake.mcpUrl });
    expect(capture).toMatchObject({ status: 'unavailable', reason: 'protocol' });
  });

  it('does not leak the key into the capture result', async () => {
    fake.mcpTools = [tool('list_issues')];
    const capture = await captureMcpTools({ apiKey: fake.keys().queryKey, url: fake.mcpUrl });
    expect(JSON.stringify(capture)).not.toContain(fake.keys().queryKey);
  });
});

describe('mcpCapabilities', () => {
  it('is all-false when nothing was captured, and never assumes a feature', () => {
    expect(mcpCapabilities({ status: 'unavailable', reason: 'auth' })).toMatchObject({
      issues: false,
      experiments: false,
    });
  });
  it('enables a feature only when every one of its tools is listed', () => {
    const base = { status: 'captured' as const, url: 'u', schemaHash: 'x', capturedAt: 't' };
    expect(
      mcpCapabilities({ ...base, tools: [tool('list_issues'), tool('get_issue'), tool('get_issue_events')] }),
    ).toMatchObject({
      issues: true,
      experiments: false,
    });
    expect(
      mcpCapabilities({ ...base, tools: [tool('list_issues'), tool('create_experiment')] }),
    ).toMatchObject({ issues: false, experiments: false });
  });
});
