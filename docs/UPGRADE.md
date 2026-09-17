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
anything is touched. Only after every item in scope passes does restore stop the affected services
(PM2), replace their files, start them again, and wait for `/ready`.

Each service is restored independently. If a failure happens partway through (a full disk, a
permissions problem), whatever was already restored stays restored, the service that failed is
reported by name with the underlying error, and anything not yet reached is left untouched — restore
never leaves a service in between an old and a new database file: the live file it's about to
replace is moved aside to `<path>.before-restore-<timestamp>` (never deleted) immediately before the
replacement is written, and moved back if the replacement itself fails.

## Rollback

**None of the migrations are reversible.** To roll back a service after a bad upgrade:

1. Restore the pre-migration copy that `Database` wrote automatically (`<DB_PATH>.pre-v<N>-<ts>`,
   or under `DB_BACKUP_DIR`), or a `npm run backup` snapshot taken before the upgrade.
2. Check out the previous version of that service's code.
3. Start it against the restored file.

A backup taken *after* an upgrade already reflects the new schema and cannot be used to go back to
the old code.
