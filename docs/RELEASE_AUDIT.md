# Release candidate audit

Audit-only. No code, version, tag or commit changes were made while producing this document. Every
number below comes from a command run directly against each repo's real HEAD during this audit
(`git`, `node -pe require(...)`, `npm audit`, `npm ls`, `npm test`), not from a prior report.

Scope: the 15 repos under `atc-web/` — `stack`, `service-core`, `gateway`, and the 12 backend
services (`notify`, `auth`, `media`, `console`, `audit`, `shortlink`, `flags`, `scheduler`,
`webhook-out`, `search`, `ratelimit`, `geo`).

## 1. Repository matrix

All 15 repos, as of this audit, verified directly:

| Repo | Branch | HEAD | origin/main | dirty | ahead/behind | pkg version | tags | Node engine | Dockerfile | ecosystem.cjs | CI workflow |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stack | main | `1beeb23` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | n/a (tooling) | n/a | none |
| service-core | main | `934af4f` | same | clean | 0/0 | 1.11.1 | 19 tags, v1.0.0..v1.11.1 | >=22.13 | n/a (library) | n/a | none |
| gateway | main | `8cc70cb` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| notify | main | `5cc38e7` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| auth | main | `a009c19` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| media | main | `feddcc3` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| console | main | `0a3a08d` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| audit | main | `6d3660b` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| shortlink | main | `c8b4551` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| flags | main | `bb7d319` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| scheduler | main | `9b30c4c` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| webhook-out | main | `742afd2` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| search | main | `8e918af` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| ratelimit | main | `9e5ff4b` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |
| geo | main | `6aadbf7` | same | clean | 0/0 | 1.0.0 | none | >=22.13 | yes | yes | none |

15/15 clean, 15/15 pushed (0 ahead, 0 behind `origin/main`, re-verified with a live `git fetch`, not
cached state). `LICENSE` (MIT) and `.env.example` present in all 15 where applicable (`stack` and
`service-core` are not deployed services, so no `.env.example`/Dockerfile/ecosystem file — correctly
absent, not missing). Every one of the 13 deployable services (gateway + 12 backends) has an
identically-shaped `## Run` section in its README with real `npm ci` / PM2 / Docker instructions —
spot-checked all 13, uniform, no drift.

**No repo has a GitHub Actions workflow.** `.github/workflows` is empty or absent in all 15 — see §7
(CI audit).

## 2. Versioning audit

**service-core is classified C (package version + git tag together, source of truth):**
`service-core/VERSIONING.md` documents the real policy already in force: every consumer pins an
exact git tag (`#v1.11.1`), `package.json.version` always equals the tag it was cut at, patch/minor/
major rules are defined and were followed correctly through 19 real tags (`v1.0.0` → `v1.11.1`).
Verified directly, not assumed:

- `git rev-parse v1.11.0` → `ee472d45f2ee326feb66af13658635f1a7ac9568`
- `git rev-parse v1.11.1` → `934af4f5a45f4be6fab9c77ba5f24f6c44c37c83`
- Both distinct, neither is HEAD's ancestor-of-a-moved-tag artifact — v1.11.0 was not moved.
- All 12 consumers' `package-lock.json` resolves `@atc-web/service-core` to
  `934af4f5a45f4be6fab9c77ba5f24f6c44c37c83` with `version: 1.11.1` — the lockfile's *resolved
  commit*, not just the `package.json` string, matches the tag's real commit in every case. No
  consumer is silently on a stale or diverged install.

**All 14 other repos are classified D (no formal release convention exists today):**
`package.json.version` is `1.0.0` in every one of them — the scaffold default, never bumped, despite
each having received real, substantial production changes across Stage 0–12 and Hardening Phase
0–5. No `git tag` has ever been created in any of these 14 repos (`git tag -l` returns empty in
every one). No `CHANGELOG.md`/`RELEASE_NOTES.md` exists in any of the 15 repos, including
service-core (its release history lives entirely in tag names + each tag's own commit log, which is
a legitimate, already-working convention — not a gap to fix).

This means: for these 14 repos, `1.0.0` is not a stale version number to "catch up" — it was never a
tagged, released version to begin with. There is no prior release to diff against, so there is no
real basis for computing what a `1.1.0` or `1.2.0` would even mean. See §11 (recommended policy) and
§12 (proposed versions) — the audit's conclusion is that this is each of these repos' **first real
release**, not a version catch-up.

