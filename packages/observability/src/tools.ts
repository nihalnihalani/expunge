import type { ToolDefinition } from '@expunge/vendor-openmuse';
import type { Episode } from './episode.js';
import { sanitizeError, sanitizeProperty, sanitizeValue } from './sanitize.js';

/**
 * Wraps one tool so each execution is a Raindrop TOOL_CALL span whose input, output and error are the SANITIZED
 * forms (structural allowlist), never the raw values. `traceContent:false` stops the SDK from also capturing raw
 * arguments. The span always ends; the original error is rethrown unchanged to the runtime.
 */
export function instrumentTool(episode: Episode, tool: ToolDefinition): ToolDefinition {
  const execute = tool.execute;
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (args) => {
      const span = episode.interaction.startToolSpan({
        name: tool.name,
        properties: {
          harness_hash: sanitizeProperty(episode.context.harnessHash, episode.policy),
          run_id: sanitizeProperty(episode.context.runId, episode.policy),
          tool_id: sanitizeProperty(tool.name, episode.policy),
        },
        traceContent: false,
      });
      span.setInput(sanitizeValue(args, episode.policy));
      try {
        const result = await execute(args);
        span.setOutput(sanitizeValue(result, episode.policy));
        return result;
      } catch (error) {
        span.setError(JSON.stringify(sanitizeError(error, episode.policy)));
        throw error;
      } finally {
        span.end();
      }
    },
  };
}
