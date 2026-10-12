// The real proposer adapter over a FAKE HTTP transport: the provider SDK, the structured-output path, the meter and the
// stamp are the production code; only `fetch` is replaced. No network, no credential (a placeholder key string).
import { describe, expect, it } from 'vitest';
import {
  EvolverModelUnavailable,
  buildEvidencePacket,
  createProviderEvolverModel,
  fromWire,
  proposeCandidate,
} from '../src/index.js';
import { ACTOR, CATALOG, INCIDENT_A, INCIDENT_B, INCIDENT_C, compileContext, w0 } from './helpers.js';

const ENV = {
  EXPUNGE_MODEL_PROVIDER: 'openai',
  EXPUNGE_MODEL_ID: 'fake-transport-model',
  OPENAI_API_KEY: 'placeholder-not-a-key',
  EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: '100000',
  EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION: '500000',
};
const BUDGET = { totalTokens: 100_000, maxCostMicrousd: 50_000 };

/** A Responses API SSE stream that answers `text` and reports usage on `response.completed`. */
function fakeTransport(text: string, usage = { input_tokens: 1200, output_tokens: 300 }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const response = {
      id: 'resp_fake',
      object: 'response',
      created_at: 0,
      model: 'fake-transport-model',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_fake',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
    };
    const events = [
      {
        type: 'response.created',
        sequence_number: 0,
        response: { ...response, status: 'in_progress', output: [] },
      },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { type: 'message', id: 'msg_fake', role: 'assistant', status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 2,
        item_id: 'msg_fake',
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: 'response.output_text.done',
        sequence_number: 3,
        item_id: 'msg_fake',
        output_index: 0,
        content_index: 0,
        text,
      },
      { type: 'response.completed', sequence_number: 4, response },
    ];
    const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const packet = () =>
  buildEvidencePacket({
    arm: 'trace_informed',
    incident: [INCIDENT_A],
    pool: [INCIDENT_A, INCIDENT_B, INCIDENT_C],
    budgetChars: 6000,
  });

describe('provider evolver model (fake transport)', () => {
  it('fails closed before any call without a selection, a credential or a complete price profile', () => {
    const code = (env: Record<string, string>) => {
      try {
        createProviderEvolverModel({ env, budget: BUDGET });
        return 'built';
      } catch (error) {
        return error instanceof EvolverModelUnavailable ? error.code : 'other';
      }
    };
    expect(code({ ...ENV, EXPUNGE_MODEL_ID: '' })).toBe('ModelNotConfigured');
    expect(code({ ...ENV, OPENAI_API_KEY: '' })).toBe('ProviderCredentialMissing');
    expect(code({ ...ENV, EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION: '' })).toBe('PricingUnavailable');
    expect(code(ENV)).toBe('built');
  });

  it('maps the strict wire answer back onto the proposal shape', () => {
    expect(
      fromWire({
        abstain: false,
        reason: '',
        hypothesis: 'h',
        claimedClass: 'behavioral',
        patches: [
          { surface: 'context', path: 'p', afterJson: '{"a":1}', hypothesis: 'x', sourceEvidenceIds: [] },
        ],
      }),
    ).toEqual({
      abstain: false,
      hypothesis: 'h',
      claimedClass: 'behavioral',
      patches: [{ surface: 'context', path: 'p', after: { a: 1 }, hypothesis: 'x', sourceEvidenceIds: [] }],
    });
    // Unparsable JSON keeps `afterJson`, which the strict proposal schema then rejects.
    const bad = fromWire({ abstain: false, reason: '', patches: [{ afterJson: '{' }] }) as {
      patches: Array<Record<string, unknown>>;
    };
    expect(bad.patches[0]).toHaveProperty('afterJson');
  });

  it('sends one strict structured-output request, meters it and stamps the proposal', async () => {
    const evidenceId = INCIDENT_A.evidenceId;
    const answer = JSON.stringify({
      abstain: false,
      reason: '',
      hypothesis: 'Raise the traversal bound so second-hop references are followed.',
      claimedClass: 'behavioral',
      patches: [
        {
          surface: 'tool_policy',
          path: 'limits.traversalDepth',
          afterJson: '2',
          hypothesis: 'The incident stopped after one hop; a second hop reaches the remaining records.',
          sourceEvidenceIds: [evidenceId],
        },
      ],
    });
    const { fetchImpl, calls } = fakeTransport(answer);
    const model = createProviderEvolverModel({ env: ENV, budget: BUDGET, fetchImpl });
    const record = await proposeCandidate({
      model,
      packet: packet(),
      branchIndex: 0,
      parent: w0(),
      actor: ACTOR,
      context: compileContext(),
      catalog: CATALOG,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/responses');
    const format = (calls[0]!.body.text as { format?: { type?: string; strict?: boolean } } | undefined)
      ?.format;
    expect(format?.type).toBe('json_schema');
    expect(calls[0]!.body).not.toHaveProperty('tool_choice');
    expect(record.modelKind).toBe('provider');
    expect(record.modelId).toBe('openai/fake-transport-model');
    // The cited evidenceId is expanded to its bundle's source ids, so the compiler's in-bundle check accepts it.
    expect(record.status).toBe('compiled');
    expect(record.patches?.[0]?.sourceEvidenceIds).not.toContain(evidenceId);
    expect(record.patches?.[0]?.after).toBe(2);
    expect(record.modelStamp?.attestation).toMatchObject({
      source: 'provider',
      provider: 'openai',
      modelId: 'fake-transport-model',
      endpoint: 'default',
    });
    // 1200 in at 0.1 USD/M + 300 out at 0.5 USD/M = 120 + 150 microusd.
    expect(record.modelStamp?.usage).toMatchObject({
      modelCalls: 1,
      inputTokens: 1200,
      outputTokens: 300,
      costMicrousd: 270,
      unpricedCalls: 0,
    });
  });

  it('refuses the next call once the proposer budget is spent, and records the over-budget call', async () => {
    const answer = JSON.stringify({
      abstain: true,
      reason: 'no support',
      hypothesis: '',
      claimedClass: 'behavioral',
      patches: [],
    });
    const { fetchImpl, calls } = fakeTransport(answer, { input_tokens: 900, output_tokens: 200 });
    const model = createProviderEvolverModel({
      env: ENV,
      budget: { totalTokens: 1000, maxCostMicrousd: 50_000 },
      fetchImpl,
    });
    const input = {
      model,
      packet: packet(),
      branchIndex: 0,
      parent: w0(),
      actor: ACTOR,
      context: compileContext(),
      catalog: CATALOG,
    };
    await expect(proposeCandidate(input)).rejects.toThrow('TokenBudgetExceeded');
    await expect(proposeCandidate(input)).rejects.toThrow('TokenBudgetExceeded');
    expect(calls).toHaveLength(1);
    expect(model.stamp().usage).toMatchObject({ modelCalls: 1, inputTokens: 900, outputTokens: 200 });
  });

  it('records an abstention with its stamp', async () => {
    const answer = JSON.stringify({
      abstain: true,
      reason: 'evidence too thin',
      hypothesis: '',
      claimedClass: 'behavioral',
      patches: [],
    });
    const { fetchImpl } = fakeTransport(answer);
    const model = createProviderEvolverModel({ env: ENV, budget: BUDGET, fetchImpl });
    const record = await proposeCandidate({
      model,
      packet: packet(),
      branchIndex: 0,
      parent: w0(),
      actor: ACTOR,
      context: compileContext(),
      catalog: CATALOG,
    });
    expect(record.status).toBe('abstained');
    expect(record.abstainReason).toBe('evidence too thin');
    expect(record.modelStamp?.usage.modelCalls).toBe(1);
  });
});
