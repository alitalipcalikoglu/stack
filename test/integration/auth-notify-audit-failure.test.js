import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll, waitUntil } from './harness.js';

/**
 * Stage 11: two real, cross-process failure scenarios around signup, proven with actual spawned
 * `node` processes (auth, notify, audit), never mocks or in-process fakes.
 *
 * Part A — notify is unreachable when a user signs up: `POST /v1/users` still succeeds (201, no
 * rollback of the created user) and the security-audit event for that signup is *already* on the
 * real audit service, with no dependency on notify's outcome at all. That independence is real,
 * not incidental: `AuthService#register` (auth/src/domain/auth-service.js) writes the user row and
 * the event's outbox row in one SQLite transaction (`EventStore.record`, auth/src/store/event-store.js)
 * and only afterwards calls `#sendVerification`, whose failure is caught and turned into
 * `verificationEmailSent: false` — never a throw, never a rollback.
 *
 * Part B — audit itself is unreachable at signup time. The mechanism that protects that event is
 * not an in-memory buffer (auth is wired in `AuditClient`'s durable *outbox* mode, not buffer mode —
 * see application.js) but a real SQLite table (`outbox`, auth/src/db.js) drained by a background
 * flush timer. This part proves the row survives a full process restart and, once audit finally
 * comes up, is delivered exactly once — never duplicated — via audit's `UNIQUE(source, client_id)`
 * constraint (audit/src/db.js) keyed by the outbox row's own stable id.
 *
 * A note on how both parts actually start their `auth` process: `GET /ready` on auth
 * (auth/src/http/auth-api.js `#registerPublic`) calls `this.mailer.verify()`, which is a real
 * `GET /health` against `NOTIFY_URL` — so auth can never become ready while notify is completely
 * unreachable, and `ServiceProcess.start()` would time out waiting for it. Both parts therefore
 * boot a real notify process just long enough for auth's own readiness probe to pass, then stop it
 * — which is also what makes the later verification-email send fail with a genuine connection
 * error, the same failure a notify outage produces in production. Audit is different: auth's
 * readiness check never touches it (only the outbox's background timer does), so Part B can leave
 * audit unstarted from the very beginning with no such trick needed.
 *
 * `STACK_INTEGRATION=1 npm test` to run; plain `npm test` skips this file (see harness.js and
 * gateway-auth-audit.test.js for the same gate and process-spawning pattern this file follows).
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const password = 'harness integration test password 1';
/** @type {string} */ let scratch;

before(() => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-integration-auth-notify-audit-'));
});

after(() => {
  if (!shouldRun) return;
  rmSync(scratch, { recursive: true, force: true });
});

/** A fresh EC P-256 signing key on disk, for auth's JWT_PRIVATE_KEY_PATH. @param {string} tag */
function jwtKeyPath(tag) {
  const path = join(scratch, `jwt-${tag}.pem`);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return path;
}

/** @param {{ port: number, apiKey: string }} o */
function notifyEnv({ port, apiKey }) {
  return {
    PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
    NOTIFY_API_KEYS: `auth:${apiKey}`, SMTP_URL: 'json:', SMTP_FROM: 'Harness <harness@example.test>', WEBHOOK_SIGNING_SECRET: randomSecret(),
  };
}

/** @param {{ port: number, apiKeys: string }} o */
function auditEnv({ port, apiKeys }) {
  return {
    PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
    AUDIT_API_KEYS: apiKeys,
  };
}

