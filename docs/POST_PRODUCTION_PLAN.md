# Post-production hardening — implementation plan

Companion to [POST_PRODUCTION_AUDIT.md](POST_PRODUCTION_AUDIT.md). Six phases, dependency-ordered.
Independent risks are kept in separate phases even where that means more phases, per the audit's own
finding that these risks are unrelated in cause and blast radius — bundling them would make rollback
and review harder for no real benefit. Phases that touch nothing but documentation are kept small and
first, since they carry zero behavioral risk and unblock nothing else.

Nothing in this plan reopens `IMPLEMENTATION_PLAN.md` Stage 0–12 or starts a new numbered Stage.

---

## Phase 0 — Documentation-only fixes (no code changes)

**Repos**: webhook-out, notify, scheduler.

**Objective**: close the audit's item 8 (duplicate-window contract clarity) with zero behavioral
risk, and record item 6 (gateway breaker) as a closed non-finding.

**Scope**:
- `webhook-out/README.md` "Security notes": one sentence stating `X-Webhook-Delivery` (and
  `X-Webhook-Id`) stay identical across every retry attempt of the same delivery, so a receiver can
  dedupe on it.
- `notify/README.md` "Security notes": same, for `X-Notify-Id` on the webhook channel; a companion
  sentence noting the email/SMTP channel has no equivalent protocol-level dedup hook and a resend can
  arrive twice in the inbox — an accepted limitation, not a gap being tracked for a future fix.
- `scheduler/README.md` "Security notes": same, for `X-Scheduler-Run`.
- No change to `gateway/README.md`/`docs/READINESS.md` — the audit found the existing text already
  correct and sufficient; nothing to do here beyond noting it closed in the audit trail.

**Invariants**: no code touched; no test behavior changes.

**Required tests**: none beyond each repo's existing suite passing unchanged (a documentation-only
diff cannot affect it, but re-run to confirm nothing else drifted).

**Compatibility impact**: none.

**Rollback implications**: trivial (revert three README diffs).

**Stop condition**: n/a — proceed automatically once reviewed, this phase carries no risk to gate on.

---

## Phase 1 — Split-worker migration race fix

**Repos**: service-core (the fix), notify, scheduler, webhook-out (regression verification only, no
production code changes expected in these three beyond what the fix in service-core already covers).

**Objective**: make a genuinely simultaneous first start of two processes against a database with a
pending migration resolve to exactly one migration application and one clean startup, never a crash,
using only existing SQLite primitives.

**Scope**:
1. `service-core/src/db.js`'s `#migrate()`: change `BEGIN` to `BEGIN IMMEDIATE`; move the pending-
   migration check inside the loop so `user_version` is re-read fresh immediately after the lock is
   acquired for each iteration, skipping (not re-applying) any migration the fresh read shows is
   already applied.
2. Fix the backup-filename collision: take the pre-migration backup only after the fresh
   inside-lock check confirms a migration is still actually pending, or give the backup filename a
   collision-proof suffix — pick whichever keeps `#backup()`'s existing call shape simplest; both are
   small, this audit's job was only to size the problem, not pre-decide between them.

**Invariants**:
- A migration is applied exactly once per pending version, regardless of how many processes race to
  open the database.
- The loser of a race never crashes when a fresh re-check shows nothing pending for it to do — it
  blocks, then proceeds normally.
- No change to migration SQL itself, to `schema_migrations`'s shape, or to the pre-migration backup's
  meaning — only to when/how the check-and-apply sequence acquires its lock and re-validates.
