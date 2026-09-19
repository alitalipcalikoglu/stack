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
  /** Origin + path prefix the ratelimit service is reachable at, e.g. "https://ratelimit.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in ratelimit's openapi.yaml (21 total).
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
    "ratelimit.check": (init: FetchOptions<operations["ratelimit.check"]>) => client.POST("/v1/check", init),
    "ratelimit.checkBatch": (init: FetchOptions<operations["ratelimit.checkBatch"]>) => client.POST("/v1/check/batch", init),
    "ratelimit.health.check": (init: FetchOptions<operations["ratelimit.health.check"]>) => client.GET("/health", init),
    "ratelimit.info.get": (init: FetchOptions<operations["ratelimit.info.get"]>) => client.GET("/v1/info", init),
    "ratelimit.metrics.get": (init: FetchOptions<operations["ratelimit.metrics.get"]>) => client.GET("/metrics", init),
    "ratelimit.openapi": (init: FetchOptions<operations["ratelimit.openapi"]>) => client.GET("/openapi.yaml", init),
    "ratelimit.overrides.delete": (init: FetchOptions<operations["ratelimit.overrides.delete"]>) => client.DELETE("/v1/policies/{name}/overrides/{subject}", init),
    "ratelimit.overrides.list": (init: FetchOptions<operations["ratelimit.overrides.list"]>) => client.GET("/v1/policies/{name}/overrides", init),
    "ratelimit.overrides.set": (init: FetchOptions<operations["ratelimit.overrides.set"]>) => client.PUT("/v1/policies/{name}/overrides/{subject}", init),
    "ratelimit.policies.create": (init: FetchOptions<operations["ratelimit.policies.create"]>) => client.POST("/v1/policies", init),
    "ratelimit.policies.delete": (init: FetchOptions<operations["ratelimit.policies.delete"]>) => client.DELETE("/v1/policies/{name}", init),
    "ratelimit.policies.get": (init: FetchOptions<operations["ratelimit.policies.get"]>) => client.GET("/v1/policies/{name}", init),
    "ratelimit.policies.getStats": (init: FetchOptions<operations["ratelimit.policies.getStats"]>) => client.GET("/v1/policies/{name}/stats", init),
    "ratelimit.policies.getTop": (init: FetchOptions<operations["ratelimit.policies.getTop"]>) => client.GET("/v1/policies/{name}/top", init),
    "ratelimit.policies.list": (init: FetchOptions<operations["ratelimit.policies.list"]>) => client.GET("/v1/policies", init),
    "ratelimit.policies.patch": (init: FetchOptions<operations["ratelimit.policies.patch"]>) => client.PATCH("/v1/policies/{name}", init),
    "ratelimit.ready.check": (init: FetchOptions<operations["ratelimit.ready.check"]>) => client.GET("/ready", init),
    "ratelimit.release": (init: FetchOptions<operations["ratelimit.release"]>) => client.POST("/v1/release", init),
    "ratelimit.stats.get": (init: FetchOptions<operations["ratelimit.stats.get"]>) => client.GET("/v1/stats", init),
    "ratelimit.subjects.getUsage": (init: FetchOptions<operations["ratelimit.subjects.getUsage"]>) => client.GET("/v1/policies/{name}/subjects/{subject}", init),
    "ratelimit.subjects.resetUsage": (init: FetchOptions<operations["ratelimit.subjects.resetUsage"]>) => client.DELETE("/v1/policies/{name}/subjects/{subject}/usage", init),
  } as const;
}

export type RatelimitClient = ReturnType<typeof createClient>;
