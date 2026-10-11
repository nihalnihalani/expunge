import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

export const RAINDROP_MCP_URL = 'https://mcp.raindrop.ai/mcp';

export type McpToolSchema = { name: string; description?: string; inputSchema: unknown };

export type McpCapture =
  | { status: 'captured'; url: string; tools: McpToolSchema[]; schemaHash: string; capturedAt: string }
  | { status: 'unavailable'; reason: 'auth' | 'transport' | 'protocol'; detail?: string };

/**
 * Captures the AUTHENTICATED `tools/list` of Raindrop's hosted MCP server (Streamable HTTP, API-key bearer). The exact
 * input schemas of Issues and Experiments tools are not public; they are read here at setup and pinned by hash, and no
 * request object is ever built from a tool name alone. A failure is recorded as `unavailable`, never as a feature.
 */
export async function captureMcpTools(options: {
  apiKey: string;
  url?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<McpCapture> {
  const url = options.url ?? RAINDROP_MCP_URL;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${options.apiKey}` } },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const client = new Client({ name: 'expunge-observer', version: '0.1.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools(undefined, { timeout: options.timeoutMs ?? 15_000 });
    const tools: McpToolSchema[] = listed.tools
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      status: 'captured',
      url,
      tools,
      schemaHash: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
      capturedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
  } catch (error) {
    // Classified by the SDK's typed errors, never by message text.
    if (error instanceof UnauthorizedError) return { status: 'unavailable', reason: 'auth' };
    if (error instanceof StreamableHTTPError) {
      if (error.code === 401 || error.code === 403) return { status: 'unavailable', reason: 'auth' };
      return { status: 'unavailable', reason: 'transport' };
    }
    if (error instanceof McpError)
      return { status: 'unavailable', reason: 'protocol', detail: `mcp error ${error.code}` };
    return { status: 'unavailable', reason: 'transport' };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export type McpCapabilities = {
  issues: boolean;
  experiments: boolean;
  /** Tools the documentation names that this account did not list. Empty means all present. */
  missing: string[];
};

const ISSUE_TOOLS = ['list_issues', 'get_issue', 'get_issue_events'] as const;
const EXPERIMENT_TOOLS = ['create_experiment', 'get_experiment'] as const;

/** What the captured list actually offers. A feature absent from the account is `false`, never assumed. */
export function mcpCapabilities(capture: McpCapture): McpCapabilities {
  if (capture.status !== 'captured')
    return { issues: false, experiments: false, missing: [...ISSUE_TOOLS, ...EXPERIMENT_TOOLS] };
  const names = new Set(capture.tools.map((tool) => tool.name));
  const missing = [...ISSUE_TOOLS, ...EXPERIMENT_TOOLS].filter((name) => !names.has(name));
  return {
    issues: ISSUE_TOOLS.every((name) => names.has(name)),
    experiments: EXPERIMENT_TOOLS.every((name) => names.has(name)),
    missing,
  };
}
