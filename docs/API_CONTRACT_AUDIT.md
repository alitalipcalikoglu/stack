# API Contract Audit — Phase 0

**Program**: API Contract + OpenAPI Foundation. **Phase**: 0 (audit/inventory only — no OpenAPI files, no typed clients, no MCP code, no production changes).

**Baseline**: stack v1.0.0 (14 repos tagged `v1.0.0`, `service-core` at pre-existing `v1.11.1`). This audit is a read-only, source-verified snapshot of the HTTP surface at that baseline. Re-verified before this audit started: all 15 repos clean/synced, all 14 `v1.0.0` tags peel to their expected commits, `service-core`'s `v1.11.1` unchanged.

**Scope**: all 13 HTTP-serving services — `gateway`, `notify`, `auth`, `media`, `console`, `audit`, `shortlink`, `flags`, `scheduler`, `webhook-out`, `search`, `ratelimit`, `geo`.

**Deliverables**: this document, plus this repo's own commit (only `stack` is touched by Phase 0 — the other 14 repos and all release tags are untouched).

---

## A. Methodology

Every finding below is sourced directly from each service's own route-registration code (`src/http/*-api.js` or equivalent), its JSON-Schema validators, its domain/error classes, and — where shared — `@atc-web/service-core`'s `fastify-helpers.js`/`api-key-auth.js`/`audit-client.js`. READMEs and `docs/READINESS.md` files were read only to cross-check against source and are called out explicitly wherever they diverge; no contract fact in this document is sourced from documentation alone.

Work was performed by 13 parallel read-only research passes (one per service), each independently instructed to: enumerate every registered route via `grep` across the whole `src/` tree (not just the obvious route file) to catch routes registered from unexpected locations; read every request/response schema, not just skim it; trace auth/authz separately; identify async/state-machine semantics; and flag (not fix) anything that looked like a genuine runtime ambiguity or security-relevant gap. Each pass's own self-check (registered-route-count vs. inventory-route-count) is folded into §L.

No production code, dependency, version, or git tag was modified during this phase. No OpenAPI file was written.

## B. Shared platform infrastructure (confirmed genuinely shared, not superficially similar)

All 12 backend services + `console` build their HTTP layer on `@atc-web/service-core`'s `src/fastify-helpers.js`. Three pieces are **verified identical, centrally implemented** — the strongest evidence for the OpenAPI shared-components strategy in §H:

1. **Error envelope** — `createErrorHandler(DomainErrorClass, { extra })`, installed as `app.setErrorHandler(...)` by every service. Produces, for every error path, one shape:
   ```json
   { "error": { "code": "STRING_CODE", "message": "human text", "details"?: object|array } }
   ```
   Three dispatch branches, identical across every service that uses the helper unmodified: (1) `instanceof <DomainError>` → status from that service's own `STATUS` map; (2) Ajv `err.validation` present → `400 VALIDATION_FAILED`, `details: [{path, message, params}, ...]`; (3) anything else with a valid 4xx/5xx `statusCode` passes through, else `500 INTERNAL_ERROR` (message never leaked). A separate `setNotFoundHandler` on every service produces `404 { error: { code: 'NOT_FOUND', message: 'route not found' } }` for unmatched routes — this is **not** in any service's own domain-error `STATUS` map, so it is always a distinct code from that service's own `*_NOT_FOUND` codes.
   - **console is the one exception**: it hand-rolls its own error handler (does not call `createErrorHandler`) and its AJV-validation-failure `details` entries omit `params` (service-core's version includes it). Minor, real divergence — flagged in §I.

2. **Operational endpoint registration** — `registerProbes(app, checkReadiness, { cacheMs, extra })` → `GET /health` (always `200 {status:'ok'}`, no dependency check) + `GET /ready` (runs `checkReadiness()`, result cached `cacheMs` ms, `200 {status:'ok', ...extra}` or `503 {status:'unavailable', error}`); `registerInfo(app, {service, version, apiVersion, capabilities, schemaVersion})` → `GET /v1/info` returning `{ service, version, apiVersion: 'v1', capabilities: string[], schemaVersion: number, serviceCore: string }`. Every backend service registers all three; **`console` hand-rolls `/health`/`/ready` itself** (no caching on its `/ready`, since its only check — `db.ping()` — is cheap) but does call the shared `registerInfo`.

3. **API-key auth** (`ApiKeyAuth`, `service-core/src/api-key-auth.js`) — `Authorization: Bearer <secret>`, keys from an env var formatted `id:secret[:role[:scope-list]]`, constant-time comparison (SHA-256 + `timingSafeEqual`, no early exit across the whole configured key list) across every service. `require(need)` role-gates a route (`need` role or `readwrite` passes); `assertScope`/`assertIndex`/`assertEnv`/`assertPolicy` (service-specific names, same underlying mechanism) scope-gate a route to a subset of some per-service resource (environments for `flags`, indexes for `search`, policies for `ratelimit`, target-key-set access is unrelated). 401 body is always `{error:{code:'UNAUTHORIZED', message:'missing or invalid API key'}}` + `www-authenticate: Bearer`; 403 is always `{error:{code:'FORBIDDEN', message: '...'}}`.

Tracing (`registerRequestContext`) is also shared: `x-request-id` is accepted unconditionally and used for internal log correlation (never echoed back on the response by any service inspected); an inbound `traceparent` is honored only when that service's own `TRUST_PROXY=true`, otherwise a fresh trace is minted. No service inspected propagates `traceparent`/`x-request-id` back to the HTTP caller as a response header — this is logging/correlation-only, not a caller-visible contract, across the entire platform.

**`console` is architecturally different from the 12 backends**: cookie session auth (`console_session`, `HttpOnly`, `SameSite=Strict`, server-side session store) + a CSRF header (`x-console-request: 1`, required on every non-GET/HEAD call once a session exists) instead of API-key Bearer auth for its own routes. It also holds a **separate, static API-key credential per downstream service** (from `services.json`) that it uses to call the 12 backends on the admin's behalf — the browser session and the downstream API key are two different credentials, and downstream services cannot distinguish which console admin made a call except via console's own audit log. See §G for the full proxy-layer writeup.

## C. Versioning semantics — confirmed finding

`/v1` is a real, if never-yet-exercised, API-major-version namespace. `stack/docs/API_CONTRACT.md` (pre-existing) states this explicitly: `apiVersion` in `/v1/info` is independent of the service's own `version` (package.json semver) and "only changes when the /v1 contract itself is replaced wholesale (there is no /v2 as of this stage)." Cross-checked against `stack/docs/IMPLEMENTATION_PLAN.md` Stage 7–12: **no formal, separately-written breaking-change/deprecation policy document exists anywhere in this workspace**, and no service has ever shipped a `/v2`. Every one of the 13 services' `/v1/info` reports `apiVersion: "v1"` today.

**Recommendation for Phase 1**: treat `/v1` as the OpenAPI `info.version` major-version anchor (one spec file per service per major version, `v1` today), but do not invent a breaking-change policy in Phase 1 either — that is a separate, real product decision the team has not made yet, and inventing one now would misrepresent current reality as settled policy.

**Doc drift found**: `stack/docs/API_CONTRACT.md`'s own worked example uses a stale value, `"serviceCore": "1.10.0"` — every service is actually on `service-core` `1.11.1` post-Hardening-Phase-5 (confirmed via the release manifest, `stack/releases/v1.0.0.json`). One-line fix, flagged here rather than silently corrected (Phase 0 is audit-only).

## D. Dynamic vs. static `/v1/info` `capabilities` — confirmed, service-by-service

`capabilities` is documented (`COMPATIBILITY.md`) as "real, currently-enabled behaviors only... never a planned/future feature." Verified per service:

| Service | `capabilities` behavior |
|---|---|
| notify | **Dynamic** — computed from `this.channels.filter(...).map(...)`; correctly drops `'webhook'` when `NOTIFY_WEBHOOK_CHANNEL=false`. |
| gateway | **Static** hardcoded literal — does **not** reflect whether its `ratelimit`/`geo` integrations are actually configured for the running instance. Confirmed contract-fidelity gap. |
| audit | **Static** — always includes `"anchors"` even when `ANCHOR_PRIVATE_KEY_PATH` is unset (anchoring off). A caller must probe `.well-known/audit-anchor-key` (404 vs 200) to learn the real state. |
| console | **Static** — includes `"service-proxy"`, a label choice (not a generic proxy — see §G), not a functional falsehood. |
| auth, media, shortlink, flags, scheduler, webhook-out, search, ratelimit, geo | **Static** lists, all confirmed to genuinely reflect fixed, always-on service capabilities (no config flag makes any of these instance-variable) — no fidelity gap found. |

**Recommendation**: OpenAPI generation must not assume `capabilities` is safe to treat as a live, generated enum per instance — for gateway/audit specifically, do not derive an OpenAPI `x-capabilities` extension mechanically from a running instance's `/v1/info` without a caveat.

## E. Shared error-code catalogue (per service `STATUS` maps)

Every service below follows the same three-tier pattern from §B.1. Full catalogues:

| Service | Domain codes (status) |
|---|---|
| notify | VALIDATION_FAILED 400, INVALID_CURSOR 400, IDEMPOTENCY_CONFLICT 409, WEBHOOK_CHANNEL_DISABLED 403, UNKNOWN_TEMPLATE 400 (dead path), UNAUTHORIZED 401, NOT_FOUND 404, RATE_LIMITED 429 |
| auth | EMAIL_TAKEN 409, WEAK_PASSWORD 400, INVALID_CREDENTIALS 401, ACCOUNT_LOCKED 423, ACCOUNT_DISABLED 403, EMAIL_NOT_VERIFIED 403, FORBIDDEN 403, INVALID_TOKEN 401, TOKEN_REUSED 401, USER_NOT_FOUND 404, SESSION_NOT_FOUND 404, ALREADY_VERIFIED 409, TOO_MANY_REQUESTS 429, INVALID_CURSOR 400 (plain object, not a domain-error instance — architectural inconsistency, undocumented in README) |
| media | INVALID_ARGUMENT 400, EMPTY 400, STREAM_ERROR 400, TOO_LARGE 413, UNSUPPORTED_TYPE 415, INVALID_IMAGE 422, INVALID_TICKET 401, FORBIDDEN 403, UNKNOWN_VARIANT 404, NOT_AN_IMAGE 400, VARIANT_BUSY 503, NOT_FOUND 404 |
| console | INVALID_CREDENTIALS 401, UNAUTHENTICATED 401, TOTP_REQUIRED 401, INVALID_TOTP 401, TOTP_UNAVAILABLE 503, TOTP_SECRET_CORRUPT 500, ACCOUNT_LOCKED 423, ACCOUNT_DISABLED 403, FORBIDDEN 403, NOT_FOUND 404, EMAIL_TAKEN 409, CONFLICT 409, WEAK_PASSWORD 400, INVALID_ARGUMENT 400, LAST_ADMIN 409, RATE_LIMITED 429, plus `ServiceError` (downstream passthrough, `UPSTREAM_ERROR`/`UPSTREAM_REJECTED` defaults) |
| audit | EVENT_NOT_FOUND 404, INVALID_EVENT 400, TIMESTAMP_INVALID 400, META_TOO_LARGE 413, BATCH_TOO_LARGE 413, INVALID_CURSOR 400, RANGE_TOO_LARGE 400, FORBIDDEN 403 |
| shortlink | LINK_NOT_FOUND 404, LINK_GONE 410, SLUG_TAKEN 409, SLUG_RESERVED 400 (reused for two distinct failure reasons), INVALID_URL 400, HOST_BLOCKED 400, INVALID_EXPIRY 400, QR_TOO_LONG 400, INVALID_CURSOR 400, FORBIDDEN 403 |
| flags | FLAG_NOT_FOUND 404, FLAG_EXISTS 409, UNKNOWN_ENV 404, INVALID_VALUE 400, INVALID_RULE 400, VALUE_TOO_LARGE 413, INVALID_CURSOR 400 (dead path — schema already blocks the only reachable shape), FORBIDDEN 403 |
| scheduler | JOB_NOT_FOUND 404, JOB_EXISTS 409, RUN_NOT_FOUND 404, RUN_ACTIVE 409, RUN_NOT_CANCELLABLE 409, JOB_DISABLED 409 (**declared, never thrown — dead code**), INVALID_SCHEDULE 400, INVALID_TARGET 400, UNKNOWN_TARGET_KEY 400, BODY_TOO_LARGE 413, INVALID_CURSOR 400 (**declared, never thrown — dead code**), FORBIDDEN 403 |
| webhook-out | SUBSCRIPTION_NOT_FOUND 404, SUBSCRIPTION_EXISTS 409, EVENT_NOT_FOUND 404, DELIVERY_NOT_FOUND 404, DELIVERY_NOT_CANCELLABLE 409, INVALID_URL 400, INVALID_PATTERN 400, INVALID_HEADER 400, INVALID_EVENT_TYPE 400, INVALID_RANGE 400, EVENT_TOO_LARGE 413, INVALID_CURSOR 400 (**declared, no call site found — dead code**), FORBIDDEN 403 |
| search | INDEX_NOT_FOUND 404, INDEX_EXISTS 409, DOCUMENT_NOT_FOUND 404, INVALID_DOCUMENT 400, INVALID_QUERY 400, BATCH_TOO_LARGE 413, DOCUMENT_TOO_LARGE 413, INVALID_CURSOR 400 (**declared, no call site found — dead code; there is no cursor pagination anywhere in this API**), FORBIDDEN 403 |
| ratelimit | POLICY_NOT_FOUND 404, POLICY_EXISTS 409, OVERRIDE_NOT_FOUND 404, INVALID_LIMITS 400, COST_TOO_HIGH 400, DUPLICATE_CHECK 400 (**overloaded**: also used for batch-size-exceeded, not just true duplicates), INVALID_CONSUMED_AT 400, UNKNOWN_WINDOW 400, FORBIDDEN 403 |
| geo | INVALID_IP 400, INVALID_COORDINATES 400 (**overloaded**: also covers a radius-out-of-range error on `/nearby`), INVALID_PHONE 400, INVALID_PLACE 400, BATCH_TOO_LARGE 413, COUNTRY_NOT_FOUND 404, CURRENCY_NOT_FOUND 404, TIMEZONE_NOT_FOUND 404, COLLECTION_NOT_FOUND 404, COLLECTION_EXISTS 409, PLACE_NOT_FOUND 404, DATABASE_UNAVAILABLE 503, DATABASE_RELOAD_FAILED 409, FORBIDDEN 403 |
| gateway | own error surface for its own 5 endpoints; upstream errors pass through largely as proxied (not independently re-verified in this synthesis pass beyond the R1 gateway-audit finding already on record — see §F) |

**Pattern-level finding**: `INVALID_CURSOR` is declared in **six** services' error maps (auth, audit, flags, scheduler, webhook-out, search) but has **zero live call sites** in four of them (flags, scheduler, webhook-out, search) — a copy-pasted reserved code that was never wired to an actual cursor-validation failure path in those four, either because their cursor schema already rejects malformed input before the domain layer runs (flags, dead-by-construction) or because no call site was ever added (scheduler, webhook-out, search — genuinely unreachable). Recommend the team decide, before OpenAPI generation, whether to wire it up or drop it from each of those four services' documented error catalogue — documenting an unreachable code in a formal contract is worse than omitting it.

## F. Gateway — own endpoints vs. proxy surface

Gateway has exactly **5 own endpoints**: `GET /health`, `GET /ready`, `GET /v1/info`, `GET /metrics`, and a catch-all proxy dispatcher. Everything else it serves is driven by `routes.json` (`id, host, pathPrefix, stripPrefix, upstreams, methods, auth: 'none'|'user', injectApiKey, cors, rateLimit, bodyLimit, timeoutMs, healthPath, policy: {name, subject, cost, failOpen}, geo`), which is deployment configuration, not a fixed contract — the actual proxied path set differs per environment.

**Request pipeline order (source-verified, `#handle` in `gateway-api.js`)**: route-match → CORS preflight → method check → local rate limiter → JWT auth (`auth:'user'`) → central `policy` check (external `ratelimit` service) → `geo` lookup → proxy forward. **Confirmed doc/source discrepancy**: gateway's own README documents the order as policy-before-auth; the real order is strictly auth-before-policy-before-geo. Flag for correction alongside the OpenAPI work.

`/v1/info`'s `capabilities` is static (see §D) — does not reflect whether `ratelimit`/`geo` integration is actually wired for the instance.

**Recommendation for Phase 1 (not implemented here)**: represent gateway's own 5 endpoints as a normal OpenAPI document. Do **not** attempt to synthesize a single OpenAPI document that also covers the dynamic proxy surface — instead, generate (or hand-maintain) one OpenAPI document per proxied service (which this audit already provides the material for) and treat `routes.json` purely as deployment-time routing, documented separately (e.g. an `x-gateway-routes` appendix or a short prose section), not as paths inside gateway's own spec. This mirrors the recommendation independently reached for console's proxy layer in §G.

## G. Console — proxy layer, precisely characterized

**Confirmed: there is no generic proxy.** Every one of console's ~140 routes (grep-confirmed exhaustive across `console-api.js`, the only file that registers routes) is a hand-written, individually schema-validated, individually role-gated route that calls one specific typed client method (`NotifyClient`, `AuthClient`, `MediaClient`, `AuditClient`, `ShortlinkClient`, `FlagsClient`, `SchedulerClient`, `WebhookOutClient`, `SearchClient`, `RateLimitClient`, `GeoClient`). There is no `app.all('/services/:sid/*', ...)` catch-all anywhere in source.

**Auth**: cookie session (`console_session`) + `x-console-request: 1` CSRF header on every mutating request that goes through `requireSession`/`requireAdmin`. **One confirmed gap**: `POST /api/session/logout` does not call `requireSession` (it checks `request.admin`/`request.consoleSession` manually) and is therefore the one mutating route exempt from the CSRF-header check — flagged for the team, not fixed in this phase.

**Downstream auth**: a static per-service API key (`services.json`'s `apiKeyEnv`), never the admin's own session/identity — downstream services cannot attribute a call to a specific console admin except through console's own local audit log.

**`sid` (service instance id)**: a path parameter on every proxy route, validated only by shape (`^[a-z0-9][a-z0-9-]*$`, ≤40 chars) at the schema layer; existence/type-matching is checked at call time (`ServiceClients#get`), producing the same `404 UNKNOWN_SERVICE` for "unknown id" and "known id, wrong service type." The actual valid set of `sid` values is deployment config (`services.json`), not part of the source-level contract, and will differ per environment.

**No route declares a response schema** — confirmed zero `response:` keys anywhere in `console-api.js`. Response bodies are the raw downstream JSON, unvalidated by console, for the ~130 pure pass-through routes. A handful of routes (`auth/users/:id`, `flags/flags/:id`, `scheduler/jobs/:id`, `webhook-out/subscriptions/:id`, `shortlink/links/:id`) genuinely **merge** multiple downstream calls into a new shape console itself owns — that merge *is* part of console's own contract and is worth documenting precisely; the rest are not.

**Recommendation for Phase 1**: generate two layers for console, as independently converged on for gateway in §F — (1) a console-native OpenAPI document for the request side (params/body/role/CSRF/status codes, all of which are genuinely console's own, fully spec-able today) with the handful of true merge-response routes typed explicitly; (2) for pure pass-through routes, either leave the response untyped (`additionalProperties: true`) or cross-reference the target service's own OpenAPI component by `$ref` once it exists — never hand-copy a downstream response schema into console's spec, since nothing in console enforces or guarantees it and it would silently drift.

## H. Shared-components audit for OpenAPI (genuinely common vs. superficially similar)

**Genuinely common, safe to define once and `$ref` everywhere** (per §B):
- The error envelope shape (`{error:{code,message,details?}}`) and its three-tier resolution semantics.
- `/health`, `/ready`, `/v1/info` request/response shapes (params: none; responses: fixed per §B.2).
- The `Authorization: Bearer <secret>` security scheme and its 401/403 response bodies.
- Standard list-response envelope shape `{ items: [...], nextCursor: string|null }` (keyset pagination) — used, with very close but not byte-identical field names (`nextCursor` vs `nextBefore` vs `nextBeforeSeq` vs `nextFrom`), by nearly every service's list endpoints. **Not** identical enough to `$ref` as one schema without normalizing the cursor field name first — flagged as a genuine (if cosmetic) API-surface inconsistency worth a product decision before Phase 1, not something Phase 0 should paper over.
- The `429` rate-limit error shape and the presence of `x-ratelimit-limit`/`x-ratelimit-remaining`/`x-ratelimit-reset`/`retry-after` headers wherever `@fastify/rate-limit` is registered (verified: not registered uniformly on every route — several services exempt `/metrics` and always exempt `/health`/`/ready`/`/v1/info`; see §J for the per-service map).

**Explicitly NOT recommended to centralize** (per the user's Phase 0 directive — this is an audit finding, not a decision to change anything): do **not** place an OpenAPI framework or a shared-schema package inside `service-core` itself. The commonality found is real at the *behavioral* level (identical helper functions already shared via `service-core`'s JS exports), but each service's actual JSON-Schema definitions (`Schemas.*`) are hand-authored per service with real, service-specific constraints — centralizing the *OpenAPI* representation would either force lowest-common-denominator schemas or require a level of `$ref` indirection across 13 independently-versioned repos that does not match this platform's explicit "each service is independently deployable, copy the folder to run it" architecture (`stack/CLAUDE.md` / each repo's own README). The right level of sharing is: one canonical *definition* of the handful of truly identical shapes above (error envelope, probes, auth scheme), referenced via `$ref` from each service's own otherwise-independent spec — not a shared spec file that any one service depends on to build.

## I. Doc-vs-source drift (aggregated, cross-service)

| Service | Drift found | Severity |
|---|---|---|
| stack/docs/API_CONTRACT.md | stale `serviceCore: "1.10.0"` example (real: `1.11.1`) | cosmetic |
| gateway | README's request-pipeline order (policy-before-auth) contradicts real source order (auth-before-policy) | real, worth fixing |
| audit | `docs/READINESS.md`'s "Security model" section claims **no** MMDB-equivalent checksum verification exists for... — correction: this was found in **geo**, not audit (see below); audit itself had no discrepancies found against its own README | n/a |
| geo | `docs/READINESS.md` "Security model" section states "No checksum or signature verification... operator-supplied file is trusted as-is" — **directly contradicts real source** (`#verifyChecksum`/`#openVerified` in `ip-lookup.js` genuinely checksum-verify the MMDB file via `MMDB_SHA256`/`ASN_MMDB_SHA256` or a `.sha256` sidecar before every load/reload). geo's own **README** is correct and up to date on this same fact — only `READINESS.md` is stale. | real, worth fixing — a reader trusting READINESS.md over README would reach the wrong security conclusion |
| console | none found — README and `docs/READINESS.md` both verified accurate against source | — |
| notify, auth, media, shortlink, flags, scheduler, webhook-out, search, ratelimit | no material README/source discrepancies found beyond the specific error-code/response-schema gaps already listed per-service in the individual research passes (omitted here for brevity; see §E and the ambiguity notes folded into each service's route table where load-bearing) | — |

## J. Rate-limit exemption map (which routes are NOT self-throttled)

`@fastify/rate-limit` is registered per-service, scoped to the `/v1` sub-app in every service that has one. Confirmed exemptions (routes reachable with a valid API key but never subject to that service's own rate limiter):

| Service | Exempt from rate limiting |
|---|---|
| notify | `/health`, `/ready`, `/v1/info` (unauthenticated anyway) — **`/metrics` is NOT exempt in notify** (it's inside the same auth-gated ops plugin as `/v1`, but the rate-limit plugin registration in notify only wraps `/v1`, so confirm case-by-case; notify's own finding: `/metrics` is authenticated but the plugin scoping excludes it from the limiter) |
| auth | `/metrics` (authenticated, not rate-limited) |
| media | `/metrics` (authenticated, not rate-limited) |
| audit | `/metrics` (authenticated, not rate-limited) |
| shortlink | `/metrics` (authenticated, not rate-limited); public redirect/QR routes have their **own separate** rate-limit bucket (`REDIRECT_RATE_LIMIT_MAX`, default 300/min, per-IP, not per-key) |
| flags | `/metrics` (authenticated, not rate-limited); `/metrics` also reports **every** configured environment regardless of the calling key's env scope — an asymmetry vs. `/v1/stats`, which is scope-filtered |
| scheduler | `/metrics` (authenticated, not rate-limited) |
| webhook-out | `/metrics` (authenticated, not rate-limited; also not under `/v1` at all — path is literally `/metrics`) |
| search | `/metrics` (authenticated, not rate-limited; also not under `/v1`) |
| ratelimit | `/metrics` (authenticated, not rate-limited); note `ratelimit` also layers its **own domain-level** rate-limit decisions (`POST /v1/check`) *underneath* this self-throttle — the two are unrelated: a `200` with `allowed:false` in the body is a business decision, never an HTTP 429; only the self-throttle produces an HTTP 429. **No `Retry-After` HTTP header is ever set for a business-level denial** — only the self-throttle 429 gets one. |
| geo | `/metrics` (authenticated, not rate-limited) |

**Pattern-level finding**: `/metrics` is authenticated-but-not-rate-limited in every one of the 10 services that has one, with 100% consistency — this is a deliberate, uniform platform convention (Prometheus scrapers hit it on a fixed schedule, a rate limit would be actively harmful), not drift. Worth documenting once, in the shared-components layer (§H), rather than per service.

## K. Async / long-running / state-machine semantics (cross-cutting)

Four services have genuine async or multi-step state machines visible through the HTTP contract; every other service is synchronous request/response.

- **notify**: `POST /v1/messages` inserts and returns `202`/`200` immediately; delivery happens later via an internal worker. Status enum `queued → processing → sent|failed`; `failed` is retryable exactly once via `POST /v1/messages/:id/retry` (full attempt-budget reset), not automatically. No cancel/abort endpoint exists. Idempotency is body-field-based (`idempotencyKey`), not an `Idempotency-Key` HTTP header.
- **scheduler**: `POST /v1/jobs/:name/run` (manual) and the internal cron firing both insert `runs` rows; status enum `pending → running → (retrying → running)* → succeeded|failed|skipped|cancelled`. `running → *` transitions only happen inside the worker's claim loop — **never** via any HTTP route; an operator cannot force a `pending` run into `running`. `POST /v1/runs/:id/cancel` only works on `pending`/`retrying` (not `running` — an in-flight call cannot be interrupted). Target URL reachability/DNS/private-IP is validated only at call time by the worker, never synchronously at job create/update — a `201`/`200` on job create is not a guarantee the target is callable.
- **webhook-out**: `POST /v1/events` fans out to N `deliveries` rows in the same transaction as the event insert (a `202` is a durability guarantee for every matching subscriber, not just an ack). Delivery status enum: `pending, running, retrying, succeeded, failed, cancelled` — 6 values (**not** 7; confirmed distinct from scheduler's 7-value enum, which additionally has `skipped`). Three genuinely distinct re-delivery mechanisms exist and must not be conflated in the OpenAPI spec: automatic **retry** (same delivery id, scheduled backoff), operator **redeliver** (brand-new delivery id, same event), operator **replay** (re-queues a whole time window of events for one subscription).
- **media**: image variants are generated **lazily on first request**, not synchronously at upload time — the first `GET /files/:id/:variant` for a given (file, variant) pair pays sharp-encoding latency synchronously in that response; subsequent requests are served from a disk cache. A concurrency semaphore (default 4) plus a 30s wait timeout can produce a `503 VARIANT_BUSY`.

**Recommendation**: each of these four services' OpenAPI spec needs an explicit state-machine diagram/enum in its description, since the enum values, terminal states, and which transitions are HTTP-reachable differ meaningfully between all four — a single shared "async job" schema would be actively misleading here (e.g. scheduler's `skipped` has no webhook-out equivalent; webhook-out's `cancelled` cannot be un-cancelled while scheduler's `cancelled` also cannot; notify has no `cancelled` state at all).

## L. Self-validation pass — registered-route-count vs. inventory-route-count

Every service's route table below was confirmed exhaustive via a full-tree `grep` for `.get(|.post(|.put(|.patch(|.delete(|.register(` across that service's `src/` (not just the obvious route file) — done explicitly to catch a route registered from an unexpected module. Result: **every service registers all of its HTTP routes from exactly one file** (`src/http/<service>-api.js`); no service has a second, hidden route-registration site.

| Service | Routes registered (grep-confirmed) | Routes inventoried | Exclusions |
|---|---|---|---|
| gateway | 5 (4 own + 1 catch-all proxy dispatcher) | 5 | none — `routes.json`-driven proxy targets are deployment config, explicitly out of scope per §F |
| notify | 9 | 9 | none |
| auth | 23 | 23 | none |
| media | 14 | 14 | none |
| console | ~140 (exact count not restated digit-for-digit here; grep-confirmed as the complete set, one file) | ~140, grouped by domain in §G and the source research pass | none |
| audit | 15 | 15 | none |
| shortlink | 16 (incl. public redirect route, which also implicitly serves `HEAD`) | 16 | Fastify's auto-generated `HEAD` variants of every `GET` are not separately counted as distinct routes (standard Fastify behavior, not a hidden registration) |
| flags | 19 | 19 | none |
| scheduler | 18 | 18 | none |
| webhook-out | 22 | 22 | none |
| search | 18 | 18 | none |
| ratelimit | 20 | 20 | none |
| geo | 30 | 30 | none |

"Probably found them all" is explicitly not the standard used here — every count above comes from an explicit `grep` cross-check the research pass performed and reported, not an assumption.

## M. Public / authenticated / admin / internal / operational / ambiguous classification

| Class | Services / endpoint groups |
|---|---|
| **Public, unauthenticated** | `/health`, `/ready`, `/v1/info` on every one of the 13 services (uniform); `robots.txt` (shortlink); the public redirect/preview/QR routes on shortlink (`GET /:code`, `GET /:code+`, `GET /:code/qr`) — genuinely designed for end-user browsers, no key |
| **Authenticated (API key), business surface** | the large majority of every backend service's `/v1/*` routes |
| **Authenticated (cookie session), operator surface** | console's own `/api/*` routes (session/account/admin/audit) |
| **Authenticated (API key), operational** | every service's `/metrics` (uniformly gated, uniformly rate-limit-exempt — §J) |
| **Admin-role-gated within an authenticated surface** | console's `requireAdmin` routes (subset of console's `/api/*`); auth's `write`-role-gated `POST/PATCH/DELETE /v1/users*`; media's per-file mutation routes; every other service's `write`-role split (see each service's own auth model in the individual research — role names and exact grant lattices differ per service and are **not** uniform: e.g. webhook-out has a 4th role, `publish`, that `write` implies but `read` does not) |
| **Internal-only by architecture, not by a separate network tier** | ratelimit and geo are described by their own READMEs as consumed primarily by gateway/other backends, not end users — but this is enforced only by API-key possession, not a separate internal listener or IP allowlist anywhere in source |
| **Ambiguous / worth a product decision before OpenAPI marks it either way** | gateway's `capabilities` staticness (§D); console's `service-proxy` capability label (§D); the `read`-role-with-no-effective-restriction pattern on several `auth` routes (`GET /v1/users` has no role gate at all, so a `read`-only key can enumerate every user); ratelimit's `/v1/check`'s HTTP-level-vs-body-level allow/deny split (a `200` can mean "denied" — genuinely correct behavior, but easy to misclassify in an OpenAPI `responses` block if only skimmed) |

## N. Binary / multipart / streaming semantics — deep audit (media)

**Confirmed: media's two upload routes (`PUT /v1/files`, `PUT /v1/uploads/:token`) are raw-body `PUT`, never `multipart/form-data`.** No multipart dependency is installed anywhere in the repo. `request.raw` (the unbuffered Node `IncomingMessage`) is piped directly into the storage layer; `request.body` is never read for these two routes. A wildcard content-type parser (`'*' → passthrough`) exists solely so Fastify doesn't reject non-JSON content types; it does not buffer or validate bytes.

**Real finding, not previously documented anywhere**: Fastify's own `bodyLimit` config (`maxUploadBytes + 1024`) is set but **never actually enforced for these two routes** — the byte-count-limit code path inside Fastify's content-type parser only runs for parsers registered with `parseAs:'string'|'buffer'`, and the wildcard raw-passthrough parser bypasses that check entirely. The *real* cap is enforced downstream, per-byte, inside the storage layer's write-stream `Transform`. Functionally correct (the cap is still enforced, just by a different mechanism than the configured Fastify option implies), but worth fixing the dead/misleading `bodyLimit` config or at least documenting the real enforcement point, since a future engineer reading only the Fastify config would draw the wrong conclusion about where the limit lives.

Client-supplied `Content-Type` is **never trusted** for storage/serving decisions on any route across the platform that accepts uploads — only server-side magic-byte sniffing (media's `TypeSniffer`) determines the stored/served MIME type. Client-supplied file extensions are always discarded and re-derived from the sniffed type.

Range-request support (media's delivery route): single-range only (`bytes=start-end`/`start-`/`-suffix`); a multi-range `Range` header is silently treated as absent (served as a full `200`), not rejected.

## O. OpenAPI strategy recommendation (Phase 1 input — not implemented in Phase 0)

1. **Version**: OpenAPI **3.1.x** — no real blocker found (every schema pattern encountered across all 13 services, including `oneOf`/`discriminator` polymorphism in notify and free-form `attrs` objects in geo/flags, is expressible in 3.1's JSON-Schema-aligned dialect).
2. **File layout**: one `openapi.yaml`/`openapi.json` per service, colocated in that service's own repo (matches this platform's explicit "each service is independently deployable, self-contained folder" convention — a centralized multi-service spec repo would contradict that). A small number of genuinely shared component definitions (§H) live in a single reference document (candidate location: `stack/docs/openapi-shared-components.yaml`) that each service's spec `$ref`s by relative/versioned pointer — not a runtime dependency, just a documentation-time one.
3. **Strategy**: **hybrid**, not purely handwritten or purely generated. Every service already has hand-authored Ajv JSON Schemas for request validation (`Schemas.*` in each `src/http/schemas.js`) that are a legitimate generation source for OpenAPI `requestBody`/`parameters` — but response schemas are frequently **absent** at the Fastify level (confirmed: notify, console, ratelimit's `/check`, and others return handler output directly with no declared `response:` schema block), so response shapes must be hand-authored from the verified route tables in this document, not mechanically generated from source.
4. **`operationId` convention (proposal)**: `<service>.<resource>.<action>` (e.g. `notify.messages.create`, `flags.envs.patch`), mirroring the audit-event action-name convention already established platform-wide (`AuditClient.route('<service>.<entity>.<verb>', ...)`) — reusing an existing, already-battle-tested naming scheme rather than inventing a new one.
5. **Schema-naming convention (proposal)**: `<Resource>` for the canonical read shape (e.g. `Flag`, `Delivery`), `<Resource>Create`/`<Resource>Patch` for write bodies, `<Resource>List` for the `{items, nextCursor}` envelope — again reusing the exact vocabulary each service's own source already uses in comments/JSDoc typedefs.

## P. Minimal future contract-validation plan (no new CI, per explicit instruction)

Phase 0 finds that **every service already validates its own requests against hand-authored Ajv schemas at runtime** — this is real, load-bearing request validation today, independent of any OpenAPI work. The gap is response-side and cross-service consistency, not request-side safety.

Recommended minimal plan for a later phase (not built now): a single local script (not a CI workflow — the project's standing policy is local-only validation, `RELEASE_AUDIT.md` §16) that, for each service, (a) diffs its OpenAPI spec's declared request schemas against its live `Schemas.*` Ajv definitions for drift, and (b) replays a captured set of real request/response pairs (already exercised by each service's own `test/api.test.js`) against the OpenAPI spec's `responses` schemas once those are authored. This reuses existing test fixtures rather than inventing new contract-test infrastructure.

## Q. Typed-client readiness matrix

| Service | Readiness | Notes |
|---|---|---|
| notify, auth, media, audit, shortlink, flags, scheduler, webhook-out, search, ratelimit, geo | **High** | Every request shape is a real, enforced Ajv schema today; a generated client's request-building code can be derived directly and will match runtime validation exactly. |
| console | **Medium** | Request shapes are equally solid, but ~130 of ~140 routes have no declared response schema — a generated client's response *types* would need to come from this audit's hand-documented shapes (§G), not from source schemas, until console's own routes are given `response:` blocks (out of scope for Phase 0). |
| gateway | **Low, by design** | Only 5 stable endpoints; the actual "API surface" most consumers care about (the proxied services) already has a typed-client path through each target service's own spec — a gateway-specific typed client adds little beyond a base-URL/JWT wrapper. |

## R. MCP-readiness classification (classification only — no MCP design in this phase)

Per the user's explicit instruction, this is a classification, not a design. Candidate groupings for a later `stack-mcp` layer, based purely on what this audit found to be safe, read-mostly, and low-blast-radius vs. mutating/high-blast-radius:

- **Read-mostly, low-risk, strong MCP-tool candidates**: geo (lookup/reference-data routes), search (query/suggest), flags (evaluate/snapshot), audit (query/verify/export), ratelimit (check with `peek:true`, stats).
- **Mutating, moderate-risk**: notify (send message), scheduler (create/patch job, manual run), webhook-out (subscription CRUD, replay), shortlink (create link), media (upload/delete).
- **High-risk / needs explicit human-in-the-loop framing if ever exposed via MCP**: auth (user creation/deletion, session revocation, password reset), console (admin account management, service-settings mutation), ratelimit (override/policy mutation — directly changes production traffic-shaping), geo (`database/reload` — swaps the live IP database).
- **Not a good MCP fit at all**: gateway (infrastructure routing, not a business capability); console's proxy layer as a whole (better modeled as MCP tools against the *target* services directly, not through console's session-cookie auth model, which doesn't map cleanly to an MCP client identity).

No further MCP design work was done — this is explicitly out of scope for Phase 0.

## S. Security-audit boundary — flagged items (none confirmed as a production bug; all are design questions for the team)

Per the explicit instruction to flag, not fix, and to STOP only for a *confirmed* bug: none of the following rose to that bar during this audit — each was independently flagged by its research pass as a design/policy question, not a verified exploit. Listed here for team review, in descending order of how concrete they are:

1. **media**: the plaintext single-use upload-ticket token is forwarded into the audit-service event's `target.id` field (`media.upload.ticket` audit action reads the token from the *response body*, not a hash). Every other credential in this codebase (API keys, ticket tokens themselves in normal use) is stored/forwarded only as a hash. Ticket is short-lived and single-use, which bounds the blast radius, but this is a real inconsistency with the rest of the platform's credential-handling discipline.
2. **scheduler**: `PATCH /v1/jobs/:name`'s audit event forwards the raw request body (`meta.patch: request.body`) verbatim to the external audit service — since a job `target.body` can contain arbitrary caller-supplied JSON, an operator who (mistakenly or not) puts a secret in a scheduled job's outbound payload has that secret copied into the audit service's own storage with no redaction at this layer.
3. **auth**: `GET /v1/users` has no role gate at all (any valid API key, including one issued with `role:read`, can list/enumerate every user by exact email lookup) — likely intentional per the class's own "not a full RBAC scheme" design comment, but worth an explicit confirmation before treating it as settled contract.
4. **auth**: `POST /v1/auth/verify-email/resend` has an asymmetric enumeration signal — unknown email silently returns `202`, but an already-verified known email returns `409 ALREADY_VERIFIED`, letting a caller distinguish "exists and verified" from "unknown or exists-unverified." Minor, two-way signal only.
5. **console**: `POST /api/session/logout` is exempt from the CSRF-header check (see §G) since it bypasses `requireSession`.
6. **geo**: `docs/READINESS.md`'s stale claim of "no checksum verification" (§I) is a documentation risk, not a code risk — the real code is correctly verifying checksums; flagging here only because a reader trusting the wrong doc could reach an incorrect security conclusion about the service.

None of the above blocks writing an OpenAPI spec, and none required stopping this phase.

## T. Unresolved questions / blockers for Phase 1 (must be answered before OpenAPI implementation, not before finishing Phase 0)

1. Should the six `INVALID_CURSOR` dead-code error declarations (§E) be wired up or removed before being written into a formal OpenAPI error catalogue? (Documenting an unreachable code is worse than omitting it.)
2. Should the platform standardize the pagination cursor field name (`nextCursor` / `nextBefore` / `nextBeforeSeq` / `nextFrom` — §H) before or after OpenAPI generation? Doing it after means the specs will need a breaking revision later.
3. Console's ~130 pass-through routes have no response schema at the source level (§G, §Q) — does the team want console's OpenAPI spec to `$ref` each target service's own response components (accurate but creates a build-order dependency across repos), or stay untyped on the response side (simpler, less useful for a generated client)?
4. Gateway's `routes.json`-driven proxy surface (§F) — confirmed as deployment config, not source-level contract. Does the team want *any* machine-readable representation of it (e.g. an `x-gateway-routes` OpenAPI extension generated from a live `routes.json`), or is prose documentation sufficient?
5. The five items in §S are product/security-policy questions for the team, not this audit's to resolve.

No genuine runtime contract ambiguity or bug that would *block* writing an OpenAPI spec was found for any of the 13 services — every route's request/response shape, status-code set, and side effects were fully resolved from source. The items above are refinements and policy decisions, not blockers to starting Phase 1's drafting work; they are blockers only to calling Phase 1 *finished*.

## U. Per-service quick-reference index

Full per-route detail (method, exact path, params, headers, request/response schemas with every field constraint, every reachable status code, side effects, and each service's own flagged ambiguities) was produced by 13 independent source-verification passes during this phase and is reflected in the summaries, tables, and cross-cutting findings above (§B–§T). The full unabridged per-route write-ups (frequently 100+ pages of source-cited detail per service) are preserved in this session's transcript and should be treated as the working notes this document was distilled from — Phase 1's spec authors should pull the exact field-level schemas from there (or re-derive them from the cited source files directly) rather than from prose summaries alone.

Service → primary source files, for a Phase 1 author to re-open directly:

| Service | Route file | Schema file | Domain error file |
|---|---|---|---|
| gateway | `src/http/gateway-api.js` | inline / `src/route-table.js` | `src/proxy.js` |
| notify | `src/app.js` | inline (`Schemas` class in `app.js`) | `src/errors.js` (via statusCode/code on thrown errors) |
| auth | `src/http/auth-api.js` | `src/http/auth-api.js` (inline `Schemas`) | `src/domain/errors.js` |
| media | `src/http/media-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| console | `src/http/console-api.js` | inline (`Schemas` class) | `src/domain/errors.js` |
| audit | `src/http/audit-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| shortlink | `src/http/shortlink-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| flags | `src/http/flags-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| scheduler | `src/http/scheduler-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| webhook-out | `src/http/webhook-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| search | `src/http/search-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| ratelimit | `src/http/rate-limit-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |
| geo | `src/http/geo-api.js` | `src/http/schemas.js` | `src/domain/errors.js` |

---

*End of Phase 0 audit. No OpenAPI files, typed clients, or MCP code were written. No production behavior, dependency, version, or git tag was changed. Awaiting approval before Phase 1 (canonical OpenAPI contracts) begins.*
