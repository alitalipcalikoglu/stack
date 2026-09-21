# ATC-WEB Project State

Last source verification: 2026-09-21. This is a concise living handoff, not a specification or
history log.

## Purpose and update rules

Use this document to establish the current suite baseline before changing any repository. It does
not replace source, tests, OpenAPI, installation manifests, release manifests, or immutable tags.

- Read this file before implementation work, then verify affected facts in authoritative source.
- Future implementation prompts must explicitly require reading this file before changes.
- Update it when a migration stage or product phase is formally closed, including verified
  development HEADs, material architecture decisions, accepted debt/deltas, and the next stage.
- Remove debt only when its resolution is implemented and validated. Never mark a phase closed
  before its acceptance gates pass.
- Never rewrite immutable release history. Keep this document brief enough to read at session
  start; link to canonical material instead of copying it.
- If this document conflicts with current repository source, source wins and this file must be
  corrected.

## Workspace topology

The workspace root is local-only and is not a Git repository. It contains 15 independent sibling
repositories: 13 independently deployable HTTP services, `service-core` (shared runtime package),
and `stack` (suite installer, orchestrator, and release-management repository). There is no
monorepo-level commit or branch.

## Source-of-truth hierarchy

Consult these in order before trusting a summary here:

1. Repository source, configuration, and tests.
2. Each HTTP service's canonical root `openapi.yaml`.
3. Authoritative `stack/installation-manifests/` release-selection data and other stack manifests.
4. Immutable Git tags and their peeled commits; `stack/releases/` is historical validation
   evidence, not installer input.
5. This living handoff summary.

No production runtime may derive a second OpenAPI source of truth or depend on a hand-maintained
route registry introduced for documentation.

## Current repository state

All rows were clean, on `main`, synchronized with `origin/main` (0 ahead/0 behind) at verification.
The release column is immutable; development HEAD may advance. Stack's listed HEAD is the clean
baseline immediately before the commit that updates this file, so the commit containing the newest
state update is necessarily newer.

| Repository | Role | Verified development HEAD | Immutable current release | State / note |
|---|---|---|---|---|
| audit | HTTP service: append-only audit log | `cc9d60d2e2dfbe5baa95240089eb7f0b6a6fb238` | `v1.1.0` → `cc9d60d2e2dfbe5baa95240089eb7f0b6a6fb238` | HEAD at release |
| auth | HTTP service: identity and tokens | `28a616c5aa2704faf0842b88aafa915c7d175abd` | `v1.1.0` → `28a616c5aa2704faf0842b88aafa915c7d175abd` | HEAD at release |
| console | HTTP service: administration UI/API | `2b81ffb7a489a4cacfa387430b614108a5381d0a` | `v1.1.0` → `367790d8a1e5d560c93140b4efaaf8724bb4d69a` | Ahead by closed M0–M6 commits |
| flags | HTTP service: feature flags/settings | `9425a74ec2e3b29bf66f0f889b609bb1359ea9c9` | `v1.1.0` → `9425a74ec2e3b29bf66f0f889b609bb1359ea9c9` | HEAD at release |
| gateway | HTTP service: public edge | `a90eefaa63935409046f7ace8cc9ed8dfaa48605` | `v1.1.0` → `a90eefaa63935409046f7ace8cc9ed8dfaa48605` | HEAD at release |
| geo | HTTP service: geolocation/reference data | `e7b8ad9678e5d30587d663ff5737b1c5b94e4a3c` | `v1.1.0` → `e7b8ad9678e5d30587d663ff5737b1c5b94e4a3c` | HEAD at release |
| media | HTTP service: uploads and delivery | `439210ae50054a499bab43b8121df7fc3902c4e9` | `v1.1.0` → `439210ae50054a499bab43b8121df7fc3902c4e9` | HEAD at release |
| notify | HTTP service: queued notifications | `27b9a1b669e26aa253c85f6cff896268a2d44e63` | `v1.1.0` → `27b9a1b669e26aa253c85f6cff896268a2d44e63` | HEAD at release |
| ratelimit | HTTP service: policies and quotas | `7a0ee5647fbec96320feb440c0703bb370cca107` | `v1.1.0` → `7a0ee5647fbec96320feb440c0703bb370cca107` | HEAD at release |
| scheduler | HTTP service: scheduled HTTP jobs | `f3761c43b30a599f7f5d3c179a66dcb107478805` | `v1.1.0` → `f3761c43b30a599f7f5d3c179a66dcb107478805` | HEAD at release |
| search | HTTP service: SQLite FTS search | `bddb6f7a9bdade67f7f465c5efd96a1b504b3355` | `v1.1.0` → `bddb6f7a9bdade67f7f465c5efd96a1b504b3355` | HEAD at release |
| service-core | Shared runtime package | `5a833451fad32864b2639d20d34570aefada3549` | `v1.12.0` → `5a833451fad32864b2639d20d34570aefada3549` | HEAD at release |
| shortlink | HTTP service: short links and QR | `52d97cd37f45e82bba1ff66d210ae4001c05d991` | `v1.1.0` → `52d97cd37f45e82bba1ff66d210ae4001c05d991` | HEAD at release |
| stack | Installer/orchestrator/release management | `1914375bae3b1f9be2bac5b1dbb2702f1303228b` | `v1.1.0` → `10e58d108458bbce61c306386b42ced0699e50ff` | Post-release installer and migration-state work; pre-update baseline |
| webhook-out | HTTP service: durable outbound webhooks | `0647204f6dfb7e5967b5df533d48b0e28e7a41bb` | `v1.1.0` → `0647204f6dfb7e5967b5df533d48b0e28e7a41bb` | HEAD at release |

