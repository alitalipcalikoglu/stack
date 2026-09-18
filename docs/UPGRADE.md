# Upgrading a running stack

There is no `stack upgrade` command. An upgrade is this documented sequence of existing commands —
`atc-stack backup`/`restore`/`status`/`up`/`down` (`npm run backup`/`restore`/`status`/`up`/`down`
from `stack/`, or `git`/`npm ci` per service — see `stack/bin/stack.js:1-13` for the full command
surface). See [BACKUP.md](BACKUP.md) for what a snapshot actually contains and the full restore
outcome/rollback mechanics; this document only covers the upgrade sequence itself.

## Preflight

- Read the target version's changelog/diff for every service you're upgrading, specifically for a
  new `MIGRATIONS` entry in its `src/db.js` (each service extends
  `@atc-web/service-core`'s `Database` with its own `static MIGRATIONS` array — see "DB migration
  implications" below) and for any new required env var (`Config.fromEnv` in that service throws
  `ConfigError` at startup if one is missing — see "Config validation" below).
- `atc-stack status --matrix` (from `stack/`) to record the current `version`/`schemaVersion`/
  `serviceCore` of every service before you touch anything — this is your rollback reference point,
  and the same command you'll re-run at the end to confirm the upgrade (`stack/src/stack.js:182-255`,
  `Stack#matrix`).

## Backup

```
npm run backup            # from stack/ — see BACKUP.md for exactly what this captures/excludes
```

Do this before touching any service's code or config, even for a same-day rollout — it is the
supported rollback path, not merely a precaution (see "Rollback decision" below). `stack backup`
does not stop anything and is safe to run against a live stack (`VACUUM INTO` against each live
database, per BACKUP.md).

## Service-core compatibility check

Every service pins its own `@atc-web/service-core` version and reports it at `GET /v1/info` as
`serviceCore` (Stage 7, `stack/src/manifest.js` / each service's `/v1/info` route). `atc-stack status
--matrix` reads this from every service and prints a warning line when more than one `serviceCore`
major is present across the fleet (`Stack#matrix` → `#printMatrix`, `stack/src/stack.js:232-255`;
proven by `stack/test/matrix.test.js`, "a mismatched serviceCore major never affects the
ok/exit-code semantics").

**This warning is informational only.** Per that same test and the code it exercises: a
`serviceCore` major mismatch across services never blocks a service from starting, never appears as
a startup check anywhere, and never affects `matrix()`'s or `status()`'s `ok`/exit-code semantics —
`ok` reflects only `/health`+`/ready` reachability, exactly like plain `status()`. A `serviceCore`
**minor** difference is not flagged as incompatible at all — the mismatch grouping in
`#printMatrix` buckets purely by major version (`stack.js:245-251`; also proven by the matrix test
suite's "grouping is by MAJOR only" assertion).

**Services in this workspace are independently deployable — there is no global lockstep
requirement.** Do not read the `serviceCore` warning as "every service must be on the same version
before upgrading the next one." It exists so an operator upgrading services one at a time (the
normal case — see "Service rollout" below) can see the fleet's version spread at a glance, nothing
more.

**Two separate concerns, do not conflate them:**
- **API compatibility** — whether callers of a service's HTTP `/v1` contract still work after the
  upgrade. This is about the wire contract that service exposes, unrelated to `serviceCore`.
- **DB schema compatibility** — whether that service's *own* database's migrations are
  forward-only-safe (see next section). This is purely local to one service and its own database
  file; it has nothing to do with any other service's `serviceCore` version or schema.
A `serviceCore` major mismatch says nothing about either of these on its own — it only tells you
which shared-library generation each service was built against.

## Config validation

There is no separate "validate config" command. Configuration validation happens as an unavoidable
part of a service actually starting: every service's entry point builds its `Config` via
`Config.fromEnv(process.env)` as the first argument to its `Application` constructor (e.g.
`notify/src/application.js:76-78`, and the equivalent in every other service), which runs — and can
throw `ConfigError` — strictly before that service's `Database` is even constructed, let alone
migrated. A missing or malformed required env var therefore always fails fast, before any migration
is attempted, as part of the normal `pm2 start`/`stack up` step below. There is nothing to run ahead
of that step beyond the preflight changelog read above (to know what a new required var would be).

## DB migration implications

Every stateful service's `Database` (`@atc-web/service-core/src/db.js`, subclassed per service with
that service's own `static MIGRATIONS` array) applies any pending migration the moment its
constructor runs, inside the service's own normal startup path — there is no separate migration
step or command, and a fresh install and an upgrade of an existing database go through the exact
same code path (`service-core/src/db.js:84-107`, `#migrate`).

**Migrations are forward-only. There is no `migrate down`, in this codebase or in `service-core`.**
Every migration is one SQL block in `MIGRATIONS[]`, applied in its own `BEGIN`/`COMMIT`; nothing
generates or runs an inverse.

**Never assume rolling back to the previous binary is safe once its DB schema has moved forward.**
The moment a migration has been applied and `PRAGMA user_version` has advanced, starting the
*previous* version of that service's code against that same database file is not automatically
safe — `Database`'s constructor checks `user_version` against `this.constructor.MIGRATIONS.length`
and refuses outright when the file is ahead of what the running build supports:

```
database is newer than this build supports (schema v<current>, build supports up to v<migrations.length>); refusing to open <path>
```

(the exact message thrown as `ConfigError`, `service-core/src/db.js:90`). This is not a soft warning
— it is a hard refusal to open the database at all, so an older binary started against a newer
schema does not start. **This applies even if a given migration happens to be additive-only and
would, in principle, tolerate the old code reading around the new column/table** — the guard doesn't
inspect what a migration actually changed, only the version number, so it refuses uniformly. Do not
special-case a "safe" migration in an upgrade runbook on that basis. **The supported rollback path
is restoring the pre-migration backup** — either the automatic `<DB_PATH>.pre-v<N>-<timestamp>` copy
`Database` itself writes just before applying the first pending migration (`#backup`,
`service-core/src/db.js:109-122`, skipped for `:memory:` and for a brand-new database with nothing
to protect), or an `atc-stack backup` snapshot taken beforehand — not simply checking out the old
code and pointing it at the now-migrated file. See [BACKUP.md](BACKUP.md) for the full restore
procedure and its outcome states.

### Worker-split rollout ordering (notify, scheduler, webhook-out)

These three services are the ones with `splitWorkers: true` in `stack/src/manifest.js` and their own
`src/api-main.js`/`src/worker-main.js` entry points (Stage 6), started as `<id>-api` + `<id>-worker`
under `atc-stack up --split-workers` instead of one combined process
(`Stack#generateSplitEcosystem`, `stack/src/stack.js:102-127`).

**Both the api and the worker process independently construct their own `Application`, and every
`Application` constructor — regardless of `role` — opens its own `Database(config.dbPath, ...)`
against the same file** (confirmed in the real code: `notify/src/application.js:34-39`,
`scheduler/src/application.js:34-44`, `webhook-out/src/application.js:34-39` all show identical
`this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir })` regardless of `role`).
There is no leader-election or single-migration-owner mechanism between the two split processes —
migration ownership is "whichever process's `Database` constructor runs first (or wins the SQLite
write lock) for a given pending version."

