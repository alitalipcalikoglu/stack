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
  /** Origin + path prefix the webhook-out service is reachable at, e.g. "https://webhook-out.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in webhook-out's openapi.yaml (22 total).
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
    "webhookOut.deliveries.cancel": (init: FetchOptions<operations["webhookOut.deliveries.cancel"]>) => client.POST("/v1/deliveries/{id}/cancel", init),
    "webhookOut.deliveries.get": (init: FetchOptions<operations["webhookOut.deliveries.get"]>) => client.GET("/v1/deliveries/{id}", init),
    "webhookOut.deliveries.list": (init: FetchOptions<operations["webhookOut.deliveries.list"]>) => client.GET("/v1/deliveries", init),
    "webhookOut.deliveries.redeliver": (init: FetchOptions<operations["webhookOut.deliveries.redeliver"]>) => client.POST("/v1/deliveries/{id}/redeliver", init),
    "webhookOut.events.get": (init: FetchOptions<operations["webhookOut.events.get"]>) => client.GET("/v1/events/{id}", init),
    "webhookOut.events.list": (init: FetchOptions<operations["webhookOut.events.list"]>) => client.GET("/v1/events", init),
    "webhookOut.events.publish": (init: FetchOptions<operations["webhookOut.events.publish"]>) => client.POST("/v1/events", init),
    "webhookOut.eventTypes.list": (init: FetchOptions<operations["webhookOut.eventTypes.list"]>) => client.GET("/v1/event-types", init),
    "webhookOut.health.get": (init: FetchOptions<operations["webhookOut.health.get"]>) => client.GET("/health", init),
    "webhookOut.info.get": (init: FetchOptions<operations["webhookOut.info.get"]>) => client.GET("/v1/info", init),
    "webhookOut.metrics.get": (init: FetchOptions<operations["webhookOut.metrics.get"]>) => client.GET("/metrics", init),
    "webhookOut.ready.get": (init: FetchOptions<operations["webhookOut.ready.get"]>) => client.GET("/ready", init),
    "webhookOut.stats.get": (init: FetchOptions<operations["webhookOut.stats.get"]>) => client.GET("/v1/stats", init),
    "webhookOut.subscriptions.create": (init: FetchOptions<operations["webhookOut.subscriptions.create"]>) => client.POST("/v1/subscriptions", init),
    "webhookOut.subscriptions.delete": (init: FetchOptions<operations["webhookOut.subscriptions.delete"]>) => client.DELETE("/v1/subscriptions/{id}", init),
    "webhookOut.subscriptions.get": (init: FetchOptions<operations["webhookOut.subscriptions.get"]>) => client.GET("/v1/subscriptions/{id}", init),
    "webhookOut.subscriptions.list": (init: FetchOptions<operations["webhookOut.subscriptions.list"]>) => client.GET("/v1/subscriptions", init),
    "webhookOut.subscriptions.listDeliveries": (init: FetchOptions<operations["webhookOut.subscriptions.listDeliveries"]>) => client.GET("/v1/subscriptions/{id}/deliveries", init),
    "webhookOut.subscriptions.patch": (init: FetchOptions<operations["webhookOut.subscriptions.patch"]>) => client.PATCH("/v1/subscriptions/{id}", init),
    "webhookOut.subscriptions.replay": (init: FetchOptions<operations["webhookOut.subscriptions.replay"]>) => client.POST("/v1/subscriptions/{id}/replay", init),
    "webhookOut.subscriptions.rotate": (init: FetchOptions<operations["webhookOut.subscriptions.rotate"]>) => client.POST("/v1/subscriptions/{id}/rotate", init),
    "webhookOut.subscriptions.test": (init: FetchOptions<operations["webhookOut.subscriptions.test"]>) => client.POST("/v1/subscriptions/{id}/test", init),
  } as const;
}

export type WebhookOutClient = ReturnType<typeof createClient>;
