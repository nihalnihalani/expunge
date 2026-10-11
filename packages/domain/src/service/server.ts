import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DomainService } from './handler.js';

const MAX_REQUEST_BYTES = 32 * 1024;

async function toRequest(incoming: IncomingMessage, host: string): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers))
    if (typeof value === 'string') headers.set(name, value);
  const method = incoming.method ?? 'GET';
  return new Request(new URL(incoming.url ?? '/', `http://${host}`), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  });
}

/** Serves the domain service over HTTP. Bind it to a private interface: it is for the operator server only. */
export async function listenDomainService(
  service: DomainService,
  options: { host?: string; port?: number; log?: (entry: Record<string, unknown>) => void } = {},
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? ((entry: Record<string, unknown>) => console.error(JSON.stringify(entry)));
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toRequest(incoming, host);
      if (!request) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"payload_too_large"}');
        return;
      }
      const response = await service.handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      // The client always gets the same generic answer. The log gets the error NAME and CODE only: never the message (it can
      // carry a connection string or a value), never the stack, never the request.
      const code = (error as { code?: unknown } | null)?.code;
      log({
        event: 'domain_service_error',
        name: error instanceof Error ? error.name : typeof error,
        ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      });
      outgoing.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"internal"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
