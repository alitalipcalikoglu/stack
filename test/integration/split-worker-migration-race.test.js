import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, waitUntil } from './harness.js';

/**
 * Post-production Phase 1, item 10: the real split-worker deployment (`stack up --split-workers`)
 * for the three split-capable services, proven against the REAL, unmodified `src/api-main.js` /
 * `src/worker-main.js` entry points (never a synthetic stand-in), each opening the SAME on-disk
 * SQLite file at (as close to) the same instant as `Promise.all`-spawning two real child processes
 * achieves — the same synchronization `service-core/scripts/migration-race-stress.mjs` used to
 * reproduce the original bug at an ~87-92% trigger rate, so this is a meaningful race, not a token
 * gesture. The fixture DB is one version BEHIND each service's real, current `MIGRATIONS` array (the
 * real migration SQL, not a synthetic canary), built by re-using that service's own `src/db.js`
 * `Database` subclass with the array sliced by one — so the migration this test races is the exact
 * SQL that ships.
 *
 * Readiness: the API process's `/ready` is a real HTTP poll. The worker process has NO HTTP listener
 * at all (confirmed in its own entry file's comment) — its readiness is the DB-backed
 * `worker_heartbeat` table actually gaining a row, the same observable, already-existing signal
 * `/ready`/`/stats` on an API-only process itself reads (Stage 6) — not an arbitrary sleep.
 *
 * Spawns real processes, so it only runs when explicitly requested: `STACK_INTEGRATION=1 npm test`.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {string} */ let scratch;
before(() => { if (shouldRun) scratch = mkdtempSync(join(tmpdir(), 'split-migration-race-')); });
after(() => { if (shouldRun) rmSync(scratch, { recursive: true, force: true }); });

/**
 * Builds an "N-1" fixture DB using the real service's own `Database` subclass with its last
 * migration held back — real migration SQL, real schema, just one version short of current.
 * @param {string} serviceId @param {string} dbPath
 * @returns {Promise<number>} the full (current) migration count, for later assertions
 */
async function seedOldFixture(serviceId, dbPath) {
  const mod = await import(pathToFileURL(join(workspaceRoot, serviceId, 'src', 'db.js')).href);
  /** @type {{ new (path: string): { close(): void }, MIGRATIONS: readonly string[] }} */
  const RealDb = mod.Database;
  const full = RealDb.MIGRATIONS;
  assert.ok(full.length >= 2, `${serviceId}: needs at least 2 real migrations for a meaningful "one behind" fixture, has ${full.length}`);
  /** @type {any} */
  const OldDb = class extends /** @type {any} */ (RealDb) {
    static MIGRATIONS = full.slice(0, -1);
  };
  new OldDb(dbPath).close();
  return full.length;
}

/**
 * Spawns a real entry-point process (api-main.js or worker-main.js) for `serviceId`, without
 * waiting for readiness — the caller races two of these via `Promise.all` around this function's
 * own launch, so the two children's `spawn()` calls happen back to back, exactly like
 * `Stack#up`'s existing `pm2 startOrRestart` loop for split apps.
 * @param {string} serviceId @param {'api'|'worker'} role @param {Record<string,string>} env
 */
function launch(serviceId, role, env) {
  const entry = role === 'api' ? 'src/api-main.js' : 'src/worker-main.js';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    cwd: join(workspaceRoot, serviceId), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  /** @type {string[]} */ const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream?.on('data', (/** @type {Buffer} */ chunk) => { buf += chunk.toString('utf8'); const parts = buf.split('\n'); buf = /** @type {string} */ (parts.pop()); for (const l of parts) if (l) lines.push(l); });
  }
  return { child, lines };
}

/** @param {import('node:child_process').ChildProcess} child */
function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined);
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => { clearTimeout(t); resolve(undefined); });
  });
}

/**
 * @param {object} o
 * @param {string} o.serviceId
 * @param {(o: { dbPath: string, apiPort: number }) => Record<string,string>} o.env  Shared env for
 *   both the api and worker process (role is selected by which entry file is spawned, not env).
 */
