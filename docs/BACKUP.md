# Backup and restore

What `stack backup`/`stack restore` (`npm run backup` / `npm run restore --` from `stack/`, or the
installed `atc-stack backup`/`atc-stack restore` binary — all three run the exact same code,
`bin/stack.js` → `Stack#backup`/`Stack#restore` → `src/snapshot.js`'s `Snapshot` class) actually do,
today, read from that code. This is the Stage 3 tooling; nothing here is a design intent that later
shifted without the code catching up — where the plan (`IMPLEMENTATION_PLAN.md`, Stage 3) says
something slightly different from what shipped, that's called out inline.

## What a snapshot contains

A snapshot is a plain directory — no archive/compression step (`Snapshot.create`,
`stack/src/snapshot.js:184-229`). Default location `stack/backups/<timestamp>/` (ISO timestamp with
`:`/`.` replaced by `-`); `--dir <path>` overrides it. Inside: one `manifest.json` plus one
subfolder per service.

Per service (`stack/src/snapshot.js:44-97`, `EXTRA_PATHS`, `DB_SERVICES`, `ALL_SERVICES`):

| Service | What's captured | How |
|---|---|---|
| Every stateful service (notify, auth, media, audit, shortlink, flags, scheduler, webhook-out, search, ratelimit, geo, console) | its SQLite database at `DB_PATH` | `PRAGMA user_version` read, then `VACUUM INTO` a fresh file — a consistent read snapshot, safe against a live WAL writer, no service is stopped (`Snapshot.#backupDb`, `snapshot.js:435-446`) |
| `media` | `objects/` and `variants/` under `DATA_DIR` (content-addressed blob storage) | recursive directory copy |
| `auth` | `keys/` (the JWT signing key pair) | recursive directory copy |
| `gateway` | `routes.json` (its only state — no database) | file copy |
| `console` | `services.json`, alongside its database | file copy |
| `audit` | the Ed25519 anchor signing key pair — `ANCHOR_PRIVATE_KEY_PATH`, plus `ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` when a rotation is in progress — **only when anchoring is configured at all** | file copy (see "Anchor key backup semantics" below — this one has real edge cases the others don't) |
| `gateway` has no database | — | `DB_SERVICES` excludes it; `ALL_SERVICES` still includes it for `routes.json` |

Every directory/file path above is resolved from that service's own `.env` at backup time (e.g.
media's `DATA_DIR`, gateway's `ROUTES_FILE`, audit's `ANCHOR_PRIVATE_KEY_PATH`), not hardcoded — the
manifest always reflects what the service was actually configured to use (`snapshot.js:16-34`,
`envVar`/`relTo`/`pathInside` helpers). `auth`'s `keys` is the one exception, hardcoded rather than
resolved from `JWT_PRIVATE_KEY_PATH` — a pre-existing convention this phase deliberately left alone
(out of scope: this phase closes audit's gap, not auth's hardcoding; see "Auth regression" coverage
in `stack/test/snapshot.test.js`, which proves the existing behavior still works unchanged).

`manifest.json` (`manifestVersion: 1`, `createdAt`, `entries: []`) records, per entry: `service`,
`kind` (`'db'`, `'dir'`, or `'file'`), `path` (relative to the service folder), `packageVersion`
(that service's own `package.json` version at backup time), `sha256` (a per-file hash, or for a
directory a deterministic hash over every file's `relativePath\0sha256\n`, sorted — `#hashDir`,
`snapshot.js:509-514`), and for a database entry only, `schemaVersion` (`PRAGMA user_version` read
before the `VACUUM INTO`). There is no separate top-level "manifest" of service versions beyond
what's recorded per entry — every entry carries its own `packageVersion`. **The manifest never
carries key bytes, only a filename and a checksum** — same as every other entry kind; a private key's
actual bytes exist in exactly one place in a snapshot: its own file, under that service's subfolder.

## What's excluded, and why

- **`.env` files** — never touched by `Snapshot.create`; not in `EXTRA_PATHS`, not derived from any
  path inside one. Deliberate: these are secrets, out of scope for a data snapshot. See "Secret and
  key backup semantics" below for what this means operationally.
- **`node_modules`, PM2 logs** — not data, regenerable/rotated independently.
- **media's `tmp/` and `trash/`** — excluded because `EXTRA_PATHS.media` only lists `objects` and
  `variants` (`snapshot.js:45-48`). Per `media/src/storage/local-storage.js:27,51-53,62`: `tmp/`
  holds in-flight uploads and scratch content, wiped on every `prepare()` (service start) and left
  alone by `check()` (the readiness probe); `trash/` holds objects/variants a purge has quarantined,
  pending permanent deletion — as of post-production Phase 4, media's own maintenance
  (`LocalStorage#reconcileTrash`) actively cleans up an aged `trash/` entry itself rather than
  leaving it as a permanent leak, so this is no longer state that only ever grows — neither `tmp/`
  nor `trash/` is durable state worth snapshotting either way.
- **console's `SECRETS_KEY`/`SECRETS_PREVIOUS_KEY`** — env-var only, no file; excluded because
  everything under `.env` is excluded.
- **an out-of-tree `ANCHOR_PRIVATE_KEY_PATH`/`ANCHOR_PREVIOUS_PUBLIC_KEY_PATH`** — if either resolves
  outside the audit service folder (e.g. an operator-mounted HSM path), `EXTRA_PATHS.audit`
  deliberately does not follow it into the snapshot (`pathInside` check, `snapshot.js:52-95`) and logs
  a warning instead — an arbitrary, operator-configured host path is not something a backup tool
  should recursively pull from without being told to. `stack backup` itself still succeeds in this
  case (the database is still backed up); that one key file is simply not part of the snapshot and
  must be backed up through whatever process manages that out-of-tree location. See "Anchor key
  backup semantics" below.
- **Symlinks, anywhere** — `Snapshot.create` throws rather than back up a symlink
  (`snapshot.js:214`, `#copyDir`'s symlink check at `snapshot.js:497`), and `restore()` refuses a
  snapshot entry that turns out to be a symlink (`#assertNoSymlinks`, `snapshot.js:472-476`).

**Plan-vs-code note:** `IMPLEMENTATION_PLAN.md` Stage 3 describes the backup scope as it stood at
Stage 3 (per-service DB, media objects/variants, auth/keys, gateway routes.json, console
services.json) — written before audit's anchor feature existed, so it says nothing about audit
either way. Post-production Phase 3 added audit's anchor key material to `EXTRA_PATHS` without
touching the Stage 3 scope for any other service; this is an addition to the plan's original scope,
not a correction of it.

## Restore flow

`stack restore <snapshot-dir> [--service <id>]` (default: every service the manifest covers).
`Stack#restore` (`stack.js:285-309`) wraps `Snapshot#restore` (`snapshot.js:237-292`) with PM2
stop/start and a readiness wait; the validation and apply/rollback logic below is entirely inside
`Snapshot#restore`.

**Nothing live is touched until everything is validated:**

1. **Manifest validation** — `manifest.json` must parse as JSON and have `manifestVersion === 1`
   and an `entries` array, or restore refuses with "not a recognised snapshot manifest" before
   reading anything else (`Snapshot.#loadManifest`, `snapshot.js:449-463`).
2. **Per-entry checksum validation** — every requested entry's file/directory must exist in the
   snapshot and its hash must match the manifest's recorded `sha256` exactly (directories via the
   same deterministic `#hashDir`); a missing file is "incomplete backup", a hash mismatch is
   "corrupt backup" (`snapshot.js:251-255`). Path-traversal guard: every source and target path is
   resolved and asserted to stay inside the snapshot directory / the target service folder
   respectively (`#assertInside`, `snapshot.js:466-469`), and every file is checked for symlinks
   (`#assertNoSymlinks`). This applies identically to a private key entry (`kind: 'file'`) as to any
   other — a tampered key file is caught here, before restore, the same as a tampered database.
3. **Staged DB validation** — for every database entry, the snapshot's copy is copied to a temp
   file and opened through *that target service's own, currently-checked-out* `Database` subclass
   (`import(...'/src/db.js')`, `#validateStagedDb`, `snapshot.js:361-374`). This is the real
   forward-schema guard: `Database`'s constructor (`service-core/src/db.js:88-91`) throws
   `ConfigError` — `` `database is newer than this build supports (schema v${current}, build
   supports up to v${migrations.length}); refusing to open ${this.path}` `` — the moment it sees a
   `user_version` higher than the running code's `MIGRATIONS.length`, so a snapshot from a newer
   deploy is rejected here, before any live file is touched. On success, `#validateStagedDb` also
   runs `PRAGMA integrity_check` on the staged copy and requires the literal result `'ok'`
   (`snapshot.js:368-369`) — this is real SQLite integrity checking, not a name-only check. A staged
   database that is merely *older* than the running code migrates forward cleanly inside this same
   validation step, exactly as a normal upgrade's first start would.

**Then, applying is two phases, both scoped to one shared `runId` (a timestamp)** — from the
`Snapshot` class docstring (`snapshot.js:135-148`) and the `#abortPrepare`/`#rollbackApplied` methods:

1. **Prepare** — every live target that currently exists is moved aside (never deleted, `renameSync`)
   to `<path>.before-restore-<runId>`, one item at a time (`#moveAside`, `snapshot.js:383-390`). A
   target that doesn't exist yet has no aside copy (`aside: null`) — its correct "reverted" state is
   simply absent.
2. **Apply** — the validated snapshot content is written into each now-cleared target in turn
   (`#applyContent`, `snapshot.js:397-402`), byte-for-byte plus its original POSIX permission bits
   (`#copyFile`, `snapshot.js:479-489` — see "Permissions" under "Anchor key backup semantics" below).

This is per-`runId` **across every requested item together, not per service** — when audit's database
and its anchor key are both part of one `restore()` call (the default: restoring "audit" restores
everything the manifest recorded for it), they share the same prepare/apply pass. A failure applying
the key after the database has already been applied rolls **both** back together, not just the one
that failed — see "Restore atomicity for audit's DB + key" below; this isn't special-cased code, it's
what `restore()` already did for every other multi-entry service (media's db + objects + variants).

**Outcomes — the real three strings the code produces** (`RestoreResult.outcome`,
`snapshot.js:106-111`, matching the plan's naming exactly):

- **`restored`** — every requested item now holds the snapshot's content. `Stack#restore` then
  `pm2 start`s every affected service and waits up to 20s for `/ready`.
- **`rolled_back`** — prepare or apply failed on one item, but every item touched so far (including
  the failed one) was successfully reverted to its pre-restore state from its own aside copy
  (`#abortPrepare` for a prepare-phase failure, `#rollbackApplied` for an apply-phase failure —
  `snapshot.js:300-350`). `Stack#restore` still restarts every affected service (safe: it's exactly
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
(`Snapshot` class docstring, `snapshot.js:150-157`). It protects against *ordinary* failures during
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
(`snapshot.js:159-160`). Every aside copy from one `restore` call shares the same `runId`, so
`ls`-ing a service's data directory for `*.before-restore-<same-timestamp>` shows everything one run
touched. Clean them up by hand once you no longer need them.

## ⚠ Stack backup now contains cryptographic private material

**A `stack backup` snapshot can contain real signing-key private material — `auth`'s JWT private key
always, and `audit`'s anchor private key whenever anchoring is configured.** Anyone with read access
to a snapshot directory has read access to those services' signing identities: they could mint valid
access tokens (auth) or sign anchors indistinguishable from the real service's own (audit), not merely
read data.

**Treat every `stack backup` snapshot as production secret material, not a plain data export:**
- Store it with the same access control as `.env`/production credentials — restricted filesystem
  permissions, restricted operator access.
- **`stack backup`/`stack restore` do not encrypt anything.** There is no at-rest encryption, no
  passphrase, no archive step at all (see "What a snapshot contains" above) — a snapshot directory's
  files are exactly as readable as any other file the backup process wrote. If you need encryption at
  rest, apply it yourself (encrypted filesystem, encrypting the directory into an archive after
  `stack backup` runs, an encrypted backup target) — nothing here does it for you, and nothing here
  should be read as implying otherwise.
- Never attach a snapshot, or any part of one, to a log, a ticket, a chat message, or any other
  channel that isn't itself under the same access control as a production secret.
- `.env` files are **still** excluded from every snapshot (unchanged) — `SECRETS_KEY`/
  `SECRETS_PREVIOUS_KEY` (console, webhook-out), `JWT_PREVIOUS_PUBLIC_KEY_PATH`/`NOTIFY_API_KEY`/every
  other env-only secret, and console/media's own signing secrets are **not** in a snapshot regardless
  of this section. Only the two file-based signing keys named above are.

## Secret and key backup semantics — operational requirement

**`.env` files are excluded from every `stack backup` snapshot, by design.** A DB/data snapshot
restored without separately keeping the matching `.env` in sync can silently break verification paths
that a restored database alone cannot detect at restore time:

- **`auth`** — the JWT signing key pair (`keys/`) **is** included in `stack backup` (`EXTRA_PATHS.auth`,
  `snapshot.js:49`), so a `stack backup`/`stack restore` round-trip keeps the database and `keys/`
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
- **`audit`** — chain anchor verification uses the Ed25519 key pair — **now included** in `stack
  backup` when `ANCHOR_PRIVATE_KEY_PATH` is configured (`EXTRA_PATHS.audit`, `snapshot.js:52-95` — see
  "Anchor key backup semantics" below for the full behavior, including what happens when it isn't
  configured, or is configured but missing, or points outside the audit service folder).
- **`webhook-out`** — per-subscription signing secrets are sealed under `SECRETS_KEY` (AES-256-GCM,
  `.env`-only, same exclusion). `webhook-out/README.md` ("Backup / restore") states plainly:
  restoring means putting the database back with the *same* `SECRETS_KEY` that sealed it, or every
  subscriber secret becomes permanently unrecoverable.

**The operational requirement for everything above `.env`-only: keep each service's `.env` in sync
with whatever `stack backup` snapshot you intend to restore alongside, backed up through your own
secret-management process, and never restore a database snapshot against an `.env` state that doesn't
match the point in time the snapshot was taken from.** `stack backup`/`stack restore` deliberately do
not manage `.env`-only secrets — that is out of scope by design, not an omission to fix later.

Never write actual secret values into a backup, this document, or any other doc — only which env vars
and files are involved, as above.

## Anchor key backup semantics

`EXTRA_PATHS.audit` (`snapshot.js:52-95`) resolves `ANCHOR_PRIVATE_KEY_PATH` and (if set)
`ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` from audit's own `.env`, the same way `media`/`gateway`/`console`
resolve their configurable paths — not a hardcoded `keys/` guess. Three states:

- **Anchoring not configured** (`ANCHOR_PRIVATE_KEY_PATH` empty, the default) — nothing to back up;
  no entry, no error. Matches the running service's own behavior: no key configured means the anchor
  feature is simply off.
- **Configured and the file exists** — included, exactly like any other `EXTRA_PATHS` entry: file
  copy, checksummed in the manifest, permission bits preserved (see below).
- **Configured but the file is missing** — `stack backup` **refuses** (throws, whole backup fails),
  rather than silently completing a snapshot that looks whole but can never restore a working anchor
  identity. This matches the real service's own contract exactly: `AnchorSigner.fromFiles`
  (`audit/src/crypto/anchor-signer.js:98-103`) does the identical `readFileSync` that would throw, and
  `Application`'s constructor doesn't catch it — a real audit deployment in this exact state already
  refuses to start. A backup tool silently producing a "complete" snapshot for a service that can't
  currently start is a worse failure mode than a loud backup error.

**What's actually needed for continuity, and why both files matter:** anchor *signing* only needs the
current private key (the running service derives its own current public key from it — there is no
separate public-key file the service reads back for itself; `anchor-keygen`'s public-key output is for
operator export/publishing only). But *verifying* an anchor signed under a since-rotated-out key needs
that old key's **public** half — `ANCHOR_PREVIOUS_PUBLIC_KEY_PATH` — since the database itself never
stores key material, only a `key_id`/`signature` pair per anchor (`audit/src/db.js`'s `anchors` table).
Backing up only the current private key and skipping a configured previous-public-key file would
silently break verification of every anchor signed before the last rotation — this is why
`EXTRA_PATHS.audit` resolves and validates both independently, not just the private key.

**Out-of-tree paths:** if either configured path resolves outside the audit service folder,
`EXTRA_PATHS.audit` does not follow it into the snapshot (see "What's excluded" above) — an
operator-chosen path outside the service's own data/config boundary (an HSM mount, a path managed by
a separate secrets pipeline) is deliberately not something `stack backup` reaches into unasked. This
is a warning (`this.log`), not a fatal backup error — a security choice, not a completeness one; the
warning is exactly where a `--dir`/log-watching operator would see it.

**Restore atomicity for audit's DB + key:** restoring "audit" restores its database and its anchor
key entries in the **same** `restore()` call, sharing one prepare/apply pass — this is the same
mechanism (`stack/test/snapshot.test.js`) proves for every other multi-entry service; nothing
audit-specific was added. A failure applying the key after the database has already been applied
rolls **both** back to their pre-restore state together, never leaving the database on the new
snapshot with the old key (or the reverse). Regression-tested: `stack/test/snapshot.test.js`
("restore failure rolls the audit database and its anchor key back together, as one consistency
unit").

**Permissions:** `#copyFile` (`snapshot.js:479-489`) now preserves the source file's POSIX permission
bits on every copy (backup AND restore), instead of `writeFileSync`'s process-umask default — a
private key written by `AnchorKeyGenerator`/`KeyGenerator` at `0600` stays `0600` through a
backup/restore round-trip rather than coming back world/group-readable. This applies to `auth`'s
`keys/` the same way it now applies to audit's — a pre-existing gap in the shared copy primitive that
this phase closed for both, not an audit-specific fix. **Best-effort on non-POSIX filesystems**:
`chmodSync` has limited effect on Windows (it can only toggle the read-only attribute, not set
arbitrary POSIX bits) — this is a real, narrow platform limitation, not a claim that Windows restores
are exactly as protected as POSIX ones.

**Cryptographic continuity, proven end-to-end**: `stack/test/integration/audit-anchor-continuity.test.js`
(`STACK_INTEGRATION=1`) spawns a real audit process, signs a real anchor with a real Ed25519 key (K1)
over a real event, takes a real `stack backup`, mutates the live database and rotates the live key to
a second real key (K2) which signs its own new anchor, runs a real `stack restore`, and proves — all
through the real spawned process's real HTTP API, never an in-process shortcut — that the pre-backup
K1 anchor still verifies, the post-backup mutation is gone, and a new anchor created after the restore
is signed under K1 again, not K2.
