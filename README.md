# stack

One command to set up and run every atc-web service together with the console: installs dependencies, generates every secret and API key, wires the services to each other and to the console (`.env` files, gateway `routes.json`, console `services.json`), builds the console, creates the first administrator, and starts or supervises the whole set.

No runtime dependencies. Node 22.13+.

## Layout it expects

```
<any folder>/
  stack/          this repo
  notify/  auth/  media/  audit/  shortlink/  flags/  scheduler/  webhook-out/  search/  ratelimit/  geo/  gateway/  console/
```

Each sibling folder is a clone of `github.com/alitalipcalikoglu/<name>`. The workspace root can have any name and is not a repository; the stack finds the services relative to its own folder.

## Quick start

### Download, configure, and start the complete suite

Prerequisites: Git, npm, Node 22.13 or newer, and—unless `--no-start` is used—a globally available
PM2 (`npm i -g pm2`). Clone only this repository, install its CLI dependencies, then let the CLI
acquire the 14 sibling repositories:

```bash
git clone https://github.com/alitalipcalikoglu/stack.git
cd stack
npm ci
npm link            # exposes both `stack` and the existing `atc-stack` command names
stack install:all --admin-password '<choose-a-strong-password>'
```

`install:all` resolves the workspace from the actual stack checkout, not the shell's current
directory. It validates prerequisites before mutation, clones missing official repositories,
validates and reuses safe existing checkouts, runs `npm ci` from every sibling lockfile, delegates
configuration to the existing `setup` implementation, starts through the existing PM2 `up` path,
and waits (bounded) for all 13 HTTP services to report ready.

The default is the current supported **production release** (`1.1.0`): every sibling is checked
against the immutable tag and exact commit recorded in
[`installation-manifests/v1.1.0.json`](installation-manifests/v1.1.0.json), selected by the explicit
[`installation-manifests/supported.json`](installation-manifests/supported.json) pointer.
`service-core` therefore resolves `v1.12.0`, while the application repositories resolve `v1.1.0`.
The installation manifest is the source of truth. The immutable
[`installation-manifests/v1.0.0.json`](installation-manifests/v1.0.0.json) remains available as the
archived original release descriptor; release-validation reports under [`releases/`](releases/)
are historical evidence and are deliberately not consumed by the installer.

Explicit development installation resolves every sibling—including `service-core`—to the current
official `main` branch and reports the exact resolved commits. It is moving and non-immutable:

```bash
stack install:all --ref main --admin-password '<choose-a-strong-password>'
```

Use that explicit development mode when running Stack from post-release `main`: its canonical
Console invariant is `server.mjs` plus an adapter-node build, while the unchanged `v1.1.0`
installation manifest describes the matching historical release snapshot. Current development
invariants are not retroactively applied to that immutable snapshot. A future supported release
must publish a mutually compatible Stack/Console manifest before the default pointer advances.

Options intentionally stay small:

- `--no-start`: clone/install/configure without requiring PM2 or starting services.
- `--split-workers`: forward the existing split-worker topology to `stack up`.
- `--dry-run`: perform read-only prerequisite, remote-ref, and existing-checkout validation and
  print the plan and resolved commits; no clone, fetch, install, setup, or startup occurs.
- Existing setup options `--host`, `--public`, `--admin-email`, and `--admin-password` are passed to
  the established setup path. `install:all` never prints a password; on a fresh install, supply
  `--admin-password` so the credential is known, or reset the generated credential afterward with
  Console's admin CLI.
- `--root <dir>` is available for an explicit workspace root; normally the parent of the executing
  stack checkout is correct.

Existing directories fail closed unless they are real, clean Git repositories with the exact
official `origin`. Release mode additionally requires HEAD and the locally/remote-resolved tag to
match the descriptor's exact commit. Development mode requires the checked-out branch to be
`main`; it fetches and performs only a fast-forward update. Dirty trees, detached/wrong branches,
diverged history, spoofed remotes, symlinks, non-Git directories, and commit/tag mismatches are
never reset, cleaned, stashed, overwritten, or deleted.

The command is safely rerunnable. Repositories cloned before a later network, npm, setup, startup,
or readiness failure are validated and reused on the next run; existing `.env` values, issued keys,
secrets, routes, service registry, and first administrator are preserved by the idempotent setup
machinery. Fix the phase-labelled error and rerun the same command. After a startup/readiness
failure, inspect `pm2 logs` and `node bin/stack.js status`; use `--no-start` when PM2 is intentionally
not installed.

### Configure an already-present workspace

```bash
git clone https://github.com/alitalipcalikoglu/stack.git && cd stack && npm ci
npm run setup      # dependencies, secrets, keys, .env files, routes, console build, first admin
npm run dev        # every service in this terminal, prefixed logs, Ctrl-C stops all
```

Then open `http://127.0.0.1:3004` and sign in with the credentials `setup` printed (shown once).

Production-style supervision with PM2 (`npm i -g pm2`):