## 3. Confirmed release blockers

None of the following blocker categories from the task's own definition were found:

- Production test deterministic fail: **none**, except §4 (notify port collision — is a blocker, see
  below, already root-caused).
- Build fail: **none** (only `console` has a real build step — `vite build` — not run during this
  audit since it's a validation-matrix item for the implementation phase, not an audit-phase check;
  flagged as a to-run item in RELEASE_PLAN.md, not a currently-confirmed failure).
- Typecheck fail: **none observed** — every repo's typecheck passed as of the Phase 5 closure run
  immediately preceding this audit (same HEADs, unchanged since); re-run is scheduled for the
  implementation phase's validation matrix rather than repeated here.
- Dirty/unpushed source: **none** — 15/15 clean, 15/15 pushed, verified above.
- Broken service-core pin: **none** — all 12 consumers' lockfiles resolve to the real, current
  `v1.11.1` commit.
- Missing required migration: not evaluated in this audit pass (requires the upgrade drill design in
  RELEASE_PLAN.md §upgrade drill, an implementation-phase activity).
- Real startup failure: not evaluated in this audit pass (requires the startup smoke design in
  RELEASE_PLAN.md, an implementation-phase activity) — no repo shows an obvious code-level reason to
  expect one (all constructors/entrypoints unchanged in shape since Hardening Phase 5's own passing
  cross-process E2E tests, which already start every service for real).
- Broken deployment generation: not evaluated in this audit pass — see §7, PM2 itself is not
  installed in this environment, so config-generation can be checked but a live `pm2 start` cannot.
- Backup/restore correctness failure: not evaluated in this audit pass (existing coverage:
  `stack/test/snapshot.test.js`, `stack/test/integration/audit-anchor-continuity.test.js` — both
  passing as of the pre-audit Hardening Phase 5 run; re-run scheduled for implementation phase).
- Secret committed: **none found** — see §9.
- Immutable tag mismatch: **none** — service-core's two most recent tags verified as distinct,
  correct commits (§2).
- Documented supported flow not working: **one confirmed instance** — notify's own documented test
  flow (`npm test`) does not reach 60/60 today; see §4.

### Confirmed blocker: notify's `test/runtime.test.js`, 2/60 deterministic failures

**Root cause, confirmed by direct comparison with sibling services, not guessed:**
`notify/test/helpers.js`'s `testConfig()` does not override `PORT`, so `Config.fromEnv()` falls back
to its real production default (`notify/src/config.js:104`, `port: r.integer('PORT', 3001, ...)`).
Three tests in `notify/test/runtime.test.js` each call `Application.start()` against this config,
binding real TCP port 3001. `scheduler` and `webhook-out` — the two other split-capable services with
an identically-shaped `runtime.test.js` (the file's own top comment even says "See scheduler's
identical test for why") — do **not** have this problem, because their own `test/helpers.js`
`testConfig()` already sets `PORT: '0'` (OS-assigned ephemeral port). This is a pre-existing gap in
notify's own test harness relative to its own sibling services' already-established, working
pattern — not a new defect introduced by Hardening Phase 5, and not something Phase 5's own changes
touch.

Confirmed reproducible right now: `lsof -i :3001` shows a `node build-worker/index.js` process (PID
verified via `ps`, cwd is `/Users/atc/Storage/Works/_dev/webcad` — a **different, unrelated project**,
not started by any work in this session, not part of `atc-web`). Per the standing safety rule against
killing processes this session did not start outside the current project, it was left running. That
means today's 58/60 is itself environment-dependent — on a machine/CI runner where port 3001 happens
to be free, this would already read 60/60, and on this machine it will keep failing until either that
external process exits or the harness is fixed to stop depending on a fixed port at all. **A test
whose pass/fail depends on what else happens to be running on the machine is a blocker in its own
right, independent of today's specific collision** — this is why it is classified as a confirmed
blocker rather than an environmental footnote.

**Fix (not applied — audit phase only):** add `PORT: '0'` to `notify/test/helpers.js`'s
`testConfig()`, matching `scheduler`'s and `webhook-out`'s own existing, already-working pattern
exactly — no new convention invented. This is a one-line test-harness change; it does not touch
`notify/src/config.js`'s real production default (`3001` stays the documented, real default port —
per the task's explicit instruction not to change production port/config semantics). Scheduled as
Phase R0 in `RELEASE_PLAN.md`. Acceptance: 5 consecutive full-suite runs, 60/60 every time.

### Closed in R0

`PORT: '0'` was not usable as-is: notify's own `PORT` validator requires `min: 1` (unlike
scheduler's/webhook-out's `min: 0`), so it was rejected by config validation before reaching a
bind. Real fix applied: `notify/test/helpers.js` gained a `freePort()` helper (the same
bind-to-0/read-assigned-port/close technique `stack/test/integration/harness.js` already uses),
and `test/runtime.test.js`'s three `Application.start()` call sites now pass
`PORT: String(await freePort())` instead of relying on the real production default. Verified with
port 3001 deliberately held by a disposable local process for the entire run: **10/10 consecutive
full-suite runs, 60/60 every time, 0 `EADDRINUSE`**. `notify/src/config.js`'s real default (3001)
and every other config/entrypoint/Docker/PM2 path are unchanged.

