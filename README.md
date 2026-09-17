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
npm run down       # pm2 delete every app
```

## What `setup` does

1. **Dependencies**: `npm ci` in every folder that has no `node_modules` (or all with `--install`).
2. **Preparation**: `npm run keygen` in `auth` when `keys/jwt-private.pem` is missing; `npm run build` in `console` when `public/` is missing.
3. **Env files**: each service's `.env` is loaded (or started from its `.env.example`), then the stack sets `PORT`, `HOST`, every secret that is empty or still a `REPLACE_WITH…` placeholder, the URLs services use to reach each other, and the API keys:
   - every service that issues keys (`*_API_KEYS`) gets an entry per holder: `console` (role `read` for audit, default elsewhere), `gateway` (auth, media, notify), `auth` (notify), `scheduler` (flags `write`, notify, webhook-out `publish`);
   - holders receive the same secret: console `*_API_KEY` variables and `GATEWAY_METRICS_TOKEN`, gateway `AUTH_API_KEY`/`MEDIA_API_KEY`/`NOTIFY_API_KEY`, auth `NOTIFY_API_KEY`, scheduler `TARGET_KEYS`.
4. **Files**: `gateway/routes.json` (auth, media, JWKS through the gateway) and `console/services.json` (every service with its local URL and key variable).
5. **First admin**: `admin@console.local` with a generated password, printed once. Nothing is created when an administrator already exists.

Running `setup` again is safe: existing secrets, keys and any value you edited by hand are kept; only placeholders and missing entries are filled. Delete a line from a `.env` to get the stack's default back.

## Local versus server

By default the stack is **local**: `HOST=127.0.0.1`, plain HTTP everywhere, `COOKIE_SECURE=false`, notify's mail transport `json:` (mails are logged, not sent), and the outbound guards of scheduler and webhook-out opened for loopback (`TARGET_ALLOW_HTTP=true`, `TARGET_ALLOW_PRIVATE=true`, `TARGET_ALLOWED_HOSTS=127.0.0.1,localhost`) so jobs and webhooks can reach the other services and local receivers.

`npm run setup -- --public --host 10.0.0.5` keeps every security default from the templates (HTTPS-only outbound, secure cookies, allowlists empty until you fill them), uses the given host for service-to-service URLs, keeps `PUBLIC_BASE_URL`s you set, and does not rewrite an existing `gateway/routes.json`. Put a TLS-terminating proxy in front and set `TRUST_PROXY=true` per service.

Options: `--root <dir>` (default: the parent of this checkout), `--admin-email <email>`, `--admin-password <password>` (otherwise generated), `--install`.

## Service list

| Service | Port | Repository | What it does | Calls |
|---|---|---|---|---|
| gateway | 3000 | [gateway](https://github.com/alitalipcalikoglu/gateway) | Public edge: routes, JWT verification, service-key injection, CORS, per-IP limits, central rate limit policies, geo headers | auth (JWKS), ratelimit, geo, every upstream |
| notify | 3001 | [notify](https://github.com/alitalipcalikoglu/notify) | Queued e-mail and signed webhooks with templates and retries | audit |
| auth | 3002 | [auth](https://github.com/alitalipcalikoglu/auth) | Users, passwords, ES256 JWT + JWKS, refresh tokens, e-mail verification, password reset | notify, audit |
| media | 3003 | [media](https://github.com/alitalipcalikoglu/media) | Uploads, deduplication, image variants, signed URLs, upload tickets | audit |
| console | 3004 | [console](https://github.com/alitalipcalikoglu/console) | Admin web app for every service: own admins, 2FA, console log | every service, audit |
| audit | 3005 | [audit](https://github.com/alitalipcalikoglu/audit) | Append-only event log with a hash chain, filters, export, retention | – |
| shortlink | 3006 | [shortlink](https://github.com/alitalipcalikoglu/shortlink) | Short links, click statistics, QR codes | audit |
| flags | 3007 | [flags](https://github.com/alitalipcalikoglu/flags) | Feature flags and typed settings per environment, rollouts, targeting rules | audit |
| scheduler | 3008 | [scheduler](https://github.com/alitalipcalikoglu/scheduler) | Cron and one-shot jobs calling HTTP targets with signatures and retries | flags, notify, webhook-out (targets), audit |
| webhook-out | 3009 | [webhook-out](https://github.com/alitalipcalikoglu/webhook-out) | Outbound webhooks: subscriptions, signed deliveries, retries, replay | audit |
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
| `Stack` | `src/stack.js` | `setup`, `up`, `down`, `dev`, `status`, first admin |
| `Cli` | `bin/stack.js` | Argument parsing |

## Documentation

- [docs/ARCHITECTURE_AUDIT.md](docs/ARCHITECTURE_AUDIT.md) — the platform-wide architecture review: what exists, what's missing, severity, proposed changes.
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — the staged plan carrying that review out.
- [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) — the request-id/`traceparent` propagation rules and structured-log field vocabulary every service is measured against.
- [docs/READINESS_TEMPLATE.md](docs/READINESS_TEMPLATE.md) — the 19-section production-readiness contract; every service has its own filled copy at `<service>/docs/READINESS.md`.
- [test/integration/](test/integration/) — cross-service integration tests that spawn real service processes (`STACK_INTEGRATION=1 npm test`; plain `npm test` stays fast and spawns nothing).

## License

MIT, see [LICENSE](LICENSE).
