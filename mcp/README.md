# stack-mcp

A single [Model Context Protocol](https://modelcontextprotocol.io) server foundation over the
atc-web platform's 13 generated typed clients (`stack/clients/typescript/`). Talks to real services
through their real, canonical HTTP APIs — never a database, never a service's own `src/`, never a
hand-rolled HTTP call.

## Architecture boundary (hard, tested)

```
MCP tool handler -> ServiceRegistry -> a generated typed client -> the service's real HTTP API
```

- No direct DB access, anywhere in this package.
- No `import` of a sibling service's own `src/` tree.
- No hand-rolled `fetch()` of a service endpoint — every service call goes through
  `src/registry.mjs`'s `ServiceRegistry`, the only file that constructs a typed client.
- No hardcoded service path or base URL in source — callers configure base URLs explicitly (see
  Configuration below).

`test/boundary-scan.test.mjs` asserts all of the above by scanning this package's own source, so a
future edit that reintroduces one of these is a failing test, not a design doc nobody re-reads.

## One server, small tool set, default deny

This is **not** an API mirror. Of the platform's 376 canonical operations
(`stack/docs/API_CONTRACT_AUDIT.md`), exactly **10 tools** are exposed — see "Available tools"
below. `mcp/tool-catalog.json` classifies all 376 operations (service, method, path,
`READ_SAFE`/`MUTATION`/`DESTRUCTIVE`/`HIGH_RISK`/`OPERATOR`/`INTERNAL`/`BINARY`/`ASYNC`/`POOR_MCP_FIT`)
as a **candidate universe** for future phases — it is not the exposed list. The exposed list is
`src/tools/index.mjs`'s explicit array, and only that array. An operation existing in a service's
`openapi.yaml`, or being classified as safe in the catalog, never makes it a tool by itself.

MCP expansion was intentionally cancelled for the production `1.1.0` suite. The supported scope
is this explicit 10-tool allowlist over local STDIO only: no destructive/admin tools, no remote
transport, no MCP-specific authentication, and no package publication. This is a product decision,
not unfinished release work; the catalog remains an audit/classification artifact, not a roadmap.

No destructive, admin, or high-risk tool is exposed. `auth` and `console` have no
business-operation tool at all (only their `/health`/`/ready`/`/v1/info` probes are touched, via
`stack.status` — see the flagged security-review items for why the rest of `auth` stays out).

## Install / build / configure / run

```bash
cd stack/mcp
npm install          # isolated node_modules, separate from stack's own (see "Why isolated" below)
npm run -w . build    # (no build step today -- source is plain .mjs + the generated .ts clients)
```

Configuration is explicit and flat — nothing is auto-discovered from `process.env`'s usual stack
conventions, a `services.json`, or any secret store. Per service (only needed for a service a tool
actually calls):

```bash
STACK_MCP_FLAGS_BASE_URL=https://flags.internal:4000
STACK_MCP_FLAGS_API_KEY=example-flags-api-key
STACK_MCP_NOTIFY_BASE_URL=https://notify.internal:4001
STACK_MCP_NOTIFY_API_KEY=example-notify-api-key
# ... one BASE_URL (+ API_KEY where the service needs one) per service a tool uses.
STACK_MCP_TIMEOUT_MS=30000   # optional; default matches gateway's own UPSTREAM_TIMEOUT_MS default.
```

`stack.status` only ever needs a `BASE_URL` per service (its 3 probes are unauthenticated on every
service) — a service with no `BASE_URL` configured is reported `configured: false` in its result,
not an error. Every other tool needs both `BASE_URL` and `API_KEY` for its own service; a missing
one produces a clear, specific `SERVICE_UNAVAILABLE` tool error naming exactly which env var is
missing — never a vague failure, never a secret value.

### Running (STDIO)

This process directly imports the generated `*.ts` typed clients under
`stack/clients/typescript/`, so it must be started with Node's type-stripping flag:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning stack/mcp/bin/stack-mcp.js
```

(`--disable-warning=ExperimentalWarning` just silences Node's SQLite/type-stripping experimental
warnings on stderr — harmless without it, just noisier.) From an MCP client's own config (e.g. a
`claude_desktop_config.json`-style `mcpServers` entry), that's the `command`/`args` pair to use,
with `env` set to the `STACK_MCP_*` variables above.

Only **STDIO** transport is implemented this phase (local client integration). No HTTP/SSE server
is started — remote MCP hosting is out of scope here.

## Why isolated `node_modules` (not stack's root)

`stack/mcp/package.json` has its own `node_modules`, deliberately separate from stack's own root
`package.json`, for the same reason `stack/clients/typescript/` does (see that package's own
README): stack's own toolchain isn't touched by anything this package needs, and vice versa. The
official MCP SDK (`@modelcontextprotocol/sdk`) and `zod` are real runtime dependencies of a
running `stack-mcp` process — that's normal and expected — but neither one is added to stack's
root `package.json`, and no service repo's dependency graph changes at all.

## Available tools

| Tool | Calls | Category | Notes |
|---|---|---|---|
| `stack.status` | every configured service's `/health`+`/ready`+`/v1/info` | operational aggregate | Not one OpenAPI operation. One dead/unconfigured service never fails the whole call. |
| `flags.evaluate` | `flags.evaluate.post` | authenticated read | |
| `geo.ip.lookup` | `geo.ip.lookup` | authenticated read | |
| `media.files.get` | `media.files.get` | authenticated read, real error path | Metadata only — never transports file bytes (see "Binary" below). |
| `notify.messages.list` | `notify.messages.list` | authenticated read, pagination | Cursor-based (`items`/`nextCursor`). |
| `notify.messages.create` | `notify.messages.create` | safe mutation, async submit | Returns immediately; delivery happens later. Pair with `notify.messages.get`. |
| `notify.messages.get` | `notify.messages.get` | authenticated read, async status | |
| `shortlink.links.create` | `shortlink.links.create` | safe mutation | Creates a new resource; never overwrites/deletes. |
| `ratelimit.check` | `ratelimit.check` | authenticated read | Always `peek:true` in the handler — never caller-controlled, so this tool can never consume real quota. |
| `search.query` | `search.query.get` | authenticated read, pagination | Offset-based (`total`/`limit`/`offset`) — deliberately a different pagination style from `notify.messages.list`'s cursor style; neither is normalized to match the other (see below). |

Every non-`stack.status` tool name matches its operation's real `operationId` — no invented naming
scheme, no API-path-shaped names like `notify_post_v1_messages`.

### On the two different pagination shapes

`notify.messages.list` returns `{items, nextCursor}`; `search.query` returns
`{hits, total, limit, offset}`. This is a **real, existing** platform inconsistency
(`stack/docs/API_CONTRACT_AUDIT.md` §H flags it as a deferred policy question), not something this
package invented or should silently paper over. Each tool's output uses that operation's own real
field names.

### Binary

No tool in this phase transports file bytes through MCP. `media.files.get` returns metadata
(including signed/public URLs) that a caller can fetch directly — never base64-encoded content in a
tool result. A future phase adding a true binary tool should use an MCP resource/content primitive
deliberately, not a giant base64 string stuffed into `structuredContent`.

## Input validation

Every tool's `inputSchema` is a `zod` raw shape whose fields, types, and requiredness are copied
directly from that operation's own OpenAPI request schema (see the file-and-line citations in each
tool's comment in `src/tools/index.mjs`) — never invented, never loosened or tightened. Deep
per-value validation that the real service already does at the JSON-Schema level (e.g. notify's
per-email-template `data` shape) is intentionally **not** re-derived here a third time — the real
service is still the final validator; this schema only re-derives the outer contract shape so
obviously malformed calls fail fast, before an HTTP round trip.

The official SDK validates every call's arguments against this schema **before** invoking a tool's
handler. A validation failure comes back as a normal `CallToolResult` with `isError: true` — the
MCP protocol's own design for tool-level errors (not a rejected JSON-RPC request) — with a message
naming the failing field. Confirmed directly against a running server, not assumed from docs.

## Output shape

Every successful tool result: `{ content: [{type:'text', text: <short summary>}], structuredContent:
{ status, data, requestId? } }`. `data` is the real, typed response body. `requestId` is the
service's own `X-Request-Id` when present (safe, useful for correlating with that service's logs);
no other header is ever included — everything else on this platform is either routine or
documented as internal-only propagation (`stack/docs/API_CONTRACT_AUDIT.md`'s tracing section).

## Error translation

Every tool funnels failures through one adapter (`src/errors.mjs`). What's always preserved: the
target service name, the real HTTP status (when there is one), the service's own canonical error
code (its real `ErrorEnvelope.error.code`, e.g. `NOT_FOUND`), and a safe message. What's **never**
included, under any circumstance: API keys, cookies, `Authorization` header values, stack traces,
local filesystem paths, or a raw unrecognized upstream body. Verified by a real, sentinel-secret
based test in `test/e2e/protocol.test.mjs`, not just documented.

Four MCP-boundary-only error kinds (not a new copy of every service's own domain error taxonomy):
`INVALID_INPUT`, `SERVICE_UNAVAILABLE` (missing config), `UPSTREAM_ERROR` (a real, well-formed error
response from the service — its own code/message preserved inside), `TRANSPORT_ERROR` (network
failure, timeout, or an unparseable response).

## Timeouts and retries

Every request gets a default timeout (`STACK_MCP_TIMEOUT_MS`, default 30000ms — matches gateway's
own `UPSTREAM_TIMEOUT_MS` default, reused rather than picked arbitrarily) via `AbortSignal.timeout`,
unless the caller already supplied a signal. **No automatic retry, anywhere, ever** — a mutating
call retried automatically risks a real duplicate side effect, and the generated typed clients this
package builds on ([Phase 2](../clients/typescript/README.md)) are deliberately retry-free for the
same reason.

## Logging

STDIO is the protocol channel: only the SDK's own framed JSON-RPC traffic may ever touch stdout.
Anything this package itself needs to say goes to stderr, or isn't said at all — no logging
dependency was added since stderr already satisfies "don't log secrets, don't touch stdout" without
one. `test/e2e/protocol.test.mjs`'s STDIO-purity test asserts stdout stays clean and stderr never
contains a sentinel test secret.

## Testing

```bash
npm run mcp:typecheck   # strict, from stack root
npm run mcp:test        # fast: catalog/allowlist/boundary-scan invariants, no process spawning
STACK_INTEGRATION=1 npm run mcp:e2e   # real: 7 spawned services + a real stack-mcp child process, driven by the official MCP client SDK over real STDIO
```

`mcp:e2e` proves, against real running services (not mocks, not direct handler calls): `initialize`
→ `listTools` → `callTool`, a read-only tool, an authenticated read, a safe mutation, an async
submit-then-status-read pair, both real pagination shapes, an expected 4xx from a real service, a
malformed-input rejection, an unconfigured-service error, a wrong-credential error, an
unreachable-service transport error, and STDIO purity / secret non-leakage.

## Adding a future tool

1. The operation must already exist in that service's canonical `openapi.yaml`
   ([Phase 1](../../docs/API_CONTRACT_AUDIT.md)).
2. Regenerate/confirm the typed client is current: `npm run clients:check` from `stack/` must be
   green (a stale client is not a base to build a tool on).
3. Classify it: re-run `npm run mcp:catalog` from `stack/` if the source spec changed, and look at
   its entry in `mcp/tool-catalog.json`.
4. Make an explicit allowlist decision. `DESTRUCTIVE`/`HIGH_RISK` operations default deny; adding
   one requires a deliberate, reviewed policy change to this README and the allowlist tests, not
   just a new entry in `src/tools/index.mjs`.
5. Write the tool: a `zod` `inputSchema` copied from the operation's real request schema, a handler
   that calls `registry.client(service)` and nothing else for I/O, real `annotations`
   (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` matching real semantics, never
   guessed).
6. Update `mcp/tool-catalog.reconcile.mjs`'s `TOOL_TO_OPERATION_IDS` map and re-run
   `npm run mcp:catalog`.
7. Update `test/allowlist.test.mjs`'s `EXPECTED_TOOL_NAMES` deliberately (the test fails on an
   accidental tool-count change on purpose).
8. Add real, service-backed tests: at minimum a success case and its real expected-error case; a
   protocol-level `test/e2e/` case if the new tool exercises a genuinely new pattern (a new
   pagination shape, a new async flow, binary content, etc.) this suite doesn't already cover.