test('signup with notify unreachable: still 201 with no rollback, and the audit event is already durable independent of notify', { skip }, async (t) => {
  const [auditPort, notifyPort, authPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const authToAuditSecret = randomSecret();
  const harnessAuditSecret = randomSecret();
  const authToNotifySecret = randomSecret();
  const authWriteSecret = randomSecret();
  const authReadSecret = randomSecret();

  /** @type {ServiceProcess|undefined} */ let audit;
  /** @type {ServiceProcess|undefined} */ let notify;
  /** @type {ServiceProcess|undefined} */ let auth;
  t.after(() => stopAll(/** @type {ServiceProcess[]} */ ([audit, notify, auth].filter((s) => s !== undefined))));

  audit = new ServiceProcess({
    name: 'audit', cwd: join(workspaceRoot, 'audit'), entry: 'src/index.js', port: auditPort,
    env: auditEnv({ port: auditPort, apiKeys: `auth:${authToAuditSecret}:write,harness:${harnessAuditSecret}:read` }),
  });
  await audit.start();

  // Boot notify only long enough to satisfy auth's own /ready gate (see file doc comment), then
  // take it down for real — the actual "notify unavailable" this part is testing.
  notify = new ServiceProcess({ name: 'notify', cwd: join(workspaceRoot, 'notify'), entry: 'src/index.js', port: notifyPort, env: notifyEnv({ port: notifyPort, apiKey: authToNotifySecret }) });
  await notify.start();

  auth = new ServiceProcess({
    name: 'auth', cwd: join(workspaceRoot, 'auth'), entry: 'src/index.js', port: authPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(authPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      AUTH_API_KEYS: `harness-write:${authWriteSecret}:write,harness-read:${authReadSecret}:read`,
      JWT_PRIVATE_KEY_PATH: jwtKeyPath(`a-${authPort}`), JWT_ISSUER: 'http://harness.test', JWT_AUDIENCE: 'app',
      APP_NAME: 'Harness', VERIFY_URL_TEMPLATE: 'https://example.test/verify?token={token}', RESET_URL_TEMPLATE: 'https://example.test/reset?token={token}',
      NOTIFY_URL: notify.baseUrl, NOTIFY_API_KEY: authToNotifySecret,
      AUDIT_URL: audit.baseUrl, AUDIT_API_KEY: authToAuditSecret,
    },
  });
  await auth.start();

  await notify.stop(); // now genuinely unreachable: nothing listens on notifyPort any more

  const email = `part-a-${randomSecret(4)}@example.test`;
  const res = await fetch(`${auth.baseUrl}/v1/users`, {
    method: 'POST', headers: { authorization: `Bearer ${authWriteSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, `expected signup to still succeed with notify unreachable: ${JSON.stringify(body)}. Recent auth log: ${JSON.stringify(auth.lines.slice(-10).map((l) => l.raw))}`);
  assert.equal(body.verificationEmailSent, false, `expected the verification mail send to have failed against a stopped notify: ${JSON.stringify(body)}`);
  assert.equal(body.user.email, email);
  assert.ok(body.user.id, 'signup response includes the new user id');
  const userId = body.user.id;

  // No rollback: the user genuinely persisted, readable back with a read-role key.
  const getRes = await fetch(`${auth.baseUrl}/v1/users/${userId}`, { headers: { authorization: `Bearer ${authReadSecret}` } });
  const getBody = await getRes.json();
  assert.equal(getRes.status, 200, `expected the user created despite the notify failure to be readable back: ${JSON.stringify(getBody)}`);
  assert.equal(getBody.user.email, email);

  // The audit event is already there, with no wait for any notify recovery: EventStore.record()
  // committed the outbox row in the same transaction as the user row, before #sendVerification
  // (and its failure) ever ran. waitUntil here only covers auth's async outbox flush timer, not
  // any dependency on notify.
  const items = await waitUntil(async () => {
    const eres = await fetch(`${audit.baseUrl}/v1/events?source=auth&action=auth.user.registered&targetId=${userId}`, { headers: { authorization: `Bearer ${harnessAuditSecret}` } });
    const ebody = await eres.json();
    return ebody.items?.length ? ebody.items : undefined;
  }, { timeoutMs: 5_000, message: `an auth.user.registered audit event for user ${userId} on the real audit service` });
  assert.equal(items.length, 1, `expected exactly one audit event for user ${userId}, got ${items.length}: ${JSON.stringify(items)}`);
  assert.equal(items[0].outcome, 'success');
});

test('signup with audit unreachable: the durable SQLite outbox survives an auth restart and later flushes to audit exactly once (no duplicate)', { skip }, async (t) => {
  const [notifyPort, authPort, auditPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const authToAuditSecret = randomSecret();
  const harnessAuditSecret = randomSecret();
  const authToNotifySecret = randomSecret();
  const authWriteSecret = randomSecret();
  const dbPath = join(scratch, `auth-outbox-${authPort}.db`); // a real file: the whole point is surviving a restart, not an in-memory DB

  /** @type {ServiceProcess|undefined} */ let notify;
  /** @type {ServiceProcess|undefined} */ let auth;
  /** @type {ServiceProcess|undefined} */ let audit;
  t.after(() => stopAll(/** @type {ServiceProcess[]} */ ([notify, auth, audit].filter((s) => s !== undefined))));

  const authEnv = () => ({
    PATH: process.env.PATH ?? '', PORT: String(authPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: dbPath,
    AUTH_API_KEYS: `harness-write:${authWriteSecret}:write`,
    JWT_PRIVATE_KEY_PATH: jwtKeyPath(`b-${authPort}`), JWT_ISSUER: 'http://harness.test', JWT_AUDIENCE: 'app',
    APP_NAME: 'Harness', VERIFY_URL_TEMPLATE: 'https://example.test/verify?token={token}', RESET_URL_TEMPLATE: 'https://example.test/reset?token={token}',
    NOTIFY_URL: `http://127.0.0.1:${notifyPort}`, NOTIFY_API_KEY: authToNotifySecret,
    // audit is not running yet at all — the outage this part tests. auth's /ready never checks
    // it (see file doc comment), so this alone does not block auth from starting.
    AUDIT_URL: `http://127.0.0.1:${auditPort}`, AUDIT_API_KEY: authToAuditSecret,
  });

  // 1) boot auth with notify briefly up (its own /ready gate), then take notify down too — this
  //    part doesn't care about notify's outcome, but keeping it unreachable here as well keeps
  //    the scenario honest (verificationEmailSent will read false, same as Part A).
  notify = new ServiceProcess({ name: 'notify', cwd: join(workspaceRoot, 'notify'), entry: 'src/index.js', port: notifyPort, env: notifyEnv({ port: notifyPort, apiKey: authToNotifySecret }) });
  await notify.start();
  auth = new ServiceProcess({ name: 'auth', cwd: join(workspaceRoot, 'auth'), entry: 'src/index.js', port: authPort, env: authEnv() });
  await auth.start();
  await notify.stop();

  // 2) register while audit has never been started at all.
  const email = `part-b-${randomSecret(4)}@example.test`;
  const res = await fetch(`${auth.baseUrl}/v1/users`, {
    method: 'POST', headers: { authorization: `Bearer ${authWriteSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, `expected signup to succeed with audit entirely unstarted: ${JSON.stringify(body)}. Recent auth log: ${JSON.stringify(auth.lines.slice(-10).map((l) => l.raw))}`);
  const userId = body.user.id;
  assert.ok(userId, 'signup response includes the new user id');

  // 3) restart auth on the SAME db file: the pending outbox row must survive a real process
  //    boundary, not just an in-memory buffer. Notify has to come back up briefly again purely
  //    for this restart's own readiness gate.
  await auth.stop();
  notify = new ServiceProcess({ name: 'notify', cwd: join(workspaceRoot, 'notify'), entry: 'src/index.js', port: notifyPort, env: notifyEnv({ port: notifyPort, apiKey: authToNotifySecret }) });
  await notify.start();
  auth = new ServiceProcess({ name: 'auth', cwd: join(workspaceRoot, 'auth'), entry: 'src/index.js', port: authPort, env: authEnv() });
  await auth.start();
  await notify.stop();

  // 4) only now start the real audit service the outbox was configured to talk to all along.
  audit = new ServiceProcess({
    name: 'audit', cwd: join(workspaceRoot, 'audit'), entry: 'src/index.js', port: auditPort,
    env: auditEnv({ port: auditPort, apiKeys: `auth:${authToAuditSecret}:write,harness:${harnessAuditSecret}:read` }),
  });
  await audit.start();

  // 5) the row that survived the restart is picked up by the outbox's background flush timer
  //    (default 2s) once its target is finally reachable.
  const query = `${audit.baseUrl}/v1/events?source=auth&action=auth.user.registered&targetId=${userId}`;
  const items = await waitUntil(async () => {
    const eres = await fetch(query, { headers: { authorization: `Bearer ${harnessAuditSecret}` } });
    const ebody = await eres.json();
    return ebody.items?.length ? ebody.items : undefined;
  }, { timeoutMs: 10_000, intervalMs: 250, message: `the restart-surviving outbox row for user ${userId} reaching audit after it comes back up` });
  assert.equal(items.length, 1, `expected exactly one audit event for user ${userId} after recovery, got ${items.length}: ${JSON.stringify(items)}`);
  assert.equal(items[0].outcome, 'success');

  // 6) stays at exactly one across further flush cycles: audit's UNIQUE(source, client_id),
  //    keyed by the outbox row's own stable id, makes a resend a no-op rather than a duplicate.
  await new Promise((r) => setTimeout(r, 4_500)); // a little over two default 2s flush intervals
  const recheckRes = await fetch(query, { headers: { authorization: `Bearer ${harnessAuditSecret}` } });
  const recheckBody = await recheckRes.json();
  assert.equal(recheckBody.items?.length, 1, `expected still exactly one event for user ${userId} after further flush cycles (no duplicate), got: ${JSON.stringify(recheckBody.items)}`);
});
