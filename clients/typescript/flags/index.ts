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
  /** Origin + path prefix the flags service is reachable at, e.g. "https://flags.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in flags's openapi.yaml (20 total).
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
    "flags.environments.list": (init: FetchOptions<operations["flags.environments.list"]>) => client.GET("/v1/environments", init),
    "flags.envs.copy": (init: FetchOptions<operations["flags.envs.copy"]>) => client.POST("/v1/flags/{key}/envs/{env}/copy", init),
    "flags.envs.get": (init: FetchOptions<operations["flags.envs.get"]>) => client.GET("/v1/flags/{key}/envs/{env}", init),
    "flags.envs.patch": (init: FetchOptions<operations["flags.envs.patch"]>) => client.PATCH("/v1/flags/{key}/envs/{env}", init),
    "flags.evaluate.get": (init: FetchOptions<operations["flags.evaluate.get"]>) => client.GET("/v1/evaluate", init),
    "flags.evaluate.post": (init: FetchOptions<operations["flags.evaluate.post"]>) => client.POST("/v1/evaluate", init),
    "flags.flags.create": (init: FetchOptions<operations["flags.flags.create"]>) => client.POST("/v1/flags", init),
    "flags.flags.delete": (init: FetchOptions<operations["flags.flags.delete"]>) => client.DELETE("/v1/flags/{key}", init),
    "flags.flags.get": (init: FetchOptions<operations["flags.flags.get"]>) => client.GET("/v1/flags/{key}", init),
    "flags.flags.getHistory": (init: FetchOptions<operations["flags.flags.getHistory"]>) => client.GET("/v1/flags/{key}/history", init),
    "flags.flags.list": (init: FetchOptions<operations["flags.flags.list"]>) => client.GET("/v1/flags", init),
    "flags.flags.patch": (init: FetchOptions<operations["flags.flags.patch"]>) => client.PATCH("/v1/flags/{key}", init),
    "flags.health.get": (init: FetchOptions<operations["flags.health.get"]>) => client.GET("/health", init),
    "flags.history.list": (init: FetchOptions<operations["flags.history.list"]>) => client.GET("/v1/history", init),
    "flags.info.get": (init: FetchOptions<operations["flags.info.get"]>) => client.GET("/v1/info", init),
    "flags.metrics.get": (init: FetchOptions<operations["flags.metrics.get"]>) => client.GET("/metrics", init),
    "flags.openapi": (init: FetchOptions<operations["flags.openapi"]>) => client.GET("/openapi.yaml", init),
    "flags.ready.get": (init: FetchOptions<operations["flags.ready.get"]>) => client.GET("/ready", init),
    "flags.snapshot.get": (init: FetchOptions<operations["flags.snapshot.get"]>) => client.GET("/v1/snapshot/{env}", init),
    "flags.stats.get": (init: FetchOptions<operations["flags.stats.get"]>) => client.GET("/v1/stats", init),
  } as const;
}

export type FlagsClient = ReturnType<typeof createClient>;
