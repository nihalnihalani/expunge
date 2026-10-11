/** A recording stand-in for fetch. FIXTURE: used only by protocol tests. */
export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | object | ((call: RecordedCall) => Response | object);

export function recordingTransport(
  handler: (call: RecordedCall) => Reply | undefined,
) {
  const calls: RecordedCall[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: url.toString(),
      path: url.pathname,
      search: url.search,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const reply = handler(call);
    if (reply === undefined) return new Response('{}', { status: 404 });
    const value = typeof reply === 'function' ? reply(call) : reply;
    return value instanceof Response
      ? value
      : new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json' },
        });
  };
  return { transport, calls };
}