## Immutable releases

- Supported production suite: application repositories and stack `v1.1.0`; shared runtime
  `service-core` `v1.12.0`.
- `stack` `v1.1.0` peels to `10e58d108458bbce61c306386b42ced0699e50ff`;
  `service-core` `v1.12.0` peels to `5a833451fad32864b2639d20d34570aefada3549`.
- Historical first suite release remains immutable: application repositories and stack `v1.0.0`;
  `service-core` `v1.11.1` at `934af4f5a45f4be6fab9c77ba5f24f6c44c37c83`.
- The authoritative install matrix is `installation-manifests/v1.1.0.json`, selected by
  `installation-manifests/supported.json`. Historical manifests are immutable. Never move tags.

## Current suite contract

- 13 canonical `openapi.yaml` files, all OpenAPI 3.1.0.
- Console: 122 paths and 156 operations. Suite: 376 canonical operations.
- Generated TypeScript clients: 13/13, with 376/376 operation coverage and no regeneration drift.
- MCP candidate catalog: 376 operations. Explicit exposure remains frozen at 10 tools.
- MCP transport is STDIO only; there is no remote transport or automatic spec-to-tool exposure.

Preserve these boundaries:

- Canonical OpenAPI remains the API source of truth; tests may derive oracles but runtime code must
  not gain a duplicate contract registry.
- Service API keys stay server-side. Console sessions remain opaque and server-side.
- Preserve SQLite compatibility and long-lived process-owned database connections; do not regress
  to request-per-connection database access.
- There is no generic downstream proxy. Large upload/download/export paths must remain streaming.
- Authenticated APIs and session-aware HTML must never enter a service-worker cache.
- The public stack command contract and immutable release tags must remain stable.

## Installer and release constraints

The established public workflow includes `stack install:all`, `stack setup`, `stack dev`,
`stack up`, `stack down`, and `stack status`. `install:all` defaults to the supported immutable release;
`--ref main` is an explicit moving development selection. GitHub supplies source, commits, and
immutable tags. GitHub Actions/CI are intentionally absent; release validation runs locally.

Installation manifests under `installation-manifests/` are authoritative installer input.
Historical `releases/` reports do not override them. Do not change release selection, installation
manifests, tags, or release manifests as a side effect of unrelated work.

