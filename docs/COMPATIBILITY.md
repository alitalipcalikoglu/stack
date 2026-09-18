# Cross-service compatibility

There is no static version matrix maintained in this repository. The live, authoritative answer to
"what version of what is actually running, and does it look compatible" is:

```bash
npm run status -- --matrix
```

which runs `Stack#matrix()` (`stack/src/stack.js`) against the actually-deployed processes — never
a hand-maintained table that drifts the moment one service is redeployed. This document explains
what that command reports, what each field means, and the compatibility rules around it. See
[API_CONTRACT.md](API_CONTRACT.md) for the exact `/v1/info` response shape each field is read from.

## What one matrix row is

For every service in `src/manifest.js`, `Stack#matrix()` (`stack.js:182-194`) independently:
1. Probes `/health` and `/ready` → `ok` (both `200`).
2. Fetches `/v1/info` and parses it defensively (`#info()`, `stack.js:205-230`) → `infoOk` plus
   either the parsed contract fields or `infoOk: false` with a human-readable `infoError`.

These two checks are **fully independent per service** — a service can be `ok: true` (healthy,
ready) while its `/v1/info` is unreachable, malformed, or missing, and vice versa is possible too
in principle. `test/matrix.test.js` proves this directly: `audit` is healthy (`ok: true`) while its
`/v1/info` body throws on `.json()` (`infoOk: false`, `malformed`), and the row still contains both
independent verdicts (`matrix.test.js:71-73`). One bad or unreachable service never aborts the
command or throws for the rest — `shortlink` in that same test is fully unreachable
(`ok: false`, `infoOk: false`) while every other row still parses normally
(`matrix.test.js:67-69, 85-87`).

## Fields

| Field | Source | Meaning |
|---|---|---|
| `ok` | `/health` + `/ready` both `200` | Reachability, exactly like plain `stack status` — never affected by version comparison. |
| `version` | `/v1/info` `version` | The service's own `package.json` semver — a release number, unrelated to the API contract. |
| `apiVersion` | `/v1/info` `apiVersion` | The `/v1` HTTP contract this instance serves. Stays `"v1"` across many package releases; only changes when the `/v1` contract itself is replaced wholesale. |
| `schemaVersion` | `/v1/info` `schemaVersion` | That service's own, currently-open database schema version (`Database#schemaVersion`, live `PRAGMA user_version` — never hand-maintained). `null` for a stateless service (today, only `gateway`). |
| `serviceCore` | `/v1/info` `serviceCore` | The `@atc-web/service-core` version actually running in that process (`SERVICE_CORE_VERSION`, read from that package's own `package.json` at import time — `service-core/src/fastify-helpers.js:14`). `null` for `gateway`, the one service with no dependency on `service-core` at all — `gateway/src/http/gateway-api.js:19-24` documents this as a deliberate, pre-existing design choice, not an oversight: gateway inlines the same `readServiceVersion`-style read of its own `package.json` for `version`, and simply has nothing to report for `serviceCore`. |
| `capabilities` | `/v1/info` `capabilities` | Real, currently-enabled behaviors only, e.g. audit's `['chain-verification', 'anchors', 'export']` (`audit/src/http/audit-api.js:69-74`) or notify's channel list plus `'templates'`/`'idempotency'`, which drops `'webhook'` when `NOTIFY_WEBHOOK_CHANNEL=false` (`notify/src/app.js:204-212`) — never a planned/future feature. |

Every field is read defensively: wrong-typed or missing (an older or partial contract) reads as
`null`/`[]`, never throws (`stack.js:222-229`). A too-old service with no `/v1/info` route yet
reads as `infoOk: false` with `infoError: 'no /v1/info (older version)'` (a 404), not a crash.

## `serviceCore` version mismatch: major vs. minor

`#printMatrix()` (`stack.js:245-254`) groups every row with a non-null `serviceCore` by **major**
version only. If more than one major is present, it prints one warning line after the table, e.g.:

```
⚠ serviceCore major version mismatch across services (informational only — no service refuses to start or serve traffic over this): v1.x: notify, auth, ...  |  v2.x: media
```

Precisely:
- **Major mismatch** → a printed warning. Nothing else. It is informational only — no service
  refuses to start, no request is rejected, and `stack status --matrix`'s own exit code is
  unaffected by it.
- **Minor mismatch** (e.g. `1.9.0` next to `1.10.0`) is **not flagged at all** — it is grouped into
  the same `v1.x` bucket as everyone else, silently. `matrix.test.js:96-97` asserts this precisely:
  `geo` on `serviceCore: '1.9.0'` shows up inside the `v1.x:` group with everyone else, and the
  warning text never contains `v1.9`, i.e. a minor-only difference never creates its own bucket or
  its own warning.
- A `serviceCore: null` row (gateway) is **excluded** from the comparison entirely — it is never
  treated as a "major of its own" and never appears in the warning
  (`matrix.test.js:95`, `doesNotMatch(warning, /gateway/)`).

**Exit code / `ok` semantics never change because of any of this.** `matrix.test.js`'s second test
is written specifically to prove it: `media` has a mismatched major (`'2.0.0'` vs. everyone else's
`'1.10.0'`) but is otherwise healthy, and `media.ok === true` — `ok` reflects only `/health`+`/ready`
reachability, exactly like plain `status()`, never the version comparison
(`matrix.test.js:100-107`). `bin/stack.js:48` (`status --matrix`'s CLI exit code) computes its exit
code from `rows.every((r) => r.ok)` — reachability only, not `infoOk`, not `serviceCore`. This
mechanism is deliberate and documented at the call site: `matrix()`'s own doc comment states
"per plan: NO STARTUP CHECK, services with different `serviceCore` majors must keep starting and
serving traffic unaffected by this command; it only ever reads and reports" (`stack.js:167-170`).
`serviceCore` is a shared internal library, not a wire contract — nothing in this platform makes an
HTTP call whose behavior depends on the caller's or callee's `serviceCore` version, so there is
nothing for a mismatch to break at the network level; the warning exists purely so an operator can
see, at a glance, that a rolling redeploy hasn't finished yet.

## API/serviceCore compatibility vs. database schema compatibility — two separate axes

These are unrelated concerns that happen to both show up as columns in the same matrix row:

- **API / `serviceCore` compatibility** is a *cross-service* concern: can service A's HTTP calls to
  service B be understood by B (and vice versa)? Per the plan, the versioned `/v1` HTTP contract,
  not the `serviceCore` package version, is what actually governs this, and `apiVersion` has been
  `"v1"` unchanged since Stage 7 wherever it's reported. Two services with different `serviceCore`
  majors can — and per the whole design of this command, must — keep working together fine over
  HTTP; that is exactly what the "no startup check" rule above guarantees.
- **`schemaVersion` (DB schema compatibility)** is an *entirely internal-to-that-one-service*
  concern: whether **that service's own** on-disk SQLite schema matches what **that service's own
  currently-running build** knows how to read. It has nothing to do with any other service. This is
  enforced, not just reported: `Database`'s migration runner (`service-core/src/db.js:84-91`)
  compares the database's real `PRAGMA user_version` against `this.constructor.MIGRATIONS.length`
  at construction time, and if the on-disk schema is **newer** than what this build supports, it
  throws `ConfigError('database is newer than this build supports (schema v${current}, build
  supports up to v${migrations.length}); refusing to open ${this.path}')` (`db.js:90`) — the service
  fails to start rather than run against a schema it doesn't fully understand. This refusal is local
  to the one service opening its one database file; it is never triggered by, or related to,
  anything another service's `/v1/info` reports.

Put plainly: a `serviceCore` major mismatch between `notify` and `media` is a warning with no
consequence for either service's ability to talk over HTTP; a `schemaVersion` behind what
`notify`'s own code expects is business as usual (the migration runner just applies the pending
migrations on next start); a `schemaVersion` **ahead of** what `notify`'s own code expects (an old
build pointed at a newer database) is the one scenario that actually refuses to start — and it is a
single-service event, never a cross-service one.

