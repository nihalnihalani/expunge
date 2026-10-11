import './fixtures/browser-globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventType } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { z } from 'zod';
import { NO_TOOL_COPY } from '../src/server/expunge/agent-copy.js';
import type { ExpungeDomainService } from '../src/server/expunge/domain-service.js';
import { ExpungeProjectionAgent } from '../src/server/expunge/projection-agent.js';
import {
  ExpungeReviewTool,
  reviewToolRegistration,
} from '../src/client/expunge/review/ExpungeReviewTool';
import {
  CARD_STATE_COPY,
  ReviewCardBody,
} from '../src/client/expunge/review/ReviewCard';
import { expungeReviewSchema, expungeReviewTool } from '../src/shared/expunge';
import { baseSnapshot } from './fixtures/expunge-data';

const hook = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));
vi.mock('@copilotkit/react-core/v2', () => ({
  useHumanInTheLoop: (config: Record<string, unknown>) => {
    hook.calls.push(config);
  },
}));

type Any = Record<string, unknown>;
const pending = baseSnapshot('job-1', {
  status: 'waiting_approval',
  approval: {
    state: 'pending',
    proposalId: 'proposal-1',
    expiresAt: '2026-10-11T10:00:00.000Z',
  },
});
const service = {
  readJobByThread: vi.fn(async () => ({ jobId: 'job-1' })),
  readJob: vi.fn(async () => pending),
} as unknown as ExpungeDomainService;
const run = async (tools: unknown[]) =>
  (await lastValueFrom(
    new ExpungeProjectionAgent(service)
      .run({
        threadId: 'thread-1',
        runId: 'run-1',
        messages: [],
        tools,
        context: [],
        state: {},
        forwardedProps: {},
      } as never)
      .pipe(toArray()),
  )) as unknown as Any[];
const types = (events: Any[]) => events.map((event) => event.type);
/** What the CopilotKit client sends for a hook-registered tool. */
const asSent = (name: string) => ({
  name,
  description: reviewToolRegistration.description,
  parameters: z.toJSONSchema(reviewToolRegistration.parameters),
});

describe('review tool, unit-level: mocked useHumanInTheLoop, no live chat turn (no CopilotKit key): client hook and backend allowlist', () => {
  it('uses one tool name and one strict schema on both sides', () => {
    expect(reviewToolRegistration.name).toBe(expungeReviewTool.name);
    expect(reviewToolRegistration.parameters).toBe(expungeReviewSchema);
    expect(expungeReviewSchema.safeParse({ proposalId: 'p-1' }).success).toBe(
      true,
    );
    // Never carries a decision or executable arguments.
    for (const bad of [
      { proposalId: 'p-1', decision: 'approve' },
      { proposalId: 'p-1', force: true },
      { proposalId: '' },
      { proposalId: 'a b' },
      {},
    ])
      expect(expungeReviewSchema.safeParse(bad).success).toBe(false);
  });

  it('three-way: registered and allowlisted emits the call; registered but not allowlisted and allowlisted but not registered do not', async () => {
    // 1. Registered by the client (name sent as the hook registers it) and allowlisted.
    const both = await run([asSent(reviewToolRegistration.name)]);
    const start = both.find(
      (event) => event.type === EventType.TOOL_CALL_START,
    ) as Any;
    expect(start.toolCallName).toBe(expungeReviewTool.name);
    // 2. Registered by the client under a name the backend does not allowlist: ignored.
    const notAllowlisted = await run([asSent('review_expunge_proposal_v2')]);
    expect(types(notAllowlisted)).not.toContain(EventType.TOOL_CALL_START);
    // 3. Allowlisted on the backend but the client registered nothing: no call, workbench pointer.
    const notRegistered = await run([]);
    expect(types(notRegistered)).not.toContain(EventType.TOOL_CALL_START);
    expect(
      notRegistered
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta)
        .join(''),
    ).toContain(NO_TOOL_COPY);
  });

  it('mounts the registration once inside CopilotKitProvider (parsed JSX, so a comment or string does not count)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/client/App.tsx', import.meta.url)),
      'utf8',
    );
    const file = ts.createSourceFile(
      'App.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const tag = (node: ts.JsxTagNameExpression) => node.getText(file);
    const mounts: string[] = [];
    const visit = (node: ts.Node, inProvider: boolean) => {
      let inside = inProvider;
      if (
        ts.isJsxElement(node) &&
        tag(node.openingElement.tagName) === 'CopilotKitProvider'
      )
        inside = true;
      if (
        ts.isJsxSelfClosingElement(node) &&
        tag(node.tagName) === 'ExpungeReviewTool'
      )
        mounts.push(inside ? 'inside' : 'outside');
      ts.forEachChild(node, (child) => visit(child, inside));
    };
    visit(file, false);
    expect(mounts).toEqual(['inside']);
    // The negative control: the same parse does not see a mount that is only a comment.
    const commented = ts.createSourceFile(
      'x.tsx',
      '// <ExpungeReviewTool />\nconst a = "<ExpungeReviewTool />";',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let seen = 0;
    const count = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node)) seen += 1;
      ts.forEachChild(node, count);
    };
    count(commented);
    expect(seen).toBe(0);
  });

  it('registers exactly one human-in-the-loop tool, with the shared name and schema', () => {
    hook.calls.length = 0;
    expect(renderToStaticMarkup(<ExpungeReviewTool />)).toBe('');
    expect(hook.calls).toHaveLength(1);
    expect(hook.calls[0].name).toBe(expungeReviewTool.name);
    expect(hook.calls[0].parameters).toBe(expungeReviewSchema);
    expect(typeof hook.calls[0].render).toBe('function');
  });
});

describe('review card, unit-level: static markup, no live chat turn (no CopilotKit key)', () => {
  it('only opens the review: no approve or decline in the chat', () => {
    const html = renderToStaticMarkup(
      <ReviewCardBody
        proposalId="proposal-1"
        state="pending"
        loading={false}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('Open review');
    expect(html).toContain(CARD_STATE_COPY.pending);
    expect(html).not.toMatch(/Approve|Decline/);
    expect(html).not.toContain('ex-seal');
    expect((html.match(/<button/g) ?? []).length).toBe(1);
  });

  it('shows the committed state after a decision, never a client claim', () => {
    for (const state of [
      'approved',
      'declined',
      'expired',
      'consumed',
      'stale',
    ] as const) {
      const html = renderToStaticMarkup(
        <ReviewCardBody
          proposalId="proposal-1"
          state={state}
          loading={false}
          onOpen={() => undefined}
        />,
      );
      expect(html).toContain(CARD_STATE_COPY[state]);
      expect(html).not.toMatch(/Promoted|promoted/);
    }
    expect(CARD_STATE_COPY.approved).not.toMatch(/promot/i);
  });

  it('handles streaming, unreadable and malformed requests without inventing state', () => {
    const preparing = renderToStaticMarkup(
      <ReviewCardBody
        proposalId={null}
        state={null}
        loading={false}
        preparing
        onOpen={() => undefined}
      />,
    );
    expect(preparing).toContain('Preparing the review request');
    expect(preparing).not.toContain('Open review');
    const bad = renderToStaticMarkup(
      <ReviewCardBody
        proposalId={null}
        state={null}
        loading={false}
        onOpen={() => undefined}
      />,
    );
    expect(bad).toContain('not understood');
    expect(bad).not.toContain('Open review');
    const unread = renderToStaticMarkup(
      <ReviewCardBody
        proposalId="proposal-1"
        state={null}
        loading={false}
        onOpen={() => undefined}
      />,
    );
    expect(unread).toContain('could not be read');
  });
});