## Architecture decisions

### Console current architecture

The released and current production implementation remains a Svelte 5 + Vite SPA with a custom
frontend router and static SPA fallback, backed by a Fastify BFF in the same repository/process.
M0 added tests only. M1 added an independent SvelteKit SSR foundation in canonical `src/routes/`
with TypeScript and adapter-node, but did not mount either framework into the other or change the
production start/build/runtime path. Transitional `kit:*` commands exercise the foundation;
production continues to use Fastify and `vite.legacy.config.js` until later migration stages. M2
adds a process-scoped SvelteKit runtime, shared SQLite/maintenance lifecycle, a thin adapter-node
HTTP/HTTPS wrapper, and filesystem ownership of `/health`, `/ready`, `/v1/info`, and
`/openapi.yaml`. M3 adds the native hooks request/security lifecycle and 10 explicit auth/session
filesystem operations, bringing SvelteKit ownership to 14 operations. M4 migrates all 138 ordinary
JSON operations into explicit filesystem endpoints, bringing SvelteKit ownership to 152
operations; at its closure Fastify remained authoritative only for the four streaming/binary
operations reserved for M5. M5 migrates those final four operations with explicit filesystem routes,
bringing SvelteKit canonical implementation ownership to all 156 operations and Fastify migration
ownership to zero. M6 moves all 34 browser URL patterns, the shared authenticated shell, and the
login flow to SSR-enabled SvelteKit filesystem pages. Server layouts now make the initial session,
TOTP-pending, and admin-only decisions; operational dashboard data still loads after hydration.
Fastify and the old `ui/` SPA remain compatibility source/runtime until M8, but neither is canonical
for migrated frontend or backend ownership. The migration runtime and legacy production runtime
remain mutually exclusive; neither framework mounts, calls, or proxies the other.

### Console target architecture

The approved target is a **full-stack SvelteKit Node application**:

- one SvelteKit application, one HTTP framework, one filesystem router, and one Node process;
- Svelte 5, TypeScript, `@sveltejs/adapter-node`, and SSR enabled;
- backend endpoints under `src/routes/api/**/+server.ts` and operational filesystem routes;
- frontend under `src/routes/**/+page.svelte` and layouts;
- lifecycle via `src/hooks.server.ts`; small reusable server-only helpers under
  `src/lib/server/**` are allowed.

This is settled, not an open design question. The final architecture explicitly excludes Fastify,
a Fastify/SvelteKit hybrid, a separate BFF, a separate `ui/` SPA, a custom frontend router, a
central custom backend router, `adapter-static`, a generic downstream proxy, and gratuitous
controller/application-service/domain-service/repository/adapter layering.

## Console migration status

| Stage | State | Scope |
|---|---|---|
| M0 | **CLOSED** | Contract freeze and migration safety net |
| M1 | **CLOSED** | SvelteKit + adapter-node + TypeScript skeleton |
| M2 | **CLOSED** | Runtime singleton, config, DB, maintenance, operational endpoints, wrapper |
| M3 | **CLOSED** | Hooks, trace, session, auth, TOTP, roles, CSRF, logout CSRF correction |
| M4 | **CLOSED** | JSON API filesystem endpoints |
| M5 | **CLOSED** | Streaming and binary special paths |
| M6 | **CLOSED** | Filesystem frontend routes, layouts, SSR |
| M7 | **NEXT** | API Docs, PWA, theme, i18n, toast |
| M8 | Planned | Remove Fastify, old layers, `ui/`, custom router, SPA fallback |
| M9 | Planned | Docker, PM2, admin CLI, stack integration |
| M10 | Planned | Full parity/E2E/security/browser/stream/runtime audit and release-candidate preparation |

There are no intermediate migration tags. Do not begin a later stage before its prerequisites and
the preceding stage's gates are closed.

## Closed work

