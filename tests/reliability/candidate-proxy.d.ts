// Type surface of infra/opendots/candidate-proxy.mjs for the reliability probes (the module is plain JavaScript).
declare module '*/candidate-proxy.mjs' {
  import type { Server } from 'node:http';
  export function createCandidateProxy(
    env: Record<string, string | undefined>,
    transport?: (url: URL, init: RequestInit & { headers: Record<string, string> }) => Promise<Response>,
  ): Server;
}
