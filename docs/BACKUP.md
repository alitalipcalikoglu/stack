# Backup and restore

What `stack backup`/`stack restore` (`npm run backup` / `npm run restore --` from `stack/`, or the
installed `atc-stack backup`/`atc-stack restore` binary — all three run the exact same code,
`bin/stack.js` → `Stack#backup`/`Stack#restore` → `src/snapshot.js`'s `Snapshot` class) actually do,
today, read from that code. This is the Stage 3 tooling; nothing here is a design intent that later
shifted without the code catching up — where the plan (`IMPLEMENTATION_PLAN.md`, Stage 3) says
something slightly different from what shipped, that's called out inline.

## What a snapshot contains

A snapshot is a plain directory — no archive/compression step (`Snapshot.create`,
`stack/src/snapshot.js:132-177`). Default location `stack/backups/<timestamp>/` (ISO timestamp with
`:`/`.` replaced by `-`); `--dir <path>` overrides it. Inside: one `manifest.json` plus one
subfolder per service.

Per service (`stack/src/snapshot.js:37-51`, `EXTRA_PATHS`, `DB_SERVICES`, `ALL_SERVICES`):

| Service | What's captured | How |
|---|---|---|
| Every stateful service (notify, auth, media, audit, shortlink, flags, scheduler, webhook-out, search, ratelimit, geo, console) | its SQLite database at `DB_PATH` | `PRAGMA user_version` read, then `VACUUM INTO` a fresh file — a consistent read snapshot, safe against a live WAL writer, no service is stopped (`Snapshot.#backupDb`, `snapshot.js:383-394`) |
| `media` | `objects/` and `variants/` under `DATA_DIR` (content-addressed blob storage) | recursive directory copy |
| `auth` | `keys/` (the JWT signing key pair) | recursive directory copy |
| `gateway` | `routes.json` (its only state — no database) | file copy |
| `console` | `services.json`, alongside its database | file copy |
| `gateway` has no database | — | `DB_SERVICES` excludes it; `ALL_SERVICES` still includes it for `routes.json` |

Every directory/file path above is resolved from that service's own `.env` at backup time (e.g.
media's `DATA_DIR`, gateway's `ROUTES_FILE`), not hardcoded — the manifest always reflects what the
service was actually configured to use (`snapshot.js:37-45`, `envVar`/`relTo` helpers).

`manifest.json` (`manifestVersion: 1`, `createdAt`, `entries: []`) records, per entry: `service`,
`kind` (`'db'`, `'dir'`, or `'file'`), `path` (relative to the service folder), `packageVersion`
(that service's own `package.json` version at backup time), `sha256` (a per-file hash, or for a
directory a deterministic hash over every file's `relativePath\0sha256\n`, sorted — `#hashDir`,
`snapshot.js:452-457`), and for a database entry only, `schemaVersion` (`PRAGMA user_version` read
before the `VACUUM INTO`). There is no separate top-level "manifest" of service versions beyond
what's recorded per entry — every entry carries its own `packageVersion`.

## What's excluded, and why

- **`.env` files** — never touched by `Snapshot.create`; not in `EXTRA_PATHS`, not derived from any
  path inside one. Deliberate: these are secrets, out of scope for a data snapshot. See "Secret and
  key backup semantics" below for what this means operationally.
- **`node_modules`, PM2 logs** — not data, regenerable/rotated independently.
- **media's `tmp/` and `trash/`** — excluded because `EXTRA_PATHS.media` only lists `objects` and
  `variants` (`snapshot.js:38-41`). Per `media/src/storage/local-storage.js:27,51-53,62`: `tmp/`
  holds in-flight uploads and scratch content, wiped on every `prepare()` (service start) and left
  alone by `check()` (the readiness probe); `trash/` holds objects/variants moved aside by a purge,
  pending permanent deletion — neither is durable state worth snapshotting.
