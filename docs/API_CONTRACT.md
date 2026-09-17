# `/v1/info` contract

Stage 7. Every service exposes `GET /v1/info` — public, unauthenticated, same pattern as `/health`
and `/ready`. It answers "what is this instance, and what does it actually support right now",
for `stack status --matrix`, the console's About view, and anyone else that needs to identify a
running instance without guessing from a version number.

## Response shape

```json
{
  "service": "notify",
  "version": "1.0.0",
  "apiVersion": "v1",
  "capabilities": ["email", "webhook", "templates", "idempotency"],
  "schemaVersion": 3,
  "serviceCore": "1.10.0"
}
```

| Field | Meaning |
|---|---|
| `service` | The manifest id (`stack/src/manifest.js`), e.g. `"notify"` — not a display label. |
| `version` | The service's own package semver. A release number, unrelated to the API contract below. |
| `apiVersion` | The `/v1` HTTP contract this instance serves. Independent of `version`: a service ships many package releases (`1.4.0`, `1.9.0`, …) while `apiVersion` stays `"v1"` throughout, and only changes when the `/v1` contract itself is replaced wholesale (there is no `/v2` as of this stage). |
| `capabilities` | Real, public, currently-supported behaviors only — deterministic (the same running configuration always reports the same list), lowercase, stable identifiers, each documented in that service's own README. Never a planned or future feature, and never a behavior that is actually disabled in this instance's configuration (e.g. notify omits `"webhook"` when `NOTIFY_WEBHOOK_CHANNEL=false`). |
| `schemaVersion` | For a stateful service: its real, currently-open database schema version, read live from `Database#schemaVersion` (`PRAGMA user_version`) — never hand-maintained, never hardcoded. For a service with no database (today, only `gateway`): always `null`. This is the one, consistent stateless contract — every stateless service reports `null`, not an omitted field, so a consumer never has to branch on whether the key exists. |
| `serviceCore` | The version of `@atc-web/service-core` actually installed and running in this process, read from that package's own `package.json` at import time (`readServiceVersion`/`SERVICE_CORE_VERSION` in `@atc-web/service-core/fastify`) — it can never say something different from what is truly running. `null` for the one service with no dependency on service-core at all (`gateway`, a deliberate, pre-existing design choice, not new to this stage). |

## Adding `/v1/info` to a service

Every service that depends on `@atc-web/service-core` calls the shared helper once, right next to
its existing `registerProbes(...)` call:

```js
import { registerInfo, readServiceVersion } from '@atc-web/service-core/fastify';

// in Application's constructor:
this.version = readServiceVersion(import.meta.url); // reads this service's own package.json

// in the HTTP class, next to registerProbes(...):
registerInfo(app, {
  service: 'notify',
  version: this.version,
  capabilities: [/* real, verified capabilities */],
  schemaVersion: this.db.schemaVersion, // omit entirely (defaults to null) if stateless
});
```

`gateway` has no service-core dependency (pre-existing, deliberate) and registers the same route
shape by hand, with `schemaVersion: null` and `serviceCore: null`.

## `stack status --matrix`

```
SERVICE      STATUS VERSION  API  SCHEMA SERVICE-CORE  CAPABILITIES
notify       ok     1.0.0    v1   3      1.10.0        email,webhook,templates,idempotency
gateway      ok     1.0.0    v1   -      -             jwt-auth,rate-limit-policy,...
shortlink    DOWN   ?        ?    ?      ?              (unreachable: connect ECONNREFUSED)
```

Reads `/health`, `/ready` and `/v1/info` per service, entirely independently and entirely
tolerant of failure — **no service reads another's `/v1/info` at startup, and this command never
blocks or refuses to run anything**; it is an operator visibility tool, not a runtime coupling
mechanism (see `IMPLEMENTATION_PLAN.md` Stage 7: "No startup checks"). One unreachable, too-old (no
route yet — reads as a 404) or malformed (non-JSON, or JSON that isn't an object) service never
aborts the command or throws; that row shows `?`/its error, every other row still reports normally.
Every optional `/v1/info` field is read defensively — present but wrong-typed, or simply missing
from an older/partial contract — degrades to `null`/`[]` rather than crashing, so the matrix is
safe to run mid-rollout, with some services upgraded and some not.

A `serviceCore` **major** version mismatch across services prints a visible warning line after the
table (informational only) — it never fails the command's exit code, which reflects reachability
(`ok`, i.e. `/health` and `/ready`) exactly as plain `stack status` does. A service with no
service-core dependency (`serviceCore: null`) is excluded from the mismatch comparison, not treated
as a "major" of its own.