- Single-process (today's default, non-split) startup behavior is unchanged — this fix only changes
  behavior when a real race exists; a single process opening its own database sees identical behavior
  to today, just with `BEGIN IMMEDIATE` instead of `BEGIN` (a strictly more conservative lock, not a
  new failure mode for the common case).

**Expected migrations/API changes**: none — this changes `#migrate()`'s internal locking behavior
only. No new migration is added, no schema shape changes, no public API changes.

**Required tests** (regression-first, per the audit's own reproduction methodology — a mock is not
acceptable here):
1. A deterministic failing regression using real separate OS processes (via `child_process.spawn`,
   mirroring the audit's own reproduction script) that currently fails against unmodified
   `service-core` and must pass after the fix: N real simultaneous-start races (N large enough for
   confidence — the audit used 75 at ~92% trigger rate; a CI-suitable regression can use fewer per run
   but should be run enough times, or with enough internal iterations, to make a regression here hard
   to miss) against at least one real multi-migration service's schema (webhook-out or notify),
   asserting: both processes reach a running state (no crash), the migration applied exactly once,
   final `schemaVersion` and `schema_migrations` are consistent, and pre-seeded data survived
   unchanged.
2. Full `service-core` suite + typecheck.
3. Full suite + typecheck for notify, scheduler, webhook-out (regression only — no functional changes
   expected in these repos, this proves the fix doesn't disturb any of their own migration-adjacent
   tests).
4. `STACK_INTEGRATION=1` full suite (proves nothing in the cross-service integration flows regressed).

**Compatibility impact**: none — this is an internal correctness fix to a mechanism that already had
one defined, documented (if unenforced) contract; no consumer-visible behavior changes for the
non-racing case, which is every deployment today (split-workers races require both apps starting
literally simultaneously with a pending migration, an upgrade-time-only scenario).

**Rollback implications**: a single, self-contained `service-core` change; reverting it reverts
`#migrate()`'s locking to today's behavior (same known, bounded, already-documented risk it has
today — not a new risk introduced by attempting and reverting this fix).

**Stop condition**: if the deterministic regression test cannot be made to reliably fail-then-pass
(i.e. the fix doesn't empirically close the race the same way the audit's own script demonstrated
the bug), stop and re-open the design rather than shipping a fix whose effectiveness isn't proven the
same rigorous way the bug itself was proven.

---

## Phase 2 — Migration HTTP E2E test coverage

**Repos**: stack (new integration tests), notify, console, webhook-out, auth (fixture data only, no
production code changes).

**Objective**: close the acceptance gap named in Stage 12's own final report and re-confirmed by this
audit — prove the full production migration path (real process, real startup, real `/ready`, real
`/v1/info`) for both the normal upgrade case and the forward-version refusal case.

**Scope**: new test file(s) under `stack/test/integration/`, built on the existing
`ServiceProcess`/`freePort`/`waitUntil` harness (no new harness primitives expected to be needed —
confirm during implementation, add only if a genuine gap is found):
1. **Old-schema → real migration → ready → schemaVersion**, for notify (v2→v3), console (v1→v2),
   webhook-out (v2→v3), auth (v1→v2): construct a fixture DB via that service's own real `Database`
   subclass with a truncated `MIGRATIONS` array, pre-seed one distinguishable row, point a spawned
   real process's `DB_PATH` at it, assert `/ready` reaches 200, `/v1/info.schemaVersion` reports the
   service's full current `MIGRATIONS.length`, and the pre-seeded row is intact and correctly
   readable through the service's own real API afterward (not just present in the raw DB file).
2. **Future-schema → real process refuses to start → data untouched**: at least one representative
   service (webhook-out or notify, whichever schema history make this cleanest to fixture), a DB with
   `user_version` bumped past `MIGRATIONS.length`, spawn the real process, assert it never reaches
   `/ready` within a bounded timeout and that the fixture file's `user_version` and content are
   unchanged afterward (proving the refusal is truly a no-op, not a partial/corrupting attempt).

**Invariants**: this phase adds tests only — no production code in any of the four services changes.
If Phase 1 has landed by the time this phase runs, these new E2E tests incidentally also serve as an
additional real-process-level regression witness for Phase 1's fix; if Phase 1 hasn't landed yet, this
phase's tests still stand on their own and don't depend on it.

**Required tests**: the new tests themselves (must pass); full `stack` suite (plain and
`STACK_INTEGRATION=1`) to confirm nothing else regressed; no other repo's test suite is expected to
change since no production code changes there.

**Compatibility impact**: none — test-only change.

**Rollback implications**: trivial (new test files only, no production code to revert).

**Stop condition**: if constructing a truncated-`MIGRATIONS` fixture for any of the four target
services turns out to require touching that service's own production code (it shouldn't — the
`Database` subclass's `MIGRATIONS` array is already a static field a test can subclass or slice
against), stop and reconsider before doing so; this phase must stay test-only.

**Implemented**: `stack/test/integration/migration-e2e.test.js`. Covers all four planned services
plus audit (v1→v2, anchors — a fifth representative kept since its hash-chain migration is a
meaningfully different shape from the others' plain `ALTER TABLE`s) for case 1, and both notify
(split-capable) and auth (normal) for case 2, per the plan's "at least one" minimum. No production
code changed in any of the five services; `stack/test/integration/harness.js` gained one shared
`openOldFixtureDb` helper (extracted from Phase 1's own fixture-building code, not new surface).

---

## Phase 3 — Audit anchor key backup

**Repos**: stack (`Snapshot`), audit (README wording only).

**Objective**: close the confirmed, already-self-documented gap where `stack backup` excludes
audit's anchor signing key material, bringing it to parity with how auth's JWT signing key is already
handled.

**Scope**:
1. `stack/src/snapshot.js`'s `EXTRA_PATHS`: add an `audit` entry, env-derived from
   `ANCHOR_PRIVATE_KEY_PATH` (returning an empty list when unset, matching the feature's own
   optionality — not a hardcoded `['keys']` the way auth's mandatory keys are), covering both the
   current private key and, when present, the previous public key file used during a rotation window.
2. `stack/docs/BACKUP.md`: move audit from the "What's excluded" list to the normal per-service
   contents table; the "Secret and key backup semantics" section's audit paragraph updates from
   "not included, back it up yourself" to "included as of [this phase]."
3. `audit/README.md`'s "Backup / restore" section: same update, matching the wording pattern already
   established for auth's own key-backup framing.

**Invariants**:
- A service with `ANCHOR_PRIVATE_KEY_PATH` unset (the anchor feature not configured) sees zero change
  in snapshot contents — the new `EXTRA_PATHS` entry must degrade to an empty list, not attempt to
  back up a path that was never configured.
- Restore behavior for this new entry uses `Snapshot`'s existing generic directory-handling path,
  identical to how auth's `keys/` is already restored — no audit-specific restore logic should be
  needed; if the implementation finds it needs any, that's a signal the design has drifted from what
  the audit confirmed and is worth re-checking against `Snapshot`'s existing generic code before
  proceeding.
- Never write actual secret/key VALUES into any doc — only paths and env var names, matching every
  other backup-related doc in this codebase.

**Expected migrations/API changes**: none — this is additive to the backup snapshot's contents, not a
schema or API change.

**Required tests**:
1. A deterministic test proving the gap existed before this change (a snapshot taken with
   `ANCHOR_PRIVATE_KEY_PATH` configured does NOT include the key directory) and is closed after (it
   does).
2. Full end-to-end: generate a real anchor key pair, create an anchor, `stack backup`, mutate both the
   audit database and the key file (simulating a restore-from-an-earlier-point scenario), `stack
   restore`, verify: the pre-existing anchor still verifies correctly against the restored key
   material, and a newly-signed anchor after restore continues the chain correctly (matches the
   audit's own "anchor create → backup → mutate → restore → old anchor verifies → new anchor signing
   continuity correct" acceptance criterion verbatim).
3. Full `stack` suite (`snapshot.test.js` and friends) + typecheck.
4. Full `audit` suite + typecheck (README-only change there, but confirm nothing else drifted).

**Compatibility impact**: additive only — existing snapshots taken before this change remain valid and
restorable exactly as before; they simply won't have the audit key directory, which is the same
degraded-but-functional state as today.

**Rollback implications**: trivial (one `EXTRA_PATHS` entry, two doc sections).

**Stop condition**: none anticipated — this is the lowest-risk phase with a real, confirmed benefit;
proceed unless the security-posture judgment call flagged in the audit (is backing up a private
signing key via the same mechanism as auth's JWT key acceptable) comes back "no" from the user, in
which case this phase is dropped entirely, not partially done.

**Implemented**: `stack/src/snapshot.js`'s `EXTRA_PATHS.audit`, `stack/test/snapshot.test.js` (7 new
tests), `stack/test/integration/audit-anchor-continuity.test.js`, `stack/docs/BACKUP.md`,
`audit/README.md`, `audit/docs/READINESS.md`. Two design refinements beyond this plan's original
scope, both re-verified against real code before implementing (not applied on the audit's design
sketch alone): configured-but-missing key material fails the backup (fatal, matching
`AnchorSigner.fromFiles`'s own startup-refusal contract) rather than degrading silently; a configured
path outside the audit service folder is excluded with a warning rather than followed, a security
boundary. `#copyFile`'s missing permission-bit preservation (a pre-existing gap affecting `auth`'s
keys too) was found and fixed in the same phase, since leaving it would have made every restored
private key world/group-readable, audit's new one included. No audit production code changed.

---

## Phase 4 — Media maintenance trigger and trash reconciliation

**Repos**: media.

**Objective**: give an operator a safe, observable way to trigger maintenance on demand, and close the
disk-space leak from an incomplete detach-then-discard sequence, without changing the existing timer
or startup-eager behavior.

**Scope**:
1. `POST /v1/maintenance/run` — a new route under media's existing flat API-key model (no new role
   concept; this is an explicit, audit-flagged judgment call the user should confirm before
   implementation, since it means any valid media API key can trigger maintenance, not a distinguished
   "admin" key). Calls `Maintenance#run()` (not `MediaService#purge()` directly), so it shares the
   existing in-process dedup guard with the hourly timer and startup-eager run — a manual trigger
   racing either of those folds into the same in-flight run rather than starting a second one.
   Response body surfaces the existing `{files, blobs, tickets}` counts plus a new `errors` count
   (currently accumulated then silently discarded per-item — needs to be collected instead).
2. Trash reconciliation, added as a step inside the same `Maintenance#run()` (so it runs on the
   existing hourly timer, the existing startup-eager run, AND the new manual trigger — no separate
   timer): sweep `trash/` for entries older than a short, explicit, newly-defined config default
   (order of minutes — chosen only to outlast the non-atomic two-part `detachForDelete` rename, not
   related to `DELETE_GRACE_DAYS`), delete only entries matching the existing `<token>.object`/
   `<token>.variants` naming pattern (reusing `local-storage.js`'s existing `TOKEN_RE`), and skip with
   a logged warning — never delete — anything that doesn't match or looks otherwise unexpected.
   Tracked via file mtime only; no new DB table (per the audit's reasoning: anything in `trash/` is
   already unreferenced by any live DB row by the time it exists, so a new table would just track the
   existence of garbage, and would reintroduce an equivalent crash-window problem one level up).

**Invariants**:
- The existing hourly timer and startup-eager-run behavior are unchanged in trigger frequency/timing —
  this phase only adds a third trigger and a new sweep step, never removes or slows the existing two.
- Two concurrent maintenance executions (timer + manual trigger, or two manual triggers) never corrupt
  state or double-act — enforced by `Maintenance#run()`'s existing dedup guard, confirmed sufficient
  by the audit given `ecosystem.config.cjs`'s `instances: 1` pin (no cross-process concurrency to
  guard against for media).
- An in-flight upload is never affected — the new route and the reconciliation sweep both stay on the
  `Maintenance#run()`/`MediaService#purge()` code path, never touching `LocalStorage#prepare()` (the
  Stage 0-fixed, destructive `tmp/`-wiping call), confirmed structurally impossible by the audit.
- Reconciliation never deletes a canonical live object or variant — only paths inside `trash/`
  matching the token-file naming pattern, confirmed by the audit to be structurally independent of any
  live canonical path once a detach's `rename()` has happened.
- No secret or internal filesystem path leaks into the new route's response body or logs beyond what
  the existing `purge()` counts already expose.

**Expected migrations/API changes**: one new HTTP route (additive, new endpoint — does not change any
existing route's contract); a new config default for the reconciliation grace period (additive, with
a sane built-in default so no operator action is required to adopt this phase).

**Required tests**:
1. Manual-trigger route: normal success path (returns real counts); concurrent manual trigger while
   one is already in flight folds into the same run rather than double-executing (assert via the
   existing dedup guard's observable behavior, e.g. both requests resolve with the same result).
2. Trash reconciliation:
   - Detach → simulated crash before discard → canonical object re-created (a fresh upload of the
     same sha256) → reconciliation runs → the live canonical copy is never touched (only the
     unrelated, independent `trash/` entry is affected).
   - Detach → simulated crash before discard → no canonical/no live reference recreated → after the
     grace period elapses → reconciliation removes the orphaned trash entry.
   - A malformed/unexpected entry placed in `trash/` (not matching `TOKEN_RE`) → reconciliation skips
     it and logs an observable warning, never deletes it.
   - Reconciliation is safe to run again immediately after a previous run (idempotent — a second pass
     over an already-clean `trash/` does nothing) and safe to run again after a process restart
     (crash-safe by construction, since it relies only on mtime, not in-memory state).
3. Full `media` suite + typecheck.

**Compatibility impact**: additive only. No existing route's behavior changes. Operators who never call
the new endpoint see identical behavior to today except for reconciliation quietly recovering disk
space that previously leaked — a strict improvement with no opt-in required.

**Rollback implications**: self-contained to `media`; reverting removes the new route and the
reconciliation step, returning to today's exact two-trigger, no-reconciliation behavior (the known,
already-documented starting state, not a new risk).

**Stop condition**: if the "no new role" judgment call (item 1's flat-API-key decision) is rejected by
the user in favor of adding a role concept to media, stop and re-scope this phase before implementing
— that's a larger, different change than what's designed here and deserves its own sign-off.

---

## Phase 5 — Backend traceparent consumption

**Repos**: service-core (new shared primitive), auth, notify, media, audit, shortlink, flags,
scheduler, webhook-out, search, ratelimit, geo (adoption — 11 backend services).

**Objective**: let backend services parse an inbound `traceparent` the same validated way
gateway/console already do, log `traceId`/`spanId` alongside the existing `reqId`, and forward a
freshly-spanned `traceparent` on outbound calls to other atc-web services — without 11 copy-pasted
implementations and without leaking internal trace identifiers to arbitrary/operator-configured
external targets.

**This phase does not start until the internal-vs-external forwarding policy (below) is explicitly
confirmed by the user** — it is the one open design judgment call in this entire plan with a real
behavioral consequence, and implementing against the wrong assumption here would mean redoing
per-service adoption work, not just a config flag flip.

**Policy needing confirmation**: forward `traceparent` only on outbound calls to a fixed,
env-configured atc-web peer URL (auth→notify, any-service→audit); never forward it to an
arbitrary/operator-configured target (a scheduler job's target URL, a webhook-out subscriber URL) —
those continue to carry only their existing service-specific headers, unchanged by this phase.

**Scope**:
1. `service-core/src/trace-context.js` (new): a `TraceContext` class combining gateway's validated
   `parse()`/`HEADER_PATTERN` (W3C format, lowercase-hex-only, all-zero trace-id/parent-id rejected)
   with console's `span()` (fresh span-id per outbound hop). Also export a small `AsyncLocalStorage`
   context helper generalizing the pattern already proven in `console/src/services/client.js`.
2. `service-core`'s existing per-service `X-Request-Id` wiring: while touching this area, consider
   (does not have to be in the same commit if it's cleaner separately) consolidating the 11
   copy-pasted `requestIdHeader`/`genReqId` blocks into one shared helper alongside the new trace
   primitive, since both live in the same request-context space and the audit found the current
   11-copy state was itself an unrecognized gap.
3. Per backend service (11 services, uniform small change each, per the audit's own line-count
   estimate of roughly 10–15 lines/service):
   - `onRequest` hook: populate the shared context from an inbound `traceparent` via
     `TraceContext.forRequest(header, trusted=false)` — backend services never trust an inbound
     header any differently than they do today for anything else; malformed/absent input always mints
     a fresh trace, matching gateway's own fallback behavior.
   - Structured logger: bind `traceId`/`spanId` (and `parentSpanId` where meaningful) alongside the
     existing `reqId`, matching gateway's own access-log line as the reference shape.
   - Only for auth (→notify, →audit) and the shared `AuditClient` (used by every service that forwards
     to audit): add the `traceparent` header, with a fresh span, on that specific outbound call —
     per the confirmed policy above. No other service's outbound calls change.

**Invariants**:
- Never trust an inbound `traceparent` any more than a backend service already trusts any other
  caller-supplied header today — this phase changes what's logged/forwarded, not the trust model.
- Never forward `traceparent` to an arbitrary/operator-configured target (enforced by scoping the
  header-adding change to only the specific internal-peer call sites named above, not a blanket change
  inside `HttpCaller` itself).
- Never use `traceId`/`spanId`/`reqId` as a Prometheus metric label anywhere this phase touches —
  preventive, matching the codebase's existing bounded-cardinality metrics design.
- `X-Request-Id` semantics stay exactly as they are today (unrelated axis) — this phase only adds
  `traceparent` alongside it, never changes request-id behavior's meaning.

**Expected migrations/API changes**: new response/request header support (`traceparent`) on 11
services that didn't parse it before — purely additive, no existing header/contract changes. No DB
schema changes anywhere in this phase.

**Required tests** (per service, and once at the service-core level):
- Valid inbound `traceparent` → parsed, trace-id continued, fresh span-id minted.
- Malformed inbound (bad format, wrong length, non-hex) → new trace minted, request still succeeds
  (never a crash on malformed input).
- All-zero trace-id or all-zero span-id → rejected exactly like gateway's existing behavior, new trace
  minted.
- Uppercase hex in an inbound header → rejected (not silently lowercased), matching gateway's existing
  exact behavior — confirm this is actually the intended behavior to preserve, or an explicit decision
  to change it, before locking in the test.
- console→backend and gateway→backend propagation, for at least one representative service each
  (real cross-process, using the existing `stack/test/integration/harness.js` pattern).
- backend→backend propagation only for the specific internal-peer paths in scope (auth→notify,
  any-service→audit) — no test should assert propagation to an arbitrary-target call, since that's
  explicitly out of scope by the confirmed policy.
- `AsyncLocalStorage` isolation under real concurrency (two simultaneous requests to the same process
  never cross-contaminate each other's trace context) — mirroring the isolation test style already
  used for console's own `traceContext` in Stage 10.
- Full suite + typecheck for every one of the 11 touched services, plus service-core, plus
  `STACK_INTEGRATION=1`.

**Compatibility impact**: additive only for every service. No existing consumer of any current header
or log field is affected; `traceparent` is new surface, not a replacement of anything.

**Rollback implications**: the largest-surface phase in this plan (12 repos touched), but each
service's change is small and independent — a problem discovered in one service's adoption does not
require reverting the others; the shared `service-core` primitive itself is additive (a new file, not
a change to `HttpCaller`'s core behavior) so reverting it in isolation is also safe.

**Stop condition**: do not begin per-service adoption before the internal-vs-external forwarding
policy is explicitly confirmed. If, during implementation, any additional outbound call site is found
that doesn't cleanly fit either "fixed internal peer" or "arbitrary external target" (the audit
checked auth, notify, scheduler, webhook-out specifically but not all 11 services' every outbound
call exhaustively), stop and classify it explicitly with the user rather than guessing.

---

## Release blockers vs. can-ship-with-documented-limitations

**Release blockers: none.** No finding in the audit describes an active data-loss, corruption, or
security incident occurring in the platform's current, normal operation. Nothing in this plan needs
to land before the platform can be considered releasable as-is.

**Can ship with documented limitations, exactly as it stands today, pending this plan's phases:**
- The split-worker migration race (Phase 1) — already has a working, documented, safe workaround
  (staggered start) in `stack/docs/UPGRADE.md`, and empirically never causes data loss, only a
  bounded, self-recovering crash under PM2's existing restart policy.
- The migration E2E coverage gap (Phase 2) — a test-coverage gap, not a runtime defect; the mechanism
  it would be testing is already covered at the unit level.
- Media purge/trash (Phase 4) — the existing timer and eager-run already keep the system correct;
  what's missing is operator convenience and a bounded disk-hygiene improvement, not correctness.
- Backend trace consumption (Phase 5) — purely additive observability; its absence today means less
  visibility, not incorrect behavior.
- Audit anchor key backup (Phase 3) — already correctly self-documented as a real operational gap the
  operator must currently work around manually; closing it is a strict improvement with no downside
  found, but its absence today doesn't corrupt or lose anything as long as the operator already
  follows the documented manual workaround.
- Gateway breaker (item 6) — not a limitation at all; already correctly documented as accepted,
  intended behavior for a class-A service.

---

## Summary

1. **Risks genuinely confirmed** (with fresh, independent evidence, not inherited from a prior
   report): the migration race (now with an exact empirical failure rate and a proven-zero corruption
   rate), the migration E2E test gap, media's purge-trigger gap (mechanism itself proven safe),
   media's trash-leak window (proven harmless to live correctness), the trace-consumption gap (with
   two material corrections to its previously-assumed starting point), the audit anchor key backup
   gap (confirmed already self-documented and consistent across docs), and the duplicate-window
   documentation gap (confirmed the underlying mechanism already exists at 3 of 4 sites).
2. **Found smaller than described**: the migration race's actual consequence (bounded crash, zero
   corruption in 75 real runs — not an open-ended "unsafe" claim); the duplicate-window risk (already
   solved at the identifier level everywhere except SMTP, needing only documentation).
   **Found larger/different than described**: backend trace consumption (service-core has no existing
   primitive to extend, console doesn't parse traceparent at all — this is new work, not an
   extension); the gateway breaker "limitation" turned out to be no limitation at all once its actual
   documented deployment contract was read.
3. **Phases proposed**: 6 (Phase 0 docs-only, Phase 1 migration race fix, Phase 2 migration E2E tests,
   Phase 3 audit anchor backup, Phase 4 media maintenance/reconciliation, Phase 5 trace consumption).
4. **First phase's full scope**: Phase 0 — three README additions (webhook-out, notify, scheduler)
   stating each service's existing delivery/message/run identifier is stable across retries, plus one
   companion sentence in notify's README honestly noting the SMTP channel has no equivalent. Zero code
   changes, zero new tests beyond re-confirming each repo's existing suite is unaffected. (If a
   code-only first phase is preferred instead, Phase 1 — the migration race fix — is the next
   candidate, and is independent of Phase 0 either way.)
5. **Any finding that actually blocks release**: no. See "Release blockers" above — none found.

Two open judgment calls need the user's explicit confirmation before their respective phases begin:
Phase 4's "no new role concept for media's maintenance trigger" and Phase 5's "internal-vs-external
traceparent forwarding" policy. Phase 3 also carries one security-posture question (backing up the
anchor private key the same way the JWT private key already is) worth an explicit yes before that
phase starts, though the audit found no technical reason to expect "no."
