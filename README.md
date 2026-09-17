# stack

One command to set up and run every atc-web service together with the console: installs dependencies, generates every secret and API key, wires the services to each other and to the console (`.env` files, gateway `routes.json`, console `services.json`), builds the console, creates the first administrator, and starts or supervises the whole set.

No runtime dependencies. Node 22.13+.

## Layout it expects

```
atc-web/
  stack/          this repo
  notify/  auth/  media/  audit/  shortlink/  flags/  scheduler/  webhook-out/  search/  gateway/  console/
```

Each sibling folder is a clone of `github.com/alitalipcalikoglu/<name>`. The workspace root itself is not a repository.

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

## Ports

| Service | Port | | Service | Port |
|---|---|---|---|---|
| gateway | 3000 | | audit | 3005 |
| notify | 3001 | | shortlink | 3006 |
| auth | 3002 | | flags | 3007 |
| media | 3003 | | scheduler | 3008 |
| console | 3004 | | webhook-out | 3009 |
| | | | search | 3010 |

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

## License

MIT, see [LICENSE](LICENSE).
