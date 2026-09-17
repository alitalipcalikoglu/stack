# `<service>` readiness contract

Copy this file to `<service>/docs/READINESS.md` and fill every section from that service's actual
code — the running behavior, not the intended one. Every claim should be checkable against a file
and line in the repository; where a section doesn't apply, say so and why, rather than omitting it.
This document is a contract with operators and with the other services calling this one: it says
what is guaranteed, what is not, and where the edges are.

## Purpose

One paragraph: what this service is for, in terms of what it lets the rest of the platform do.

## Dependencies

Every other service or external system this one calls, and what happens when each is unavailable:
- `<NAME>` (`<ENV_VAR>`): required at startup? optional? what breaks without it, what still works.

## Persistence

Engine, file location (`<ENV_VAR>`, default path), schema (tables/indexes in one line each),
migration mechanism, and what a fresh install versus an upgrade does on first start.

## Health endpoint

`GET /health`: what it checks (if anything), what response it returns, whether it can ever be
slow or fail while the process is otherwise fine.

## Readiness endpoint

`GET /ready`: what it checks, how the result is cached (and for how long), what makes it answer
503, and — this is the one Stage 0 exists to police — whether it is safe to poll: does it ever
mutate state, discard in-flight work, or have a side effect beyond reading current status.

## Graceful shutdown

Signals handled, the exact order of steps (stop accepting new work, drain what, flush what, close
what), the force-exit timeout and where it comes from, and how that compares to the PM2
`kill_timeout` / Docker stop grace period actually configured for this service.

## Resource limits

Body size, batch size, page size, upload size, memory ceiling (`max_memory_restart` or
equivalent) — whatever caps exist and their environment variables.

## Timeouts

Every timeout this service applies to its own work and to calls it makes outward: value, default,
environment variable, and what happens when it fires (retry, error, partial response).

## Retry policy

For anything this service retries on its own (queued work, outbound calls): backoff formula,
maximum attempts, jitter or not, and where that logic lives in the code.

## Idempotency

Which operations are safe to repeat (and why: idempotency key, conditional write, natural
idempotence) and which are not (state the risk plainly rather than implying safety that isn't
there).

## Backup

What state needs to survive a disk loss, how to capture it today, and how (`stack backup` once
Stage 3 lands, or a manual command today).

## Restore

The exact steps to bring the service back from a backup, and any ordering constraint with other
services' data (e.g., a database row referencing a file that must come from the same snapshot).

## Metrics

What `/metrics` exposes, which numbers are durable (backed by the database) and which are
per-process counters that reset on restart — label them as such explicitly.

## Logging

Structured fields this service's access/error logs carry today, referencing the vocabulary in
[OBSERVABILITY.md](OBSERVABILITY.md); note any field from that vocabulary this service does not
yet emit.

## Tracing

Whether this service participates in `traceparent` propagation (accepts it, generates it, forwards
it on outbound calls) per [OBSERVABILITY.md](OBSERVABILITY.md), and its trust boundary if any.

## Security model

Authentication (API keys, roles/scopes, cookies — whichever applies), secret rotation support (or
its absence), what is and isn't validated at the boundary, anything explicitly out of scope.

## Scaling model

One of:
- **A — stateless, horizontally scalable**: any number of instances behind a load balancer, no
  shared state assumption. Name anything that is still per-instance (caches, local rate limits)
  even in this class.
- **B — single-node stateful**: one process owns one SQLite file (or equivalent); horizontal
  scaling is not supported today. State why running two instances on the same file would or would
  not be safe, precisely.
- **C — multi-node with shared database**: several instances may point at the same database
  safely; say what specifically makes that true (transaction boundaries, atomic claims) and what
  is still per-instance.
- **D — distributed coordinated worker**: claims/leases/heartbeats make multiple worker instances
  safe to run concurrently against shared state; name the mechanism.

## Single-node / multi-node guarantees

Restate plainly, in one or two sentences, exactly what is and is not guaranteed if the operator
runs more than one instance of this service today. Silence here is a defect in the document, not
a subtle "figure it out from the scaling model" — say it outright.

## Known failure modes

Concrete, currently-true scenarios and their consequence: what happens when the disk fills, when
a dependency times out mid-request, when the process is killed without a graceful shutdown, when
two instances are run against one file despite the guidance above. Cite the file/behavior, don't
speculate about mitigations that don't exist yet.
