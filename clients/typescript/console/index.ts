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
  /** Origin + path prefix the console service is reachable at, e.g. "https://console.internal:4000". */
  baseUrl: string;
  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */
  headers?: HeadersInit;
  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */
  fetch?: typeof fetch;
  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */
  credentials?: RequestCredentials;
}

/**
 * One operationId-keyed method per operation in console's openapi.yaml (153 total).
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
    "console.activity.list": (init: FetchOptions<operations["console.activity.list"]>) => client.GET("/api/audit", init),
    "console.admins.create": (init: FetchOptions<operations["console.admins.create"]>) => client.POST("/api/admins", init),
    "console.admins.delete": (init: FetchOptions<operations["console.admins.delete"]>) => client.DELETE("/api/admins/{id}", init),
    "console.admins.list": (init: FetchOptions<operations["console.admins.list"]>) => client.GET("/api/admins", init),
    "console.admins.resetPassword": (init: FetchOptions<operations["console.admins.resetPassword"]>) => client.POST("/api/admins/{id}/password", init),
    "console.admins.unlock": (init: FetchOptions<operations["console.admins.unlock"]>) => client.POST("/api/admins/{id}/unlock", init),
    "console.admins.update": (init: FetchOptions<operations["console.admins.update"]>) => client.PATCH("/api/admins/{id}", init),
    "console.audit.chain.head": (init: FetchOptions<operations["console.audit.chain.head"]>) => client.GET("/api/services/{sid}/audit/chain/head", init),
    "console.audit.chain.verify": (init: FetchOptions<operations["console.audit.chain.verify"]>) => client.GET("/api/services/{sid}/audit/chain/verify", init),
    "console.audit.events.export": (init: FetchOptions<operations["console.audit.events.export"]>) => client.GET("/api/services/{sid}/audit/events/export", init),
    "console.audit.events.get": (init: FetchOptions<operations["console.audit.events.get"]>) => client.GET("/api/services/{sid}/audit/events/{id}", init),
    "console.audit.events.list": (init: FetchOptions<operations["console.audit.events.list"]>) => client.GET("/api/services/{sid}/audit/events", init),
    "console.audit.stats.get": (init: FetchOptions<operations["console.audit.stats.get"]>) => client.GET("/api/services/{sid}/audit/stats", init),
    "console.auth.jwks.get": (init: FetchOptions<operations["console.auth.jwks.get"]>) => client.GET("/api/services/{sid}/auth/jwks", init),
    "console.auth.users.create": (init: FetchOptions<operations["console.auth.users.create"]>) => client.POST("/api/services/{sid}/auth/users", init),
    "console.auth.users.delete": (init: FetchOptions<operations["console.auth.users.delete"]>) => client.DELETE("/api/services/{sid}/auth/users/{id}", init),
    "console.auth.users.events": (init: FetchOptions<operations["console.auth.users.events"]>) => client.GET("/api/services/{sid}/auth/users/{id}/events", init),
    "console.auth.users.get": (init: FetchOptions<operations["console.auth.users.get"]>) => client.GET("/api/services/{sid}/auth/users/{id}", init),
    "console.auth.users.list": (init: FetchOptions<operations["console.auth.users.list"]>) => client.GET("/api/services/{sid}/auth/users", init),
    "console.auth.users.passwordResetEmail": (init: FetchOptions<operations["console.auth.users.passwordResetEmail"]>) => client.POST("/api/services/{sid}/auth/users/{id}/password-reset-email", init),
    "console.auth.users.resendVerification": (init: FetchOptions<operations["console.auth.users.resendVerification"]>) => client.POST("/api/services/{sid}/auth/users/{id}/resend-verification", init),
    "console.auth.users.revokeAllSessions": (init: FetchOptions<operations["console.auth.users.revokeAllSessions"]>) => client.DELETE("/api/services/{sid}/auth/users/{id}/sessions", init),
    "console.auth.users.revokeSession": (init: FetchOptions<operations["console.auth.users.revokeSession"]>) => client.DELETE("/api/services/{sid}/auth/users/{id}/sessions/{sub}", init),
    "console.auth.users.update": (init: FetchOptions<operations["console.auth.users.update"]>) => client.PATCH("/api/services/{sid}/auth/users/{id}", init),
    "console.flags.environments.list": (init: FetchOptions<operations["console.flags.environments.list"]>) => client.GET("/api/services/{sid}/flags/environments", init),
    "console.flags.envs.copy": (init: FetchOptions<operations["console.flags.envs.copy"]>) => client.POST("/api/services/{sid}/flags/flags/{id}/envs/{sub}/copy", init),
    "console.flags.envs.update": (init: FetchOptions<operations["console.flags.envs.update"]>) => client.PATCH("/api/services/{sid}/flags/flags/{id}/envs/{sub}", init),
    "console.flags.evaluate.post": (init: FetchOptions<operations["console.flags.evaluate.post"]>) => client.POST("/api/services/{sid}/flags/evaluate", init),
    "console.flags.flags.create": (init: FetchOptions<operations["console.flags.flags.create"]>) => client.POST("/api/services/{sid}/flags/flags", init),
    "console.flags.flags.delete": (init: FetchOptions<operations["console.flags.flags.delete"]>) => client.DELETE("/api/services/{sid}/flags/flags/{id}", init),
    "console.flags.flags.get": (init: FetchOptions<operations["console.flags.flags.get"]>) => client.GET("/api/services/{sid}/flags/flags/{id}", init),
    "console.flags.flags.history": (init: FetchOptions<operations["console.flags.flags.history"]>) => client.GET("/api/services/{sid}/flags/flags/{id}/history", init),
    "console.flags.flags.list": (init: FetchOptions<operations["console.flags.flags.list"]>) => client.GET("/api/services/{sid}/flags/flags", init),
    "console.flags.flags.update": (init: FetchOptions<operations["console.flags.flags.update"]>) => client.PATCH("/api/services/{sid}/flags/flags/{id}", init),
    "console.flags.history.list": (init: FetchOptions<operations["console.flags.history.list"]>) => client.GET("/api/services/{sid}/flags/history", init),
    "console.flags.stats.get": (init: FetchOptions<operations["console.flags.stats.get"]>) => client.GET("/api/services/{sid}/flags/stats", init),
    "console.geo.collections.clear": (init: FetchOptions<operations["console.geo.collections.clear"]>) => client.POST("/api/services/{sid}/geo/collections/{id}/clear", init),
    "console.geo.collections.create": (init: FetchOptions<operations["console.geo.collections.create"]>) => client.POST("/api/services/{sid}/geo/collections", init),
    "console.geo.collections.delete": (init: FetchOptions<operations["console.geo.collections.delete"]>) => client.DELETE("/api/services/{sid}/geo/collections/{id}", init),
    "console.geo.collections.get": (init: FetchOptions<operations["console.geo.collections.get"]>) => client.GET("/api/services/{sid}/geo/collections/{id}", init),
    "console.geo.collections.list": (init: FetchOptions<operations["console.geo.collections.list"]>) => client.GET("/api/services/{sid}/geo/collections", init),
    "console.geo.collections.nearby": (init: FetchOptions<operations["console.geo.collections.nearby"]>) => client.GET("/api/services/{sid}/geo/collections/{id}/nearby", init),
    "console.geo.collections.update": (init: FetchOptions<operations["console.geo.collections.update"]>) => client.PATCH("/api/services/{sid}/geo/collections/{id}", init),
    "console.geo.countries.get": (init: FetchOptions<operations["console.geo.countries.get"]>) => client.GET("/api/services/{sid}/geo/countries/{id}", init),
    "console.geo.countries.list": (init: FetchOptions<operations["console.geo.countries.list"]>) => client.GET("/api/services/{sid}/geo/countries", init),
    "console.geo.currencies.list": (init: FetchOptions<operations["console.geo.currencies.list"]>) => client.GET("/api/services/{sid}/geo/currencies", init),
    "console.geo.database.get": (init: FetchOptions<operations["console.geo.database.get"]>) => client.GET("/api/services/{sid}/geo/database", init),
    "console.geo.database.reload": (init: FetchOptions<operations["console.geo.database.reload"]>) => client.POST("/api/services/{sid}/geo/database/reload", init),
    "console.geo.distance.get": (init: FetchOptions<operations["console.geo.distance.get"]>) => client.GET("/api/services/{sid}/geo/distance", init),
    "console.geo.ip.batch": (init: FetchOptions<operations["console.geo.ip.batch"]>) => client.POST("/api/services/{sid}/geo/ip/batch", init),
    "console.geo.ip.lookup": (init: FetchOptions<operations["console.geo.ip.lookup"]>) => client.GET("/api/services/{sid}/geo/ip", init),
    "console.geo.phone.lookup": (init: FetchOptions<operations["console.geo.phone.lookup"]>) => client.GET("/api/services/{sid}/geo/phone", init),
    "console.geo.places.delete": (init: FetchOptions<operations["console.geo.places.delete"]>) => client.DELETE("/api/services/{sid}/geo/collections/{id}/places/{sub}", init),
    "console.geo.places.list": (init: FetchOptions<operations["console.geo.places.list"]>) => client.GET("/api/services/{sid}/geo/collections/{id}/places", init),
    "console.geo.places.upsert": (init: FetchOptions<operations["console.geo.places.upsert"]>) => client.PUT("/api/services/{sid}/geo/collections/{id}/places", init),
    "console.geo.stats.get": (init: FetchOptions<operations["console.geo.stats.get"]>) => client.GET("/api/services/{sid}/geo/stats", init),
    "console.geo.timezones.list": (init: FetchOptions<operations["console.geo.timezones.list"]>) => client.GET("/api/services/{sid}/geo/timezones", init),
    "console.health.get": (init: FetchOptions<operations["console.health.get"]>) => client.GET("/health", init),
    "console.info.get": (init: FetchOptions<operations["console.info.get"]>) => client.GET("/v1/info", init),
    "console.me.password.change": (init: FetchOptions<operations["console.me.password.change"]>) => client.POST("/api/me/password", init),
    "console.me.sessions.list": (init: FetchOptions<operations["console.me.sessions.list"]>) => client.GET("/api/me/sessions", init),
    "console.me.sessions.logoutOthers": (init: FetchOptions<operations["console.me.sessions.logoutOthers"]>) => client.POST("/api/me/sessions/logout-others", init),
    "console.me.totp.confirm": (init: FetchOptions<operations["console.me.totp.confirm"]>) => client.POST("/api/me/totp/confirm", init),
    "console.me.totp.disable": (init: FetchOptions<operations["console.me.totp.disable"]>) => client.POST("/api/me/totp/disable", init),
    "console.me.totp.start": (init: FetchOptions<operations["console.me.totp.start"]>) => client.POST("/api/me/totp/start", init),
    "console.media.files.bytes": (init: FetchOptions<operations["console.media.files.bytes"]>) => client.GET("/api/services/{sid}/media/files/{id}/bytes/{sub}", init),
    "console.media.files.delete": (init: FetchOptions<operations["console.media.files.delete"]>) => client.DELETE("/api/services/{sid}/media/files/{id}", init),
    "console.media.files.get": (init: FetchOptions<operations["console.media.files.get"]>) => client.GET("/api/services/{sid}/media/files/{id}", init),
    "console.media.files.list": (init: FetchOptions<operations["console.media.files.list"]>) => client.GET("/api/services/{sid}/media/files", init),
    "console.media.files.restore": (init: FetchOptions<operations["console.media.files.restore"]>) => client.POST("/api/services/{sid}/media/files/{id}/restore", init),
    "console.media.files.update": (init: FetchOptions<operations["console.media.files.update"]>) => client.PATCH("/api/services/{sid}/media/files/{id}", init),
    "console.media.files.uploadTicketed": (init: FetchOptions<operations["console.media.files.uploadTicketed"]>) => client.PUT("/api/services/{sid}/media/files", init),
    "console.media.files.urls": (init: FetchOptions<operations["console.media.files.urls"]>) => client.POST("/api/services/{sid}/media/files/{id}/urls", init),
    "console.media.tickets.create": (init: FetchOptions<operations["console.media.tickets.create"]>) => client.POST("/api/services/{sid}/media/tickets", init),
    "console.notify.messages.get": (init: FetchOptions<operations["console.notify.messages.get"]>) => client.GET("/api/services/{sid}/notify/messages/{id}", init),
    "console.notify.messages.list": (init: FetchOptions<operations["console.notify.messages.list"]>) => client.GET("/api/services/{sid}/notify/messages", init),
    "console.notify.messages.retry": (init: FetchOptions<operations["console.notify.messages.retry"]>) => client.POST("/api/services/{sid}/notify/messages/{id}/retry", init),
    "console.notify.messages.send": (init: FetchOptions<operations["console.notify.messages.send"]>) => client.POST("/api/services/{sid}/notify/messages", init),
    "console.notify.templates.list": (init: FetchOptions<operations["console.notify.templates.list"]>) => client.GET("/api/services/{sid}/notify/templates", init),
    "console.ratelimit.check.post": (init: FetchOptions<operations["console.ratelimit.check.post"]>) => client.POST("/api/services/{sid}/ratelimit/check", init),
    "console.ratelimit.overrides.delete": (init: FetchOptions<operations["console.ratelimit.overrides.delete"]>) => client.DELETE("/api/services/{sid}/ratelimit/policies/{id}/overrides/{sub}", init),
    "console.ratelimit.overrides.list": (init: FetchOptions<operations["console.ratelimit.overrides.list"]>) => client.GET("/api/services/{sid}/ratelimit/policies/{id}/overrides", init),
    "console.ratelimit.overrides.set": (init: FetchOptions<operations["console.ratelimit.overrides.set"]>) => client.PUT("/api/services/{sid}/ratelimit/policies/{id}/overrides/{sub}", init),
    "console.ratelimit.policies.create": (init: FetchOptions<operations["console.ratelimit.policies.create"]>) => client.POST("/api/services/{sid}/ratelimit/policies", init),
    "console.ratelimit.policies.delete": (init: FetchOptions<operations["console.ratelimit.policies.delete"]>) => client.DELETE("/api/services/{sid}/ratelimit/policies/{id}", init),
    "console.ratelimit.policies.get": (init: FetchOptions<operations["console.ratelimit.policies.get"]>) => client.GET("/api/services/{sid}/ratelimit/policies/{id}", init),
    "console.ratelimit.policies.list": (init: FetchOptions<operations["console.ratelimit.policies.list"]>) => client.GET("/api/services/{sid}/ratelimit/policies", init),
    "console.ratelimit.policies.stats": (init: FetchOptions<operations["console.ratelimit.policies.stats"]>) => client.GET("/api/services/{sid}/ratelimit/policies/{id}/stats", init),
    "console.ratelimit.policies.top": (init: FetchOptions<operations["console.ratelimit.policies.top"]>) => client.GET("/api/services/{sid}/ratelimit/policies/{id}/top", init),
    "console.ratelimit.policies.update": (init: FetchOptions<operations["console.ratelimit.policies.update"]>) => client.PATCH("/api/services/{sid}/ratelimit/policies/{id}", init),
    "console.ratelimit.stats.get": (init: FetchOptions<operations["console.ratelimit.stats.get"]>) => client.GET("/api/services/{sid}/ratelimit/stats", init),
    "console.ratelimit.subjects.get": (init: FetchOptions<operations["console.ratelimit.subjects.get"]>) => client.GET("/api/services/{sid}/ratelimit/policies/{id}/subjects/{sub}", init),
    "console.ratelimit.subjects.resetUsage": (init: FetchOptions<operations["console.ratelimit.subjects.resetUsage"]>) => client.DELETE("/api/services/{sid}/ratelimit/policies/{id}/subjects/{sub}/usage", init),
    "console.ready.get": (init: FetchOptions<operations["console.ready.get"]>) => client.GET("/ready", init),
    "console.scheduler.jobs.create": (init: FetchOptions<operations["console.scheduler.jobs.create"]>) => client.POST("/api/services/{sid}/scheduler/jobs", init),
    "console.scheduler.jobs.delete": (init: FetchOptions<operations["console.scheduler.jobs.delete"]>) => client.DELETE("/api/services/{sid}/scheduler/jobs/{id}", init),
    "console.scheduler.jobs.get": (init: FetchOptions<operations["console.scheduler.jobs.get"]>) => client.GET("/api/services/{sid}/scheduler/jobs/{id}", init),
    "console.scheduler.jobs.list": (init: FetchOptions<operations["console.scheduler.jobs.list"]>) => client.GET("/api/services/{sid}/scheduler/jobs", init),
    "console.scheduler.jobs.run": (init: FetchOptions<operations["console.scheduler.jobs.run"]>) => client.POST("/api/services/{sid}/scheduler/jobs/{id}/run", init),
    "console.scheduler.jobs.runs": (init: FetchOptions<operations["console.scheduler.jobs.runs"]>) => client.GET("/api/services/{sid}/scheduler/jobs/{id}/runs", init),
    "console.scheduler.jobs.update": (init: FetchOptions<operations["console.scheduler.jobs.update"]>) => client.PATCH("/api/services/{sid}/scheduler/jobs/{id}", init),
    "console.scheduler.preview.get": (init: FetchOptions<operations["console.scheduler.preview.get"]>) => client.GET("/api/services/{sid}/scheduler/preview", init),
    "console.scheduler.runs.cancel": (init: FetchOptions<operations["console.scheduler.runs.cancel"]>) => client.POST("/api/services/{sid}/scheduler/runs/{id}/cancel", init),
    "console.scheduler.runs.get": (init: FetchOptions<operations["console.scheduler.runs.get"]>) => client.GET("/api/services/{sid}/scheduler/runs/{id}", init),
    "console.scheduler.runs.list": (init: FetchOptions<operations["console.scheduler.runs.list"]>) => client.GET("/api/services/{sid}/scheduler/runs", init),
    "console.scheduler.stats.get": (init: FetchOptions<operations["console.scheduler.stats.get"]>) => client.GET("/api/services/{sid}/scheduler/stats", init),
    "console.scheduler.targetKeys.list": (init: FetchOptions<operations["console.scheduler.targetKeys.list"]>) => client.GET("/api/services/{sid}/scheduler/target-keys", init),
    "console.scheduler.timezones.list": (init: FetchOptions<operations["console.scheduler.timezones.list"]>) => client.GET("/api/services/{sid}/scheduler/timezones", init),
    "console.search.documents.browse": (init: FetchOptions<operations["console.search.documents.browse"]>) => client.GET("/api/services/{sid}/search/indexes/{id}/documents", init),
    "console.search.documents.delete": (init: FetchOptions<operations["console.search.documents.delete"]>) => client.DELETE("/api/services/{sid}/search/indexes/{id}/documents/{sub}", init),
    "console.search.documents.get": (init: FetchOptions<operations["console.search.documents.get"]>) => client.GET("/api/services/{sid}/search/indexes/{id}/documents/{sub}", init),
    "console.search.documents.upsert": (init: FetchOptions<operations["console.search.documents.upsert"]>) => client.PUT("/api/services/{sid}/search/indexes/{id}/documents", init),
    "console.search.indexes.clear": (init: FetchOptions<operations["console.search.indexes.clear"]>) => client.POST("/api/services/{sid}/search/indexes/{id}/clear", init),
    "console.search.indexes.create": (init: FetchOptions<operations["console.search.indexes.create"]>) => client.POST("/api/services/{sid}/search/indexes", init),
    "console.search.indexes.delete": (init: FetchOptions<operations["console.search.indexes.delete"]>) => client.DELETE("/api/services/{sid}/search/indexes/{id}", init),
    "console.search.indexes.get": (init: FetchOptions<operations["console.search.indexes.get"]>) => client.GET("/api/services/{sid}/search/indexes/{id}", init),
    "console.search.indexes.list": (init: FetchOptions<operations["console.search.indexes.list"]>) => client.GET("/api/services/{sid}/search/indexes", init),
    "console.search.indexes.search": (init: FetchOptions<operations["console.search.indexes.search"]>) => client.POST("/api/services/{sid}/search/indexes/{id}/search", init),
    "console.search.indexes.update": (init: FetchOptions<operations["console.search.indexes.update"]>) => client.PATCH("/api/services/{sid}/search/indexes/{id}", init),
    "console.search.stats.get": (init: FetchOptions<operations["console.search.stats.get"]>) => client.GET("/api/services/{sid}/search/stats", init),
    "console.services.about": (init: FetchOptions<operations["console.services.about"]>) => client.GET("/api/services/about", init),
    "console.services.list": (init: FetchOptions<operations["console.services.list"]>) => client.GET("/api/services", init),
    "console.services.overview": (init: FetchOptions<operations["console.services.overview"]>) => client.GET("/api/services/overview", init),
    "console.services.status": (init: FetchOptions<operations["console.services.status"]>) => client.GET("/api/services/{sid}/status", init),
    "console.services.updateSettings": (init: FetchOptions<operations["console.services.updateSettings"]>) => client.PATCH("/api/services/{sid}/settings", init),
    "console.session.get": (init: FetchOptions<operations["console.session.get"]>) => client.GET("/api/session", init),
    "console.session.login": (init: FetchOptions<operations["console.session.login"]>) => client.POST("/api/session/login", init),
    "console.session.logout": (init: FetchOptions<operations["console.session.logout"]>) => client.POST("/api/session/logout", init),
    "console.session.totp": (init: FetchOptions<operations["console.session.totp"]>) => client.POST("/api/session/totp", init),
    "console.shortlink.links.create": (init: FetchOptions<operations["console.shortlink.links.create"]>) => client.POST("/api/services/{sid}/shortlink/links", init),
    "console.shortlink.links.delete": (init: FetchOptions<operations["console.shortlink.links.delete"]>) => client.DELETE("/api/services/{sid}/shortlink/links/{id}", init),
    "console.shortlink.links.get": (init: FetchOptions<operations["console.shortlink.links.get"]>) => client.GET("/api/services/{sid}/shortlink/links/{id}", init),
    "console.shortlink.links.list": (init: FetchOptions<operations["console.shortlink.links.list"]>) => client.GET("/api/services/{sid}/shortlink/links", init),
    "console.shortlink.links.qr": (init: FetchOptions<operations["console.shortlink.links.qr"]>) => client.GET("/api/services/{sid}/shortlink/links/{id}/qr.png", init),
    "console.shortlink.links.stats": (init: FetchOptions<operations["console.shortlink.links.stats"]>) => client.GET("/api/services/{sid}/shortlink/links/{id}/stats", init),
    "console.shortlink.links.update": (init: FetchOptions<operations["console.shortlink.links.update"]>) => client.PATCH("/api/services/{sid}/shortlink/links/{id}", init),
    "console.shortlink.stats.get": (init: FetchOptions<operations["console.shortlink.stats.get"]>) => client.GET("/api/services/{sid}/shortlink/stats", init),
    "console.webhookOut.deliveries.cancel": (init: FetchOptions<operations["console.webhookOut.deliveries.cancel"]>) => client.POST("/api/services/{sid}/webhook-out/deliveries/{id}/cancel", init),
    "console.webhookOut.deliveries.get": (init: FetchOptions<operations["console.webhookOut.deliveries.get"]>) => client.GET("/api/services/{sid}/webhook-out/deliveries/{id}", init),
    "console.webhookOut.deliveries.list": (init: FetchOptions<operations["console.webhookOut.deliveries.list"]>) => client.GET("/api/services/{sid}/webhook-out/deliveries", init),
    "console.webhookOut.deliveries.redeliver": (init: FetchOptions<operations["console.webhookOut.deliveries.redeliver"]>) => client.POST("/api/services/{sid}/webhook-out/deliveries/{id}/redeliver", init),
    "console.webhookOut.events.get": (init: FetchOptions<operations["console.webhookOut.events.get"]>) => client.GET("/api/services/{sid}/webhook-out/events/{id}", init),
    "console.webhookOut.events.list": (init: FetchOptions<operations["console.webhookOut.events.list"]>) => client.GET("/api/services/{sid}/webhook-out/events", init),
    "console.webhookOut.eventTypes.list": (init: FetchOptions<operations["console.webhookOut.eventTypes.list"]>) => client.GET("/api/services/{sid}/webhook-out/event-types", init),
    "console.webhookOut.stats.get": (init: FetchOptions<operations["console.webhookOut.stats.get"]>) => client.GET("/api/services/{sid}/webhook-out/stats", init),
    "console.webhookOut.subscriptions.create": (init: FetchOptions<operations["console.webhookOut.subscriptions.create"]>) => client.POST("/api/services/{sid}/webhook-out/subscriptions", init),
    "console.webhookOut.subscriptions.delete": (init: FetchOptions<operations["console.webhookOut.subscriptions.delete"]>) => client.DELETE("/api/services/{sid}/webhook-out/subscriptions/{id}", init),
    "console.webhookOut.subscriptions.get": (init: FetchOptions<operations["console.webhookOut.subscriptions.get"]>) => client.GET("/api/services/{sid}/webhook-out/subscriptions/{id}", init),
    "console.webhookOut.subscriptions.list": (init: FetchOptions<operations["console.webhookOut.subscriptions.list"]>) => client.GET("/api/services/{sid}/webhook-out/subscriptions", init),
    "console.webhookOut.subscriptions.replay": (init: FetchOptions<operations["console.webhookOut.subscriptions.replay"]>) => client.POST("/api/services/{sid}/webhook-out/subscriptions/{id}/replay", init),
    "console.webhookOut.subscriptions.rotate": (init: FetchOptions<operations["console.webhookOut.subscriptions.rotate"]>) => client.POST("/api/services/{sid}/webhook-out/subscriptions/{id}/rotate", init),
    "console.webhookOut.subscriptions.test": (init: FetchOptions<operations["console.webhookOut.subscriptions.test"]>) => client.POST("/api/services/{sid}/webhook-out/subscriptions/{id}/test", init),
    "console.webhookOut.subscriptions.update": (init: FetchOptions<operations["console.webhookOut.subscriptions.update"]>) => client.PATCH("/api/services/{sid}/webhook-out/subscriptions/{id}", init),
  } as const;
}

export type ConsoleClient = ReturnType<typeof createClient>;
