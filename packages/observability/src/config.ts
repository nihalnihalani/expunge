export type EnvMap = Readonly<Record<string, string | undefined>>;

export type RaindropWriteConfig = {
  /** Ingestion (write) key. Never the Query key. */
  writeKey: string;
  projectId: string;
  /** Ingestion base URL override (tests and private gateways). Default: the SDK's production endpoint. */
  endpoint?: string;
};

export type RaindropWriteConfigResult =
  { ok: true; config: RaindropWriteConfig } | { ok: false; missing: string[] };

/**
 * Reads the ingestion configuration from the environment: RAINDROP_API_KEY (write key), RAINDROP_PROJECT_ID, and
 * optionally RAINDROP_INGEST_URL. Reports only variable NAMES when something is missing, never values.
 */
export function raindropWriteConfigFromEnv(env: EnvMap): RaindropWriteConfigResult {
  const writeKey = env.RAINDROP_API_KEY?.trim();
  const projectId = env.RAINDROP_PROJECT_ID?.trim();
  const missing = [...(writeKey ? [] : ['RAINDROP_API_KEY']), ...(projectId ? [] : ['RAINDROP_PROJECT_ID'])];
  if (missing.length || !writeKey || !projectId) return { ok: false, missing };
  const endpoint = env.RAINDROP_INGEST_URL?.trim();
  return { ok: true, config: { writeKey, projectId, ...(endpoint ? { endpoint } : {}) } };
}

export type RaindropQueryConfig = { queryKey: string; projectId: string; baseUrl?: string };

/** RAINDROP_QUERY_API_KEY is a SEPARATE key from the write key; RAINDROP_QUERY_URL overrides the base URL. */
export function raindropQueryConfigFromEnv(
  env: EnvMap,
): { ok: true; config: RaindropQueryConfig } | { ok: false; missing: string[] } {
  const queryKey = env.RAINDROP_QUERY_API_KEY?.trim();
  const projectId = env.RAINDROP_PROJECT_ID?.trim();
  const missing = [
    ...(queryKey ? [] : ['RAINDROP_QUERY_API_KEY']),
    ...(projectId ? [] : ['RAINDROP_PROJECT_ID']),
  ];
  if (missing.length || !queryKey || !projectId) return { ok: false, missing };
  const baseUrl = env.RAINDROP_QUERY_URL?.trim();
  return { ok: true, config: { queryKey, projectId, ...(baseUrl ? { baseUrl } : {}) } };
}
