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
  /** Origin + path prefix the geo service is reachable at, e.g. "https://geo.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in geo's openapi.yaml (31 total).
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
    "geo.collections.clear": (init: FetchOptions<operations["geo.collections.clear"]>) => client.POST("/v1/collections/{name}/clear", init),
    "geo.collections.create": (init: FetchOptions<operations["geo.collections.create"]>) => client.POST("/v1/collections", init),
    "geo.collections.delete": (init: FetchOptions<operations["geo.collections.delete"]>) => client.DELETE("/v1/collections/{name}", init),
    "geo.collections.get": (init: FetchOptions<operations["geo.collections.get"]>) => client.GET("/v1/collections/{name}", init),
    "geo.collections.list": (init: FetchOptions<operations["geo.collections.list"]>) => client.GET("/v1/collections", init),
    "geo.collections.patch": (init: FetchOptions<operations["geo.collections.patch"]>) => client.PATCH("/v1/collections/{name}", init),
    "geo.countries.get": (init: FetchOptions<operations["geo.countries.get"]>) => client.GET("/v1/countries/{code}", init),
    "geo.countries.list": (init: FetchOptions<operations["geo.countries.list"]>) => client.GET("/v1/countries", init),
    "geo.currencies.get": (init: FetchOptions<operations["geo.currencies.get"]>) => client.GET("/v1/currencies/{code}", init),
    "geo.currencies.list": (init: FetchOptions<operations["geo.currencies.list"]>) => client.GET("/v1/currencies", init),
    "geo.database.getInfo": (init: FetchOptions<operations["geo.database.getInfo"]>) => client.GET("/v1/database", init),
    "geo.database.reload": (init: FetchOptions<operations["geo.database.reload"]>) => client.POST("/v1/database/reload", init),
    "geo.distance.compute": (init: FetchOptions<operations["geo.distance.compute"]>) => client.GET("/v1/distance", init),
    "geo.health.check": (init: FetchOptions<operations["geo.health.check"]>) => client.GET("/health", init),
    "geo.info.get": (init: FetchOptions<operations["geo.info.get"]>) => client.GET("/v1/info", init),
    "geo.ip.lookup": (init: FetchOptions<operations["geo.ip.lookup"]>) => client.GET("/v1/ip/{ip}", init),
    "geo.ip.lookupBatch": (init: FetchOptions<operations["geo.ip.lookupBatch"]>) => client.POST("/v1/ip/batch", init),
    "geo.ip.lookupSelf": (init: FetchOptions<operations["geo.ip.lookupSelf"]>) => client.GET("/v1/ip/self", init),
    "geo.metrics.get": (init: FetchOptions<operations["geo.metrics.get"]>) => client.GET("/metrics", init),
    "geo.openapi": (init: FetchOptions<operations["geo.openapi"]>) => client.GET("/openapi.yaml", init),
    "geo.phone.normalize": (init: FetchOptions<operations["geo.phone.normalize"]>) => client.GET("/v1/phone", init),
    "geo.phone.normalizeBatch": (init: FetchOptions<operations["geo.phone.normalizeBatch"]>) => client.POST("/v1/phone/batch", init),
    "geo.places.delete": (init: FetchOptions<operations["geo.places.delete"]>) => client.DELETE("/v1/collections/{name}/places/{id}", init),
    "geo.places.get": (init: FetchOptions<operations["geo.places.get"]>) => client.GET("/v1/collections/{name}/places/{id}", init),
    "geo.places.list": (init: FetchOptions<operations["geo.places.list"]>) => client.GET("/v1/collections/{name}/places", init),
    "geo.places.nearby": (init: FetchOptions<operations["geo.places.nearby"]>) => client.GET("/v1/collections/{name}/nearby", init),
    "geo.places.upsert": (init: FetchOptions<operations["geo.places.upsert"]>) => client.PUT("/v1/collections/{name}/places", init),
    "geo.ready.check": (init: FetchOptions<operations["geo.ready.check"]>) => client.GET("/ready", init),
    "geo.stats.get": (init: FetchOptions<operations["geo.stats.get"]>) => client.GET("/v1/stats", init),
    "geo.timezones.get": (init: FetchOptions<operations["geo.timezones.get"]>) => client.GET("/v1/timezones/{tzPath}", init),
    "geo.timezones.list": (init: FetchOptions<operations["geo.timezones.list"]>) => client.GET("/v1/timezones", init),
  } as const;
}

export type GeoClient = ReturnType<typeof createClient>;
