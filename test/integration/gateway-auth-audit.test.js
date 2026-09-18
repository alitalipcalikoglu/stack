import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll } from './harness.js';
import { SetupContext } from '../../src/setup-context.js';

/**
 * Real cross-service flow, real processes: gateway proxies a login to auth, over the wire, and
 * auth forwards the resulting security event to audit. This is the flow Stage 1 exists to make
 * traceable, proven with the actual services running as separate OS processes rather than in one
 * test process or against fakes — including, in the second test below, the specific thing Stage 1
 * changed in the gateway: whether a caller-supplied `X-Request-Id` is honoured or discarded,
 * verified by what a *different process* (auth) logged after receiving it purely over HTTP.
 *
 * The gateway route used here is `stack`'s own real, unmodified `SetupContext.gatewayRoutes()`
 * output (`buildRoutes()` below only rebinds upstream origins from the manifest's fixed ports to
 * this run's ephemeral ones — pathPrefix, stripPrefix, methods and every other field are exactly
 * what a real `stack setup` would write to `gateway/routes.json`). See the Stage 1.1 report: the
 * P0 bug flagged in the Stage 1 addendum did not exist in the generator — `stripPrefix` only ever
 * removes a literal substring of the caller's URL (gateway has no path-insert capability), so the
 * correct public call is the target's real upstream path appended verbatim after `pathPrefix`
 * (`/api/auth/v1/auth/login`, not `/api/auth/login`), exactly as gateway's own
 * `examples/public-route-with-injected-key.md` already documented before Stage 1. The Stage 1 test
 * called the wrong (short) URL and misdiagnosed the 404 as a generator defect.
 *
 * Spawns real `node` processes (audit, notify, auth, media, plus one or two gateway instances) and
 * can take several seconds, so it only runs when explicitly requested: `STACK_INTEGRATION=1 npm
 * test`. Plain `npm test` stays fast and spawns nothing (see harness-self-test.test.js for the
 * always-on tests, which exercise the harness itself without any atc-web service).
 *
 * What this does NOT (yet) prove, so the tests don't claim it: the audit event auth forwards for a
 * login has no `requestId` field today (`auth/src/store/event-store.js`'s security-event schema
 * doesn't carry one), so a request id cannot appear *inside* that event's JSON — only the plain
 * fact that the event is there at all is checked. See the Stage 1 report.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {SetupContext} */ let context;
/** @type {string} */ let jwtAudience;
/** @type {string} */ let scratch;
/** @type {ServiceProcess} */ let audit;
/** @type {ServiceProcess} */ let notify;
/** @type {ServiceProcess} */ let auth;
/** @type {ServiceProcess|null} */ let media = null;
/** @type {string} */ let authApiKeySecret;
/** @type {string} */ let gatewayToAuthSecret;
/** @type {string} */ let gatewayToMediaSecret;
/** @type {string} */ let harnessAuditSecret;
let userCount = 0;

