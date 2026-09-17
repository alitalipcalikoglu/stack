# Architecture audit

Platform: 13 services plus this installer, one public repository each under `github.com/alitalipcalikoglu`. Source of truth for the review: the code at the revisions listed below, read repository by repository (`src/`, `test/`, `db.js` schemas, `.env.example`, `ecosystem.config.cjs`, `Dockerfile`, README, `examples/`). Line references are to those revisions.

| Repository | Revision |
|---|---|
| gateway | e44486c |
| notify | bb955f7 |
| auth | 47b82de |
| media | bb175df |
| console | a30af41 |
| audit | (unchanged since 2026-09-16) |
| shortlink | a2b5ecc |
| flags | 54508ce |
| scheduler | 49ad313 |
| webhook-out | 8b64568 |
| search | 3d73526 |
| ratelimit | 339ddd1 |
| geo | 8b27d0c |
| stack | 027f652 |

## 1. Dependency graph (from code and `stack/src/manifest.js`)

```
browser ──HTTPS──▶ gateway ──▶ auth      (routes.json; JWKS for auth:"user" routes)
                           ──▶ media
                           ──▶ notify
                           ──▶ ratelimit (route "policy": POST /v1/check, check role)
                           ──▶ geo       (route "geo": GET /v1/ip/:ip, read role)
browser ──HTTPS──▶ console ──▶ every service (readwrite keys; audit: readwrite)
                           ──▶ audit     (forwards its own log as console.* events)

auth      ──▶ notify (verification / reset mails, synchronous, in request)
scheduler ──▶ flags | notify | webhook-out | any HTTP target (TARGET_KEYS by name)
notify    ──▶ SMTP, receiver URLs (webhook channel)
webhook-out ──▶ subscriber URLs

notify, auth, media, shortlink, flags, scheduler, webhook-out, search, ratelimit, geo, console
          ──▶ audit (POST /v1/events/batch, buffered, write-role key per service)

audit, search, flags, shortlink, ratelimit, geo: no outbound calls except audit.
```

Every edge is optional at runtime (missing URL = feature off) except `auth → notify` (`NOTIFY_URL` required by config; a down notify degrades registration to `verificationEmailSent:false` and turns auth `/ready` red). Readiness never waits on other services except auth (notify `/health`) and gateway (upstream `healthPath`).

## 2. Shared skeleton (what every service already has)

Confirmed identical or near-identical across services (diffs run):

