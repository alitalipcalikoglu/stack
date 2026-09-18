# Implementation plan

Companion to [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md). Stages are ordered by dependency; each stage ends with tests green in every touched repository, a commit per repository, and a stage report. Nothing here changes a public `/v1` endpoint incompatibly or an existing persistence format; every schema change is a new migration.

## Ordering and why it differs from the suggested order

Suggested order: contracts → shared core → migrations → auth/audit → ratelimit → workers → notify/webhook boundary → media → gateway → rest → integration tests → stack docs.

Changes:

1. **P0 defects first, before any refactor** (new Stage 0): the media readiness wipe, the audit export corruption, the auth dummy-hash cost and the geo reload error path are one-file fixes with tests. Shipping them behind a multi-week core extraction would leave known data-loss and security defects in place while unrelated code moves.
2. **Shared core before the migration standard and before the outbox** (Stages 2 → 3 → 4): the migration runner, the `AuditClient` DB-outbox mode and the request context all live in the core; writing them once in the core and adopting per service avoids implementing them twice (once in copies, once in the package).
3. **Worker runtime separation (Stage 6) before the notify/webhook boundary (Stage 7)**: the boundary work is documentation plus a deprecation note; it depends on nothing but reads better once the worker entry points exist.
4. **Backup/restore tooling moves up into Stage 3** with the migration standard, because the migration runner's pre-migration copy and `stack backup` share the same SQLite backup primitive and the restore test is the proof that migrations are safe.
5. **Integration tests are written incrementally**: the harness lands in Stage 1 (needed to prove the tracing/readiness conventions end to end) and each later stage adds its flow; Stage 11 only completes failure paths.

