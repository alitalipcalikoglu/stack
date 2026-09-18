# atc-web TypeScript clients

Generated TypeScript clients for the platform's 13 canonical OpenAPI contracts
(`<service>/openapi.yaml` in each service's own repo). This directory is the *consumer* of those
contracts, never the source of truth — the canonical contract always lives in the service's own
repo, and `openapi.yaml` is what runtime behavior must match (see `stack/docs/API_CONTRACT_AUDIT.md`
and each repo's `openapi.yaml` itself).

Toolchain: [`openapi-typescript`](https://openapi-ts.dev) 7.13.0 (spec → TypeScript types) +
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) 0.17.0 (a ~6&nbsp;kB, native-`fetch`-based
typed client). Both are pinned exact, in this directory's own `package.json` — not stack's root
one, on purpose: `openapi-typescript` needs the classic `typescript` package (its own `ts.factory`
node-builder API) and only works with a `^5.x` release of it, which conflicts with the version
stack's own `tsc -p jsconfig.json` uses. Keeping this directory's `node_modules` separate means
neither toolchain can ever affect the other's resolved `typescript` version.

## Commands (run from the `stack` repo root)

| Command | What it does |
|---|---|
| `npm run clients:generate` | Regenerates every `<service>/{types.gen.ts,index.ts}` from that service's real `openapi.yaml`. |
| `npm run clients:check` | Regenerates into a scratch dir and diffs against the committed output. Non-zero exit on any drift; never touches the real tree. This is the determinism proof. |
| `npm run clients:typecheck` | `tsc --noEmit` over every generated client, strict, using this directory's own isolated `typescript`. |
| `npm run clients:test` | Fast orchestration invariant tests (service-list completeness, operation coverage, no stray files, no `any`). No process spawning. |
| `npm run clients:smoke` | Real, disposable-process runtime smoke for the three representative pilots (auth, media, console) — only runs with `STACK_INTEGRATION=1`, like every other process-spawning test in this workspace. |
| `npm run contracts:check` | The full local gate: OpenAPI validation → info-parity → clients:check → clients:typecheck → clients:test, in that order. Not wired into any CI/workflow (project policy: local-only validation). |

To regenerate one service only: `npm run clients:generate -- auth`.

## Using a client

Nothing is read from `process.env`, a stack config file, or any other implicit source — you always
pass `baseUrl` and credentials explicitly. This is deliberate: it keeps the client usable from a
browser, a serverless function, a future MCP tool, or anywhere else that has no access to this
workspace's own environment conventions.

```ts
import { createClient } from './clients/typescript/flags/index.ts';

const flags = createClient({
  baseUrl: 'https://flags.internal:4000',
  headers: { Authorization: `Bearer ${apiKeySecret}` },
});

const { data, error, response } = await flags['flags.evaluate.post']({
  body: { env: 'prod', context: { userId: 'u_123' } },
});
if (error) {
  // error is the real, typed ErrorEnvelope for this operation's declared error responses.
  console.error(response.status, error.error.code, error.error.message);
} else {
  console.log(data.flags);
}
```

Every call is keyed by the spec's own `operationId` — the same string you'd find in
`<service>/openapi.yaml` — not by a hand-picked method name, so the mapping from contract to call
site is mechanical and never drifts. `data`/`error`/`response` come straight from `openapi-fetch`:
nothing throws on a non-2xx by default; `response.status` and `response.headers` are always real and
always reachable, whichever branch you're in.

### Cookies (console)

Console uses a session cookie, not an API key. Pass `credentials: 'include'` when running in a
browser (the cookie is then handled automatically, same as any other `fetch` call). In Node there is
no cookie jar — capture `response.headers.get('set-cookie')` from the login call yourself and pass it
back as a `cookie` header on subsequent calls (see `clients/typescript/test/smoke/pilots.test.ts`'s
console pilot for a complete, real example). Console's CSRF header (`x-console-request: 1`) is a
typed, required parameter on every mutating operation that needs it — you cannot forget it and have
it silently omitted; the generated type will not compile without it.

### Binary bodies (uploads)

OpenAPI/JSON-Schema has no native binary type, so `openapi-typescript` maps a `format: binary`
request body to `string` — this is documented upstream behavior, not a bug. For a real binary
upload (currently only `media.files.upload` / `media.files.uploadTicketed`), pass the real bytes with
a matching `bodySerializer` override so `openapi-fetch` hands them straight to `fetch` instead of
trying to serialize a `string`:

```ts
await media['media.files.upload']({
  body: fileBytes as unknown as string,
  bodySerializer: (b: unknown) => b as unknown as BodyInit,
  headers: { 'content-type': 'image/png' },
});
```

This is a targeted, visible cast at the call site — not `any`, not a patch to generated code. It is
the documented, supported `openapi-fetch` escape hatch for this exact, known limitation.

### Binary responses (downloads)

`openapi-fetch` defaults every response to JSON parsing (`parseAs: 'json'`), regardless of what
content type an operation actually declares. For a real binary/non-JSON response (media's file
delivery route, audit's NDJSON/CSV export, shortlink's QR image routes), pass `parseAs` explicitly:

```ts
const { data, response } = await media['media.files.deliver']({
  params: { path: { id, variant: 'original' } },
  parseAs: 'arrayBuffer', // or 'blob' / 'text' / 'stream'
});
```

Once `parseAs` is set, `data` holds the already-parsed body in that shape and `response`'s body
stream has already been consumed by that parse — read bytes from `data`, not from calling
`response.arrayBuffer()` again.

### Timeouts, retries, cancellation

None of that is built in, on purpose. Pass a standard `AbortSignal` via the per-call `init` if you
need cancellation or a timeout — this is a transport, not a workflow SDK, and retrying a mutating
call automatically is not safe in general (see `stack/docs/API_CONTRACT_AUDIT.md` §K for which
services have real state machines where a blind retry would be wrong).

## What's generated vs. hand-written

Every file under `<service>/` (`types.gen.ts`, `index.ts`) is fully generated and carries a
"GENERATED FILE -- do not edit by hand" banner. Never edit them directly — edit the service's own
`openapi.yaml` (only if it's genuinely wrong relative to real runtime behavior — see
`stack/docs/API_CONTRACT_AUDIT.md` §44's rule on this) and regenerate.

`generate.mjs`, `check.mjs`, `services.mjs`, and everything under `test/` are hand-written tooling,
not generated output.

## Scope

13/13 services have a generated client, one operationId-keyed method per operation, 361 operations
total. Explicit `any` count: 0. `unknown`/`Record<string, unknown>` is used only where the source
OpenAPI spec itself has no real schema to offer (mainly console's pass-through proxy responses —
see `stack/docs/API_CONTRACT_AUDIT.md` §G) — never as a shortcut around a real, knowable shape.

No package is published to any registry from this directory. These are repo-internal generated
artifacts, consumed by cloning this repo — see the Phase 2 report for the reasoning.
