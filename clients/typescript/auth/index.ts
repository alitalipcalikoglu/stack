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
  /** Origin + path prefix the auth service is reachable at, e.g. "https://auth.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in auth's openapi.yaml (23 total).
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
    "auth.emailVerification.resend": (init: FetchOptions<operations["auth.emailVerification.resend"]>) => client.POST("/v1/auth/verify-email/resend", init),
    "auth.emailVerification.verify": (init: FetchOptions<operations["auth.emailVerification.verify"]>) => client.POST("/v1/auth/verify-email", init),
    "auth.events.list": (init: FetchOptions<operations["auth.events.list"]>) => client.GET("/v1/users/{id}/events", init),
    "auth.health.get": (init: FetchOptions<operations["auth.health.get"]>) => client.GET("/health", init),
    "auth.info.get": (init: FetchOptions<operations["auth.info.get"]>) => client.GET("/v1/info", init),
    "auth.introspect": (init: FetchOptions<operations["auth.introspect"]>) => client.POST("/v1/auth/introspect", init),
    "auth.jwks.get": (init: FetchOptions<operations["auth.jwks.get"]>) => client.GET("/.well-known/jwks.json", init),
    "auth.login": (init: FetchOptions<operations["auth.login"]>) => client.POST("/v1/auth/login", init),
    "auth.logout": (init: FetchOptions<operations["auth.logout"]>) => client.POST("/v1/auth/logout", init),
    "auth.metrics.get": (init: FetchOptions<operations["auth.metrics.get"]>) => client.GET("/metrics", init),
    "auth.password.change": (init: FetchOptions<operations["auth.password.change"]>) => client.POST("/v1/auth/password/change", init),
    "auth.password.forgot": (init: FetchOptions<operations["auth.password.forgot"]>) => client.POST("/v1/auth/password/forgot", init),
    "auth.password.reset": (init: FetchOptions<operations["auth.password.reset"]>) => client.POST("/v1/auth/password/reset", init),
    "auth.ready.get": (init: FetchOptions<operations["auth.ready.get"]>) => client.GET("/ready", init),
    "auth.refresh": (init: FetchOptions<operations["auth.refresh"]>) => client.POST("/v1/auth/refresh", init),
    "auth.sessions.list": (init: FetchOptions<operations["auth.sessions.list"]>) => client.GET("/v1/users/{id}/sessions", init),
    "auth.sessions.revokeAll": (init: FetchOptions<operations["auth.sessions.revokeAll"]>) => client.DELETE("/v1/users/{id}/sessions", init),
    "auth.sessions.revokeOne": (init: FetchOptions<operations["auth.sessions.revokeOne"]>) => client.DELETE("/v1/users/{id}/sessions/{sid}", init),
    "auth.users.create": (init: FetchOptions<operations["auth.users.create"]>) => client.POST("/v1/users", init),
    "auth.users.delete": (init: FetchOptions<operations["auth.users.delete"]>) => client.DELETE("/v1/users/{id}", init),
    "auth.users.get": (init: FetchOptions<operations["auth.users.get"]>) => client.GET("/v1/users/{id}", init),
    "auth.users.list": (init: FetchOptions<operations["auth.users.list"]>) => client.GET("/v1/users", init),
    "auth.users.patch": (init: FetchOptions<operations["auth.users.patch"]>) => client.PATCH("/v1/users/{id}", init),
  } as const;
}

export type AuthClient = ReturnType<typeof createClient>;