Ratelimit backend abstraction stays at Stage 5 (after the core, because the contract test suite uses the core's `Database`).

## Stage 0 — P0 defects (no refactoring)

Repositories: media, audit, auth, geo.

| Repo | Problem (evidence) | Change | Tests |
|---|---|---|---|
| media | `/ready` runs `storage.init()` which removes `tmp/` (`http/media-api.js:156`, `storage/local-storage.js:45`) | `LocalStorage.init()` → `prepare()` (mkdir + wipe, called once from `Application.start`) and `check()` (access/mkdir only, used by readiness) | `api.test.js`: an upload in progress survives a `/ready` call; `storage.test.js`: `check()` never removes files |
| media | Purge deletes blob rows then bytes async (`domain/media-service.js:316-322`) | Purge marks orphan blobs inside the transaction, unlinks, then deletes rows; `commit()` re-checks the row after `exists()` and re-links when missing | `media-service.test.js`: purge racing an upload of the same sha leaves a readable file |
| audit | Shared `StatementSync` across concurrent `iterate()` (`store/event-store.js:188-192`) | `iterate()` prepares a private statement (not `#cached`); `search()`/`count()` keep the cache | `api.test.js`: two concurrent exports with the same filter produce identical, complete output |
| auth | Dummy hash logN 14 vs configured (`domain/auth-service.js:436`) | Dummy hash generated at construction with the configured `scryptLogN` | `auth-service.test.js`: dummy hash params equal config; timing test asserts same parameters, not wall time |
| geo | `POST /v1/database/reload` → `load()` throws → 500, `loadError` stale (`http/geo-api.js:162`) | `reload()` in `IpLookup`: try/catch, record error, keep readers, return `{ ok, error }`; API answers 409 `DATABASE_RELOAD_FAILED` with the message | `api.test.js`: failed reload → 409 with error, `/v1/database.error` set, lookups still served |

Invariants: no in-flight upload is ever removed by a probe; export output is a bijection of the filtered rows; login timing does not depend on whether the e-mail exists beyond hash cost equality; a failed reload never changes serving data.

## Stage 1 — Production contracts and observability conventions

Repositories: stack (template, harness), every service (docs only + request-context conventions where trivial).

- `stack/docs/READINESS_TEMPLATE.md` with the 19 sections and scaling class; `docs/READINESS.md` in every service filled from the audit (class B everywhere except gateway A). README "Scaling model", "Observability", "Backup / restore" sections reference it.
- Logging convention document (`stack/docs/OBSERVABILITY.md`): field names `service`, `version`, `reqId`, `traceId`, `spanId`, `op`, `durationMs`, `code`, `upstream`, `upstreamMs`; `traceparent` propagation rules (accept inbound at the gateway only from trusted proxies, generate otherwise; every outbound call sends `traceparent` and `x-request-id`).
- Gateway: accept inbound `x-request-id`/`traceparent` only when `TRUST_PROXY=true`, generate otherwise, forward both (`http/gateway-api.js`, `proxy.js`). Console: forward `x-request-id` in `services/client.js`. Both are one-line changes and unblock end-to-end correlation before the core exists.
- Integration harness: `stack/test/integration/harness.js` (spawn services from the workspace on free ports with generated envs, wait for `/ready`, tear down) + first flow: gateway → auth login → `x-request-id` visible in auth log and audit event.

Tests: harness self-test; gateway request-id tests. No persistence changes.

## Stage 2 — `service-core` extraction

New repository: `service-core` (`@alitalipcalikoglu/service-core`, MIT, semver, `exports` map, no runtime dependencies besides `fastify` as a peer for the hook types).

Contents (each a class, each with its own tests, taken from the best existing copy):

| Module | Source copy | Notes |
|---|---|---|
| `config` (`EnvReader`, `ConfigError`, `parseApiKeys(raw, { roles, scopePattern })`, `parseTarget(prefix)`) | ratelimit/geo | roles/scopes pluggable; keeps every current key format |
| `db` (`Database` with `MIGRATIONS`, `transaction`, `ping`, `sizeBytes`, `StatementCache`) | audit/ratelimit | Stage 3 adds `migrate({ backupDir })`, `schema_migrations`, forward guard |
| `audit` (`AuditClient`, `AuditClient.hook`, `AuditClient.route`) | identical copies | Stage 4 adds DB-outbox source |
| `auth` (`ApiKeyAuth` with `identify`, `require(role)`, `assertScope`) | ratelimit | shortlink/media adapt decorators |
| `context` (`RequestContext`: request id, `traceparent` parse/generate/child) | new | used by clients and loggers |
| `http` (`HttpCaller` with timeout, pinned-DNS `NetGuard`, retry classification; `Signer` with `secrets[]`, `timingSafeEqual`) | webhook-out (guard, signer), scheduler (caller) | notify adopts and drops its inlined copy |
| `lifecycle` (`Lifecycle.install(app, { forceExitMs, steps })`, PM2 ready) | auth/ratelimit | shutdown step order becomes explicit: stop intake → drain workers → flush audit → close db |
| `fastify` (`errorHandler(DomainError)`, `probes(app, readiness)`, `metricsText(lines)`, `jsonParser`) | search/ratelimit | pure helpers, no app factory |

Adoption order (one commit each, tests must stay green with zero behaviour change): ratelimit, geo, search, flags, shortlink (decorator rename kept via alias), audit, media, notify, scheduler, webhook-out, auth, console. Every adoption deletes the local copy, pins `"@alitalipcalikoglu/service-core": "1.0.0"`, and adds `serviceCore` to `/v1/info` (Stage 7 fills the rest of `/v1/info`; the endpoint is introduced here with `service`, `version`, `apiVersion`).

Invariants: byte-identical HTTP responses before/after for every existing test; no new env variables required.

## Stage 3 — Migration standard, backup and restore

Repositories: service-core, every stateful service, stack.

- `Database.migrate()`: before the first pending migration copy the file with the SQLite backup API to `<DB_PATH>.pre-v<N>-<ts>` (configurable `DB_BACKUP_DIR`, disabled for `:memory:`); record each applied migration in `schema_migrations(version, name, applied_at, duration_ms)`; refuse to open when `user_version > MIGRATIONS.length` (`ConfigError: database is newer than this build`); expose `schemaVersion` for `/v1/info`.
- Migration tests in the core: apply from empty, apply from each older version fixture (fixtures generated by the services' own tests: `test/fixtures/db-v<N>.sql`), failure in migration k leaves version k-1 and the pre-copy.
- `stack backup [--dir]`: per stateful service `sqlite3`-free copy via `node:sqlite` backup (`DatabaseSync.backup` where available, else `VACUUM INTO`), plus `media/data/objects`, `media/data/variants`, `auth/keys`, `gateway/routes.json`, `console/services.json`; manifest written with service versions.
- `stack restore <snapshot> [--service]`: stop (PM2) → restore → start → wait `/ready`; refuses when the snapshot's schema version is newer than the code.
- Stack test: backup → mutate → restore → verify on temp copies of each service DB (uses each service's `Database` through the core).
- Docs: `stack/docs/UPGRADE.md` (pull → `npm ci` → `stack backup` → start (migrates) → `stack status`; rollback = previous checkout + `stack restore`), per-service README "Backup / restore" and "Rollback limitations: none of the migrations are reversible; restore the pre-migration copy".

## Stage 4 — Auth, audit and console correctness

- **auth outbox**: migration 2 adds `outbox(id TEXT PK, at INTEGER, payload TEXT, sent_at INTEGER)`; `EventStore.record` inserts the outbox row in the same statement batch (inside the caller's transaction when one is open — `Database.transaction` exposes `inTransaction`); `AuditClient` gains `source: 'outbox'` mode: drain loop selects unsent rows, sends, marks `sent_at`, purges after `AUDIT_OUTBOX_RETENTION_DAYS`. Buffered mode stays for other services. Tests: crash between commit and flush (kill the client, restart, event delivered once); rolled-back transaction emits nothing; duplicate drain is idempotent (audit `UNIQUE(source, client_id)` + same `id`).
- **auth roles + client IP trust**: `AUTH_API_KEYS=id:secret[:role[:flags]]` with roles `read`/`write`/`readwrite` (default readwrite, compatible) and flag `proxy` allowing `X-Client-IP`; keys without `proxy` get `request.ip`. Tests: non-proxy key cannot spoof IP; read key cannot register.
- **console**: outbox mode for the forwarder (same core code); TOTP secrets sealed with `SecretBox` under `SECRETS_KEY` (migration re-seals existing rows at first start; `SECRETS_KEY` required only when TOTP rows exist or on enrol — startup error message explains). Tests: seal/unseal round trip, migration of plaintext rows.
- **audit anchors**: `ANCHOR_PRIVATE_KEY_PATH` (Ed25519 PEM, `npm run anchor-keygen`) and `ANCHOR_INTERVAL_MIN`; `anchors(seq, hash, at, signature)` table written by `Maintenance`; `GET /v1/chain/anchors`, `GET /v1/chain/anchors/latest`, `GET /.well-known/audit-anchor-key` (public key); `verify` checks every anchor in range against the recomputed hash and the signature; optional `ANCHOR_WEBHOOK_URL` posts each anchor (fire-and-forget through the core `HttpCaller`) so an external system keeps its own copy. Tests: modified event, removed event, reordered pair (swap `at`/payload of two rows), forged anchor, purge then verify from checkpoint, anchor key rotation (previous public key path).
- **audit durability contract**: README states WAL + `synchronous=NORMAL` semantics and the single-writer rule; `AUDIT_SYNCHRONOUS=FULL` option for operators who need it.

## Stage 5 — Ratelimit backend contract

- `domain/counter-backend.js`: interface (JSDoc typedef + abstract class) `checkAndConsume(checks, now, { peek })`, `release(policy, subject, limits, consumedAt, cost)`, `reset`, `top`, `activeSubjects`, `cleanup`, `decide`, `series`, `totals`. `SqliteCounterBackend` wraps today's `CounterStore` + the transaction (moved out of `RateLimitService`). `RateLimitService` depends on the interface only.
- `test/backend-contract.test.js`: a suite parameterised by backend factory (window boundaries, concurrent checks via `Promise.all` on an async backend, batch atomicity, release, overrides, cleanup, clock boundaries with an injected clock). Runs against SQLite now; a Redis backend later must pass it unchanged.
- `release` fix: accepts `consumedAt` (ISO, default now) and decrements the window containing that instant; documented.
- Clock: README "Clock model" (server monotonic wall clock, skew between gateway instances irrelevant because the service owns time; NTP recommended; window edges computed from epoch multiples).
- Deployment doc: class B; "multiple gateways, one ratelimit" is the supported topology; Redis backend listed as the path to class C with the contract suite as acceptance.

## Stage 6 — Worker runtime separation and leases

Repositories: notify, scheduler, webhook-out (+ core `Lifecycle`).

- Entry points: `src/api-main.js`, `src/worker-main.js`, `src/index.js` keeps running both (default, compatible). `package.json`: `npm run api`, `npm run worker`; `ecosystem.config.cjs` gains two optional apps (`<name>-api`, `<name>-worker`) documented as the split deployment; the combined app stays the default.
- API without worker: `/ready`, `/stats`, `/metrics` read worker state from the DB (in-flight = rows in `running`, plus a `worker_heartbeat(instance, seen_at)` table) instead of the in-process object.
- Leases: `runs.lease_until` (scheduler), `deliveries.lease_until` (webhook-out) via migration; claim sets `lease_until = now + timeout + grace`, the worker refreshes it every `LEASE_REFRESH_MS` while a call is in flight, the loop (not only `recover()` at start) settles rows whose lease expired as a failed attempt `lease expired`. `recover()` at start only touches rows with expired leases → a second process no longer steals in-flight work; the docs still say single node until a claim contention test exists.
- Shutdown order via `Lifecycle`: stop claiming → stop HTTP intake → drain in-flight within `DRAIN_MS` → flush audit → close DB; force-exit and PM2 `kill_timeout` derived from `max(call timeout) + drain grace`; scheduler `MAX_TIMEOUT_MS` bounded (≤ 600 000).
- notify: rolling pool (`inFlight` set like the others) instead of `Promise.all` batches; `LOCK_TTL_MS ≥ SMTP socket timeout` enforced in config; `Buffer.equals` → `timingSafeEqual`; idempotent replay with a different payload → 409 `IDEMPOTENCY_CONFLICT`.
- webhook-out: purge excludes events that still have pending/retrying deliveries; publish catches the UNIQUE violation and returns the existing event.
- Tests (each of the three): crash after claim (kill + restart → retried once), crash after remote 2xx before local commit (documented duplicate, asserted `attempt = 2`, receiver sees same id), duplicate delivery id stability, retry exhaustion, `stop()` with in-flight (drained, nothing left `running`), stale lease recovery in-loop, API-only process readiness, worker-only process readiness.

## Stage 7 — Boundaries and versioning

- `/v1/info` completed everywhere: `capabilities` list (e.g. auth `["jwks","refresh","password-reset"]`, webhook-out `["replay","rotate","test"]`), `schemaVersion`, `serviceCore`. Console: "About" line per service; `stack status --matrix` prints versions and flags mismatched `serviceCore` majors. No startup checks.
- notify webhook channel: README and examples mark it "legacy signed webhook for one-off calls"; new integrations directed to webhook-out; no removal. A `NOTIFY_WEBHOOK_CHANNEL=false` switch lets operators turn it off (default true, compatible).
- Boundary statement per README (Purpose / Responsibilities / Non-responsibilities) using the final target list from the review.

## Stage 8 — Media storage abstraction and secret grace

- `storage/storage.js`: `Storage` interface (`prepare`, `check`, `writeTemp`, `commit`, `exists`, `open`, `remove`, `writeAtomic`, `stat`); `LocalStorage` implements it; `MediaService` typed against the interface; `Application` picks by `STORAGE_DRIVER=local` (only value today). No S3 implementation; the interface plus a contract test (`test/storage-contract.test.js`) is the deliverable.
- `SIGNING_SECRET_PREVIOUS`: `UrlSigner` verifies with both, signs with current.
- Variant generation stays request-time; README documents the per-process dedupe and the single-node class; `MAX_CONCURRENT_VARIANTS` guard (semaphore) so a burst of first-time variant requests cannot exhaust CPU.

## Stage 9 — Gateway resilience and telemetry

- `policy.failOpen` required when `policy` is set (validation error names the route); generated `routes.json` from stack shows both examples. Public/anonymous routes with `subject:'ip'` and `failOpen:true` log a warning at startup.
- `traceparent` generation/propagation (Stage 1 convention) and `x-upstream-latency` in access logs; metrics `gateway_upstream_latency_ms` histogram per route.
- Breaker: `UpstreamPool` gains failure counting with threshold + half-open probe (one request allowed after cooldown; success resets, failure extends) — deterministic, injected clock, tests for open/half-open/closed transitions and for "all down → try anyway".
- Routes reload: `SIGHUP` re-reads `routes.json`, validates, swaps `RouteTable` and pools atomically; on error keeps the old table and logs (`/v1/info` reports `routesRevision` = file mtime + hash). Tests: bad file keeps serving; good file switches without dropping in-flight requests.
- No split of `proxy.js` (213 lines, single responsibility: transport); header policy already lives in two named functions.

## Stage 10 — Service-specific fixes

- shortlink: conditional increment `UPDATE links SET clicks = clicks + 1 … WHERE code = ? AND (max_clicks IS NULL OR clicks < max_clicks)`, `changes = 0` → exhausted; concurrency test with two processes on one temp file; README states exact semantics.
- flags: `Evaluator` in `src/domain/evaluator.js` kept dependency-free and published as `examples/evaluator.js` + `examples/golden-vectors.json` (500 vectors: salt, id, percentage → bucket/decision); tests load the vectors; `examples/snapshots.md` uses the same file.
- webhook-out: optional `ordered: true` per subscription (serial deliveries per subscription, best-effort order, documented), per-subscription in-flight cap.
- geo: bounds-checked MMDB decoder (every read checks `offset + n <= buf.length`, throws `MmdbFormatError`), load-time validation (decode metadata fully, look up a fixed sample), optional `MMDB_SHA256`/`.sha256` sidecar verification before swap; scheduler-driven update example completed with the checksum step.
- search: readiness doc only (class B, ephemeral counters).
- console: TOTP sealing landed in Stage 4; here: `x-request-id`/`traceparent` forwarding (from Stage 1) verified in tests; `/v1/info` display.

## Stage 11 — Cross-service integration tests (completion)

Flows added to the harness with failure paths: signup with notify down (201 + `verificationEmailSent:false`; the audit event for the signup is independent of notify's own state and is already durable via auth's own outbox — see the Stage 11 report), gateway with ratelimit down on a `failOpen:false` route (503) and `true` route (200 + dependency metric), webhook-out receiver 500 → retry → success and repeated failure → subscription disabled once `DISABLE_AFTER_FAILURES` (default 10, operator-configurable; earlier drafts of this plan said "5×" — that number was never the real default and the Stage 11 tests exercise the actual configured threshold) consecutive terminal failures are reached, scheduler target timeout → retry → run failed, media upload then purge then download 404, flag update → snapshot ETag changes → evaluate reflects it, ratelimit policy edit while checks run. Runs in CI of `stack` only when `STACK_INTEGRATION=1`.

## Stage 12 — Stack deployment, upgrade and documentation

- `stack/docs/UPGRADE.md`, `BACKUP.md`, `COMPATIBILITY.md` (matrix generated by `stack status --matrix`), README "Service list" refreshed (already maintained per change), `docs/READINESS.md` links.
- PM2 ecosystem generation for split api/worker apps when `--split-workers` is passed to `stack up`.
- Final pass: every service README has the 16 mandated sections; no marketing language; guarantees stated as in `READINESS.md`.

## Stage reports

Each stage ends with the report format from the review (repositories inspected, files changed, existing behaviour, problems confirmed/not confirmed, decisions, implementation, tests added/executed, results, security/performance/compatibility impact, remaining risks, next stage). Stage 0 starts only after approval of this plan.
