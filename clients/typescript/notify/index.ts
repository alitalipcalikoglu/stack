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
  /** Origin + path prefix the notify service is reachable at, e.g. "https://notify.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in notify's openapi.yaml (9 total).
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
    "notify.health.get": (init: FetchOptions<operations["notify.health.get"]>) => client.GET("/health", init),
    "notify.info.get": (init: FetchOptions<operations["notify.info.get"]>) => client.GET("/v1/info", init),
    "notify.messages.create": (init: FetchOptions<operations["notify.messages.create"]>) => client.POST("/v1/messages", init),
    "notify.messages.get": (init: FetchOptions<operations["notify.messages.get"]>) => client.GET("/v1/messages/{id}", init),
    "notify.messages.list": (init: FetchOptions<operations["notify.messages.list"]>) => client.GET("/v1/messages", init),
    "notify.messages.retry": (init: FetchOptions<operations["notify.messages.retry"]>) => client.POST("/v1/messages/{id}/retry", init),
    "notify.metrics.get": (init: FetchOptions<operations["notify.metrics.get"]>) => client.GET("/metrics", init),
    "notify.ready.get": (init: FetchOptions<operations["notify.ready.get"]>) => client.GET("/ready", init),
    "notify.templates.list": (init: FetchOptions<operations["notify.templates.list"]>) => client.GET("/v1/templates", init),
  } as const;
}

export type NotifyClient = ReturnType<typeof createClient>;
