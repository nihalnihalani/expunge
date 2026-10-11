/**
 * LIVE provider smoke. Runs ONLY when a provider credential is present AND EXPUNGE_LIVE_PROVIDER_SMOKE=1
 * (it spends a few hundred tokens). Without them it is skipped and the live claim stays BLOCKED; with
 * EXPUNGE_REQUIRE_LIVE_TESTS=1 a missing credential FAILS instead of skipping. A scripted model never
 * substitutes for this test.
 *
 * Variables: OPENAI_API_KEY (+ EXPUNGE_MODEL_PROVIDER=openai) or ANTHROPIC_API_KEY (+ EXPUNGE_MODEL_PROVIDER=anthropic),
 * and EXPUNGE_MODEL_ID.
 */
import { EventType } from '@ag-ui/core';
import { providerReadiness } from '@expunge/runtime';
import { defineTool, tanstackAgent } from '@expunge/vendor-openmuse';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lastValueFrom, toArray } from 'rxjs';

const readiness = providerReadiness(process.env);
const wanted = process.env.EXPUNGE_LIVE_PROVIDER_SMOKE === '1';
const required = process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1';

const suite = wanted && readiness.ready ? describe : describe.skip;
if (required && !(wanted && readiness.ready))
  describe('live provider smoke (required)', () => {
    it('needs a provider credential and EXPUNGE_LIVE_PROVIDER_SMOKE=1', () => {
      throw new Error(
        `BLOCKED: live provider smoke not runnable (${readiness.ready ? 'EXPUNGE_LIVE_PROVIDER_SMOKE is not 1' : readiness.blockers.map((b) => b.detail).join(' ')})`,
      );
    });
  });

suite('live provider through the vendored OpenMuse helper', () => {
  it('makes a real tool call and finishes a run', async () => {
    if (!readiness.ready) return;
    const executed: number[] = [];
    const agent = tanstackAgent({
      model: readiness.spec,
      env: process.env,
      maxSteps: 3,
      prompt: 'You are a protocol test. Follow the user instruction exactly and briefly.',
      tools: [
        defineTool({
          name: 'echo',
          description: 'Echo a number back',
          parameters: z.object({ v: z.number() }),
          execute: async ({ v }) => {
            executed.push(v);
            return { echoed: v };
          },
        }),
      ],
    });
    const events = await lastValueFrom(
      agent
        .run({
          threadId: 'live-smoke',
          runId: 'live-smoke-1',
          state: {},
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'Call the echo tool exactly once with v=7, then reply with the single word done.',
            },
          ],
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    expect(executed).toEqual([7]);
    expect(events.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  }, 60_000);
});
