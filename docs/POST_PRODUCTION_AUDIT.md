# Post-production hardening — residual risk audit

Companion to [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (Stage 0–12, approved, not reopened
by this document) and its Stage 12 final report's "Known limitations" section. This audit
independently re-verifies each limitation named there against real current HEAD code — nothing
here is carried forward from that report without its own fresh evidence. Where this audit's
findings differ from what that report implied (in either direction — a risk turning out smaller or
larger than described), the difference is called out explicitly in each section and summarized at
the end.

This is an audit and a plan ([POST_PRODUCTION_PLAN.md](POST_PRODUCTION_PLAN.md)) only. No code was
changed to produce it.

Repos covered: stack, service-core, gateway, notify, auth, media, console, audit, shortlink, flags,
scheduler, webhook-out, search, ratelimit, geo.

---

## 1. Split-worker migration race

**Status: CONFIRMED (empirically reproduced). Severity: correctness (bounded — crash, not data
loss). Priority: P1.**

### Evidence

`service-core/src/db.js`'s `#migrate()` (lines 84–107): `PRAGMA user_version` is read **once**,
before any lock is taken and before the migration loop starts. Each migration then runs inside a
plain `BEGIN` (deferred, not `BEGIN IMMEDIATE`) / `COMMIT`. `busy_timeout=5000` is set at connection
open, before `#migrate()` runs. The pre-migration backup (`#backup()`, lines 115–122) writes to
`<DB_PATH>.pre-v<current>-<Date.now()>` — a millisecond-resolution filename.

`notify/src/application.js`, `scheduler/src/application.js`, `webhook-out/src/application.js` all
construct their own `Database(config.dbPath, ...)` unconditionally, regardless of `role`
(`api`/`worker`/`combined`) — nothing arbitrates which of two split processes (`stack up
--split-workers`, `<id>-api` + `<id>-worker`) gets to apply a pending migration first.
`stack/src/stack.js`'s `up()` (lines 57–75) starts both apps back-to-back with no readiness gate
between them.

**Empirical reproduction** (real separate OS processes via `child_process.spawn`, each opening the
service's own real, unmodified `Database` subclass against the same on-disk file — not two
in-process instances sharing a connection): 75 true-simultaneous-start races across webhook-out (3
migrations) and notify (3 migrations).

| Outcome | Count / 75 |
|---|---|
| Both processes succeed | 6 (8%) |
| Exactly one process throws, the other succeeds | 69 (92%) |
| Both processes throw | 0 |
| **Final DB state inconsistent** (wrong `schemaVersion`, missing/duplicate `schema_migrations` rows, lost/duplicated data) | **0 / 75** |

Loser errors (all real `ERR_SQLITE_ERROR`): `table schema_migrations already exists`, `duplicate
column name: owner_token` (a non-idempotent `ALTER TABLE` re-run), `database is locked`, `output
file already exists` (the predicted backup-filename collision, confirmed live).

A narrower isolation test — racing only the very first statement of `#migrate()`
(`CREATE TABLE IF NOT EXISTS schema_migrations`, ostensibly idempotent) — still produced
`database is locked` in 19/40 runs. `SQLITE_LOCKED` (WAL-mode schema-lock contention) is not
retried by the busy handler the way `SQLITE_BUSY` is, so `busy_timeout` does not fully protect this
path. The race is not confined to "non-idempotent DDL re-run" as originally framed — the very first
line of `#migrate()` is itself a race point.

### What this means in practice

The losing process's `Database` constructor throws; only `ConfigError` is caught in each service's
`fromEnv()`, so the process crashes. Under PM2 (`autorestart: true`, `exp_backoff_restart_delay:
200`, `max_restarts: 20`), it restarts ~200ms later, re-runs the constructor, sees `user_version`
already current, and starts cleanly. **In every one of the 75 real runs, the end state was a
correct, consistent database and exactly one clean process running — never corruption, never
duplication, never data loss.** The blast radius is a visible crash-and-restart during a
split-workers upgrade that includes a pending migration, not a durability incident.

`stack/docs/UPGRADE.md`'s "Worker-split rollout ordering" section (written during Stage 12) already
documents this risk and gives a staggered-start workaround. That documentation is accurate and does
not overstate or understate what this audit found — it was already honest about "not proven safe,"
and this audit now has the empirical evidence for exactly what "not safe" means (a clean crash, not
corruption) and how often it triggers under a true simultaneous start.

### Recommended fix (design only, not implemented)

Using only existing SQLite primitives, no new dependency:
1. Change `BEGIN` to `BEGIN IMMEDIATE` in `#migrate()` — acquires SQLite's write lock at transaction
   start, so a second process's own `BEGIN IMMEDIATE` blocks until the first's migration transaction
   commits (or rolls back), rather than racing to run DDL concurrently.
2. Move the `current = this.schemaVersion` read inside the loop, re-read fresh **after** each
   `BEGIN IMMEDIATE` acquires the lock. If the freshly-read version already covers this iteration's
   target, skip it (`ROLLBACK`/no-op) instead of re-running the migration SQL — this is the
   "blocked, then discovers nothing left to do" pattern, not "blocked, then races anyway."
3. The backup-filename collision needs the same treatment: either take the backup only after the
   fresh re-check confirms a migration is actually still pending (inside the same guarded section),
   or give the backup filename a collision-proof suffix (e.g. a PID or random component) so a
   would-be-skipped process never even attempts a duplicate `VACUUM INTO`.

### Tests required before this ships
- A deterministic failing regression: the same real two-process reproduction methodology used for
  this audit (not a mock), run against `service-core` directly, proven to fail before the fix and
  pass after, at a sample size large enough to be meaningful (the audit used 75 runs at ~92% trigger
  rate for the crash case — the regression test doesn't need that many runs every time it's in CI,
  but should run enough iterations to catch a regression with reasonable confidence, and should be
  tagged/skippable the same way `STACK_INTEGRATION` gates expensive tests today if it's slow).
- Full `service-core` suite + typecheck.
- Full suite + typecheck for notify, scheduler, webhook-out (the only real consumers of
  `Database.MIGRATIONS`-based multi-migration schemas among the split-capable services).
- `stack/docs/UPGRADE.md`'s "Worker-split rollout ordering" section updated to reflect the new real
  guarantee (or left as a documented limitation, if the fix is deferred — see the plan).

---

## 2. Migration HTTP E2E coverage gap

**Status: CONFIRMED. Severity: observability/operability (test-coverage gap, not a runtime defect).
Priority: P1.**

### Evidence

No test in any of the 8 repos audited spawns a real service process against an old-schema fixture
and asserts `/ready` + `/v1/info`'s `schemaVersion` after a real startup-triggered migration. Every
existing migration test (`service-core/test/db.test.js`, and each service's own `test/db.test.js`)
opens the `Database` class directly in the test's own process — real migration logic, but not a real
process boundary. `stack/test/integration/harness.js`'s `ServiceProcess` (real `spawn`, real `/ready`
poll) already exists and is used for cross-service flows, but no integration test currently builds
an old-schema fixture and points a spawned service at it.

Future-schema rejection is similarly only covered in-process (`service-core/test/db.test.js`,
`stack/test/snapshot.test.js`'s restore-path validation) — never via a real spawned process that's
expected to exit non-zero / never reach ready.

### Recommended fix (design only)

Build on `stack/test/integration/harness.js`'s existing `ServiceProcess`:
- Old-schema E2E: construct a fixture DB via the service's own real `Database` subclass with a
  truncated `MIGRATIONS` array (matching an older version), point a spawned real service's `DB_PATH`
  at it, assert `/ready` reaches 200 and `/v1/info.schemaVersion` reports the FULL current
  `MIGRATIONS.length` after startup, and assert pre-seeded data survived.
- Future-schema E2E: a fixture DB with `user_version` bumped past `MIGRATIONS.length`, assert the
  spawned process never reaches ready within a bounded timeout (and, if practically observable,
  that it exited non-zero) — and that the fixture file itself is untouched afterward.
- Representative services (per the task's own list, confirmed reasonable given real schema
  histories): notify (schemaVersion 3), console (2), webhook-out (3), auth (2).

**Closed in Phase 2** (`stack/test/integration/migration-e2e.test.js`): the finding above and its
recommended design stand as originally written — this note only records that the plan's Phase 2
implemented it, plus audit (v1→v2) as a fifth representative service. Both directions from the
recommended fix are covered: old-schema fixture with pre-existing domain data → real spawned process
→ `/ready` → `/v1/info.schemaVersion` → data still readable through the real API, for all five
services; and future-schema fixture → real spawned process never reaches ready and the file is
provably untouched, for notify (split-capable) and auth (normal).

---

## 3. Media manual maintenance/purge control

**Status: CONFIRMED (feature gap; underlying purge mechanics already safe). Severity: operability.
Priority: P2.**

### Evidence

`media/src/maintenance.js`: `INTERVAL_MS = 3_600_000` is a hardcoded static field, no env override
anywhere (`media/src/config.js`, `.env.example` both confirmed to have zero `INTERVAL`/`MAINTENANCE`
vars). Triggers are exactly two: the hourly `setInterval`, and one eager run at
`Application#start()`. No HTTP route, no CLI, exists anywhere in this codebase for triggering
another process's maintenance work on demand — grepped every service's `src/http/*.js` for
`maintenance|purge`, zero hits outside media's own internal call.

`MediaService#purge()` (`media-service.js:436-456`) is **idempotent by construction**: every step is
a plain SQL predicate (`WHERE deleted_at < ?`, `WHERE delete_token IS NULL`) or a CAS delete
(`DELETE FROM blobs WHERE sha256=? AND delete_token=?`) — a second concurrent or sequential call
matches zero rows and no-ops, never errors, never double-acts. `Maintenance#run()` additionally
provides a free in-process dedup guard (`this.running` promise) that a manual trigger could piggyback
on. `ecosystem.config.cjs` pins `instances: 1`, so cross-process concurrency for media isn't a real
deployment concern to design around.

Media's API-key model is deliberately flat — `id:secret` only, no role concept (confirmed:
`parseApiKeys` called without a `roles` option, unlike scheduler which opts in). The closest prior
art in this codebase is scheduler's `POST /v1/jobs/:name/run` (a `write`-role-gated manual trigger
for a different kind of background work), gated by a role media has never had.

`Maintenance#run()` never touches `LocalStorage#prepare()` (the destructive `tmp/`-wiping call from
Stage 0's readiness fix) — only `Application#start()` calls `prepare()`, once. A manual trigger that
calls `Maintenance#run()` is the identical code path the hourly timer already uses; it structurally
cannot reach `prepare()`.

`purge()` already returns `{ files, blobs, tickets }` counts internally but per-item errors during
the detach/discard loop are caught, logged, and silently discarded from the return value today.

### Recommended fix (design only)

`POST /v1/maintenance/run` on media, under the existing flat API-key model (introducing a role
concept just for this one route would be a larger, disproportionate change — flagged as a judgment
call: the plan proposes NOT adding roles to media, matching its established convention, but this is
worth the user's explicit sign-off since it means any valid media API key could trigger maintenance,
not just a hypothetical "admin" one). The handler calls `Maintenance#run()` (not `service.purge()`
directly), so a manual trigger racing the hourly timer is folded into the same in-flight run via the
existing dedup guard — no new lock table needed. Response surfaces the existing `{files, blobs,
tickets}` counts plus a new `errors` count (currently discarded, would need one line to accumulate
instead of swallow).

---

## 4. Media trash reconciliation

**Status: CONFIRMED real leak window; proven harmless to live correctness. Severity: operability
(disk space only). Priority: P2.**

### Evidence

`local-storage.js`'s `detachForDelete()`/`discardDetached()` are two separate `await`ed filesystem
operations with no persisted record between them (`token` is a local `randomUUID()`, never written
to SQLite). A process kill between them is a real, reachable window — already independently
documented as an accepted, known gap in `media/docs/READINESS.md`'s "Known failure modes" section
before this audit began (this audit confirms the documentation was already accurate, not
discovering a hidden problem).

Confirmed from code order: `purge()`'s blob-row deletion (`finalizeOrphanBlobs()`, a CAS delete) runs
to completion **before** the loop that calls `detachForDelete` even starts — so anything that ever
reaches `trash/` is, by construction, already unreferenced by any live DB row. A reconciler sweeping
`trash/` can never orphan a row that still needs its bytes.

Re-upload-after-detach is a real possible sequence (a sha256 could be re-uploaded after its old blob
was detached-to-trash but before discard), but `detachForDelete` uses `rename()` and a later
`commit()` uses `link()` to create a structurally independent directory entry at the canonical path —
different inode, different path, from the moment of detach onward. Deleting a stale trash entry can
never shadow-delete a live re-uploaded file at the canonical path; they are unconnected once the
rename has happened.

### Recommended fix (design only)

A reconciliation sweep piggybacked on the same `Maintenance#run()` trigger (both the hourly timer
and the manual endpoint from item 3) rather than a new separate timer. Uses file **mtime**, not a new
DB table, for crash-safe age tracking — reasoned as follows: anything in `trash/` is already
unreferenced garbage by the time it exists (per the code-order finding above), so tracking it in
SQLite would mean recording the existence of garbage, contradicting this codebase's
SQLite-source-of-truth-for-live-state convention; a new "detach in progress" tracking table would
just relocate the identical crash-window problem one level up (a crash between writing the tracking
row and the rename is the same class of bug). A short grace period (order of minutes, unrelated to
`DELETE_GRACE_DAYS`, which is a different, file-soft-delete concept) protects only against
reconciling a `trash/` entry whose two-part rename (`object`/`variants`, run via `Promise.all`, not
atomic as a pair) is still mid-flight. Malformed/unrecognized entries in `trash/` (not matching the
`<token>.object`/`<token>.variants` naming pattern, already defined via `local-storage.js`'s
`TOKEN_RE`) must be skipped with a logged warning, never deleted blindly — matching `purge()`'s own
existing fail-safe-per-item convention.

If `stack backup`'s exclusion list for media (`tmp/`, `trash/`) changes as a result of adding
reconciliation, `stack/docs/BACKUP.md` needs a corresponding update — but reconciliation itself
doesn't change what's excluded, only how fast `trash/` gets cleaned, so no BACKUP.md change is
actually anticipated here.

---

## 5. Backend trace consumption

**Status: CONFIRMED gap, with material corrections to how it was previously described. Severity:
observability only (no correctness/security impact from the current state). Priority: P2 (real
value, genuinely new scope, needs one explicit policy decision before implementation).**

### Corrections to the prior framing

- **Console does not parse or validate an inbound `traceparent` at all** — it has no regex, no
  `parse()` method (`console/src/trace-context.js`, full file read, confirmed). Only gateway does
  (`gateway/src/trace-context.js`). "Both generate/parse" overstated console's half; console only
  generates/forwards, by deliberate design (it's a trust boundary reached directly by browsers,
  documented accurately in `stack/docs/OBSERVABILITY.md`).
- **`service-core` has no `RequestContext`/traceparent primitive today.** It appears only as planned
  Stage 2 scope in `stack/docs/IMPLEMENTATION_PLAN.md`/`ARCHITECTURE_AUDIT.md` — never built. Confirmed
  no `context.js` exists in `service-core/src/`.
- **`X-Request-Id` handling is not centralized either**, contrary to an assumption in this task's own
  framing: it's 11 near-identical hand-copied two-line Fastify config blocks
  (`requestIdHeader`/`genReqId`), one per backend service, plus gateway's and console's own
  independently-written trust-boundary-aware variants.

### Evidence for the internal-vs-external forwarding question

Auth's calls to notify (`mailer.js`) and to audit (`AuditClient#send`) are fixed, env-configured peer
URLs (`NOTIFY_URL`, `AUDIT_URL`) — not operator/caller input. Scheduler's and webhook-out's outbound
calls go to arbitrary, operator-configured target URLs (a scheduled job's `Target.url`, a webhook
subscription's `url`) — `NetGuard`'s `allowPrivate` option is per-instance operator configuration, not
a reliable internal/external classifier, since an operator could legitimately point either at an
internal atc-web peer too.

**Recommendation (flagged explicitly as a judgment call needing the user's confirmation, not settled
fact):** forward `traceparent` only at call sites using a fixed, env-configured peer URL (auth→notify,
any-service→audit) — never to an arbitrary/operator-configured target (scheduler job targets,
webhook-out subscriber URLs), to avoid leaking internal trace/span identifiers to a third party who
could use them to correlate or spoof against internal systems.

### What already exists vs. genuinely new

Reusable as-is: `HttpCaller.send()` takes a plain `headers` object (one-line addition per forwarding
call site); the `AsyncLocalStorage`-based context-carrying pattern console already uses
(`console/src/services/client.js`) generalizes cleanly with no console-specific technical constraint
(only a policy constraint — console never populates it from a parsed inbound header, by design).

Genuinely new: the shared `TraceContext` class itself (merging gateway's validated `parse()` with
console's `span()`), a shared `AsyncLocalStorage` context helper in `service-core`, and per-service
adoption (~10–15 lines each across the 11 backend services, plus one addition inside
`service-core/src/audit-client.js` for the audit-forwarding hop, benefiting every adopter at once).

### Metric-label cardinality

Confirmed **preventive-only, not an existing bug**: zero `.labels(` usages anywhere in the codebase
today; the one real metrics module (`gateway/src/metrics.js`) already has an explicit
anti-high-cardinality design comment and uses only bounded dimensions (`route`, `upstream`,
`status`). The plan should state this as a constraint to preserve, not a defect to fix.

---

## 6. Gateway breaker state limitation

**Status: NOT A GAP — ACCEPTED ARCHITECTURAL LIMITATION, already correctly and thoroughly
documented. Severity: n/a. Priority: none — no action recommended.**

### Evidence

The breaker (`gateway/src/upstream-pool.js`) genuinely holds state process-locally (plain instance
fields, no shared store) — confirmed. But gateway's own scaling class is **A**, and class A is
explicitly *defined* (`stack/docs/ARCHITECTURE_AUDIT.md`, `stack/docs/READINESS_TEMPLATE.md`) as
"any number of instances behind a load balancer, no shared-state assumption, name anything that is
still per-instance" — the opposite of "single-instance only." `gateway/ecosystem.config.cjs:15`'s own
comment explicitly invites running multiple instances behind a TCP balancer and names the exact
per-process state (rate limits, cooldowns — the breaker) that stays per-instance. `gateway/README.md`
and `gateway/docs/READINESS.md` both independently state this same trade-off, by name, as accepted
non-defect behavior — satisfying (and exceeding) what the class-A template itself requires services
to disclose.

Nothing in `stack` tooling can ever start more than one gateway process today (`stack/src/manifest.js`
carries no `splitWorkers` for gateway, `Stack#up()` runs exactly one `pm2 startOrRestart` per
service) — but this is incidental, not a stated contract; an operator raising `instances:` by hand
(exactly as the ecosystem file's own comment suggests) is a legitimate, already-anticipated use.

**Verdict: this is not something to code around, and the documentation already meets the bar the
project's own template sets for a class-A service. No change recommended in either code or docs.**

---

## 7. Audit anchor key backup gap

**Status: CONFIRMED. Severity: durability (of the anchor cryptographic-continuity feature, not of
the platform's core data). Priority: P1 (mechanically trivial, real value).**

### Evidence

`stack/src/snapshot.js`'s `EXTRA_PATHS` includes `auth: () => ['keys']` (JWT signing keys) but has
**no entry for audit** — `audit`'s `ANCHOR_PRIVATE_KEY_PATH`-configured key material is never part of
a `stack backup` snapshot. `audit/README.md`'s own "Backup / restore" section already states this gap
explicitly and accurately, in wording that matches `stack/docs/BACKUP.md`'s (Stage 12) description of
the same gap — **the two documents are consistent with each other, not drifted**; this audit confirms
they already tell the truth about the current state, they just describe a real limitation rather than
a documentation bug.

Rotation semantics: `ANCHOR_PRIVATE_KEY_PATH` (required for the anchor feature) plus an optional
`ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` for a rotation grace window — directly analogous to auth's
`JWT_PRIVATE_KEY_PATH`/`JWT_PREVIOUS_PUBLIC_KEY_PATH`. The running service always re-derives its
current public key from the private key in memory (never reads a separate public-key file back), so
only the **private** key file (plus, during a rotation window, the previous **public** key file,
whose own private counterpart is already gone) is genuinely irreplaceable.

Security consideration (a posture judgment for the user, not something this audit resolves
unilaterally): no code/architecture reason was found to treat the anchor private key as categorically
more sensitive than the JWT private key already backed up today — both are "this service can produce
cryptographically valid artifacts a downstream party trusts." One real asymmetry worth naming: a
compromised JWT key has *immediate* blast radius (arbitrary authentication); a compromised anchor key
has *retrospective/reputational* blast radius (forged tamper-evidence for the audit chain) — different
in kind, not obviously different in whether it belongs in an already-encrypted-at-rest-adjacent
backup snapshot the same way the JWT key already does.

Mechanical cost: `Snapshot`'s directory-handling, checksum, and restore-validation logic is already
fully generic over any `EXTRA_PATHS` entry (auth/media/console/gateway all already share it) — adding
`audit` requires one new map entry, ideally env-derived (mirroring gateway's pattern, since
`ANCHOR_PRIVATE_KEY_PATH` is optional) rather than hardcoded (mirroring auth's, since auth's keys are
mandatory), no restore-path changes.

### Recommended fix (design only)

Add an env-derived `audit` entry to `EXTRA_PATHS` in `stack/src/snapshot.js`, returning the anchor
key directory only when `ANCHOR_PRIVATE_KEY_PATH` is actually configured (an empty array otherwise —
`Snapshot.create()` already logs-and-skips any path that doesn't exist, so even a naive hardcoded
entry would degrade gracefully, but the env-derived form is more correct and consistent with
gateway's existing optional-feature pattern). Update `stack/docs/BACKUP.md` and `audit/README.md`
from "excluded, back this up yourself" to "included" language. Test: create a real anchor, back up,
mutate both DB and key material, restore, verify the pre-existing anchor still verifies and a new
anchor signs under continuous chain semantics.

**Closed in Phase 3** (`stack/src/snapshot.js`'s `EXTRA_PATHS.audit`, `stack/test/snapshot.test.js`,
`stack/test/integration/audit-anchor-continuity.test.js`): the finding and recommended fix above stand
as originally written — re-verification during implementation found the recommended design needed two
refinements the audit's design-only sketch didn't anticipate: (1) a configured-but-missing key file is
treated as a fatal backup error, not a graceful skip, matching `AnchorSigner.fromFiles`'s own
startup-refusal contract, since a naive skip here would silently produce an incomplete snapshot; (2) a
configured path resolving outside the audit service folder is excluded with a loud warning rather than
followed, a security boundary the design-only sketch didn't consider. Both the private key and, when
configured, the previous public key are included — not just the private key, since historical anchor
verification depends on whichever public key actually signed a given anchor. A pre-existing,
unrelated gap in the shared `#copyFile` primitive (no permission-bit preservation, affecting `auth`'s
JWT keys too, not just audit's addition) was found and fixed in the same phase.

---

## 8. At-least-once duplicate windows

**Status: CONFIRMED crash windows real at every site checked; but every site already has a stable,
retry-persistent identifier a well-behaved receiver could dedupe on — this is a documentation gap,
not a missing mechanism, at 3 of 4 sites. Severity: durability (contract clarity, not an active
defect). Priority: P2 (trivial, low urgency).**

### Evidence, per site

| Site | Crash window | Stable identifier across retries | Classification |
|---|---|---|---|
| webhook-out delivery | confirmed (`worker.js` awaits the HTTP call, then `deliveries.finish()`) | `X-Webhook-Delivery` (+`X-Webhook-Id`) — same value every retry | documentation only |
| notify webhook channel | confirmed, same pattern | `X-Notify-Id` — same value every retry | documentation only |
| notify SMTP/email | confirmed, and already explicitly noted in-code (`queue.js:268-271`) | `X-Notify-Id` exists only inside the mail content, not a protocol-level dedup hook | **accepted architectural limitation** — SMTP itself gives no server-side dedup mechanism to attach to; no additive fix proposed |
| scheduler HTTP targets | confirmed, same pattern | `X-Scheduler-Run` — already injected on every attempt, same value every retry; custom operator headers cannot collide (`x-scheduler-` prefix reserved) | documentation only |
| auth → audit outbox | n/a (reference pattern) | outbox row's own stable UUID, deduped receiver-side via `UNIQUE(source, client_id)` before insert | already best-practice — no changes; this is the calibration example the other sites are compared against |

In every "documentation only" case, retries reuse the identical identifier and payload — no new id
is minted on retry, so nothing here currently defeats a receiver's own dedup attempt; the header is
simply never stated, in the relevant service's own README, to be stable across retries of the same
logical delivery/message/run.

### Recommended fix

One sentence each, added to `webhook-out/README.md`, `notify/README.md`, and `scheduler/README.md`'s
existing "Security notes" sections, stating the relevant header is stable across every retry attempt
of the same delivery/message/run and can be used by a receiver for its own dedup. No code change. The
SMTP limitation gets a documentation note describing it honestly as out of notify's control, not a
promise of a fix.

---

## Summary: corrections to the prior report

1. **Migration race is real** — confirmed empirically, not merely theorized — but its actual
   consequence (a clean crash-and-restart, zero data corruption across 75 real runs) is narrower and
   better-bounded than "not proven safe" alone communicated. Priority raised from "documented
   limitation" to **P1, recommended for an actual fix**, because the fix is small, uses only existing
   primitives, and the empirical evidence makes the fix's correctness easy to verify.
2. **Gateway breaker "limitation" is not a limitation at all** — it's already-correct, already
   sufficient documentation of an intentionally-supported (not merely tolerated) deployment
   trade-off. Downgraded from "known limitation to track" to **no action needed**.
3. **Backend trace consumption's starting assumptions were wrong in two ways**: service-core has no
   existing primitive to extend (it's unbuilt, not underused), and console doesn't parse inbound
   traceparent at all (only gateway does) — the real scope is larger (genuinely new shared code, not
   an extension of something that already exists) but also more precisely bounded once the
   internal-vs-external forwarding question is answered.
4. **Media purge/trash risks are real but already provably safe at the mechanism level** — `purge()`
   is idempotent by construction, and anything reaching `trash/` is by code-order construction always
   already unreferenced. What's missing is purely operator convenience/observability and disk hygiene,
   not correctness.
5. **At-least-once duplicate windows are, in 3 of 4 sites, already solved at the identifier level** —
   the gap is that the contract was never written down for receivers to rely on, not that the
   identifier is missing.
6. **Audit anchor key backup gap is real, already honestly self-documented, and cheap to close** —
   confirmed as accurately described already, with a near-zero mechanical cost to actually fix rather
   than merely continue documenting.

No finding in this audit surfaced an ACTIVE data-loss, corruption, or security incident occurring in
normal current operation. Every CONFIRMED risk is either already safely bounded (migration race,
media purge/trash) or a documentation/observability gap (trace consumption, duplicate-window
contracts) or a small, mechanically cheap fix with no urgency driver beyond "worth doing"
(audit anchor backup).