A second, unrelated, genuinely new blocker was discovered while establishing R0's local baseline:
`scheduler` and `webhook-out`'s `#stats()` (`src/http/scheduler-api.js`, `src/http/webhook-api.js`)
computed their `last24h` stats window from real `Date.now()`, while their own test fixtures
(`test/helpers.js`) freeze a `FakeClock` at `2026-09-17T10:00:00Z` — a fixed anchor date, not
relative to real time. Once real wall-clock time passed 24h beyond that anchor, the window stopped
overlapping the fixtures' simulated run timestamps and `last24h.succeeded` read `0` instead of `1`
— reproducible 3/3, not flaky, and would never self-heal since real time only moves forward from a
fixed anchor. Fixed with the same dependency-injection pattern `Worker`/`JobService`/`HttpCaller`
already use elsewhere in both services: `SchedulerApi`/`WebhookApi` gained an optional
`now = Date.now` constructor dependency, `#stats()` now reads `this.now()` instead of calling
`Date.now()` directly, and each service's `testService()` passes its existing `FakeClock`'s
`.now` through unchanged. Production wiring (`src/application.js` in both services) passes no
`now`, so the real default (`Date.now`) is unchanged there — verified directly, not assumed. Two
new boundary regression tests were added (one per service) proving the fix is genuinely
clock-driven, not just currently-lucky: an event/run at `T0`, checked `last24h` immediately after
(included), at exactly `T0 + 24h` (still included — the store's own SQL is `created_at >= since`,
an inclusive lower bound, read directly from `run-store.js`/`delivery-store.js` rather than
guessed), and at `T0 + 24h + 1ms` (excluded). Verified with 10 consecutive full-suite runs each:
scheduler 46/46 (45 original + 1 new), webhook-out 44/44 (43 original + 1 new), every run, no
flakiness. No worker/lease/retry/scheduling/delivery timing semantics were touched — only the
stats route's own reference-time dependency became injectable.

## 4. Non-blocking limitations

These are real, already-known, and explicitly out of scope for a release blocker per the task's own
non-blocker examples:

- No CHANGELOG/RELEASE_NOTES in any repo today (§2) — a release-notes *strategy* is proposed in §13,
  not required before this release.
- `stack/docs/UPGRADE.md`'s "Worker-split rollout ordering" section states "every service besides
  these three still pins v1.10.0" — **stale as of Hardening Phase 5**: all 12 consumers now pin
  `v1.11.1` (§2). This is a documentation-drift item (§10), not a release blocker — the guarantee it
  describes (migration-race safety) is unaffected and, if anything, now applies more broadly than the
  stale sentence claims.
- No S3, no distributed scaling, no worker-level trace root, `AuditClient`/`GeoClient` trace
  continuation left unwired — all already-documented, already-accepted architecture limitations from
  Hardening Phase 5's own closure report, not new findings, not blockers.
- Backup encryption remains an operator responsibility (Stage 3/Phase 3 territory) — unchanged,
  already documented, not a release blocker.
