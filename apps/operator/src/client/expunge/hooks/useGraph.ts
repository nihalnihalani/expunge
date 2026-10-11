import { useEffect, useMemo, useState } from 'react';
import type {
  ArtifactEnvelope,
  GraphEdge,
  GraphNode,
  GraphPage,
} from '../../../shared/expunge';
import { ExpungeApiError, expungeFetch, isAbort } from '../api';
import { buildIndex, type GraphIndex } from '../projection/graphModel';

export type PageFetcher = (
  artifactId: string,
  cursor: string | null,
  signal: AbortSignal,
) => Promise<ArtifactEnvelope<GraphPage>>;

const defaultFetcher: PageFetcher = (artifactId, cursor, signal) =>
  expungeFetch<ArtifactEnvelope<GraphPage>>(
    `/artifacts/${encodeURIComponent(artifactId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { signal },
  );

/** Reads every page up to the bound. A cursor that repeats is treated as the end (a misbehaving backend cannot loop us). */
export async function readGraph(
  artifactId: string,
  fetchPage: PageFetcher,
  signal: AbortSignal,
  maxPages = 20,
) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const envelope: ArtifactEnvelope<GraphPage> = await fetchPage(
      artifactId,
      cursor,
      signal,
    );
    nodes.push(...envelope.payload.nodes);
    edges.push(...envelope.payload.edges);
    cursor = envelope.payload.nextCursor;
    pages += 1;
    if (cursor !== null) {
      if (seen.has(cursor)) {
        cursor = null;
        break;
      }
      seen.add(cursor);
    }
  } while (cursor && pages < maxPages);
  // Duplicate ids across pages are collapsed so the table never shows a record twice.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    index: buildIndex([...byId.values()], edges),
    truncated: cursor !== null,
  };
}

export const MAX_GRAPH_PAGES = 20;

export interface GraphState {
  status: 'idle' | 'loading' | 'ok' | 'not_found' | 'unavailable' | 'error';
  index: GraphIndex | null;
  /** True when more pages exist than the client will fetch. */
  truncated: boolean;
  error: ExpungeApiError | null;
  /** The snapshot sequence this graph was read at; refreshes when the snapshot moves. */
  readAt: number | null;
}

/**
 * Reads the graph artifact page by page (bounded). It reloads when `version` changes (a new
 * committed snapshot), so effects landing on the graph appear without a manual refresh.
 */
export function useGraph(
  artifactId: string | null,
  version: number,
  fetchPage: PageFetcher = defaultFetcher,
): GraphState & { refresh: () => void } {
  const [state, setState] = useState<GraphState>({
    status: 'idle',
    index: null,
    truncated: false,
    error: null,
    readAt: null,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!artifactId) {
      setState({
        status: 'idle',
        index: null,
        truncated: false,
        error: null,
        readAt: null,
      });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({
      ...previous,
      status: previous.index ? previous.status : 'loading',
    }));
    void readGraph(artifactId, fetchPage, controller.signal, MAX_GRAPH_PAGES)
      .then(({ index, truncated }) =>
        setState({
          status: 'ok',
          index,
          truncated,
          error: null,
          readAt: version,
        }),
      )
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbort(cause)) return;
        const error =
          cause instanceof ExpungeApiError
            ? cause
            : new ExpungeApiError(
                'transport',
                0,
                'transport',
                'Could not reach the operator.',
              );
        setState((previous) => ({
          ...previous,
          status:
            error.status === 404
              ? 'not_found'
              : error.status === 503 || error.status === 501
                ? 'unavailable'
                : 'error',
          error,
        }));
      });
    return () => controller.abort();
  }, [artifactId, version, nonce, fetchPage]);
  const refresh = useMemo(() => () => setNonce((value) => value + 1), []);
  return { ...state, refresh };
}