async function raceSplitStartup({ serviceId, env }) {
  const dbPath = join(scratch, `${serviceId}-${randomSecret(4)}.db`);
  const fullMigrationCount = await seedOldFixture(serviceId, dbPath);
  const apiPort = await freePort();
  const sharedEnv = env({ dbPath, apiPort });

  const api = launch(serviceId, 'api', sharedEnv);
  const worker = launch(serviceId, 'worker', sharedEnv);
  try {
    await waitUntil(async () => {
      if (api.child.exitCode !== null) throw new Error(`${serviceId} api process exited early (code ${api.child.exitCode}). Lines: ${api.lines.slice(-20).join('\n')}`);
      try {
        const res = await fetch(`http://127.0.0.1:${apiPort}/ready`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) { await res.body?.cancel(); return true; }
        await res.body?.cancel();
      } catch { /* not listening yet */ }
      return false;
    }, { timeoutMs: 15_000, message: `${serviceId} api process /ready` });

    await waitUntil(() => {
      if (worker.child.exitCode !== null) throw new Error(`${serviceId} worker process exited early (code ${worker.child.exitCode}). Lines: ${worker.lines.slice(-20).join('\n')}`);
      let raw;
      try { raw = new DatabaseSync(dbPath, { readOnly: true }); } catch { return false; } // file may not exist yet at the very first instant
      try {
        const row = /** @type {any} */ (raw.prepare('SELECT COUNT(*) AS n FROM worker_heartbeat').get());
        return (row?.n ?? 0) > 0;
      } catch {
        return false; // worker_heartbeat table not created yet (migration still in flight)
      } finally {
        raw.close();
      }
    }, { timeoutMs: 15_000, message: `${serviceId} worker process worker_heartbeat presence` });

    const infoRes = await fetch(`http://127.0.0.1:${apiPort}/v1/info`);
    const info = await infoRes.json();
    assert.equal(info.schemaVersion, fullMigrationCount, `${serviceId}: /v1/info reports the full current schemaVersion after the real split startup migrated the fixture. api lines: ${JSON.stringify(api.lines.slice(-15))}`);

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(/** @type {any} */ (raw.prepare('PRAGMA user_version').get()).user_version, fullMigrationCount);
    const rows = /** @type {any[]} */ (raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).map((r) => r.version);
    assert.deepEqual(rows, Array.from({ length: fullMigrationCount }, (_, i) => i + 1), `${serviceId}: schema_migrations has exactly one row per version, no duplicates`);
    raw.close();

    assert.equal(api.child.exitCode, null, `${serviceId} api process must still be alive (never crashed by the race)`);
    assert.equal(worker.child.exitCode, null, `${serviceId} worker process must still be alive (never crashed by the race)`);
  } finally {
    await Promise.all([stop(api.child), stop(worker.child)]);
  }
}

test('notify: split api+worker simultaneous first start against a pending migration — both survive, migration applies once', { skip }, async () => {
  await raceSplitStartup({
    serviceId: 'notify',
    env: ({ dbPath, apiPort }) => ({
      PATH: process.env.PATH ?? '', PORT: String(apiPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: dbPath,
      NOTIFY_API_KEYS: `harness:${randomSecret()}`, SMTP_URL: 'json:', SMTP_FROM: 'Harness <harness@example.test>', WEBHOOK_SIGNING_SECRET: randomSecret(),
    }),
  });
});

test('scheduler: split api+worker simultaneous first start against a pending migration — both survive, migration applies once', { skip }, async () => {
  await raceSplitStartup({
    serviceId: 'scheduler',
    env: ({ dbPath, apiPort }) => ({
      PATH: process.env.PATH ?? '', PORT: String(apiPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: dbPath,
      SIGNING_SECRET: randomSecret(), SCHEDULER_API_KEYS: `harness:${randomSecret()}:readwrite`,
      TARGET_ALLOW_HTTP: 'true', TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: '127.0.0.1',
    }),
  });
});

test('webhook-out: split api+worker simultaneous first start against a pending migration — both survive, migration applies once', { skip }, async () => {
  await raceSplitStartup({
    serviceId: 'webhook-out',
    env: ({ dbPath, apiPort }) => ({
      PATH: process.env.PATH ?? '', PORT: String(apiPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: dbPath,
      WEBHOOK_API_KEYS: `harness:${randomSecret()}:readwrite`, SECRETS_KEY: randomSecret(32),
      TARGET_ALLOW_HTTP: 'true', TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: '127.0.0.1',
    }),
  });
});
