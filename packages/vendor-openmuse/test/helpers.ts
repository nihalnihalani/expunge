import { type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, type Observable, toArray } from 'rxjs';

export function runInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    state: {},
    messages: [{ id: 'user-1', role: 'user', content: 'start' }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

export async function collect(events: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return lastValueFrom(events.pipe(toArray()));
}

export const types = (events: BaseEvent[]) => events.map((event) => event.type as string);