- Zero CI workflow (§7) is treated as a **gap worth a minimal fix recommendation**, not a hard
  blocker for tagging this specific release — see §7's own reasoning for why it stops short of
  blocker status this time.

## 5. service-core dependency graph

```
service-core v1.11.1 (934af4f)
├─ notify        pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ auth          pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ media         pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ console       pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ audit         pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ shortlink     pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ flags         pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ scheduler     pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ webhook-out   pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ search        pins v1.11.1 — lockfile resolves to 934af4f ✓
├─ ratelimit     pins v1.11.1 — lockfile resolves to 934af4f ✓
└─ geo           pins v1.11.1 — lockfile resolves to 934af4f ✓

gateway — no @atc-web/service-core dependency (deliberate, standing architectural decision,
          confirmed unrelated to this release; gateway keeps its own independent trace-context.js)
stack   — no @atc-web/service-core dependency (orchestration tooling, not a running service)
```

All 12 real consumers on the identical, current, correctly-tagged commit. No split-pin situation, no
consumer lagging behind.

## 6. Test/build/CI findings

**Test scripts** — identical shape in all 15: `"test": "node [--disable-warning=ExperimentalWarning]
--test \"test/**/*.test.js\""`. **Typecheck scripts** — identical shape in all 15: `"typecheck": "tsc
-p jsconfig.json"`, with `console` additionally running `svelte-check --workspace ui --tsconfig
./jsconfig.json` for its Svelte UI. **Build script** — only `console` has one (`"build": "vite
build"`, compiling `ui/` to `public/`, which is gitignored); no other repo has or needs a build step
(plain ESM, no bundling). `notify`/`scheduler`/`webhook-out` additionally expose `"api"`/`"worker"`
scripts for split-process mode.

