import { defineTool, type ToolDefinition } from '@expunge/vendor-openmuse';
import { z } from 'zod';
import type { Episode } from './episode.js';
import { sanitizeFreeText } from './sanitize.js';

export type DiagnosticsToolOptions = {
  /** The tool name the model sees. Default `report_diagnostic` (the frozen worker tool ID). */
  toolName?: string;
  guidance?: string;
};

/**
 * Self Diagnostics as a REAL TanStack server tool. The SDK has `forVercelAI()` (executable), `forOpenAI()` and
 * `forAnthropic()` (definitions only); it has no TanStack adapter, so this builds the tool from the SDK tool's own
 * name, description and input schema and dispatches every invocation to `diagnostics.execute(input, context)`.
 * The signal it records is an `agent_self_report` hypothesis, never external truth.
 */
export function createDiagnosticsTool(
  episode: Episode,
  options: DiagnosticsToolOptions = {},
): ToolDefinition {
  const diagnostics = episode.tracing.client.createSelfDiagnosticsTool({
    eventId: episode.eventId,
    toolName: options.toolName ?? 'report_diagnostic',
    guidance: options.guidance,
    source: 'expunge_worker',
    // A broken correlation must be loud during contract probes, not a silent no-op.
    onMissingEventId: 'throw',
  });
  const categories = diagnostics.inputSchema.properties.category.enum as [string, ...string[]];
  return defineTool({
    name: diagnostics.name,
    description: diagnostics.description,
    parameters: z
      .object({
        category: z.enum(categories),
        detail: z.string().min(1).max(500),
      })
      .strict(),
    execute: async (input) => {
      // The category is a closed enum; the free-text detail passes the forbidden-literal guard first.
      const safeInput = { category: input.category, detail: sanitizeFreeText(input.detail, episode.policy) };
      const result = await diagnostics.execute(safeInput, {
        eventId: episode.eventId,
        properties: {
          origin: 'agent_self_report',
          run_id: episode.context.runId,
          harness_hash: episode.context.harnessHash,
        },
      });
      // The model learns only whether the report was accepted for recording, not any remote state.
      return { acknowledged: result.acknowledged, category: result.category };
    },
  });
}
