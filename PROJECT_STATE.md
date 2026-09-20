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
| console | HTTP service: administration UI/API | `dc851b24eed4908f5fff80558d56fbbcd137c4cc` | `v1.1.0` → `367790d8a1e5d560c93140b4efaaf8724bb4d69a` | Ahead by closed M0–M2 commits |
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
| stack | Installer/orchestrator/release management | `a6cd96f36f049e52bb933c9330e6e228fa75ab1f` | `v1.1.0` → `10e58d108458bbce61c306386b42ced0699e50ff` | Post-release installer and migration-state work; pre-update baseline |
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
`/openapi.yaml`. The migration runtime and legacy production runtime remain mutually exclusive;
neither framework mounts, calls, or proxies the other.

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
| M3 | **NEXT** | Hooks, trace, session, auth, TOTP, roles, CSRF, logout CSRF correction |
| M4 | Planned | JSON API filesystem endpoints |
| M5 | Planned | Streaming and binary special paths |
| M6 | Planned | Filesystem frontend routes, layouts, SSR |
| M7 | Planned | API Docs, PWA, theme, i18n, toast |
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

## Known debt and deliberate migration deltas

1. **M3 logout CSRF correction:** current logout deliberately retains a CSRF exception frozen by
   M0. M3 will require `x-console-request: 1` for an authenticated logout without changing the
   operation count.
2. **SSR:** current pages are SPA-delivered. The target requires SvelteKit SSR; HTML byte equality
   with the old shell is not a compatibility requirement.
3. **PWA:** current SPA caching is frozen. The future service worker must not cache authenticated
   APIs or session-aware SSR HTML and must use a secret-free offline response.
4. **Range:** the current media-byte path does not forward inbound `Range` downstream. M0 freezes
   that behavior; any change requires an explicit behavior/security decision.
5. Current media-byte and QR responses effectively receive `Cache-Control: no-store` from the
   shared API response hook, overriding route-local cache directives. Treat the observable header
   as the migration oracle unless deliberately changed and reviewed.
6. **M1 development-tooling advisory:** production dependencies audit clean. The latest selected
   SvelteKit 2.70.3 transitively pins `cookie` 0.6.0, which npm reports under a low-severity cookie
   attribute validation advisory. No compatible fixed SvelteKit release is currently available;
   monitor upstream rather than applying npm's breaking downgrade suggestion.
7. **M2 transitional route copies:** the unchanged public Fastify production command retains
   compatibility copies of the four operational routes until final cutover. The explicit SvelteKit
   migration runtime owns their new implementations; the runtimes are mutually exclusive and no
   request crosses between them. Derivational parity treats filesystem routes as migrated owners.

## Operational constraints

- No GitHub workflow files are used. Validation, tagging, and release checks remain local.
- Do not modify production behavior while establishing migration scaffolding unless the active
  stage explicitly authorizes a named delta.
- Preserve server-side credentials, opaque sessions, schema compatibility, streaming behavior,
  graceful shutdown, native TLS/proxy semantics, and PM2 readiness/shutdown contracts.
- Do not create, move, replace, or delete immutable tags; do not infer release authorization from
  completion of a migration stage.

## Next controlled stage

**M3 — Hooks, trace/request context, sessions, authentication, TOTP, roles, CSRF, and the deliberate
logout CSRF correction.** M3 has not started. Its implementation prompt must establish fresh Git
baselines, read this document and the Console migration oracles, preserve M2 process/resource
ownership, and define validation/stop conditions before mutation.

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
