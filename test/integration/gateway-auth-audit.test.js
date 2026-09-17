import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll } from './harness.js';

/**
 * Real cross-service flow, real processes: gateway proxies a login to auth, over the wire, and
 * auth forwards the resulting security event to audit. This is the flow Stage 1 exists to make
 * traceable, proven with the actual services running as separate OS processes rather than in one
 * test process or against fakes — including, in the second test below, the specific thing Stage 1
 * changed in the gateway: whether a caller-supplied `X-Request-Id` is honoured or discarded,
 * verified by what a *different process* (auth) logged after receiving it purely over HTTP.
 *
 * Spawns 4 real `node` processes (audit, notify, auth, plus one or two gateway instances) and can
 * take several seconds, so it only runs when explicitly requested: `STACK_INTEGRATION=1 npm test`.
 * Plain `npm test` stays fast and spawns nothing (see harness-self-test.test.js for the always-on
 * tests, which exercise the harness itself without any atc-web service).
 *
 * What this does NOT (yet) prove, so the tests don't claim it: the audit event auth forwards for a
 * login has no `requestId` field today (`auth/src/store/event-store.js`'s security-event schema
 * doesn't carry one), so a request id cannot appear *inside* that event's JSON — only the plain
 * fact that the event is there at all is checked. See the Stage 1 report.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {string} */ let scratch;
/** @type {ServiceProcess} */ let audit;
/** @type {ServiceProcess} */ let notify;
/** @type {ServiceProcess} */ let auth;
/** @type {string} */ let authApiKeySecret;
/** @type {string} */ let gatewayToAuthSecret;
/** @type {string} */ let harnessAuditSecret;
let userCount = 0;

before(async () => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-integration-'));
  const [auditPort, notifyPort, authPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const authToAuditSecret = randomSecret();
  harnessAuditSecret = randomSecret();
  gatewayToAuthSecret = randomSecret();
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
      JWT_PRIVATE_KEY_PATH: jwtKeyPath, JWT_ISSUER: 'http://harness.test', JWT_AUDIENCE: 'harness',
      NOTIFY_URL: notify.baseUrl, NOTIFY_API_KEY: authToNotifySecret,
      APP_NAME: 'Harness', VERIFY_URL_TEMPLATE: 'https://example.test/verify?token={token}', RESET_URL_TEMPLATE: 'https://example.test/reset?token={token}',
      AUDIT_URL: audit.baseUrl, AUDIT_API_KEY: authToAuditSecret,
    },
  });
  await auth.start();
});

after(async () => {
  if (!shouldRun) return;
  await stopAll([auth, notify, audit]);
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Starts a gateway instance routing `/v1/auth/*` to the shared real auth process, unmodified (no
 * stripPrefix). This is NOT the route shape `stack/src/setup-context.js`'s `gatewayRoutes()`
 * generates for auth in a real deployment (it strips "/api/auth" down to "/login", which 404s
 * against auth's real `/v1/auth/login`) — that mismatch is a separate, pre-existing bug this test
 * happened to surface while being built; see the Stage 1 report. Fixing it is out of scope for
 * Stage 1, so this test defines its own correct route rather than reusing the broken one.
 * @param {{ trustProxy?: boolean }} [o]
 */
async function startGateway({ trustProxy = false } = {}) {
  const port = await freePort();
  const routesPath = join(scratch, `routes-${port}.json`);
  writeFileSync(routesPath, JSON.stringify({
    routes: [{ id: 'auth', pathPrefix: '/v1/auth/', upstreams: [auth.baseUrl], injectApiKey: 'AUTH_API_KEY', methods: ['POST'], healthPath: '/health' }],
  }));
  const gateway = new ServiceProcess({
    name: 'gateway', cwd: join(workspaceRoot, 'gateway'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info',
      ROUTES_FILE: routesPath, AUTH_API_KEY: gatewayToAuthSecret, TRUST_PROXY: String(trustProxy),
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

test('gateway (default, untrusted) mints its own request id for a login; it shows up in auth’s own log and the login reaches audit', { skip }, async (t) => {
  const gateway = await startGateway({ trustProxy: false });
  t.after(() => gateway.stop());
  const { email, password } = await registerUser();

  const loginRes = await fetch(`${gateway.baseUrl}/v1/auth/login`, {
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
  assert.equal(gatewayLog?.route, 'auth');
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

  const loginRes = await fetch(`${gateway.baseUrl}/v1/auth/login`, {
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
