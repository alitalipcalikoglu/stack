# Upgrading a running stack

## Normal upgrade

```
git -C <service> pull                # repeat for every service you're upgrading
cd <service> && npm ci
```

```
npm run backup            # from stack/ — snapshots every service's database, plus media's blob
                           # storage, auth's JWT keys, gateway's routes.json, console's
                           # services.json (see "What's covered" below)
```

```
pm2 restart <service>     # or `stack up` for the whole workspace
```

Each service's own `Database` applies any pending migration the moment it opens the file, inside
the new code's normal startup path — there is no separate migration step to run. Before it touches
anything, it snapshots the file itself to `<DB_PATH>.pre-v<N>-<timestamp>` (next to the database, or
under `DB_BACKUP_DIR` if set); `npm run backup` above is the operator-driven equivalent, covering the
whole workspace at once rather than one file.

```
npm run status             # from stack/ — confirm every service reports health=200 ready=200
```

A fresh install and an upgrade of an existing database go through the exact same migration code —
there is no separate "first run" path to get out of sync with the upgrade path.

## What's covered

`npm run backup` snapshots:

| Service | What |
|---|---|
| every stateful service | its SQLite database (`DB_PATH`), via `VACUUM INTO` against the live file — safe to run without stopping anything |
| `media` | the database, plus `objects/` and `variants/` under `DATA_DIR` (content-addressed blob storage) — `tmp/` is excluded, it holds only in-flight uploads and is cleared on the next start |
| `auth` | the database, plus `keys/` (the JWT signing key pair) — restoring the database with a different signing key invalidates every outstanding access token |
| `gateway` | `routes.json` only (it has no database) |
| `console` | the database, plus `services.json` |

Not covered, deliberately: `.env` files (secrets; keep these under your own secret management, not
in a snapshot directory), `node_modules`, PM2 logs, and media's `tmp/`.

A snapshot is a plain directory (`stack/backups/<timestamp>/` by default, or `--dir <path>`) with a
`manifest.json` (per-item sha256, each database's schema version, each service's package version)
and one subfolder per service. There is no archive/compression step — pipe it through `tar`/`zip`
yourself if you want one file to move around or store off-host.

## Restore

```
npm run restore -- stack/backups/2026-01-15T10-30-00-000Z
```

Or one service only:

```
npm run restore -- stack/backups/2026-01-15T10-30-00-000Z --service media
```

Restore validates everything in the snapshot before touching any live file: the manifest is
well-formed, every recorded database and directory is present with a matching checksum (an
incomplete or corrupted backup is refused outright), and every database is opened, through the
target service's own current code, from a temporary staged copy — which is also where a snapshot
whose schema is newer than what the running code supports gets rejected (`ConfigError`), before
anything is touched.

### All-or-nothing across the items in scope

Applying a validated restore is two steps, both scoped to one `runId`:

1. **Prepare** — every live file/directory about to be replaced is moved aside to
   `<path>.before-restore-<runId>` (never deleted), one item at a time.
2. **Apply** — the validated snapshot content is written into each target in turn.

If *anything* fails in either step, restore reverts every item this run had already touched, using
the aside copies `prepare` just made, so a failed restore never leaves some services on the new
snapshot and others on the old one. Only after both steps succeed for every item does restore stop
being reversible for this run and go on to (re)start PM2. The outcome is always one of three:

- **`restored`** — every item now has the snapshot's content; affected services are started on it.
- **`rolled_back`** — the restore failed, but every item is confirmed back at its exact pre-restore
  state; affected services are started on that original state. The command still exits non-zero (it
  was a failed restore), but nothing was lost.
- **`rollback_incomplete`** — the restore failed *and* reverting at least one item also failed (its
  aside copy went missing mid-run, a second disk error, …). **Nothing is (re)started** — a stopped
  service is safer than one started against a file whose state is now unknown. The error names every
  item and whether it's confirmed reverted or unknown, and points at its `.before-restore-<runId>`
  copy; check that copy by hand before starting anything.

`rollback_incomplete` is never reported as an ordinary restore failure — it is a distinct outcome
specifically because "the rollback also failed" needs a human to look, not a retry.

### What this is not: a cross-service transaction

This is a best-effort, in-process saga — not a filesystem transaction spanning every service's
files. It protects against *ordinary* failures during apply (a permissions problem, a full disk, a
missing aside copy): every one of those is caught and rolled back as described above. It does **not**
protect against the process running `stack restore` itself being killed, or the machine losing power,
partway through the apply step. If that happens: some targets may be on the new content, others on
the old, `.before-restore-<runId>` copies sit next to whichever targets were already touched, and
there is no automatic detection or resume on the next run — compare the aside copies against the
current files by hand, decide per item, and re-run `restore` (it re-validates from the snapshot every
time) once you're confident about the starting state. This is a deliberate scope decision: a
restore-journal that detects and resumes an interrupted run is real complexity for a failure mode
(the operator's own machine or process dying mid-restore, while every affected service is already
stopped) that ordinary in-process error handling doesn't need to solve.

### Retention

`.before-restore-<runId>` copies are **never deleted automatically**, whether the restore succeeded,
rolled back, or left `rollback_incomplete` — deleting them automatically is exactly the kind of
"probably fine" behavior that turns into lost data the one time it wasn't. Every copy from the same
`restore` call shares the same `runId` (its timestamp), so `ls`-ing a service's data directory for
`*.before-restore-2026-*` shows you everything one run touched. Clean them up by hand once you're
confident you no longer need them.

## Rollback

**None of the migrations are reversible.** To roll back a service after a bad upgrade:

1. Restore the pre-migration copy that `Database` wrote automatically (`<DB_PATH>.pre-v<N>-<ts>`,
   or under `DB_BACKUP_DIR`), or a `npm run backup` snapshot taken before the upgrade.
2. Check out the previous version of that service's code.
3. Start it against the restored file.

A backup taken *after* an upgrade already reflects the new schema and cannot be used to go back to
the old code.
