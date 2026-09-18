# Readiness index

Each service in this workspace keeps its own `docs/READINESS.md`, filled from
[READINESS_TEMPLATE.md](READINESS_TEMPLATE.md) — the 19-section production-readiness contract this
platform holds every service to. This page is only an index into those 13 documents, with one real
line pulled from each. It is not itself a readiness claim.

`stack` (this repo) and `service-core` (a library, not a running service — it has no `/health`,
`/ready` or database of its own to document) have no `docs/READINESS.md`; every one of the 13
services that actually runs as its own process does.

**`/ready` vs. "production-ready".** `GET /ready` is one HTTP endpoint: a cached, read-only check of
that one service's own dependencies (its database, and for a couple of services one synchronous
upstream — see [OBSERVABILITY.md](OBSERVABILITY.md#health-and-ready)). It answers "is this instance
currently able to do its job", nothing more. "Production-ready" as used in this project (see
`CLAUDE.md`'s "no TODOs or deferred work") is a much broader claim — config validation, auth, error
handling, graceful shutdown, tests, a Dockerfile, a README — and each service's own
`docs/READINESS.md` is where that broader claim is actually backed by file/line citations, section by
section, including its known failure modes. This index links to that real documentation; it does not
assert that everything described there is bulletproof — read the linked "Known failure modes"
section of any service before relying on it for something that matters.

| Service | Ready means | Scaling | Process boundary |
|---|---|---|---|
| [gateway](../../gateway/docs/READINESS.md) | every route has at least one upstream passing its own `/health` probe (2s timeout, 15s cache) | **A — stateless, horizontally scalable**; per-instance state not shared: local per-IP limiter, per-instance circuit breaker, geo cache | single process only |
| [notify](../../notify/docs/READINESS.md) | `db.ping()` and every registered channel's `verify()` (SMTP handshake; webhook channel has no real check) | **B — single-node stateful, but "single-node" now means one HOST, not one PROCESS** | API/worker split-capable (`src/api-main.js` + `src/worker-main.js`); message claiming is a single atomic `UPDATE…RETURNING`, proven safe under real cross-connection concurrency |
| [auth](../../auth/docs/READINESS.md) | `db.ping()` and a live call to notify's `/health` (5s timeout) | **B — single-node stateful**; audit-forwarding buffer and rate limiter are per-instance | single process; uses a durable SQLite **outbox** for audit-forwarding, not the in-memory buffer every other service uses |
| [media](../../media/docs/READINESS.md) | `db.ping()` and `storage.check()` (directory layout exists and is writable) | **B — single-node stateful**; in-process `Map` de-dupes concurrent variant encodes, not a multi-instance guarantee | single process |
| [console](../../console/docs/READINESS.md) | `db.ping()` only — does not check the services it proxies to | **B — single-node stateful**; in-memory login limiter and per-request `AsyncLocalStorage` context | single process |
| [audit](../../audit/docs/READINESS.md) | `db.ping()`, cached 10s | **B — single-node stateful**; append path's correctness relies on one process owning the hash chain | single process |
| [shortlink](../../shortlink/docs/READINESS.md) | `db.ping()`, cached 10s | **B — single-node stateful**, but as of Stage 10 every write path including the redirect/`maxClicks` path is a single atomic SQLite statement, safe across processes sharing one file | single process (`instances: 1` pinned) |
| [flags](../../flags/docs/READINESS.md) | `db.ping()`, cached 10s | **B — single-node stateful**; per-process evaluation cache and counters would diverge across instances | single process (`instances: 1` pinned) |
| [scheduler](../../scheduler/docs/READINESS.md) | `db.ping()`, cached 10s; reports `worker: "running"` or `"stopped"` | **B — single-node stateful, but "single-node" now means one HOST, not one PROCESS** | API/worker split-capable; job-firing and run-claiming proven correct, and throughput/crash-recovery genuinely improved, under real multi-worker concurrency |
| [webhook-out](../../webhook-out/docs/READINESS.md) | `db.ping()`, cached 10s; reports `worker: "running"` or `"stopped"` | **B — single-node stateful, but "single-node" now means one HOST, not one PROCESS** | API/worker split-capable; delivery claiming, per-subscription ordering and the concurrency cap all proven safe under real cross-connection concurrency; `Worker.counters`/audit buffer stay per-process |
| [search](../../search/docs/READINESS.md) | `db.ping()`, cached 10s | **B — single-node stateful**; every write path transactional, but its own search counters are process-local and would diverge across instances | single process (`instances: 1` pinned) |
| [ratelimit](../../ratelimit/docs/READINESS.md) | `db.ping()`, cached 10s | **B — single-node stateful**; the check/consume path is safe under two processes sharing one file (whole read-decide-write sequence in one transaction), but this service isn't run that way today | single process (`instances: 1` pinned) |
| [geo](../../geo/docs/READINESS.md) | `db.ping()` and, when `MMDB_PATH` is set, that the IP database actually loaded | **A for in-memory lookups/reference data, B for place collections**; classified **B** overall because one process owns both | single process |

Three services — **notify, scheduler, webhook-out** — are the only ones in the workspace shipping a
real `src/api-main.js` + `src/worker-main.js` split (confirmed on disk) and `splitWorkers: true` in
[`src/manifest.js`](../src/manifest.js); `stack up --split-workers` generates each one's
`<id>-api`/`<id>-worker` PM2 apps from that service's own `ecosystem.config.cjs` (see
`Stack#generateSplitEcosystem`, `src/stack.js`). Every other service only ever runs its single
combined app.

No gaps found: all 13 services that run as their own process have a `docs/READINESS.md`.
