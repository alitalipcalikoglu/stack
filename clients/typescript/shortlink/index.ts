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
  /** Origin + path prefix the shortlink service is reachable at, e.g. "https://shortlink.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in shortlink's openapi.yaml (16 total).
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
    "shortlink.health.get": (init: FetchOptions<operations["shortlink.health.get"]>) => client.GET("/health", init),
    "shortlink.info.get": (init: FetchOptions<operations["shortlink.info.get"]>) => client.GET("/v1/info", init),
    "shortlink.links.create": (init: FetchOptions<operations["shortlink.links.create"]>) => client.POST("/v1/links", init),
    "shortlink.links.delete": (init: FetchOptions<operations["shortlink.links.delete"]>) => client.DELETE("/v1/links/{code}", init),
    "shortlink.links.get": (init: FetchOptions<operations["shortlink.links.get"]>) => client.GET("/v1/links/{code}", init),
    "shortlink.links.getQr": (init: FetchOptions<operations["shortlink.links.getQr"]>) => client.GET("/v1/links/{code}/qr", init),
    "shortlink.links.getStats": (init: FetchOptions<operations["shortlink.links.getStats"]>) => client.GET("/v1/links/{code}/stats", init),
    "shortlink.links.list": (init: FetchOptions<operations["shortlink.links.list"]>) => client.GET("/v1/links", init),
    "shortlink.links.patch": (init: FetchOptions<operations["shortlink.links.patch"]>) => client.PATCH("/v1/links/{code}", init),
    "shortlink.metrics.get": (init: FetchOptions<operations["shortlink.metrics.get"]>) => client.GET("/metrics", init),
    "shortlink.qr.getForText": (init: FetchOptions<operations["shortlink.qr.getForText"]>) => client.GET("/v1/qr", init),
    "shortlink.qr.getPublic": (init: FetchOptions<operations["shortlink.qr.getPublic"]>) => client.GET("/{code}/qr", init),
    "shortlink.ready.get": (init: FetchOptions<operations["shortlink.ready.get"]>) => client.GET("/ready", init),
    "shortlink.redirect.follow": (init: FetchOptions<operations["shortlink.redirect.follow"]>) => client.GET("/{code}", init),
    "shortlink.robots.get": (init: FetchOptions<operations["shortlink.robots.get"]>) => client.GET("/robots.txt", init),
    "shortlink.stats.get": (init: FetchOptions<operations["shortlink.stats.get"]>) => client.GET("/v1/stats", init),
  } as const;
}

export type ShortlinkClient = ReturnType<typeof createClient>;