Console M0 is closed at `5a806e41ea782ace48b6b67cdedd76e2af3f06bf`
(`test: freeze console migration contracts`), whose parent is the immutable Console v1.1.0 commit
`367790d8a1e5d560c93140b4efaaf8724bb4d69a`. Framework-neutral oracles live under
`console/test/migration/`; they are tests, not production configuration or an API registry.

M0 closure evidence: Console 122 paths / 156 operations, suite 376 operations, frontend 34 URL
patterns, 112/112 Console tests, typecheck with 0 errors/warnings, successful production build,
156/156 route parity, 13/13 generated clients, 376 generated operations, 6/6 client tests, MCP
catalog 376, 10 exposed tools, and 17/17 MCP tests.

Console M1 is closed at `71c4191753371bb7383db1371cc8c39d3adb7f54`
(`build: establish SvelteKit migration foundation`). It adds SvelteKit 2.70.3, adapter-node 5.5.7,
strict TypeScript configuration, one SSR filesystem page, an interactive hydration proof, and an
explicit server-only module boundary. The adapter-node and legacy production paths remain
independent; no API or legacy page was migrated.

M1 closure evidence: clean `npm ci`; 114/114 Console tests; legacy and SvelteKit typechecks with
0 errors/warnings; adapter-node SSR build/runtime smoke; server-only client-bundle exclusion;
successful unchanged legacy production build; 156/156 Console route parity; 13/13 generated
clients with no drift; suite catalog 376 operations; and MCP exposure unchanged at 10 tools.

Console M2 is closed at `dc851b24eed4908f5fff80558d56fbbcd137c4cc`
(`feat: establish SvelteKit runtime foundation`). The SvelteKit migration runtime now owns one
process-scoped resolved configuration, SQLite connection, maintenance timer, explicit readiness
and idempotent shutdown lifecycle, and direct filesystem implementations of the four operational
routes. Root `server.mjs` wraps only adapter-node's handler and Node HTTP/HTTPS process concerns.

M2 closure evidence: clean `npm ci`; 118/118 Console tests; all legacy and SvelteKit typechecks
with 0 errors/warnings; adapter-node SSR and runtime smoke; real HTTP and native HTTPS/HSTS;
correct IPC readiness and graceful double-SIGTERM shutdown; byte-identical canonical OpenAPI;
156/156 derived legacy-plus-SvelteKit route parity; successful legacy production build; 13/13
generated clients without drift; suite catalog 376 operations; and MCP exposure unchanged at 10.

Console M3 is closed at `5c81b347d72f94f205fc37e95c7b98aae30c376c`
(`feat: migrate console auth lifecycle to SvelteKit`). `src/hooks.server.ts` now owns request IDs,
trace context, trusted client IP, safe locals, process-scoped session resolution, the explicit CSRF
boundary, and common security headers. Ten canonical filesystem operations now own login,
pre-session TOTP, session state/logout, session listing/revocation, password change, and TOTP
enrolment/confirmation/disable. Existing DB, token, password, TOTP, role, expiry, revocation, audit,
and cookie primitives remain unchanged. Authenticated logout now requires
`x-console-request: 1`; the legacy M0 assertion remains as history and M3 black-box coverage proves
the corrected SvelteKit behavior. The canonical OpenAPI and generated Console client describe that
approved delta without changing an operation identity or count.

M3 closure evidence: 120/120 Console tests; legacy and SvelteKit typechecks with 0 errors/warnings;
successful legacy production build; adapter-node SSR/hydration/server-only, HTTP/HTTPS, singleton,
IPC and shutdown smokes; full M3 auth/session/TOTP/CSRF/cookie/trace/proxy black-box smoke; 14
SvelteKit-owned plus 142 remaining Fastify-owned operations for exact 156/156 parity; 13/13
generated clients and 376/376 generated operations without drift; MCP catalog 376, explicit tools
unchanged at 10, and 17/17 MCP tests. Production dependency audit is clean; the existing three
low-severity development-only `cookie` advisories remain as recorded below.