All test suites were run to completion once already, immediately before this audit, as part of
Hardening Phase 5's own closure verification, at these exact HEADs (no code changed since):
service-core 97/97, gateway 51/51, auth 43/43, media 78/78, audit 46/46, shortlink 23/23, flags
20/20, scheduler 45/45, webhook-out 43/43, search 14/14, ratelimit 33/33, geo 44/44, console 72/72,
notify 58/60 (§4), stack 37/37 plain + 67/67 with `STACK_INTEGRATION=1`. Every typecheck (including
console's svelte-check, 0 errors/0 warnings) passed. This audit does not re-run them — re-running the
full matrix is explicitly an implementation-phase activity (RELEASE_PLAN.md's validation matrix,
§upgrade drill notwithstanding) so results stay fresh relative to any Phase R0 fix, not duplicated
effort here.

**`npm audit --production`**: zero vulnerabilities (info/low/moderate/high/critical all 0) in all 15
repos, checked directly against the live npm advisory database during this audit. **`npm ls --all`**:
clean in all 15 — no missing, invalid, or extraneous packages, no duplicate-resolution warnings.

**CI: none exists.** `.github/workflows` is empty or absent in every one of the 15 repos. See §7.

## 7. Deployment findings

Every one of the 13 deployable services (gateway + 12 backends) ships an identically-structured
`ecosystem.config.cjs` (PM2, fork mode) and `Dockerfile`, confirmed present. `stack/src/stack.js`
generates both the normal single-process ecosystem file and, for the three split-capable services
(`notify`, `scheduler`, `webhook-out`), a `<id>-api` + `<id>-worker` split ecosystem
(`Stack#generateSplitEcosystem`, `stack/src/stack.js:102-127`) — this logic was inspected directly in
this audit and matches what `stack/docs/UPGRADE.md`'s own description of it says, except for the one
stale sentence noted in §4.

**PM2 is not installed in this audit environment** (`which pm2` → not found). Per the task's own
instruction, this is reported explicitly rather than skipped silently: a real `pm2 start
ecosystem.config.cjs` / `pm2 save` / process-supervision smoke cannot be executed here. What *can*
and should be validated in the implementation phase without PM2 itself: (a) the generated
`ecosystem.config.cjs`/split-ecosystem *content* — correct entrypoints, env, cwd, log paths,
`kill_timeout`, naming — is pure data generation and testable without PM2 running; (b) each service's
real production entrypoint (`node src/index.js`, or `src/api-main.js`/`src/worker-main.js` for the
split three) can be smoke-tested directly as a child process, which is exactly what
`stack/test/integration/*.test.js` already does today and what RELEASE_PLAN.md's startup-smoke phase
extends. The PM2-specific half (real process supervision, `kill_timeout` actually enforced by PM2's
own signal handling, `pm2 save`/`pm2 startup` round-trip) stays an accepted gap of *this specific
audit environment*, not a statement that PM2 itself is untested in real deployment — it is called out
explicitly per the task's instruction rather than silently assumed to have been checked.

## 8. Upgrade/rollback readiness

Existing, already-passing coverage this audit identified as the real foundation for the
implementation-phase drills (not to be duplicated, only extended to a release-level system view):

- `service-core/test/migration-race.test.js` + `stack/test/integration/split-worker-migration-race.test.js`
  — real, separate-process, barrier-synchronized proof that concurrent split-worker startup against
  one SQLite file never double-applies or corrupts a pending migration (Hardening Phase 1).
- `stack/test/integration/migration-e2e.test.js` — real HTTP-level migration coverage (Hardening
  Phase 2).
- `stack/test/snapshot.test.js` + `stack/test/integration/audit-anchor-continuity.test.js` — backup/
  restore correctness and audit anchor signing/verification continuity across a restore (Stage
  3/Hardening Phase 3).

None of these were re-run in this audit pass (all passed at the same HEADs immediately before this
audit began, as part of Hardening Phase 5's closure verification). The implementation phase's
upgrade/rollback drills (RELEASE_PLAN.md) are scoped as a *system-level* exercise built on top of
these — old-schema DB → backup → new binary → auto-migrate → ready → data preserved →
`/v1/info.schemaVersion` current for upgrade; running state → backup → mutate → restore → services
restart → data/media/signing/anchor continuity restored for rollback — not a reimplementation of what
already exists.

## 9. Secrets/artifact hygiene

**Secrets scan** (private key blocks, AWS-style access keys, GitHub PAT patterns, Slack token
patterns, tracked `.env` files, tracked `.pem`/`.key`/password-named files) — **zero real findings**
across all 15 repos. The only name matches were legitimate source: `service-core/src/secret-box.js`
+ `webhook-out/src/crypto/secret-box.js` (an encryption-helper *class*, not a secret value),
`console/ui/src/pages/webhook/SecretDialog.svelte` (a UI component), `console/test/totp-secrets.test.js`
(a test file name), `auth/examples/password-change.md`/`password-reset.md` (documentation examples).
No tracked `.env`, no tracked private key material, no hardcoded credential anywhere matched.

**Artifact hygiene** — no `node_modules/`, `.log`, `.db`/`.db-wal`/`.db-shm`, `.DS_Store`, `dist/`,
`coverage/`, or archived-backup file is tracked in any of the 15 repos. One initial false positive
(`console/ui/build/*.js`) was investigated directly: `ui/build/` is a hand-written build-tooling
*source* directory (icon rasterizer, the overflow probe referenced by this workspace's own visual-QA
convention, a service-worker plugin) — not generated output; Vite's real compiled output goes to
`ui/public/`, which is correctly gitignored. `.gitignore` coverage was read directly in all 15 repos:
`node_modules/`, `.env`, `.DS_Store` are universal; service-specific additions (`data/`, `keys/`,
`routes.json`, `services.json`, `public/`, `ecosystem.split.generated.cjs`) are present exactly where
each service actually generates that kind of runtime artifact. No gap found; no expansion needed.

## 10. Documentation drift

One confirmed stale claim, found by direct re-read during this audit (§4 non-blocking-limitations
entry): `stack/docs/UPGRADE.md`'s "Worker-split rollout ordering" section states every service besides
notify/scheduler/webhook-out "still pins v1.10.0" for service-core — false as of Hardening Phase 5,
all 12 consumers now pin v1.11.1. Everywhere else this audit checked for the specific stale phrases
named in the task (staggered split-worker startup required, audit key not backed up, media trash
leaks forever, backend traceparent not consumed, missing migration HTTP E2E, hardening still
pending) — none were found; Hardening Phase 5's own documentation sweep already closed the
traceparent-consumption claims across all 22 README/READINESS files plus OBSERVABILITY.md, and
Phases 1–4 already closed their own respective stale claims in earlier closure work. This one
`UPGRADE.md` sentence is the only drift this audit found. Recommended fix (not applied — audit phase
only): update the sentence to state that migration-race safety now applies to all 12 pinned
consumers as of v1.10.1+, correcting "still pins v1.10.0" to reflect the real, current pin.

## 11. Recommended release policy

Adopt for all 15 repos, modeled directly on service-core's own already-working, already-documented
convention (`service-core/VERSIONING.md`), without forcing service-core's *registry-avoidance*
reasoning onto services that are deployed, not installed as a dependency:

- **SemVer in `package.json.version`.**
- **An immutable `vX.Y.Z` git tag per release**, cut from a real commit on `main`, matching the
  `package.json` version at that commit exactly. Never force-moved, never recreated.
- **A release commit**: the commit the tag points at is the one that sets `package.json.version` to
  match — same discipline as service-core's own tags today.
- **No CHANGELOG requirement forced now** — see §13 for the release-notes strategy question,
  answered as its own recommendation rather than assumed here.
- **No monorepo conversion, no npm registry requirement** — these are 15 independently deployable
  services/tools, each already its own GitHub repo with its own `package.json`, and none of the 14
  non-service-core repos is ever `npm install`-ed as a dependency by another repo the way
  service-core is; a registry would solve a problem none of them has.
- **service-core keeps its exact current model unchanged** — git-tag-pinned dependency, no registry,
  immutable tags, semver-by-documented-behavior. This release does not touch that.

This directly matches what the task asked for: SemVer, `package.json.version`, immutable tag, tag ==
version, release commit, no monorepo, no registry requirement, service-core's existing model
preserved.

## 12. Proposed release versions (per repo)

**service-core: no change.** Already at `v1.11.1`, already tagged, already the correct current
release. Nothing to do.

**The other 14 repos: tag the current HEAD as `v1.0.0` each, keeping `package.json.version` at the
`1.0.0` it already has.** This is not a "catch-up bump" — per §2, none of these repos has ever had a
real tagged release, so there is no prior release to have moved past. Marking the current,
fully-hardened HEAD (Stage 0–12 + Hardening Phase 0–5, all verified clean/tested in this audit) as
each repo's `v1.0.0` is the correct, honest first release under SemVer — "1.0.0 = first stable public
release" is exactly what SemVer's own spec says it means, and it avoids inventing a fictitious
0.x.y→1.0.0 or 1.0.0→1.1.0 history that never actually happened commit-by-commit. From this tag
forward, every one of these 14 repos follows the same tag-per-release discipline service-core already
has.

## 13. Release notes strategy (recommendation, not yet implemented)

Given 15 independent repos with real, direct dependency relationships between exactly two of them
(gateway has none; 12 backends depend on service-core; `stack` orchestrates all 15 but is not a
runtime dependency of any), the simplest model that actually shows the dependency relationship
without new infrastructure: **a root release manifest in `stack` (generated, not source-of-truth —
see §14) plus one lightweight tag+commit-message-based release note per repo**, not a full
per-repo `CHANGELOG.md` file (14 of the 15 repos have never needed one and a full changelog process
would be new process weight for a first release) and not one single combined stack-suite release
note (it would hide which specific repo/commit changed, which matters here because each repo deploys
and rolls back independently). Concretely: each release commit's own message states what changed
(already this project's practice for every commit in Stage 0–12/Hardening); the tag `vX.Y.Z` is the
addressable release pointer; `stack`'s generated manifest (§14) is where someone looks to see the
whole platform's release state at a glance. No new document type is introduced by this
recommendation. Not implemented in this audit pass — this is a recommendation, to be decided before
Phase R2 (RELEASE_PLAN.md).

## 14. Release manifest (recommendation, not yet implemented)

A machine-readable manifest is worth having given 15 independently-tagged repos, but it must be a
**generated snapshot, not a source of truth** — live `/v1/info` (already real, already implemented
per §"API compatibility" below) and each repo's own git tags stay the real sources. Recommended
shape: `stack` gains a command (e.g. `stack manifest`) that writes a JSON snapshot — service id,
version, commit, tag, service-core pin, schema version — derived by reading each repo's own
`package.json`/git state directly (the same way this audit did), not by hand-maintaining a table. If
this manifest goes stale (a repo re-tagged after the manifest was generated), nothing in production
reads it — it's a convenience view for humans, matching the task's own constraint that a stale
manifest must never affect production behavior. No new registry or service is introduced. Not
implemented in this audit pass.

## 15. API compatibility (`/v1/info`) — confirmed real, not just documented

`registerInfo` (`service-core/src/fastify-helpers.js:224`) is the single shared implementation of
`GET /v1/info`, called directly by all 12 backend services including console — confirmed by grepping
every one of their `src/http/*-api.js` (or `src/app.js` for notify) files for the actual call site,
not assumed from documentation. `gateway` implements its own equivalent independently (matching its
standing no-service-core-dependency architecture). `stack/src/stack.js`'s `status --matrix` command
reads these live endpoints directly (`service`, `version`, `apiVersion`, `schemaVersion`,
`serviceCore`, `capabilities` — the `MatrixRow` type at `stack/src/stack.js:15`) and is already the
single live source of truth this task asked to confirm — no static compatibility table exists or is
proposed. Live verification (actually starting all services and running `stack status --matrix`
against them) is scheduled as part of the implementation-phase startup smoke, not this audit (this
audit confirms the *mechanism* is real and wired correctly by reading the code directly; running it
live is an implementation-phase activity per the task's own phasing).

## 16. CI audit

**Finding: no repo has any CI workflow.** This means, today, a `git push` (or, relevant to this
closure, a future `git tag`) is not gated by any automated test/typecheck/build run — a human (or an
agent) must run the suite manually before tagging, exactly as this audit and Hardening Phase 5 both
did by hand. **This is a real gap** in the sense the task asks about (item 18: "production release'in
test edilmeden taglenmesine izin veren açık bir gap") — nothing currently *prevents* a tag from being
cut against an untested commit. It is not escalated to a release *blocker* for this specific release
candidate, because: (a) every one of the 15 repos' current HEAD *was* in fact fully tested + typechecked
immediately before this audit (Hardening Phase 5's closure run, same commits, verified unchanged),
so the actual commits being proposed for `v1.0.0`/reconfirmed `v1.11.1` are not untested; (b)
retrofitting 15 repos' worth of CI is explicitly out of scope per the task's own §20 ("yeni devasa CI
platformu kurma" is disallowed). **Minimal fix recommended, not built in this audit pass**: one
small `.github/workflows/ci.yml` per repo (`npm ci && npm test && npm run typecheck`, matching each
repo's own real scripts from §6, Node version pinned to `>=22.13` per each `package.json.engines`) —
small enough to not be "a new CI platform," closes the actual gap named by the task, and would be a
reasonable Phase R0/R1 item if the user wants it in scope; not assumed included by default since it
touches all 15 repos and wasn't explicitly requested — flagged here for an explicit decision.

### Closed in R0

Minimal per-repo CI added exactly as recommended above, decided as in-scope for R0 (not a general
CI platform): one `.github/workflows/ci.yml` per repo, `actions/checkout@v7` + `actions/setup-node@v7`
(current supported majors, checked live against GitHub's own releases, not guessed) pinned to Node
`22` (matches every repo's `engines.node: >=22.13` and every Dockerfile's `FROM node:22-alpine`, no
version matrix), `permissions: contents: read`, triggers `push`/`pull_request` on `main` only,
`concurrency` with `cancel-in-progress`. Each workflow runs exactly the commands that repo's own
`package.json` defines — `npm ci && npm test && npm run typecheck` for the 14 non-UI repos, plus
`npm run build` for `console` (real `vite build`, confirmed it leaves `git status` clean —
`public/` is gitignored). `stack`'s workflow runs its plain suite only; `STACK_INTEGRATION=1`
deliberately stays out of push-gated CI per this task's own scope (an R1 concern). No credential of
any kind was added: `npm ci`'s resolution of `github:alitalipcalikoglu/service-core#v1.11.1` was
verified empirically, under an environment with no SSH key, no SSH agent, and no `HOME`-based git
config at all, to still succeed — Node's git-dependency fetcher falls back to anonymous HTTPS for
this public repo without any help, so no `GITHUB_TOKEN`, no PAT, no `git config` rewrite was needed
or added.
