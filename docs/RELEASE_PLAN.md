# Release candidate — implementation plan

Dependency-ordered phases for turning the audited state in `RELEASE_AUDIT.md` into a tagged release.
Nothing in this plan has been executed yet — this is the plan only, pending approval.

## Phase R0 — Test-harness fix + CI decision

**Scope**: exactly one code change, plus one decision to make explicitly rather than default.

1. `notify/test/helpers.js`: add `PORT: '0'` to `testConfig()`'s defaults, matching `scheduler`'s and
   `webhook-out`'s own existing `testConfig()` pattern exactly (`RELEASE_AUDIT.md` §4/§confirmed
   blocker). Does not touch `notify/src/config.js`'s real production default (`3001` stays the real
   default). Acceptance: `npm test` in `notify`, 5 consecutive full runs, 60/60 every time, run on a
   machine/moment where nothing else has taken port 3001 first is no longer a precondition for a
   correct result.
2. Decide whether to add the minimal per-repo CI workflow recommended in `RELEASE_AUDIT.md` §16
   (`npm ci && npm test && npm run typecheck`, one `.github/workflows/ci.yml` per repo) as part of
   this release or explicitly deferred. Not assumed — needs an explicit yes/no before R0 closes,
   since it touches all 15 repos.

**Blocking**: yes — R1's validation matrix is only meaningful once notify's suite is deterministic.

### R0 status: implemented / completed

Notify's fix used `freePort()` (not literal `PORT: '0'` — notify's own `PORT` validator requires
`min: 1`, unlike scheduler/webhook-out's `min: 0`; see `RELEASE_AUDIT.md`'s "Closed in R0" note) —
10/10 consecutive runs, 60/60 each, port 3001 deliberately held throughout. A second, unrelated
blocker was found while establishing R0's baseline (scheduler/webhook-out's `#stats()` reading real
`Date.now()` against a fixed-date test fixture) and fixed with the same injectable-`now` pattern
already used elsewhere in both services — 10/10 runs each, scheduler 46/46, webhook-out 44/44 (both
counts up by one real new boundary regression test). CI: decided in-scope, added — minimal per-repo
`.github/workflows/ci.yml`, `RELEASE_AUDIT.md` §16 "Closed in R0" has the exact shape. R1 has not
started.

## Phase R1 — Release validation + drills

Everything here is real execution, not planning — but still no version/tag/commit changes.

**1. Full validation matrix** (exact commands, taken directly from each repo's real `package.json`,
none invented):

| Repo | Commands |
|---|---|
| service-core | `npm test`, `npm run typecheck` |
| gateway | `npm test`, `npm run typecheck` |
| notify | `npm test`, `npm run typecheck` |
| auth | `npm test`, `npm run typecheck` |
| media | `npm test`, `npm run typecheck` |
| audit | `npm test`, `npm run typecheck` |
| shortlink | `npm test`, `npm run typecheck` |
| flags | `npm test`, `npm run typecheck` |
| scheduler | `npm test`, `npm run typecheck` |
| webhook-out | `npm test`, `npm run typecheck` |
| search | `npm test`, `npm run typecheck` |
| ratelimit | `npm test`, `npm run typecheck` |
| geo | `npm test`, `npm run typecheck` |
| console | `npm test`, `npm run typecheck` (runs `tsc` + `svelte-check`), `npm run build` (real `vite build`, not previously run in this closure) |
| stack | `npm test`, `npm run typecheck`, then `STACK_INTEGRATION=1 npm test` |

Acceptance: every command exits 0, notify at 60/60.

**2. Production startup smoke** — one real child process per runnable service (gateway + all 12
backends), each against its own real entrypoint, ephemeral isolated config, temp DB/data dir, a free
port (OS-assigned, not a fixed test port — the same class of fix as R0), proving: starts → `/ready`
returns healthy → `/v1/info` returns a well-formed body (service/version/apiVersion/schemaVersion/
serviceCore/capabilities, per `RELEASE_AUDIT.md` §15) → `SIGTERM` → exits within a bounded time. No
new test-only production flag — uses each service's real entrypoint exactly as `ecosystem.config.cjs`
does today. For `notify`, `scheduler`, `webhook-out`: an additional split-mode smoke — `api-main.js`
+ `worker-main.js` against the same DB file, both independently reaching healthy, both shutting down
gracefully — reusing the real entrypoints Hardening Phase 1's `split-worker-migration-race.test.js`
already spawns, not a new mechanism.