- `Config.fromEnv(env)` over a private `EnvReader` (`optional/required/integer/boolean`, some add `csv/list`), frozen `Config`, `ConfigError` → `process.exit(1)`.
- `Database` (`node:sqlite` `DatabaseSync`): `MIGRATIONS[]`, `PRAGMA user_version` loop, one `BEGIN/COMMIT` per migration, `ROLLBACK` + rethrow (startup aborts), `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `transaction(fn)` = `BEGIN IMMEDIATE`. Exactly one migration everywhere.
- `Application`: `fromEnv/start/shutdown`, SIGTERM/SIGINT, `unhandledRejection` → shutdown, `uncaughtException` → exit 1, force-exit timer (30 s; media 60 s; gateway upstream timeout + 5 s; workers derive from their longest call), `process.send('ready')`.
- Fastify 5.12.4: optional native TLS (`minVersion TLSv1.2`), pino with `authorization` redacted, `x-request-id` honoured (gateway and console generate and ignore inbound), custom tolerant JSON parser, error envelope `{ error: { code, message, details? } }`, `/health` static, `/ready` cached dependency check, `/metrics` Prometheus text behind the API key (gateway: bearer token; console: none).
- `ApiKeyAuth`: SHA-256 + `timingSafeEqual` over every configured key (no early exit); four variants (id-only: media, notify; roles: audit, scheduler, webhook-out (+`publish`), search/ratelimit/flags (+scope)); shortlink decorates `apiKeyId/apiKeyRole` instead of `apiKey`.
- `net/audit-client.js`: byte-identical in 11 repositories (buffer 5 000, batch 200, 2 s flush, 6 attempts, drop on 4xx≠429, keep on network error, `AuditClient.hook` on `onSend`, `AuditClient.route(...)`).
- `net-guard.js` (SSRF guard with pinned DNS): identical scheduler ↔ webhook-out; older variant in notify (no `allowPrivate`).
- `http-caller.js` / `signer.js`: three variants (notify inlined in `channels/webhook.js`, `Buffer.equals` in its verifier; webhook-out static multi-secret; scheduler single secret).
- `crypto/password.js`, `crypto/opaque-token.js`: byte-identical auth ↔ console. `rate-limiter.js`: gateway ↔ console. `maintenance.js`: same shape auth/console/flags/shortlink/media/audit.
- PM2 `ecosystem.config.cjs` (fork, `instances: 1`, `wait_ready`, `kill_timeout` 35–80 s) and `Dockerfile` (node:22-alpine, non-root, `/data` volume, wget healthcheck) identical modulo name/port/memory.

Roughly 450 lines of infrastructure are copied per service; a change to the audit retry policy today needs 11 commits.

## 3. Summary table

Severity: P0 correctness/security/data-loss, P1 production architecture, P2 maintainability/operability, P3 optional capability. "Breaking?" refers to public HTTP API or persistence format.

| Service | Purpose | Current architecture | Missing / defect (with evidence) | Improvements | Severity | Proposed change | Breaking? |
|---|---|---|---|---|---|---|---|
| gateway | Edge: routing, proxy, JWT, limits, policy, geo | Stateless single process; `RouteTable` loaded once; streaming proxy (`proxy.js:188,207`); passive upstream cooldown (`upstream-pool.js:69-82`); local per-IP limiter; ratelimit/geo clients | `policy.failOpen` defaults to `true` (`route-table.js:146`) so a security route silently loses its limit when ratelimit is down; no `traceparent`; inbound `x-request-id` ignored (`gateway-api.js:59`); no half-open breaker, one failure = cooldown; no route reload; `RateLimit-*` set even on fail-open pass | Make `failOpen` mandatory when `policy` is set (no default) or default to `false` for `subject:'ip'` login-style routes; propagate/generate `traceparent`; add upstream latency + breaker state to metrics; `SIGHUP` route reload with validate-then-swap | P1 (failOpen), P2 (tracing, reload) | Stage 9 | No (config validation stricter: routes.json with `policy` but no `failOpen` will be rejected with a clear message; documented) |
| notify | Queued e-mail + signed webhook delivery | Single process API + in-process worker; claim `UPDATE…RETURNING` with `locked_until` lease (`queue.js:81`), `reapStale` every 60 s, equal-jitter backoff, `failed` terminal, retention purge; idempotency per key | Shutdown order flushes audit before stopping the worker (`application.js:89-91`) so PM2 can kill mid-delivery; batch loop `Promise.all` (`worker.js:68`) — one slow send idles the pool; `LOCK_TTL_MS` may be shorter than SMTP worst case 50 s (`config.js:72`, `email.js:41-44`); at-least-once e-mail with no receiver dedup (inherent); idempotent replay ignores payload differences (`queue.js:117-130`); `WebhookSigner.verify` uses `Buffer.equals` (`channels/webhook.js:60`); webhook channel duplicates webhook-out (same signing scheme, own retries, caller-supplied `Authorization` stored in payload) | Fix shutdown order; rolling pool; TTL ≥ SMTP timeout enforced; `Buffer.equals` → `timingSafeEqual`; 409 on idempotent replay with different payload; separate `api`/`worker` entry points; document webhook channel as legacy, point new integrations at webhook-out | P1 (shutdown, TTL), P2 (pool, split), P3 (channel boundary) | Stages 6, 7 | No |
| auth | Identity, sessions, JWT, password flows | scrypt (logN 15), sessions with rotating refresh hash + previous hash reuse detection (`session-store.js`, `auth-service.js:181-186`), hashed single-use action tokens, reset revokes sessions in a transaction, ES256 with `kid`, `JWT_PREVIOUS_PUBLIC_KEY_PATH` overlap rotation, lockout, dummy-hash timing defence, events per user | Dummy hash logN 14 vs users 15 (`auth-service.js:436`) → measurable timing difference on unknown e-mail; audit forwarding fires inside transactions before COMMIT and lives in a memory buffer (`event-store.js:25`, `audit-client.js:66`) → lost on crash, or sent for a rolled-back write; `X-Client-IP` trusted from any key holder (`auth-api.js:120`); no roles on API keys; `AuthService` 444 lines/15 methods (wide but cohesive); MFA/WebAuthn/OIDC absent (README out of scope) | Dummy hash at the configured logN; transactional outbox table for security events (audit forwarder reads committed rows); `X-Client-IP` only from keys flagged as gateway; roles read/write on keys (compatible: default readwrite); keep `AuthService` as is (split not justified) | P0 (outbox/timing), P1 (X-Client-IP, roles) | Stage 4 | No (new outbox table via migration 2; API unchanged) |
| media | Binary storage, variants, signed URLs | Raw streaming upload to tmp + rename, sniffing, sharp normalisation, sha256 dedupe via `blobs`, lazy WebP variants with in-process `inflight` map, tickets, soft delete/grace purge, HMAC URLs | `/ready` calls `storage.init()` which `rm -rf tmp` (`media-api.js:156`, `local-storage.js:45`) → any readiness probe aborts in-flight uploads (P0); purge deletes orphan blob rows in a transaction then removes bytes asynchronously (`media-service.js:318-319`) → concurrent upload of the same content can end with a row pointing at deleted bytes; no storage interface (`LocalStorage` typed directly, `media-service.js:13`); single `SIGNING_SECRET`, rotation invalidates outstanding URLs; no fsync on object writes | Readiness = `access()` only, tmp wipe once at start; purge order: unlink bytes inside the same critical section with a re-check, or mark blob `purging` first; `Storage` interface extracted from `LocalStorage` (adapter boundary, no S3 yet); `SIGNING_SECRET_PREVIOUS` accepted for verification; document variant generation as request-time with per-process dedupe (single-node) | P0 (ready wipe), P1 (purge race, storage interface, secret grace) | Stages 4 (ready), 8 | No |
| console | Admin control plane | Own admins/sessions/TOTP, cookie `HttpOnly SameSite=Strict`, CSRF header, typed per-service clients, own log forwarded to audit | RBAC admin/viewer only; TOTP secrets plaintext in SQLite (`db.js:16`); request id not forwarded to services; no capability discovery (clients hardcoded per type — acceptable, typed) | Encrypt TOTP secrets under a `SECRETS_KEY` (as webhook-out `SecretBox`); forward `x-request-id`/`traceparent` to services; add `GET /v1/info` consumption for version/compat display; keep static typed clients | P1 (TOTP at rest), P2 | Stages 1, 7 (versioning), 10 | No (migration re-seals secrets) |
| audit | Tamper-evident central log | Canonical JSON, `SHA256(prev + "\n" + canonical)`, `BEGIN IMMEDIATE` append, `UNIQUE(source, client_id)`, purge keeps checkpoint hash, streaming export, meta redaction | Concurrent exports share a cached `StatementSync`; a second `iterate()` resets the first (verified on Node 22.23.2) → garbled export output (`event-store.js:188-192,252-258`) (P0); `seq` not part of the hash (ordering relies on `prev_hash` + gap check, `chain.js:42-57`, `audit-service.js:136-139`); no signed checkpoint/anchor; single-writer is a SQLite property, not enforced; `synchronous=NORMAL` durability not stated | Fresh statement per export; signed periodic checkpoints (Ed25519, `ANCHOR_PRIVATE_KEY_PATH`), `GET /v1/chain/anchors`, optional push to webhook-out/notify or file; verify checks anchors; document writer/durability contract; optional `seq` in hash for chain v2 (deferred, breaking) | P0 (export), P1 (anchor) | Stage 4 | No (anchors are additive) |
| shortlink | Redirects, click stats, QR | Sync redirect path: select → status → `BEGIN IMMEDIATE` insert click + increment → 30x; HMAC visitor hash, no IP stored; blocked hosts | `maxClicks` check is read-then-write (`link-service.js:139-150`, `link-store.js:18`): correct in one process, overshoots with two; every redirect is a write transaction before the response | Conditional `UPDATE … WHERE clicks < max_clicks` and treat `changes = 0` as exhausted (also inside one process makes intent explicit); keep synchronous counting (single node, cheap); document exactness | P1 | Stage 10 | No |
| flags | Flags, rollout, snapshots | Version-checked per-env cache, `BEGIN IMMEDIATE` writes, deterministic bucket `SHA256(salt:id) % 10000`, ETag snapshots, history | No golden vectors for `Evaluator.bucket`; `examples/snapshots.md` re-implements the evaluator by hand (drift risk); no SDK package | Golden-vector test file committed to the repo and published as `examples/golden-vectors.json`; `Evaluator` extracted to a dependency-free module suitable for copy/publish; example client uses the same vectors | P2 | Stage 10 | No |
| scheduler | Persistent cron/one-shot HTTP jobs | Own cron parser with DST gap skip / overlap first-occurrence; `fire()` re-checks `next_run_at` in `BEGIN IMMEDIATE`; overlap → `skipped`; retries with backoff; `recover()` at start | No lease/heartbeat: a hung call leaves a run `running` forever and every later slot `skipped` (`job-service.js:159`); `recover()` from a second process would settle the first's in-flight runs (multi-process unsafe, documented as single-node); shutdown order flushes audit before stopping the worker; `MAX_TIMEOUT_MS` unbounded vs fixed `kill_timeout 80 s`; crash after 2xx before `finish` re-calls target (documented, `X-Scheduler-Run` for idempotency) | Lease column `lease_until` refreshed while running, stale-lease recovery in the loop (not only at start); bound `MAX_TIMEOUT_MS` and derive force-exit/`kill_timeout` from it; shutdown order; `api`/`worker` entry points; state "single-node (B)" explicitly, no leader election | P1 | Stage 6 | No (migration adds a column) |
| webhook-out | Generic webhook delivery | Fan-out inside publish transaction, per-subscriber sealed secrets with dual-signed rotation grace, fixed retry schedule, auto-disable, replay, `recover()` at start | No lease (same hang problem); no per-subscription concurrency limit → two deliveries to one subscriber can run at once, retries reorder (README says unordered — consistent); `EventStore.purge` cascades to pending/retrying deliveries (`event-store.js:19`) → paused subscribers lose queued work after retention; multi-process idempotency would surface as UNIQUE 500 (`event-service.js:52-58`); shutdown order; `kill_timeout 40 s` < force-exit when `DELIVERY_TIMEOUT_MS` raised | Lease + in-loop recovery; purge excludes events with live deliveries; catch UNIQUE on publish and return the original (belt and braces); optional per-subscription serial mode (`ordered: true`) documented as best-effort per subscription; `api`/`worker` split; derive timers | P1 | Stages 6, 10 | No |
| search | Embedded FTS5 search | Folded standalone FTS table, transactional batches, BM25, filters/facets, scoped keys | Process-local `searches` counters (labelled "since start", acceptable); `search()` count and rows in two statements (can disagree under concurrent writes; single process makes it moot); offset-only pagination | State single-node explicitly in the readiness contract; nothing else required | P3 | Stage 11 (docs) | No |
| ratelimit | Central limits | `checkMany` reads + adds in one `BEGIN IMMEDIATE`; integer-numerator sliding window; overrides; hourly decisions; cleanup worker | No backend abstraction (`CounterStore` is SQLite-bound, `RateLimitService` takes `db` for transactions); `release()` decrements only the current fixed window (`rate-limit-service.js:162`) → refunds after a boundary are lost or zero a fresh window; clock skew undocumented; multi-instance on one file is correct but serialises on the event loop | Introduce `CounterBackend` interface (`checkAndConsume(checks, now)`, `release`, `reset`, `top`, `cleanup`) with `SqliteCounterBackend` as the only implementation; contract test suite that a future Redis backend must pass (no Redis now); `release` targets the window the units were consumed in (client passes `consumedAt`, default now); document clock model (server clock, ±skew tolerated by design of sliding windows) | P1 | Stage 5 | No (release gains an optional field) |
| geo | IP + reference lookups | In-memory MMDB with own reader, atomic reader swap on load, SIGHUP/POST reload, places | `POST /v1/database/reload` calls `load()` not `tryLoad()` (`geo-api.js:162`): failure → opaque 500, `info().error` stale (contradicts `examples/ip-databases.md`); MMDB decoder has no bounds checks against `buf.length` (`mmdb.js:89-133`) → truncated file throws at lookup time, not at load; no checksum verification | `reload` returns 409 `DATABASE_RELOAD_FAILED` with the error and records it; bounds-checked decoder + validation lookup at load (walk the tree for a fixed set of addresses, decode metadata fully); optional `MMDB_SHA256` env or `.sha256` sidecar verified before swap; keep download outside the service (scheduler + script) | P1 (reload path), P2 (bounds) | Stage 10 | No |
| stack | Bootstrap, wiring, dev runner | Manifest-driven env/key generation, PM2 up/down, dev runner, first admin | No backup/restore tooling, no upgrade/rollback procedure, no compatibility matrix, README §Layout mentions console audit role `read` (stale; manifest says `readwrite`) | `stack backup` / `stack restore` (SQLite `.backup` per service + media objects rsync, manifest-driven, restore test), `stack upgrade` (pull, `npm ci`, migrate = start once, health gate, rollback = previous checkout + restored backup), compatibility check via each service's `/v1/info`, docs | P1 (backup/restore), P2 | Stages 3, 7, 12 | No |

## 4. Cross-cutting findings

### 4.1 Observability (recommendation 3.1)

Confirmed gaps: no `traceparent` anywhere; gateway and console generate request ids and ignore inbound ones (gateway forwards its own upstream, console forwards nothing); log field names differ per service (`reqId` vs pino `reqId`, `route`, `job`, `delivery`); no `service`/`version` fields; no upstream latency in logs outside gateway. Already implemented: per-request UUID ids, pino structured logs, redaction of `authorization`, Prometheus `/metrics` in every service but console, cheap `/health`, cached `/ready`.

Decision: no OpenTelemetry runtime dependency. A 60-line `RequestContext` helper (generate or parse `traceparent`, carry `traceId`/`spanId`/`requestId`, child span ids for outbound calls) plus a logging convention (`service`, `version`, `reqId`, `traceId`, `op`, `durationMs`, `code`, `upstream`, `upstreamMs`) gives 90 % of the value; OpenTelemetry can be attached later by an optional adapter that reads the same context. Health/readiness stay as they are.

### 4.2 Shared runtime (recommendation 4)

Duplication is real and mechanical (section 2). Decision: create `service-core` as a small, versioned package (`@alitalipcalikoglu/service-core`, semver, published from its own repository, consumed as an exact-version dependency) containing only: `EnvReader` + `ConfigError`, `Database` (migration runner), `AuditClient` (+ hook/route), `ApiKeyAuth` (with pluggable role/scope check), `RequestContext`/`traceparent`, `HttpCaller` primitives (timeout, pinned-DNS `NetGuard`, retry classification), `Signer`, `Lifecycle` (signals, force-exit, PM2 ready), `errorHandler`/`probes`/`metricsText` helpers, `StatementCache`. Nothing domain-specific. Services adopt it one by one; a service keeps working without it (copy stays until its own stage). Each service pins the version; the `stack` compatibility check reads `service-core` version from `/v1/info`.

Rejected: a shared Fastify "app factory" that hides routing, and any shared domain code.

### 4.3 Database and migrations (recommendation 5)

Already implemented consistently: ordered `MIGRATIONS[]`, `user_version`, one transaction per migration, failure aborts startup, WAL. Missing: backup-before-migrate, documented rollback limits, migration tests beyond "schema applies", version stamp in a table (only `user_version`). Decision: `Database` moves to `service-core` with `migrate({ backupDir })` that copies the file (`VACUUM INTO` or `.backup` API) before applying a pending migration, records `schema_migrations(version, applied_at, description)` (additive to `user_version`), refuses to open a database whose version is newer than the code (forward-incompat guard), and exposes `Database.expectedVersion` for `/v1/info`. Rollback = restore the pre-migration copy; documented as the only path. No down migrations.

### 4.4 Transactional outbox (recommendation 6)

Where the gap matters: auth security events (login failures, resets, revocations) and console admin actions are the audit trail; today they sit in a memory buffer for up to 2 s and, in auth, are emitted before COMMIT inside transactions. webhook-out and notify already use the DB as their outbox (deliveries/messages rows are created in the business transaction). Media/flags/ratelimit/search/geo/shortlink audit events are operational, loss on crash is tolerable and documented.

Decision: outbox only in auth and console: `outbox(id, at, payload, sent_at)` written in the same transaction as the security/log event; the audit forwarder drains committed rows (idempotent by row id), marks `sent_at`, purges after retention. `AuditClient` gains a `source` mode `db` reused by both. Everything else keeps the buffered client.

### 4.5 API versioning (recommendation 7)

Already implemented: `/v1` prefix everywhere; keys and roles stable. Missing: no way to learn a service's version or capabilities. Decision: `GET /v1/info` (read role) in every service: `{ service, version (package.json), apiVersion: 1, schemaVersion, capabilities: [...], serviceCore: version }`. Console shows it; `stack status` prints a matrix and warns on unknown capabilities; no startup hard checks (services must not refuse to start because a peer is old).

### 4.6 Secrets and rotation (recommendation 8)

Already implemented: auth JWT previous public key; webhook-out per-subscriber dual-signed grace; API-key lists allow two ids in parallel (add new id, switch callers, remove old). Missing: `SIGNING_SECRET` (media URLs, scheduler, notify) single-valued; `SECRETS_KEY` (webhook-out) unversioned; `HASH_SECRET` (shortlink) unrotatable by nature (visitor hashes would change; acceptable, document); `METRICS_TOKEN` single; TOTP secrets plaintext (console). Decision: accept `<NAME>_PREVIOUS` for every HMAC/signing secret (verify with both, sign with current); `SECRETS_KEY` becomes `SECRETS_KEYS=kid:hex,...` with the sealed format already carrying a version prefix; console seals TOTP secrets; document the two-id API-key rotation. Secrets stay env-provided; `EnvReader` gets a single seam (`Config.fromEnv(env)` already) so a secret manager can materialise env at start without code changes. No vault integration now.

### 4.7 Backup and restore (recommendation 9)

Missing everywhere except README one-liners (`sqlite3 .backup`). Decision: `stack backup` writes `<dir>/<ts>/<service>.db` via SQLite backup API (consistent under WAL) plus `media/objects` and `media/variants` (rsync-style copy) and `auth/keys`; `stack restore <ts>` stops the service, restores, starts, checks `/ready`; a stack test runs backup → mutate → restore → verify on temp dirs. Per-service README gets a "Backup / restore" section with the invariant (database + object dir must be from the same snapshot for media).

### 4.8 Integration tests (recommendation 10)

Missing entirely at stack level (each repo tests itself with in-memory DBs and fakes). Decision: `stack/test/integration/*.test.js` that spawn real services from the workspace on ephemeral ports with generated envs (the `dev` runner already does most of this) and drive: signup → auth → notify (fake SMTP `json:` transport) → audit; gateway → JWT → policy (ratelimit) → upstream, including ratelimit down with `failOpen:false`; publish → webhook-out → receiver failing twice → retry → success, and subscriber auto-disable; scheduler job → target (flags write) → run history, target 500 → retry; media upload → signed URL → download → delete → purge; flag update → snapshot ETag change → evaluate. Marked `integration` and skipped when `STACK_INTEGRATION` is unset so unit runs stay fast.

### 4.9 Production readiness contract (recommendations 11, 27)

Missing as a document. Decision: `docs/READINESS.md` in every service (template in `stack/docs/READINESS_TEMPLATE.md`) with the 19 mandated sections and the scaling class. Classes from the code as it stands:

| Class | Services |
|---|---|
| A stateless, horizontally scalable | gateway (limiter, cooldown and geo cache are per instance — documented) |
| B single-node stateful (one process per SQLite file) | notify, auth, media, console, audit, shortlink, flags, scheduler, webhook-out, search, ratelimit, geo |
| C multi-node with shared DB | none today; ratelimit and audit are correct on a shared local file but not designed for it |
| D distributed coordinated worker | none; scheduler/webhook-out/notify claim atomically but recovery is per process |

No service will be promoted to C/D in this plan; each README will say so.

## 5. Recommendation-by-recommendation verdict

| # | Recommendation | Verdict |
|---|---|---|
| 3.1 | Observability standard | Confirmed gap (traceparent, field names, service/version); OpenTelemetry not adopted as dependency, optional adapter seam only |
| 4 | Shared service runtime | Confirmed (450 lines × 11 copies); small versioned package justified |
| 5 | Migration standard | Mostly implemented; add pre-migration backup, migration table, forward-incompat guard, rollback docs |
| 6 | Transactional outbox | Confirmed for auth (and console); already effectively present in notify/webhook-out/scheduler via DB rows; not applied elsewhere |
| 7 | API versioning | `/v1` present; add `/v1/info`; no startup coupling |
| 8 | Secrets/rotation | Partially implemented (JWT, subscriber secrets, key lists); add `_PREVIOUS` for HMAC secrets, keyed `SECRETS_KEYS`, sealed TOTP |
| 9 | Backup/restore | Confirmed missing; stack tooling + tests |
| 10 | Integration tests | Confirmed missing |
| 11 | Readiness contract | Confirmed missing |
| 12 | Gateway | Streaming, separation, fail-open/closed: already implemented; `failOpen` default true needs modification; breaker/tracing/reload confirmed missing; proxy.js is 213 lines and not a problem — no split |
| 13 | Notify | Queue properties already implemented; DLQ = `failed` + manual retry (documented as such, no separate table needed); priority/scheduled delivery: not required by any caller, not applicable; provider failover: not applicable; API/worker split confirmed; webhook overlap confirmed |
| 14 | Auth | Correctness list verified as implemented except dummy-hash cost and outbox; MFA/WebAuthn/OIDC not applicable (out of scope by design); `AuthService` split not warranted |
| 15 | Media | Good properties confirmed; storage interface confirmed missing; S3/malware/resumable/CDN not applicable now; readiness wipe is a new P0; lazy variants stay request-time (single node) with the process-local lock documented |
| 16 | Console | RBAC/capabilities confirmed limited; capability endpoint = `/v1/info` consumed for display only; clients stay static |
| 17 | Audit | Chain properties confirmed; export bug is a new P0; anchor confirmed missing; single-writer documented |
| 18 | Shortlink | `maxClicks` race confirmed (multi-process only); abuse/reputation/custom domains not applicable |
| 19 | Flags | Confirmed good; golden vectors + evaluator module needed; enterprise features not applicable |
| 20 | Scheduler | Lease/heartbeat confirmed missing; leader election/fencing not applicable (single node by contract); DAG not applicable; split confirmed |
| 21 | Webhook-out | Ordering stated as none (matches); per-subscription concurrency confirmed unbounded; purge cascade is a new finding; challenge/schema versioning not applicable now |
| 22 | Search | Already matches "single-node embedded"; counters are labelled ephemeral; nothing to change beyond the contract doc |
| 23 | Ratelimit | Atomicity confirmed; backend abstraction confirmed missing (interface + contract tests, no Redis); release boundary defect is new; clock docs missing |
| 24 | Geo | Atomic swap confirmed; reload error path needs modification; checksum/bounds confirmed missing; LRU cache not applicable (gateway already caches; geo lookups are in-memory) |
| 25 | Stack | Backup/restore/upgrade/compat confirmed missing; secret provider not applicable now |
| 26 | API/worker separation | Confirmed for notify, scheduler, webhook-out |
| 27 | Single/multi-node contract | Confirmed missing as a document; classification above |

## Addendum, discovered during Stage 1

Found while building the real multi-process integration test
(`stack/test/integration/gateway-auth-audit.test.js`), not present in the original discovery pass
because gateway's own test suite proxies to a fake echo upstream that cannot catch a path mismatch
against a real service's actual routes:

`SetupContext.gatewayRoutes()` (`stack/src/setup-context.js`) generates the `auth-public` route as
`{ pathPrefix: '/api/auth/', stripPrefix: '/api/auth', upstreams: [this.url('auth')], ... }`. Auth's
real routes live under `/v1/auth/*` (`auth/src/http/auth-api.js` registers `#registerV1` at prefix
`/v1`, with `POST /auth/login` inside it). Stripping `/api/auth` from `/api/auth/login` leaves
`/login`, which does not exist on auth — every login/register/refresh/etc. call made through a
*real deployed* gateway using this generated `routes.json` would 404. This is a P0 correctness bug
in generated production configuration, separate from anything in the original table above and not
covered by Stage 0's scope (P0 fixes were auth/audit/media/geo application code, not stack's route
generator). A fix-only follow-up has been flagged (see the spawned task chip; not fixed in Stage 1,
per the reviewer's explicit scope instruction not to exceed Stage 1). The Stage 1 integration test
does not exercise the broken generated route — it defines its own correct one — specifically so it
would not silently mask this.