- **audit's `keys/`** (the Ed25519 anchor signing key pair, when `ANCHOR_PRIVATE_KEY_PATH` is
  configured) — audit is in `DB_SERVICES` (its database is backed up) but **not** in `EXTRA_PATHS`,
  so its `keys/` directory is never part of a `stack backup` snapshot. `audit/README.md` states this
  explicitly ("audit is not itself included in its own backup scope beyond its database") and tells
  operators to back up `keys/` themselves, the same way `.env` must be. This is a real gap between
  "everything a service needs to keep working" and what `stack backup` covers — see "Secret and key
  backup semantics" below.
- **console's `SECRETS_KEY`/`SECRETS_PREVIOUS_KEY`** — env-var only, no file; excluded because
  everything under `.env` is excluded.
- **Symlinks, anywhere** — `Snapshot.create` throws rather than back up a symlink
  (`snapshot.js:162`, `#copyDir`'s symlink check at `snapshot.js:440`), and `restore()` refuses a
  snapshot entry that turns out to be a symlink (`#assertNoSymlinks`, `snapshot.js:422-426`).

**Plan-vs-code note:** `IMPLEMENTATION_PLAN.md` Stage 3 describes the same backup scope (per-service
DB, media objects/variants, auth/keys, gateway routes.json, console services.json) and matches the
real `EXTRA_PATHS` map exactly. The one place the plan text is easy to misread is audit: the plan
never explicitly says audit's anchor keys are included, and the real code does not include them —
consistent, not a drift, but worth stating plainly since it's a genuine operational gap (see below).

## Restore flow

`stack restore <snapshot-dir> [--service <id>]` (default: every service the manifest covers).
`Stack#restore` (`stack.js:285-309`) wraps `Snapshot#restore` (`snapshot.js:185-240`) with PM2
stop/start and a readiness wait; the validation and apply/rollback logic below is entirely inside
`Snapshot#restore`.

**Nothing live is touched until everything is validated:**

1. **Manifest validation** — `manifest.json` must parse as JSON and have `manifestVersion === 1`
   and an `entries` array, or restore refuses with "not a recognised snapshot manifest" before
   reading anything else (`Snapshot.#loadManifest`, `snapshot.js:397-411`).
2. **Per-entry checksum validation** — every requested entry's file/directory must exist in the
   snapshot and its hash must match the manifest's recorded `sha256` exactly (directories via the
   same deterministic `#hashDir`); a missing file is "incomplete backup", a hash mismatch is
   "corrupt backup" (`snapshot.js:199-203`). Path-traversal guard: every source and target path is
   resolved and asserted to stay inside the snapshot directory / the target service folder
   respectively (`#assertInside`, `snapshot.js:413-419`), and every file is checked for symlinks
   (`#assertNoSymlinks`).
3. **Staged DB validation** — for every database entry, the snapshot's copy is copied to a temp
   file and opened through *that target service's own, currently-checked-out* `Database` subclass
   (`import(...'/src/db.js')`, `#validateStagedDb`, `snapshot.js:309-322`). This is the real
   forward-schema guard: `Database`'s constructor (`service-core/src/db.js:88-91`) throws
   `ConfigError` — `` `database is newer than this build supports (schema v${current}, build
   supports up to v${migrations.length}); refusing to open ${this.path}` `` — the moment it sees a
   `user_version` higher than the running code's `MIGRATIONS.length`, so a snapshot from a newer
   deploy is rejected here, before any live file is touched. On success, `#validateStagedDb` also
   runs `PRAGMA integrity_check` on the staged copy and requires the literal result `'ok'`
   (`snapshot.js:316-317`) — this is real SQLite integrity checking, not a name-only check. A staged
   database that is merely *older* than the running code migrates forward cleanly inside this same
   validation step, exactly as a normal upgrade's first start would.

**Then, applying is two phases, both scoped to one shared `runId` (a timestamp)** — from the
`Snapshot` class docstring (`snapshot.js:83-97`) and the `#abortPrepare`/`#rollbackApplied` methods:

1. **Prepare** — every live target that currently exists is moved aside (never deleted, `renameSync`)
   to `<path>.before-restore-<runId>`, one item at a time (`#moveAside`, `snapshot.js:331-338`). A
   target that doesn't exist yet has no aside copy (`aside: null`) — its correct "reverted" state is
   simply absent.