## What the mixed-version rollout guarantee actually covers

Two real (not mocked) test suites exercise this, and the guarantee below is scoped to exactly what
they prove — no broader claim ("any version combination works") is made, because that isn't what's
tested.

**`stack/test/integration/v1-info-matrix.test.js`** (`STACK_INTEGRATION=1 npm test`, spawns real
`audit` and `notify` processes, not an in-process fake): asserts each real service's live `/v1/info`
matches the documented contract shape exactly (`service`, `version`, `apiVersion`, `capabilities`,
`schemaVersion`, `serviceCore` all present and correctly typed), and that `Stack#matrix()` pointed
at those two real processes parses their actual responses correctly, while the other 11 manifest
entries (pointed at closed ports, nothing spawned for them) come back as ordinary unreachable rows
without the command throwing (`v1-info-matrix.test.js:83-100`).

**`console/test/about.test.js`** (Stage 10) exercises the console's own consumer of this same
contract, `GET /api/services/about`, against a fake service returning five distinct response
shapes, and proves `ClientRegistry#about()` degrades per-service in every case without crashing the
page:
- a full, current `/v1/info` — passed through as-is, unmodified, unvalidated against any hardcoded
  shape (`about.test.js:40-47`);
- an older response missing every optional field beyond `service`/`version` — passed through as-is,
  `ok: true` (`about.test.js:49-56`) — console does not require a field to be present to accept the
  row;
- a malformed body that parses as JSON but isn't an object — degrades to `ok: false` for that one
  service, request still `200` (`about.test.js:58-65`);
- a non-JSON body — same graceful degradation (`about.test.js:67-74`);
- a 404 (too-old service, no `/v1/info` route yet) — reported distinctly as an older version, not
  confused with a generic error (`about.test.js:76-83`);
- an unreachable service (connection destroyed) — reported per-service; every other configured
  service still gets its own entry (`about.test.js:85-93`).

**What this proves, precisely:** a real, currently-shipping service's `/v1/info` matches the
documented contract; and both `stack status --matrix` and the console's About view tolerate, without
crashing, a peer that is unreachable, too old (no route), or returns a malformed/partial body. What
it does **not** prove: that every possible pairing of two arbitrary `serviceCore`/`schemaVersion`
combinations behaves identically at the HTTP-call layer, or that any given past `apiVersion` remains
callable — those claims are out of scope for this doc because Stage 7 never wrote a test for them.
The only version-skew scenario actually exercised end-to-end is "one service several minor/major
versions of `serviceCore` behind or ahead of another, everything still reachable" — which is what
the mismatch-warning mechanism above is built to surface, not silently hide.