```bash
npm run up         # pm2 startOrRestart in every folder, then status
npm run status     # /health and /ready of every service
npm run status -- --matrix  # version/API/schema/service-core/capabilities matrix, from each service's own /v1/info
npm run down       # pm2 delete every app
```

See [docs/API_CONTRACT.md](docs/API_CONTRACT.md) for the exact `/v1/info` contract every service
serves (`service`, `version`, `apiVersion`, `capabilities`, `schemaVersion`, `serviceCore`) and what
the matrix does with it — an operator visibility tool, never a startup check or a runtime coupling
mechanism: a `serviceCore` major mismatch is a printed warning, nothing refuses to start or run.

Backup and restore:

```bash
npm run backup                                   # snapshot every service's database and other state
npm run restore -- backups/<timestamp>            # stop, restore, start, wait for /ready
```

See [docs/UPGRADE.md](docs/UPGRADE.md) for what's covered, restore's validation and atomicity, and
rollback after a bad upgrade.

Operator maintenance (post-production Phase 4 — today: media only):

```bash
atc-stack maintenance media    # one-shot: purge + trash reconciliation, safe alongside a live server
```

Runs media's real production `Maintenance`/`MediaService#purge()` directly against its `.env`/data
directory — no HTTP route, no new auth system; see [media/README.md](../media/README.md#maintenance).

## What `setup` does

1. **Dependencies**: `npm ci` in every folder that has no `node_modules` (or all with `--install`).
2. **Preparation**: `npm run keygen` in `auth` when `keys/jwt-private.pem` is missing; `npm run build` in `console` when `public/` is missing.
3. **Env files**: each service's `.env` is loaded (or started from its `.env.example`), then the stack sets `PORT`, `HOST`, every secret that is empty or still a `REPLACE_WITH…` placeholder, the URLs services use to reach each other, and the API keys:
   - every service that issues keys (`*_API_KEYS`) gets an entry per holder: `console` (role `read` for audit, default elsewhere), `gateway` (auth, media, notify), `auth` (notify), `scheduler` (flags `write`, notify, webhook-out `publish`);
   - holders receive the same secret: console `*_API_KEY` variables and `GATEWAY_METRICS_TOKEN`, gateway `AUTH_API_KEY`/`MEDIA_API_KEY`/`NOTIFY_API_KEY`, auth `NOTIFY_API_KEY`, scheduler `TARGET_KEYS`.
4. **Files**: `gateway/routes.json` (auth, media, JWKS through the gateway) and `console/services.json` (every service with its local URL and key variable).
5. **First admin**: `admin@console.local` with a generated password, printed once. Nothing is created when an administrator already exists.

Running `setup` again is safe: existing secrets, keys and any value you edited by hand are kept; only placeholders and missing entries are filled. Delete a line from a `.env` to get the stack's default back. Console's adapter-node application is rebuilt on every setup boundary so a build artifact left by an older source checkout is never accepted as current.

## Local versus server

By default the stack is **local**: `HOST=127.0.0.1`, plain HTTP everywhere, `COOKIE_SECURE=false`, notify's mail transport `json:` (mails are logged, not sent), and the outbound guards of scheduler and webhook-out opened for loopback (`TARGET_ALLOW_HTTP=true`, `TARGET_ALLOW_PRIVATE=true`, `TARGET_ALLOWED_HOSTS=127.0.0.1,localhost`) so jobs and webhooks can reach the other services and local receivers.

`npm run setup -- --public --host 10.0.0.5` keeps every security default from the templates (HTTPS-only outbound, secure cookies, allowlists empty until you fill them), uses the given host for service-to-service URLs, keeps `PUBLIC_BASE_URL`s you set, and does not rewrite an existing `gateway/routes.json`. Put a TLS-terminating proxy in front and set `TRUST_PROXY=true` per service.

Options: `--root <dir>` (default: the parent of this checkout), `--admin-email <email>`, `--admin-password <password>` (otherwise generated), `--install`.

## Service list

| Service | Port | Repository | What it does | Calls |
|---|---|---|---|---|
| gateway | 3000 | [gateway](https://github.com/alitalipcalikoglu/gateway) | Public edge: routes, JWT verification, service-key injection, CORS, per-IP limits, central rate limit policies, geo headers | auth (JWKS), ratelimit, geo, every upstream |
| notify | 3001 | [notify](https://github.com/alitalipcalikoglu/notify) | Queued e-mail with templates and retries, plus a legacy signed webhook for one-off calls (`webhook-out` is the durable delivery service — see below). API/worker split-capable. | audit |
| auth | 3002 | [auth](https://github.com/alitalipcalikoglu/auth) | Users, passwords, ES256 JWT + JWKS, refresh tokens, e-mail verification, password reset | notify, audit |
| media | 3003 | [media](https://github.com/alitalipcalikoglu/media) | Uploads, deduplication, image variants, signed URLs, upload tickets | audit |
| console | 3004 | [console](https://github.com/alitalipcalikoglu/console) | Admin web app for every service: own admins, 2FA, console log | every service, audit |
| audit | 3005 | [audit](https://github.com/alitalipcalikoglu/audit) | Append-only event log with a hash chain, filters, export, retention | – |
| shortlink | 3006 | [shortlink](https://github.com/alitalipcalikoglu/shortlink) | Short links, click statistics, QR codes | audit |
| flags | 3007 | [flags](https://github.com/alitalipcalikoglu/flags) | Feature flags and typed settings per environment, rollouts, targeting rules | audit |
| scheduler | 3008 | [scheduler](https://github.com/alitalipcalikoglu/scheduler) | Cron and one-shot jobs calling HTTP targets with signatures and retries. API/worker split-capable. | flags, notify, webhook-out (targets), audit |
| webhook-out | 3009 | [webhook-out](https://github.com/alitalipcalikoglu/webhook-out) | The durable, general-purpose outbound-webhook service: subscriptions, signed deliveries, retries, replay. API/worker split-capable. | audit |
| search | 3010 | [search](https://github.com/alitalipcalikoglu/search) | Full-text search over your documents with facets and highlights (SQLite FTS5) | audit |
| ratelimit | 3011 | [ratelimit](https://github.com/alitalipcalikoglu/ratelimit) | Central rate limits and quotas: policies, sliding windows, overrides, blocks | audit |
| geo | 3012 | [geo](https://github.com/alitalipcalikoglu/geo) | IP geolocation (MMDB), countries, currencies, time zones, phone normalization, places | audit |
| stack | – | [stack](https://github.com/alitalipcalikoglu/stack) | This installer and runner | – |

Every service is its own repository and deployable alone; "Calls" lists the services it talks to over HTTP when configured (all optional except auth → notify for verification and reset mails). Browsers only ever reach the gateway and the console.

## Ports

| Service | Port | | Service | Port |
|---|---|---|---|---|
| gateway | 3000 | | audit | 3005 |
| notify | 3001 | | shortlink | 3006 |
| auth | 3002 | | flags | 3007 |
| media | 3003 | | scheduler | 3008 |
| console | 3004 | | webhook-out | 3009 |
| | | | search | 3010 |
| | | | ratelimit | 3011 |
| | | | geo | 3012 |

## Adding a service

A new service is part of the stack from its first release. In the same delivery:

1. Add its entry to `src/manifest.js`: `id` (folder, PM2 name, console id), `port`, `keysVar` when it issues API keys, `env(ctx)` for the values a local stack needs (secrets via `ctx.secret`, keys via `ctx.issue`, URLs via `ctx.url`/`ctx.publicUrl`, operator-kept values via `ctx.keep`, outbound guards via `ctx.outbound`), `files(ctx)` for generated files, `prepare(ctx)` for one-off steps, and `console` when the console shows it (type, label, key variable, polling).
2. Add the holders it needs to other entries: the console's key comes from `console.keyEnv` automatically; a key for another service is one `ctx.issue(...)` in that service's `env`.
3. Add the port to the table above and a template line to `test/stack.test.js` so the wiring test covers it.
4. Run `npm run setup` and `npm run dev`; every service, old and new, must report `ready`.

## Code layout

| Class | File | Role |
|---|---|---|
| `EnvFile` | `src/env-file.js` | `.env` read/modify/write that keeps comments and order |
| `SERVICES` | `src/manifest.js` | The service list: ports, keys, env, files, console entry |
| `SetupContext` | `src/setup-context.js` | In-memory envs, secrets, key issuing, routes and services.json, save |
| `Stack` | `src/stack.js` | `setup`, `up`, `down`, `dev`, `status`, `matrix`, `backup`, `restore`, `maintenance`, first admin |
| `Snapshot` | `src/snapshot.js` | Whole-workspace backup creation and validated restore |
| `Cli` | `bin/stack.js` | Argument parsing |

## Documentation

- [docs/ARCHITECTURE_AUDIT.md](docs/ARCHITECTURE_AUDIT.md) — the platform-wide architecture review: what exists, what's missing, severity, proposed changes.
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — the staged plan carrying that review out.
- [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) — the request-id/`traceparent` propagation rules and structured-log field vocabulary every service is measured against.
- [docs/UPGRADE.md](docs/UPGRADE.md) — how migrations apply on upgrade, what `backup`/`restore` cover, restore's validation and atomicity, and rollback.
- [docs/READINESS_TEMPLATE.md](docs/READINESS_TEMPLATE.md) — the 19-section production-readiness contract; every service has its own filled copy at `<service>/docs/READINESS.md`.
- [docs/READINESS.md](docs/READINESS.md) — index into every service's own `docs/READINESS.md`, one real line each.
- [docs/API_CONTRACT.md](docs/API_CONTRACT.md) — the `/v1/info` contract (Stage 7) every service serves, and what `stack status --matrix` does with it.
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — what `stack status --matrix` reports and the compatibility semantics around it (major/minor `serviceCore` mismatch, API vs. schema compatibility, mixed-version rollout coverage).
- [test/integration/](test/integration/) — cross-service integration tests that spawn real service processes (`STACK_INTEGRATION=1 npm test`; plain `npm test` stays fast and spawns nothing).

## License

MIT, see [LICENSE](LICENSE).