**This is not proven safe for a true simultaneous first start, and nothing in the code or test
suite claims it is.** `service-core`'s own migration tests
(`service-core/test/db.test.js`) cover reopening after a completed migration (no re-invocation, the
`schema_migrations` version `PRIMARY KEY` catching a *corrupted* `user_version` that fools the
version-gate into re-attempting an already-applied, idempotent migration) but there is no test for
two `Database` instances racing to migrate the *same* database file from a genuinely pending version
at the same time. Reasoning from the actual transaction shape (`#migrate`, `service-core/src/db.js:
84-107`): each migration runs inside its own `BEGIN`/`COMMIT` with `busy_timeout = 5000`, so SQLite
serializes the two processes' writes rather than corrupting the file — but the *loser* of that race,
having already read `user_version` as pending before the winner committed, will attempt to
re-apply the same migration SQL once it gets the write lock. If that migration is not itself
idempotent (most `CREATE TABLE`/`ALTER TABLE` migrations in this codebase are not — see the "canary"
test in `service-core/test/db.test.js`, "reopening at the latest version never re-invokes an
already-applied migration callback"), the loser's own migration statement throws, its transaction
rolls back, and that process's `Database` constructor — and so its whole startup — throws. **Treat a
simultaneous first start of both split processes against a database with a pending migration as
unsupported**, not as a race that has been made safe by design.

**Rollout ordering for `--split-workers` across an upgrade that includes a pending migration:**
start the two processes staggered, not simultaneously, so exactly one of them performs the
migration and the second one only ever opens an already-current database:

1. Stop both `<id>-api` and `<id>-worker` (or use `atc-stack down --split-workers` for the whole
   affected service).
2. `npm ci` the new code.
3. Start **one** of the two processes first (either one — `role` doesn't change what
   `Database` does) and wait for it to report ready before starting the second. In practice this
   means: `pm2 start <id>-worker` (or `<id>-api`), wait for its readiness signal (`/ready` for the
   api process; for the worker process, which has no HTTP listener at all — "PM2's own process
   state is the liveness signal for this role", `notify/src/worker-main.js` — wait for PM2 to report
   it online and check its log for the migration having completed, or simply pause a few seconds
   given migrations in this codebase run synchronously at startup before either role does anything
   else), then start the second process.
4. `atc-stack up --split-workers` itself starts every service's two apps back-to-back within the
   same loop with no readiness gate between `<id>-api` and `<id>-worker` (`Stack#up`,
   `stack/src/stack.js:65-75` — `pm2 startOrRestart` is called for one app, then immediately the
   next) — **this is fine when there is no pending migration for that service** (both processes just
   open an already-current database, which is the common case), but is exactly the scenario above to
   avoid for a service that does have a new migration in this upgrade. For a split-workers upgrade
   that includes a migration, restart that one service's two processes by hand with the pause in
   step 3, rather than relying on `atc-stack up --split-workers` for that service.

Every other service in the manifest has no `splitWorkers` flag and only ever runs one process per
service, so this ordering concern does not apply to it — one process, one `Database` instance, no
race is possible.

## Service rollout

Per service you're upgrading:

```
git -C <service> pull
cd <service> && npm ci
pm2 restart <service>       # or, for a split-capable service already run with --split-workers,
                             # restart its two apps per "Worker-split rollout ordering" above
```

This is the step where config validation (above) and DB migration (above) both actually happen, as
part of that service's own normal startup — there's nothing additional to run. A fresh install and
an upgrade of an existing database go through the exact same migration code, so there's no separate
"first run" path to get out of sync with the upgrade path.

For the whole workspace at once: `atc-stack up [--split-workers]` (`npm run up` from `stack/`) —
iterates every service in manifest order (`stack/src/manifest.js`) and `pm2 startOrRestart`s it.

## Readiness verification

```
npm run status              # from stack/ — confirm every service reports health=200 ready=200
```

`Stack#status` (`stack/src/stack.js:154-164`) probes every service's `/health` and `/ready` in
manifest order and reports `ok` only when both are `200`. Do this before moving on to the matrix
check below — a service that isn't ready yet will also just show `?` fields in the matrix, which is
less specific about what's actually wrong.

## Matrix verification

```
npm run status -- --matrix    # or: atc-stack status --matrix
```

Confirms, per service, `version`/`apiVersion`/`schemaVersion`/`serviceCore`/`capabilities` as read
from its own `GET /v1/info` (`Stack#matrix`, `stack/src/stack.js:182-194`). Compare against the
preflight snapshot you took at the start: `schemaVersion` for each upgraded service should now match
that service's own highest `MIGRATIONS` index; `version`/`apiVersion` should match what you intended
to deploy. A service that hasn't adopted `/v1/info` yet, or is unreachable, reports `infoOk: false`
with a human-readable `infoError` (`no /v1/info (older version)`, `unreachable: ...`, etc.) rather
than aborting the whole command — every other row still reports normally (`Stack#info`,
`stack.js:196-230`).

## Rollback decision

**None of the migrations are reversible.** If the upgrade needs to be rolled back:

1. Decide whether any migration actually ran during this upgrade (check the matrix output's
   `schemaVersion` against your preflight snapshot, or that service's own
   `<DB_PATH>.pre-v<N>-<timestamp>` file appearing). If none did, checking out the previous code and
   restarting is sufficient — there's no schema mismatch to worry about.
2. If a migration did run: **do not** just check out the previous version of that service's code and
   start it — per "DB migration implications" above, the old binary's `Database` constructor will
   refuse to open a database whose `user_version` is ahead of what it supports. Instead:
   - `atc-stack restore <snapshot-dir>` from the `atc-stack backup` you took in the Backup step
     above (or, as a last resort if that snapshot is unavailable, restore that service's own
     automatic `<DB_PATH>.pre-v<N>-<timestamp>` copy by hand) — see [BACKUP.md](BACKUP.md) for the
     full restore procedure, validation, and the exact `restored`/`rolled_back`/`rollback_incomplete`
     outcomes it can produce.
   - Then check out the previous version of that service's code and restart it against the restored
     file.
3. A backup taken *after* the upgrade already reflects the new schema and cannot be used to go back
   to the old code — the rollback backup has to predate the migration that ran.

See [BACKUP.md](BACKUP.md) for secret/key semantics that also matter on a rollback (a restored
database and a mismatched signing/sealing key can break verification even when the schema itself
restores cleanly).