2. **Apply** — the validated snapshot content is written into each now-cleared target in turn
   (`#applyContent`, `snapshot.js:345-350`).

**Outcomes — the real three strings the code produces** (`RestoreResult.outcome`,
`snapshot.js:55-59`, matching the plan's naming exactly):

- **`restored`** — every requested item now holds the snapshot's content. `Stack#restore` then
  `pm2 start`s every affected service and waits up to 20s for `/ready`.
- **`rolled_back`** — prepare or apply failed on one item, but every item touched so far (including
  the failed one) was successfully reverted to its pre-restore state from its own aside copy
  (`#abortPrepare` for a prepare-phase failure, `#rollbackApplied` for an apply-phase failure —
  `snapshot.js:248-298`). `Stack#restore` still restarts every affected service (safe: it's exactly
  what was running before the call) and then throws, so the CLI still reports a non-zero exit for a
  failed restore even though nothing was lost (`stack.js:305-307`).
- **`rollback_incomplete`** — the restore failed **and** reverting at least one item also failed
  (its aside copy went missing, a second I/O error mid-rollback, …). This is never folded into an
  ordinary failure; it is its own distinct outcome specifically because "the rollback also failed"
  needs a human to look, not a retry. **`Stack#restore` starts nothing** in this case
  (`stack.js:294-299`) — a stopped service is treated as safer than one started against a file
  whose state is unknown. The result's `rolledBack` array lists items confirmed back at their
  original state; `rollbackFailed` lists `{ service, path, error }` for every item whose state is
  now unknown, each pointing at its `.before-restore-<runId>` copy to inspect by hand.

### Crash / power-loss during restore itself

This is a best-effort, in-process saga, not a filesystem transaction spanning every service's files
(`Snapshot` class docstring, `snapshot.js:98-108`). It protects against *ordinary* failures during
apply — a permissions problem, a full disk, a missing aside copy — every one of those is caught and
produces `rolled_back` or `rollback_incomplete` as above. **It does not protect against the `stack
restore` process itself being killed, or the host losing power, partway through prepare or apply.**
There is no journal and no automatic resume: `stack/test/snapshot.test.js` covers the ordinary
failure paths (a real permission failure preparing one target rolls back everything untouched; with
at least two targets already applied, a real I/O failure on the third rolls all three back; a
second, distinct failure during rollback itself reports `rollback_incomplete` rather than pretending
the rollback succeeded) — none of those tests, and nothing in the implementation, cover the
process/machine dying mid-run. If that happens:

- Some targets may already be on the new snapshot's content, others still on the old, and
  `.before-restore-<runId>` aside copies sit next to whichever targets prepare had already touched
  when the process died.
- The affected services were already stopped by `Stack#restore` before `Snapshot#restore` ran, and
  nothing restarts them automatically — they stay stopped until an operator acts.
- **Operator recovery procedure (manual, by hand — there is no command for this):**
  1. `ls` each affected service's data directory for `*.before-restore-<runId>` (the `runId` is the
     restore's own timestamp, printed at the start of that restore attempt/in its logs) to see
     exactly which targets that run had already touched.
  2. For each such target, compare the current live file/directory against its
     `.before-restore-<runId>` sibling and decide, per item, which one is the state you want live —
     there is no way to tell automatically which side "won."
  3. Once every affected target's live content is in the state you've decided on, re-run `stack
     restore <same-snapshot-dir>` if you still want the snapshot applied (it re-validates from the
     snapshot from scratch every time — the earlier partial run doesn't leave any state that biases
     or blocks the retry) or start the service as-is if you've decided to keep what's currently
     there.
  4. Only start the affected services (`pm2 start <id>`) once you're confident which content is
     actually live for every item that run touched.

This is a deliberate scope decision documented in the code itself, not an oversight: a
restore-journal that detects and resumes an interrupted run is real complexity for a failure mode
(the operator's own restore process or machine dying mid-restore, while every affected service is
already stopped) that ordinary in-process error handling does not need to solve.

### Retention of `.before-restore-<runId>` copies

Never deleted automatically by any outcome — success, `rolled_back`, or `rollback_incomplete`
(`snapshot.js:107-108`). Every aside copy from one `restore` call shares the same `runId`, so
`ls`-ing a service's data directory for `*.before-restore-<same-timestamp>` shows everything one run
touched. Clean them up by hand once you no longer need them.

## Secret and key backup semantics — operational requirement

**`.env` files are excluded from every `stack backup` snapshot, by design.** A DB/data snapshot
restored without separately keeping the matching `.env` (and, for audit, its `keys/` directory — see
above) in sync can silently break verification paths that a restored database alone cannot detect at
restore time:

- **`auth`** — the JWT signing key pair (`keys/`) **is** included in `stack backup` (`EXTRA_PATHS.auth`,
  `snapshot.js:42`), so a `stack backup`/`stack restore` round-trip keeps the database and `keys/`
  together automatically. The risk is only if you restore the database by some other path (the
  automatic `.pre-v<N>-<ts>` copy alone, say) without also restoring `keys/` from the same point in
  time: `auth/README.md` ("Backup / restore") states that restoring the database with a different
  signing key than the one used when it was backed up invalidates every outstanding access token.
  `JWT_PREVIOUS_PUBLIC_KEY_PATH` (env-only, in `.env`) matters here too during a key-rotation window.
- **`console`** — TOTP secrets are sealed at rest under `SECRETS_KEY` (`console/README.md`, "TOTP
  secret storage"). `SECRETS_KEY`/`SECRETS_PREVIOUS_KEY` live only in `.env`, which `stack backup`
  never touches. Restoring console's database without the `SECRETS_KEY` that was live when that
  snapshot was taken means every sealed TOTP row fails to decrypt — the service actually refuses to
  start in that state (`ConfigError`, per `console/README.md`, "TOTP secret storage"), rather than
  silently losing 2FA, but only because that specific failure mode was designed to be loud.
- **`media`** — signed URL verification uses `SIGNING_SECRET`/`SIGNING_SECRET_PREVIOUS`, both
  `.env`-only. Restoring media's database (URLs, metadata) without the matching signing secret
  breaks verification of any URL signed before the restore point.
- **`audit`** — chain anchor verification uses the Ed25519 key pair under `keys/`
  (`ANCHOR_PRIVATE_KEY_PATH`/`ANCHOR_PREVIOUS_PUBLIC_KEY_PATH`), which — unlike `auth`'s `keys/` — is
  **not** part of `stack backup`'s scope at all (see "What's excluded" above). Restoring audit's
  database from a snapshot without separately preserving `keys/` from the same point in time means
  new anchors after the restore may not chain the way an operator expects when cross-checking against
  anchors signed before it, and losing the private key entirely means no anchor can ever be signed
  under that `keyId` again (a fresh pair must be generated and treated as a rotation) — already-signed
  and already-verified anchors stay valid regardless.
- **`webhook-out`** — per-subscription signing secrets are sealed under `SECRETS_KEY` (AES-256-GCM,
  `.env`-only, same exclusion). `webhook-out/README.md` ("Backup / restore") states plainly:
  restoring means putting the database back with the *same* `SECRETS_KEY` that sealed it, or every
  subscriber secret becomes permanently unrecoverable.

**The operational requirement, stated once, plainly: back up `.env` (every service) and audit's
`keys/` directory separately from `stack backup`, keep that separate copy in sync with whatever `stack
backup` snapshot you intend to restore alongside, and never restore a database snapshot against a
`.env`/key state that doesn't match the point in time the snapshot was taken from.** `stack
backup`/`stack restore` deliberately do not manage secrets — that is out of scope by design (see
"What's excluded" above), not an omission to fix later; managing it is entirely on the operator's own
secret-management process.

Never write actual secret values into a backup, this document, or any other doc — only which env vars
and files are involved, as above.