before(async () => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-integration-'));
  // `local: true` makes gatewayRoutes() always regenerate from the manifest, ignoring whatever
  // `gateway/routes.json` a real `npm run setup` may have left on disk in this workspace.
  context = new SetupContext({ root: workspaceRoot, host: '127.0.0.1', local: true, run: async () => {} });
  jwtAudience = context.env('auth').get('JWT_AUDIENCE') || 'app';

  const [auditPort, notifyPort, authPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const authToAuditSecret = randomSecret();
  harnessAuditSecret = randomSecret();
  gatewayToAuthSecret = randomSecret();
  gatewayToMediaSecret = randomSecret();
  const authToNotifySecret = randomSecret();
  authApiKeySecret = randomSecret();

  audit = new ServiceProcess({
    name: 'audit', cwd: join(workspaceRoot, 'audit'), entry: 'src/index.js', port: auditPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(auditPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      AUDIT_API_KEYS: `auth:${authToAuditSecret}:write,harness:${harnessAuditSecret}:read`,
    },
  });
  notify = new ServiceProcess({
    name: 'notify', cwd: join(workspaceRoot, 'notify'), entry: 'src/index.js', port: notifyPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(notifyPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      NOTIFY_API_KEYS: `auth:${authToNotifySecret}`, SMTP_URL: 'json:', SMTP_FROM: 'Harness <harness@example.test>', WEBHOOK_SIGNING_SECRET: randomSecret(),
    },
  });
  await Promise.all([audit.start(), notify.start()]);

  const jwtKeyPath = join(scratch, 'jwt-private.pem');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(jwtKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  auth = new ServiceProcess({
    name: 'auth', cwd: join(workspaceRoot, 'auth'), entry: 'src/index.js', port: authPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(authPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      AUTH_API_KEYS: `gateway:${gatewayToAuthSecret},harness:${authApiKeySecret}`,
      JWT_PRIVATE_KEY_PATH: jwtKeyPath,
      // Signed so the token's iss/aud match exactly what the real generated routes.json's jwt
      // config expects (context.url('gateway') / the real JWT_AUDIENCE from auth's own env file).
      JWT_ISSUER: context.url('gateway'), JWT_AUDIENCE: jwtAudience,
      APP_NAME: 'Harness', VERIFY_URL_TEMPLATE: 'https://example.test/verify?token={token}', RESET_URL_TEMPLATE: 'https://example.test/reset?token={token}',
      NOTIFY_URL: notify.baseUrl, NOTIFY_API_KEY: authToNotifySecret,
      AUDIT_URL: audit.baseUrl, AUDIT_API_KEY: authToAuditSecret,
      // Post-production Phase 5: gateway is auth's own real trusted proxy in production — this
      // is the exact same trust declaration auth already makes for X-Forwarded-For, now reused
      // for traceparent too. Independent of gateway's OWN inbound trust of the client, tested
      // separately above.
      TRUST_PROXY: 'true',
    },
  });
  await auth.start();
});

after(async () => {
  if (!shouldRun) return;
  await stopAll([auth, notify, audit, ...(media ? [media] : [])]);
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The real `SetupContext.gatewayRoutes()` output, with only upstream origins rebound from the
 * manifest's fixed ports to this run's ephemeral ones (`pathPrefix`/`stripPrefix`/methods/ids are
 * untouched — that shape is exactly what is under test). Routes whose upstream isn't one of this
 * run's actually-spawned services are dropped rather than rebound: gateway's `/ready` requires
 * every listed route to have a live upstream, and not every test spawns media, so including
 * media-user/media-files against the unreachable static manifest port would leave `/ready` stuck
 * 503 forever — a test-scoping choice, not a change to any route's real generated fields.
 */
function buildRoutes() {
  const generated = context.gatewayRoutes();
  const isLive = (/** @type {string} */ url) => url.startsWith(context.url('auth')) || (media && url.startsWith(context.url('media')));
  const rebind = (/** @type {string} */ url) => {
    if (url.startsWith(context.url('auth'))) return url.replace(context.url('auth'), auth.baseUrl);
    if (media && url.startsWith(context.url('media'))) return url.replace(context.url('media'), media.baseUrl);
    return url;
  };
  return {
    jwt: { ...generated.jwt, jwksUrl: rebind(generated.jwt.jwksUrl) },
    routes: generated.routes.filter((/** @type {any} */ r) => r.upstreams.every(isLive)).map((/** @type {any} */ r) => ({ ...r, upstreams: r.upstreams.map(rebind) })),
  };
}

/** @param {{ trustProxy?: boolean }} [o] */
async function startGateway({ trustProxy = false } = {}) {
  const port = await freePort();
  const routesPath = join(scratch, `routes-${port}.json`);
  writeFileSync(routesPath, JSON.stringify(buildRoutes()));
  const gateway = new ServiceProcess({
    name: 'gateway', cwd: join(workspaceRoot, 'gateway'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info',
      ROUTES_FILE: routesPath, AUTH_API_KEY: gatewayToAuthSecret, MEDIA_API_KEY: gatewayToMediaSecret, TRUST_PROXY: String(trustProxy),
    },
  });
  await gateway.start();
  return gateway;
}

/** A fresh registered account, so each test's login is unambiguous in the shared auth log. */
async function registerUser() {
  const email = `harness-user-${++userCount}@example.test`;
  const password = 'harness integration test password 1';
  const res = await fetch(`${auth.baseUrl}/v1/users`, {
    method: 'POST', headers: { authorization: `Bearer ${authApiKeySecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 201, await res.text());
  return { email, password };
}

test('gateway (default, untrusted) mints its own request id for a login through the real generated route; it shows up in auth’s own log and the login reaches audit', { skip }, async (t) => {
  const gateway = await startGateway({ trustProxy: false });
  t.after(() => gateway.stop());
  const { email, password } = await registerUser();

  // auth-public's real generated shape is pathPrefix "/api/auth/", stripPrefix "/api/auth": the
  // caller includes auth's real upstream path verbatim after it (gateway strips only "/api/auth").
  const loginRes = await fetch(`${gateway.baseUrl}/api/auth/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'client-should-not-win' }, body: JSON.stringify({ email, password }),
  });
  const loginBody = await loginRes.json();
  assert.equal(loginRes.status, 200, JSON.stringify(loginBody));
  assert.equal(loginBody.user.email, email);

  const requestId = loginRes.headers.get('x-request-id');
  assert.ok(requestId);
  assert.notEqual(requestId, 'client-should-not-win', 'TRUST_PROXY defaults to false: the caller’s id is discarded, a fresh one minted');

  await new Promise((r) => setTimeout(r, 50));
  const gatewayLog = gateway.findLog((f) => f.msg === 'access' && f.reqId === requestId);
  assert.ok(gatewayLog, `gateway logged an access line for reqId ${requestId}. Recent lines: ${JSON.stringify(gateway.lines.slice(-5).map((l) => l.raw))}`);
  assert.equal(gatewayLog?.route, 'auth-public');
  assert.equal(gatewayLog?.status, 200);

  // The proof this test exists for: the id gateway generated, received purely over HTTP by a
  // *different OS process*, appears in that process's own structured log for the same request.
  const authIncoming = auth.findLog((f) => f.msg === 'incoming request' && f.reqId === requestId);
  assert.ok(authIncoming, `auth logged the incoming request for reqId ${requestId}. Recent lines: ${JSON.stringify(auth.lines.slice(-8).map((l) => l.raw))}`);
  assert.equal(/** @type {any} */ (authIncoming?.req)?.url, '/v1/auth/login');
  const authCompleted = auth.findLog((f) => f.msg === 'request completed' && f.reqId === requestId);
  assert.ok(authCompleted, `auth logged completion for reqId ${requestId}`);
  assert.equal(/** @type {any} */ (authCompleted?.res)?.statusCode, 200);
  assert.ok(!auth.findLog((f) => f.reqId === 'client-should-not-win'), 'auth never saw the discarded client id either');

  // auth forwarded the successful login as a security event, and audit actually stored it: a real
  // HTTP POST from the auth process to the audit process, buffered and flushed for real
  // (net/audit-client.js), confirmed by asking the real audit service, not by trusting auth's side.
  let found = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !found) {
    const res = await fetch(`${audit.baseUrl}/v1/events?source=auth&action=auth.login.succeeded&limit=20`, { headers: { authorization: `Bearer ${harnessAuditSecret}` } });
    const body = await res.json();
    found = body.items?.find((/** @type {any} */ e) => e.target?.id === loginBody.user.id);
    if (!found) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(found, 'the login event reached the real audit service within 5s of the login completing');
  assert.equal(found.outcome, 'success');
});

test('gateway (TRUST_PROXY=true) honours a caller-supplied request id; the same, exact id crosses into auth’s log', { skip }, async (t) => {
  const gateway = await startGateway({ trustProxy: true });
  t.after(() => gateway.stop());
  const { email, password } = await registerUser();
  const suppliedId = `harness-supplied-${randomSecret(6)}`;

  const loginRes = await fetch(`${gateway.baseUrl}/api/auth/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': suppliedId }, body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200, await loginRes.text());
  assert.equal(loginRes.headers.get('x-request-id'), suppliedId, 'trusted: gateway forwards the caller’s own id in its response');

  await new Promise((r) => setTimeout(r, 50));
  // The exact same id, chosen by the test itself and never generated by any atc-web process, is
  // what a *separate real process* (auth) logged for this request — proof the trust-gated id
  // actually crosses the wire, not proof of anything gateway merely claims about itself.
  const authCompleted = auth.findLog((f) => f.msg === 'request completed' && f.reqId === suppliedId);
  assert.ok(authCompleted, `auth logged completion for the caller-supplied id ${suppliedId}. Recent lines: ${JSON.stringify(auth.lines.slice(-8).map((l) => l.raw))}`);
  assert.equal(/** @type {any} */ (authCompleted?.res)?.statusCode, 200);
});

test('Post-production Phase 5: a real traceparent gateway mints for a login crosses into auth (a real, separate process) with the SAME trace-id and a FRESH span-id, visible in auth\'s own structured log', { skip }, async (t) => {
  const gateway = await startGateway({ trustProxy: true });
  t.after(() => gateway.stop());
  const { email, password } = await registerUser();

  const loginRes = await fetch(`${gateway.baseUrl}/api/auth/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200, await loginRes.text());
  const gatewayTraceparent = loginRes.headers.get('traceparent');
  assert.ok(gatewayTraceparent, 'gateway echoed its own traceparent on the response');
  const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
  const gw = TRACEPARENT.exec(/** @type {string} */ (gatewayTraceparent));
  assert.ok(gw, `expected a well-formed traceparent, got ${gatewayTraceparent}`);
  const gatewayTraceId = gw?.[1];
  const gatewaySpanId = gw?.[2];

  await new Promise((r) => setTimeout(r, 50));
  const requestId = loginRes.headers.get('x-request-id');
  const authCompleted = auth.findLog((f) => f.msg === 'request completed' && f.reqId === requestId);
  assert.ok(authCompleted, `auth logged completion for reqId ${requestId}. Recent lines: ${JSON.stringify(auth.lines.slice(-8).map((l) => l.raw))}`);
  assert.equal(/** @type {any} */ (authCompleted).traceId, gatewayTraceId, 'auth (a real, separate OS process) continued the SAME trace gateway started, received purely over HTTP');
  assert.notEqual(/** @type {any} */ (authCompleted).spanId, gatewaySpanId, 'auth minted its own FRESH span-id for this hop, never reusing gateway\'s');
  assert.match(String(/** @type {any} */ (authCompleted).spanId), /^[0-9a-f]{16}$/);
});

test('media-user route (Stage 1.1 regression): the real generated routes.json resolves through gateway to media’s actual upload route, not a stripped-too-short one', { skip }, async (t) => {
  const mediaPort = await freePort();
  media = new ServiceProcess({
    name: 'media', cwd: join(workspaceRoot, 'media'), entry: 'src/index.js', port: mediaPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(mediaPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:', DATA_DIR: join(scratch, 'media-files'),
      PUBLIC_BASE_URL: `http://127.0.0.1:${mediaPort}`, MEDIA_API_KEYS: `gateway:${gatewayToMediaSecret}`, SIGNING_SECRET: randomSecret(),
    },
  });
  await media.start();
  t.after(() => media?.stop());

  const gateway = await startGateway({ trustProxy: false });
  t.after(() => gateway.stop());

  const { email, password } = await registerUser();
  const loginRes = await fetch(`${gateway.baseUrl}/api/auth/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const { tokens } = await loginRes.json();
  assert.equal(loginRes.status, 200);

  // A real, fully-decodable 2x2 PNG (generated with sharp, the same library media re-encodes
  // uploads with — a hand-copied minimal PNG that only *parses* metadata but doesn't fully decode
  // under libvips fails here with a confusingly unrelated 422 INVALID_IMAGE, not a routing error).
  // media sniffs and re-encodes upload bytes, so an arbitrary text payload would 415 before the
  // route mapping even matters.
  const twoPixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISd3Qk6OAUIBAB8mBBGFRCvEAAAAAElFTkSuQmCC', 'base64');

  // media-user's real generated shape is pathPrefix "/api/media/", stripPrefix "/api/media": the
  // caller includes media's real upstream path ("/v1/files") verbatim after it, exactly like auth
  // above (both routes share the same generator, same stripPrefix contract). If the pre-Stage-1.1
  // misdiagnosis had actually been "fixed" by shortening pathPrefix/stripPrefix, this would 404.
  const uploadRes = await fetch(`${gateway.baseUrl}/api/media/v1/files`, {
    method: 'PUT', headers: { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'image/png' }, body: twoPixelPng,
  });
  const uploadBodyText = await uploadRes.text();
  assert.notEqual(uploadRes.status, 404, `expected media's real upload route to be reached, got 404: ${uploadBodyText}`);
  const body = JSON.parse(uploadBodyText);
  assert.equal(uploadRes.status, 201, JSON.stringify(body));
  assert.ok(body.file?.id, 'media accepted the upload and returned a file record');
});
