/**
 * GENERATED FILE -- do not edit by hand.
 * Produced from <repo>/openapi.yaml by `node clients/typescript/generate.mjs`.
 * Re-run generation instead of patching this file; see clients/typescript/README.md.
 */

import createFetchClient from 'openapi-fetch';
import type { FetchOptions } from 'openapi-fetch';
import type { paths, operations, components } from './types.gen.js';
export type { paths, operations, components } from './types.gen.js';

/**
 * Caller-supplied configuration. Nothing is read from process.env, a stack config file,
 * or any other implicit source -- baseUrl and credentials must always be passed explicitly.
 */
export interface ClientConfig {
  /** Origin + path prefix the search service is reachable at, e.g. "https://search.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in search's openapi.yaml (18 total).
 * Each call returns openapi-fetch's own { data, error, response } union -- status, headers and
 * the raw Response are always reachable via .response; nothing throws on a non-2xx by default.
 * No retry, no timeout, no polling: this is a transport, not a workflow SDK. Pass an AbortSignal
 * via the per-call init if you need cancellation/timeout -- the client has no built-in timeout.
 */
export function createClient(config: ClientConfig) {
  const client = createFetchClient<paths>({
    baseUrl: config.baseUrl,
    headers: config.headers,
    fetch: config.fetch,
    credentials: config.credentials,
  });
  return {
    "search.documents.browse": (init: FetchOptions<operations["search.documents.browse"]>) => client.GET("/v1/indexes/{name}/documents", init),
    "search.documents.delete": (init: FetchOptions<operations["search.documents.delete"]>) => client.DELETE("/v1/indexes/{name}/documents/{id}", init),
    "search.documents.get": (init: FetchOptions<operations["search.documents.get"]>) => client.GET("/v1/indexes/{name}/documents/{id}", init),
    "search.documents.upsert": (init: FetchOptions<operations["search.documents.upsert"]>) => client.PUT("/v1/indexes/{name}/documents", init),
    "search.indexes.clear": (init: FetchOptions<operations["search.indexes.clear"]>) => client.POST("/v1/indexes/{name}/clear", init),
    "search.indexes.create": (init: FetchOptions<operations["search.indexes.create"]>) => client.POST("/v1/indexes", init),
    "search.indexes.delete": (init: FetchOptions<operations["search.indexes.delete"]>) => client.DELETE("/v1/indexes/{name}", init),
    "search.indexes.get": (init: FetchOptions<operations["search.indexes.get"]>) => client.GET("/v1/indexes/{name}", init),
    "search.indexes.list": (init: FetchOptions<operations["search.indexes.list"]>) => client.GET("/v1/indexes", init),
    "search.indexes.patch": (init: FetchOptions<operations["search.indexes.patch"]>) => client.PATCH("/v1/indexes/{name}", init),
    "search.query.get": (init: FetchOptions<operations["search.query.get"]>) => client.GET("/v1/indexes/{name}/search", init),
    "search.query.post": (init: FetchOptions<operations["search.query.post"]>) => client.POST("/v1/indexes/{name}/search", init),
    "search.stats.get": (init: FetchOptions<operations["search.stats.get"]>) => client.GET("/v1/stats", init),
    "search.suggest": (init: FetchOptions<operations["search.suggest"]>) => client.GET("/v1/indexes/{name}/suggest", init),
    "search.system.health": (init: FetchOptions<operations["search.system.health"]>) => client.GET("/health", init),
    "search.system.info": (init: FetchOptions<operations["search.system.info"]>) => client.GET("/v1/info", init),
    "search.system.metrics": (init: FetchOptions<operations["search.system.metrics"]>) => client.GET("/metrics", init),
    "search.system.ready": (init: FetchOptions<operations["search.system.ready"]>) => client.GET("/ready", init),
  } as const;
}

export type SearchClient = ReturnType<typeof createClient>;