**3. Deployment smoke** — `stack up` and `stack up --split-workers` in a disposable environment.
Verify: generated PM2 app definitions (entrypoints, env, cwd, log paths, `kill_timeout`,
`<id>-api`/`<id>-worker` naming for the split three, no duplicate serving process, split-worker
migration safety per Hardening Phase 1, shutdown ordering). Per `RELEASE_AUDIT.md` §7: PM2 itself is
not installed in the audit environment used to write this plan — if that is still true when R1 runs,
split config-generation verification (pure data, no PM2 needed) from live PM2 process-supervision
verification (needs PM2 actually installed) and report which half actually ran, exactly as the audit
flagged.

**4. Upgrade drill** — disposable environment, system-level (not a duplicate of Phase 2's HTTP E2E
coverage): old supported DB/schema → backup → start the current release binary → automatic migration
→ `/ready` → confirm existing data preserved → `/v1/info.schemaVersion` reads current. Includes the
split-worker pending-migration guarantee from Hardening Phase 1 as an explicit regression check
inside this drill (not a separate re-test), since a release drill is exactly the system-level context
that guarantee needs to keep holding in.

**5. Rollback drill** — reusing Stage 3/Hardening Phase 3's existing backup/restore + audit anchor
continuity coverage (`stack/test/snapshot.test.js`,
`stack/test/integration/audit-anchor-continuity.test.js`) as the real implementation, not rewritten:
running state → `stack backup` → mutate/upgrade → `stack restore` → services restart → data restored
→ media bytes restored → auth signing continuity → audit anchor signing/verification continuity.
Expected restore result: `restored`. No failure-injection here (Stage 3.1's own scope, already
covered elsewhere, not duplicated).

**6. Live API compatibility check** — with the startup smoke's services actually running, run `stack
status --matrix` for real and confirm it reports the live `service`/`version`/`apiVersion`/
`schemaVersion`/`serviceCore`/`capabilities` fields for each (mechanism already confirmed real by
static read in `RELEASE_AUDIT.md` §15 — this is the live confirmation).

**Blocking**: yes — R2 does not start until every drill in this phase is green.

## Phase R2 — Versioning + release metadata

1. Apply the version/tag policy from `RELEASE_AUDIT.md` §11–§12: `service-core` unchanged (already
   `v1.11.1`); the other 14 repos get a release commit (if `package.json.version` needs to actually
   change from what it already reads — see audit §12, most stay textually `1.0.0` since that value is
   already correct as a first release, so this may be a no-op commit-wise for most of them) plus a
   `vX.Y.Z` tag on that commit.
2. Decide and, if approved, implement the release-notes strategy (`RELEASE_AUDIT.md` §13) and the
   generated release manifest (`RELEASE_AUDIT.md` §14) — both explicitly scoped as non-source-of-truth
   conveniences, not new systems of record.
3. Update the one confirmed stale doc line (`stack/docs/UPGRADE.md`'s "still pins v1.10.0" sentence,
   `RELEASE_AUDIT.md` §10) as part of this phase's own commit, not left for later.

**Blocking**: yes — R3 does not tag anything until this phase's metadata decisions are made and
applied.

## Phase R3 — Tag/release execution

1. Create the immutable tags decided in R2, one per repo, each on the real commit that sets its
   version.
2. If GitHub Releases are wanted (not assumed — a separate decision from tagging itself): create them
   from the tags, referencing whatever release-notes form R2 settled on.
3. Final 15-repo hygiene re-check (same shape as `RELEASE_AUDIT.md` §1): clean, pushed, ahead/behind
   0/0, tag→commit verified, before declaring the release candidate actually released.

**Blocking**: this is the last phase — nothing follows it in this plan.

---

Four phases, strictly dependency-ordered (R0 unblocks a meaningful R1, R1's green drills unblock R2's
metadata decisions, R2's decided metadata unblocks R3's actual tagging). No phase here does
architecture work, new infrastructure, or anything from the task's own out-of-scope list.
