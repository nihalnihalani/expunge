// Port of the state tools from OpenMuse apps/server/src/engine/tanstack-agent.ts (lines 81-111)
// at commit 1ac68f3909f2478ab6280883f1ab5ea65eb5719d. MIT, Copyright (c) 2026 OpenMuse contributors.
// Unchanged tool names and schemas: @copilotkit/runtime 1.75.0's TanStack converter turns the
// results of exactly these two tool names into STATE_SNAPSHOT / STATE_DELTA events
// (dist/agent/converters/tanstack.mjs).
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

export const STATE_SNAPSHOT_TOOL = 'AGUISendStateSnapshot';
export const STATE_DELTA_TOOL = 'AGUISendStateDelta';

// The classic BuiltInAgent always offers these two state tools. The converter turns their
// results into STATE_SNAPSHOT / STATE_DELTA events.
export const stateTools = [
  defineTool({
    name: STATE_SNAPSHOT_TOOL,
    description: 'Replace the entire application state with a new snapshot',
    parameters: z.object({ snapshot: z.any().describe('The complete new state object') }),
    execute: async ({ snapshot }) => ({ success: true, snapshot }),
  }),
  defineTool({
    name: STATE_DELTA_TOOL,
    description: 'Apply incremental updates to application state using JSON Patch operations',
    parameters: z.object({
      delta: z
        .array(
          z.object({
            op: z.enum(['add', 'replace', 'remove']).describe('The operation to perform'),
            path: z.string().describe("JSON Pointer path (e.g., '/foo/bar')"),
            value: z
              .any()
              .optional()
              .describe(
                "The value to set. Required for 'add' and 'replace' operations, ignored for 'remove'.",
              ),
          }),
        )
        .describe('Array of JSON Patch operations'),
    }),
    execute: async ({ delta }) => ({ success: true, delta }),
  }),
];