Console M4 is closed at `6fca9bba4cee6f0519948ff6a80d6b93c440b32c`
(`feat: migrate JSON API routes to SvelteKit`). All 138 ordinary JSON operations across local
administration/audit, documentation, service overview/settings/status, and the notify, auth,
media, audit, shortlink, flags, scheduler, webhook-out, search, ratelimit, and geo service families
now have explicit `src/routes/api/**/+server.ts` owners. Existing validation schemas were extracted
for reuse; a thin server-only helper supplies AJV validation and shared mechanics, while the
process singleton owns the fixed downstream registry, clients, documentation loader, and audit
forwarder. There is no central route-dispatch registry, generic proxy, or catch-all. API
documentation work in M4 is backend-only; the frontend remains deferred to M7.

M4 deliberately leaves exactly four Fastify-owned operations for M5:

- `PUT /api/services/{sid}/media/files`
- `GET /api/services/{sid}/media/files/{id}/bytes/{sub}`
- `GET /api/services/{sid}/audit/events/export`
- `GET /api/services/{sid}/shortlink/links/{id}/qr.png`

M4 closure evidence: 120/120 Console tests; legacy and SvelteKit typechecks with 0 errors/warnings;
successful legacy production build and adapter-node build; M1–M3 runtime/auth smokes and the M4
adapter-node black-box smoke; 152 SvelteKit-owned plus four Fastify-owned operations for exact
156/156 parity; Console 122 paths / 156 operations and suite 376 operations; 13/13 generated
clients, 376/376 generated operations without drift, and 6/6 client tests; MCP catalog 376,
explicit exposure unchanged at 10 tools, and 17/17 MCP tests. Production dependency audit is
clean; the existing three low-severity development-only advisories remain unchanged.

Console M5 is closed at `087204e887cb8250f89b0137dcb9aa1a743486a7`
(`feat: migrate streaming routes to SvelteKit`). The media upload, media-byte download, audit
export, and shortlink QR PNG operations now have explicit filesystem owners. Uploads stream with
backpressure and actual-byte counting under the exact 512 MiB limit; the downstream request keeps
its 300-second timeout and propagates cancellation. Media bytes and audit exports stream without
read-all buffering; QR preserves its small buffered PNG contract. The established binary-header
filter, hostile-SVG neutralization with byte identity, effective API `no-store`, and intentional
non-forwarding of inbound `Range` are unchanged.

M5 closure evidence: 124/124 Console tests; legacy and SvelteKit typechecks with 0 errors/warnings;
successful legacy and adapter-node builds; M1–M4 smokes plus a real adapter-node M5 black-box smoke
covering synchronized upload backpressure, declared and streamed size enforcement, byte/header
identity, abort propagation, and graceful shutdown during an active export. Derivational parity is
156 SvelteKit-owned plus zero Fastify migration-owned operations for exact 156/156 coverage.
Console remains at 122 paths / 156 operations and the suite at 376 operations; 13/13 generated
clients have 376/376 coverage without drift, while MCP remains 376 catalog operations, 10 exposed
tools, and 17/17 tests. Production dependency audit is clean; the existing three low-severity
development-only advisories remain unchanged.

Console M6 is closed at `2b81ffb7a489a4cacfa387430b614108a5381d0a` across implementation
commit `4c387fd774c2ffd6f1de08eb15491d68cd0afa9b` and parity-evidence commit
`c5932bfd84144842b45ec6cdb8d78dd68e6a589e`, followed by runtime-smoke refresh commit
`2b81ffb7a489a4cacfa387430b614108a5381d0a`. All 34 frozen browser URL patterns now have native
`src/routes/**/+page.svelte` owners under public and authenticated route groups. Root server data
contains only the safe principal summary and TOTP-pending flag; authenticated and admin-only
guards execute before protected SSR HTML is rendered. The shared shell, login/TOTP UI, same-origin
API client, URL query state, polling lifecycle, assets, global styles, and existing page/component
behavior are canonical under `src/`. The custom router, `App.svelte` route switch, direct history
machinery, and SPA fallback are not imported or required by the canonical frontend.

