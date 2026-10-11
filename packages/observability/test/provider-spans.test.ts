/**
 * Do the REAL @tanstack/ai-openai adapter and the REAL openai client produce GenAI model spans through the Raindrop
 * SDK? The provider boundary is a labeled FAKE OpenAI Responses server (HTTP + SSE), so the adapter, the client and
 * the TanStack middleware are the real code paths; only the model service is fake. This is NOT a live provider
 * test and says nothing about a real provider's behavior or about Raindrop's backend.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chat } from '@tanstack/ai';
import { createOpenaiChat } from '@tanstack/ai-openai';
import { Episode, closeTracing, initTracing } from '../src/index.js';
import { FakeRaindrop } from './fake-raindrop.js';

const raindrop = new FakeRaindrop();
let openai: Server;
let openaiPort = 0;
const openaiRequests: Array<{ path: string; body: any }> = [];

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

beforeAll(async () => {
  await raindrop.start();
  openai = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      openaiRequests.push({ path: req.url ?? '', body });
      const response = (status: string, output: unknown[], usage?: unknown) => ({
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status,
        model: 'gpt-fake-1',
        output,
        ...(usage ? { usage } : {}),
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
        temperature: 1,
        top_p: 1,
      });
      const message = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello there', annotations: [] }],
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        sse([
          { type: 'response.created', sequence_number: 0, response: response('in_progress', []) },
          {
            type: 'response.output_item.added',
            sequence_number: 1,
            output_index: 0,
            item: { ...message, status: 'in_progress', content: [] },
          },
          {
            type: 'response.content_part.added',
            sequence_number: 2,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          {
            type: 'response.output_text.delta',
            sequence_number: 3,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: 'hello there',
          },
          {
            type: 'response.output_text.done',
            sequence_number: 4,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            text: 'hello there',
          },
          {
            type: 'response.content_part.done',
            sequence_number: 5,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            part: message.content[0],
          },
          { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: message },
          {
            type: 'response.completed',
            sequence_number: 7,
            response: response('completed', [message], {
              input_tokens: 21,
              output_tokens: 4,
              total_tokens: 25,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            }),
          },
        ]),
      );
    });
  });
  await new Promise<void>((resolve) => openai.listen(0, '127.0.0.1', resolve));
  openaiPort = (openai.address() as AddressInfo).port;
});
afterAll(async () => {
  await closeTracing();
  await raindrop.stop();
  await new Promise((resolve) => openai.close(resolve));
});

describe('model spans from the real OpenAI adapter', () => {
  it('emits an LLM chat span with provider, model and measured token usage, correlated to the episode', async () => {
    const tracing = initTracing(
      { writeKey: raindrop.keys().writeKey, projectId: 'proj-1', endpoint: raindrop.ingestUrl },
      { disableBatching: true, bufferSize: 1 },
    );
    const episode = Episode.begin(tracing, {
      role: 'worker',
      jobId: 'job-p',
      runId: 'run-p',
      attempt: 1,
      harnessHash: 'c'.repeat(64),
      telemetryUserId: 'tok_00000000000000b1',
      input: 'adapter span check',
    });
    const adapter = createOpenaiChat('gpt-5', 'test-key-not-real', {
      baseURL: `http://127.0.0.1:${openaiPort}/v1`,
      maxRetries: 0,
    });
    const text: string[] = [];
    await episode.run(async () => {
      for await (const chunk of chat({
        adapter,
        messages: [{ role: 'user', content: 'say hello' }],
        middleware: [episode.chatMiddleware()],
      }) as AsyncIterable<any>)
        if (chunk.type === 'TEXT_MESSAGE_CONTENT') text.push(chunk.delta);
    });
    expect(text.join('')).toBe('hello there');
    expect(openaiRequests.at(-1)?.path).toBe('/v1/responses');
    const deadline = Date.now() + 3000;
    while (!raindrop.spans.some((s) => s.name.startsWith('chat gpt-5')) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    const modelSpan = raindrop.spans.find(
      (s) => s.name.startsWith('chat gpt-5') && s.attributes['tanstack.ai.iteration'] !== undefined,
    )!;
    expect(modelSpan, `spans: ${raindrop.spans.map((s) => s.name).join(', ')}`).toBeTruthy();
    expect(modelSpan.attributes['gen_ai.system']).toBe('openai');
    expect(modelSpan.attributes['gen_ai.request.model']).toBe('gpt-5');
    expect(modelSpan.attributes['gen_ai.usage.input_tokens']).toBe(21);
    expect(modelSpan.attributes['gen_ai.usage.output_tokens']).toBe(4);
    expect(modelSpan.attributes['traceloop.association.properties.run_id']).toBe('run-p');
    expect(modelSpan.attributes['expunge.harness_hash']).toBe('c'.repeat(64));
  });
});
