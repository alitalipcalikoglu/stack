import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll } from './harness.js';

/**
 * Post-production Phase 5: the console → backend half of the required real cross-service trace
 * E2E (the gateway → backend half lives in `gateway-auth-audit.test.js`). Two real, separate OS
 * processes: a real console proxying an authenticated admin request to a real audit service.
 * Proves, through audit's own real structured log (never trusted from console's side alone), that
 * the trace console generated for the inbound admin request continues into audit with the SAME
 * trace-id and a FRESH span-id for that hop — exactly the same mechanism (service-core's
 * `RequestContext`/`registerRequestContext`) the gateway → auth test already proves, now exercised
 * through console's own, independent trace-generation path (console never trusts an inbound
 * traceparent from the browser, but always propagates its own downstream).
 *
 * Spawns real service processes, so it only runs when explicitly requested: `STACK_INTEGRATION=1
 * npm test`.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {string[]} */
const scratchDirs = [];
/** @type {ServiceProcess[]} */
const procs = [];
after(async () => {
  await stopAll(procs);
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A real service checkout: symlinks the real `src/`/`node_modules`, own `.env`/`data` under a
 * throwaway scratch dir — the same convention every other file in this directory uses.
 * @param {string} scratch @param {string} serviceId
 */
function fixtureDir(scratch, serviceId) {
  const real = join(workspaceRoot, serviceId);
  const dir = join(scratch, serviceId);
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(real, 'src'), join(dir, 'src'), 'dir');
  symlinkSync(join(real, 'node_modules'), join(dir, 'node_modules'), 'dir');
  if (serviceId === 'console') {
    symlinkSync(join(real, 'build'), join(dir, 'build'), 'dir');
    cpSync(join(real, 'server.mjs'), join(dir, 'server.mjs'));
    cpSync(join(real, 'openapi.yaml'), join(dir, 'openapi.yaml'));
  }
  cpSync(join(real, 'package.json'), join(dir, 'package.json'));
  return dir;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

test('console -> audit: the trace console generates for a real admin request continues into a real, separate audit process with the SAME trace-id and a FRESH span-id', { skip }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'console-audit-trace-'));
  scratchDirs.push(scratch);

  // --- real audit process ---
  const auditPort = await freePort();
  const consoleToAuditSecret = randomSecret();
  const auditDir = fixtureDir(scratch, 'audit');
  const audit = new ServiceProcess({
    name: 'audit', cwd: auditDir, entry: 'src/index.js', port: auditPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(auditPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      AUDIT_API_KEYS: `console:${consoleToAuditSecret}:read`,
      // Post-production Phase 5: console is audit's real trusted caller here — the same
      // TRUST_PROXY declaration audit already makes for X-Forwarded-For, reused for traceparent.
      TRUST_PROXY: 'true',
    },
  });
  procs.push(audit);
  await audit.start();

  // --- real console process, seeded with one real admin before it starts ---
  const consolePort = await freePort();
  const servicesFile = join(scratch, 'services.json');
  writeFileSync(servicesFile, JSON.stringify({ services: [{ id: 'audit', type: 'audit', url: audit.baseUrl, apiKeyEnv: 'AUDIT_API_KEY' }] }));
  const consoleDir = fixtureDir(scratch, 'console');
  const dbPath = join(consoleDir, 'data', 'console.db');

  const { Database } = await import(pathToFileURL(join(consoleDir, 'src', 'db.js')).href);
  const { PasswordHasher } = await import(pathToFileURL(join(consoleDir, 'src', 'crypto', 'password.js')).href);
  const { AdminStore } = await import(pathToFileURL(join(consoleDir, 'src', 'store', 'admin-store.js')).href);
  const email = 'admin@example.test';
  const password = 'correct horse battery staple 9';
  const passwordHash = await new PasswordHasher({ logN: 14 }).hash(password);
  const seedDb = new Database(dbPath);
  new AdminStore(seedDb).create({ email, name: 'Harness Admin', passwordHash, role: 'admin' });
  seedDb.close();

  const consoleProc = new ServiceProcess({
    name: 'console', cwd: consoleDir, entry: 'server.mjs', port: consolePort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(consolePort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: './data/console.db',
      SERVICES_FILE: servicesFile, AUDIT_API_KEY: consoleToAuditSecret,
    },
  });
  procs.push(consoleProc);
  await consoleProc.start();

  const loginRes = await fetch(`${consoleProc.baseUrl}/api/session/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-request': '1' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(loginRes.status, 200, await loginRes.text());
  const setCookie = loginRes.headers.get('set-cookie');
  assert.ok(setCookie, 'expected a session cookie');
  const cookie = String(setCookie).split(';')[0];

  // The proxied admin call to the real audit service.
  const eventsRes = await fetch(`${consoleProc.baseUrl}/api/services/audit/audit/events?limit=5`, { headers: { cookie, 'x-console-request': '1' } });
  assert.equal(eventsRes.status, 200, await eventsRes.text());
  const eventsTraceparent = eventsRes.headers.get('traceparent');
  const eventsTrace = TRACEPARENT.exec(/** @type {string} */ (eventsTraceparent));
  assert.ok(eventsTrace, `expected a well-formed traceparent on the proxy response, got ${eventsTraceparent}`);
  const consoleTraceId = eventsTrace?.[1];
  const consoleSpanId = eventsTrace?.[2];

  // The proof: audit (a real, separate OS process, reached purely over HTTP) logged the SAME
  // trace-id console generated for this request, with its own FRESH span-id for the hop.
  await new Promise((r) => setTimeout(r, 100));
  const auditCompleted = audit.findLog((f) => f.msg === 'request completed');
  assert.ok(auditCompleted, `expected a "request completed" line in audit's log. Recent lines: ${JSON.stringify(audit.lines.slice(-10).map((l) => l.raw))}`);
  assert.equal(/** @type {any} */ (auditCompleted).traceId, consoleTraceId, 'audit (a real, separate process) continued the SAME trace console started, received purely over HTTP');
  assert.notEqual(/** @type {any} */ (auditCompleted).spanId, consoleSpanId, 'audit minted its own FRESH span-id for this hop, never reusing console\'s');
  assert.match(String(/** @type {any} */ (auditCompleted).spanId), /^[0-9a-f]{16}$/);
});