M6 closure evidence: 126/126 Console tests; both legacy and canonical Svelte checks with 0 errors
and 0 warnings; successful legacy and adapter-node production builds; derivational 34/34 filesystem
route proof and real adapter-node direct-load checks for public/authenticated/admin classifications;
anonymous, admin, viewer, logout/invalidation, dynamic/query, browser/API 404, and M5 binary UI
contracts. Real Chrome verified hydration, client navigation, back/forward, refresh/deep links,
role navigation, logout, and zero unexpected console errors; the established overflow probe passed
at 1440×900 and 375×812. Client bundle and representative SSR HTML secret scans were clean.
Backend ownership remains 156 SvelteKit and zero Fastify migration operations; Console remains 122
paths / 156 operations and the suite 376. All 13 specs validate, generated clients remain 13/13 and
376/376 without drift, and MCP remains 376 catalog entries with 10 exposed tools. Production audit
is clean; the three existing low-severity development-only advisories are unchanged.

## Known debt and deliberate migration deltas

1. **PWA:** current SPA caching is frozen. The future service worker must not cache authenticated
   APIs or session-aware SSR HTML and must use a secret-free offline response.
2. **Range:** the current media-byte path does not forward inbound `Range` downstream. M0 freezes
   that behavior; any change requires an explicit behavior/security decision.
3. Current media-byte and QR responses effectively receive `Cache-Control: no-store` from the
   shared API response hook, overriding route-local cache directives. Treat the observable header
   as the migration oracle unless deliberately changed and reviewed.
4. **M1 development-tooling advisory:** production dependencies audit clean. The latest selected
   SvelteKit 2.70.3 transitively pins `cookie` 0.6.0, which npm reports under a low-severity cookie
   attribute validation advisory. No compatible fixed SvelteKit release is currently available;
   monitor upstream rather than applying npm's breaking downgrade suggestion.
5. **M1–M6 transitional compatibility:** the unchanged public Fastify production command retains
   compatibility copies of all 156 SvelteKit-owned operations until final cutover. The explicit
   SvelteKit migration runtime owns every canonical implementation for migration purposes; Fastify
   owns zero. The unchanged `ui/` SPA, custom router, `App.svelte`, service worker, and fallback
   remain compatibility evidence until M8 but are not canonical frontend dependencies. API Docs,
   PWA, and theme/i18n/toast final integration remain the explicit M7 boundary. The runtimes are
   mutually exclusive and no request crosses between them. No new non-transitional debt was
   accepted in M6.

## Operational constraints

- No GitHub workflow files are used. Validation, tagging, and release checks remain local.
- Do not modify production behavior while establishing migration scaffolding unless the active
  stage explicitly authorizes a named delta.
- Preserve server-side credentials, opaque sessions, schema compatibility, streaming behavior,
  graceful shutdown, native TLS/proxy semantics, and PM2 readiness/shutdown contracts.
- Do not create, move, replace, or delete immutable tags; do not infer release authorization from
  completion of a migration stage.

## Next controlled stage

**M7 — API Docs, PWA, theme, i18n, and toast integration.** The 34-route SvelteKit frontend and
server-known session layout are now the baseline. M7 completes the staged browser integrations
without reintroducing a custom router or caching authenticated SSR/API responses. Legacy
Fastify/`ui/` cleanup remains M8, and deployment/stack integration remains M9.

## Update checklist

When formally closing future work:

1. Re-read authoritative source and verify all 15 repository branches, remotes, HEADs, and trees.
2. Update the repository table, immutable release section only when a real release occurs, and the
   current contract counts from canonical specs/tooling.
3. Record the closed stage, acceptance evidence, material architecture decisions, and resulting
   debt/deltas; mark exactly one next controlled stage.
4. Resolve or remove debt entries only with validated evidence.
5. Confirm this remains summary-only: no copied route registry, secrets, credentials, local paths,
   machine details, or conversation transcript.
6. Validate the affected repositories locally, inspect the documentation diff, then make a focused
   commit without changing unrelated repositories or immutable release history.
