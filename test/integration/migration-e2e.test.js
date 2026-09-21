import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { freePort, openOldFixtureDb, randomSecret, ServiceProcess, stopAll } from './harness.js';

/**
 * Post-production Phase 2: closes the "full HTTP-level migration E2E missing" gap left open by
 * Stage 12 and Phase 1. Phase 1 already proves the concurrent-startup *arbitration* mechanism
 * (two processes racing the same pending migration never corrupt it or double-apply it) with a
 * synthetic canary schema. This file proves the orthogonal thing nothing else in the suite
 * covers: a SINGLE real service process, booted against each service's own real one-version-old
 * schema with real pre-existing domain data in it, actually migrates through its real entry point,
 * becomes ready, serves the new schema version over its real `/v1/info` and business API, and
 * still has the old data — and, in the other direction, a real process opening a database newer
 * than it supports refuses to start and leaves the file untouched.
 *
 * Every fixture is the real service's own `Database` subclass with its last migration held back
 * (see `openOldFixtureDb` in harness.js) — never a hand-written stand-in for the migration SQL.
 * Every fixture's pre-existing row is seeded with a direct SQL `INSERT` matching that OLD schema's
 * actual columns: a service's current domain Store classes `db.prepare()` statements referencing
 * columns/tables that don't exist yet at the held-back version (e.g. webhook-out's
 * `SubscriptionStore` selects the Phase 2-added `ordered` column unconditionally), so they cannot
 * be constructed against a deliberately old fixture — direct SQL against the already-real,
 * migration-SQL-derived schema is the only way to seed it without duplicating that schema logic.
 *
 * Spawns real service processes, so it only runs when explicitly requested: `STACK_INTEGRATION=1
 * npm test`. Plain `npm test` stays fast and spawns nothing.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {ServiceProcess[]} */
const running = [];
/** @type {string[]} */
const scratchDirs = [];

after(async () => {
  if (!shouldRun) return;
  await stopAll(running);
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** @param {string} prefix @returns {string} a fresh, tracked scratch directory (removed in `after`, not shared between tests). */
function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * ES256 key pair written to real PEM files under `dir`, via auth's own `KeyGenerator` — the exact
 * class `npm run keygen` uses, not a re-implementation of key generation.
 * @param {string} dir
 */
function authKeys(dir) {
  const privatePath = join(dir, 'jwt-private.pem');
  const publicPath = join(dir, 'jwt-public.pem');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  return privatePath;
}

/**
 * A minimal real `node:http` server answering 200 to anything — for a dependency this test only
 * needs REACHABLE, not exercised for real business logic (auth's own readiness probe does a real
 * `GET /health` against `NOTIFY_URL` before `/ready` succeeds; standing up the whole real notify
 * service just to satisfy that reachability check would be its own, unrelated integration test).
 */
function startHttpStub() {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      res({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/**
 * ---------------------------------------------------------------------------------------------
 * Positive E2E: old schema + real data -> real process -> migrates -> /ready -> /v1/info ->
 * business API still sees the old data.
 * ---------------------------------------------------------------------------------------------
 * @param {object} o
 * @param {string} o.serviceId
 * @param {string} o.entry
 * @param {(db: any, scratch: string) => any} o.seed  Inserts one real pre-migration row via direct
 *   SQL against the OLD schema; returns whatever the seed's identity/content the verify step needs.
 * @param {(o: { dbPath: string, port: number, scratch: string }) => Record<string,string>} o.env
 * @param {(o: { proc: ServiceProcess, dbPath: string, fullMigrationCount: number, seeded: any }) => Promise<void>} o.verify
 * @param {boolean} [o.checkBackup] Also verify the pre-migration backup file (item 11) — only one
 *   service needs to; the mechanism is generic, not per-service.
 */
async function positiveMigrationE2E({ serviceId, entry, seed, env, verify, checkBackup = false }) {
  const scratch = scratchDir(`migration-e2e-${serviceId}-`);
  const dbPath = join(scratch, `${serviceId}.db`);
  const { db, fullMigrationCount } = await openOldFixtureDb(workspaceRoot, serviceId, dbPath);
  const seeded = seed(db, scratch);
  db.close();

  const port = await freePort();
  const proc = new ServiceProcess({
    name: serviceId, cwd: join(workspaceRoot, serviceId), entry, port,
    env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: dbPath, ...env({ dbPath, port, scratch }) },
  });
  running.push(proc);
  await proc.start();

  const infoRes = await fetch(`${proc.baseUrl}/v1/info`);
  const info = await infoRes.json();
  assert.equal(info.schemaVersion, fullMigrationCount, `${serviceId}: /v1/info reports the full current schema version after real startup migration. lines: ${JSON.stringify(proc.lines.slice(-15).map((l) => l.raw))}`);

  if (checkBackup) {
    const oldVersion = fullMigrationCount - 1;
    const backups = readdirSync(scratch).filter((f) => f.includes(`.pre-v${oldVersion}-`));
    assert.equal(backups.length, 1, `${serviceId}: exactly one pre-migration backup for this non-concurrent run, found ${JSON.stringify(backups)}`);
    const raw = new DatabaseSync(join(scratch, backups[0]), { readOnly: true });
    try {
      assert.equal(/** @type {any} */ (raw.prepare('PRAGMA user_version').get()).user_version, oldVersion, `${serviceId}: backup's own schema version is the OLD (pre-migration) version`);
    } finally {
      raw.close();
    }
  }

  await verify({ proc, dbPath, fullMigrationCount, seeded });
}

/**
 * ---------------------------------------------------------------------------------------------
 * Future-schema E2E: a real process opening a database newer than it supports refuses to start,
 * for the right reason, and leaves the file untouched.
 * ---------------------------------------------------------------------------------------------
 * @param {object} o
 * @param {string} o.serviceId
 * @param {string} o.entry
 * @param {(db: any) => void} o.seed  Inserts one real row via the CURRENT (full) schema — the
 *   fixture here is a normal, fully-migrated database, just later bumped past what this build
 *   supports.
 * @param {(o: { dbPath: string, port: number }) => Record<string,string>} o.env
 * @param {(raw: import('node:sqlite').DatabaseSync) => void} o.assertSentinelUnchanged
 */
async function futureSchemaRefusalE2E({ serviceId, entry, seed, env, assertSentinelUnchanged }) {
  const scratch = scratchDir(`migration-e2e-future-${serviceId}-`);
  const dbPath = join(scratch, `${serviceId}.db`);

  const mod = await import(pathToFileURL(join(workspaceRoot, serviceId, 'src', 'db.js')).href);
  const RealDb = mod.Database;
  const db = new RealDb(dbPath);
  seed(db);
  db.close();

  let currentVersion, migrationsCountBefore;
  {
    const raw = new DatabaseSync(dbPath);
    try {
      currentVersion = /** @type {any} */ (raw.prepare('PRAGMA user_version').get()).user_version;
      migrationsCountBefore = /** @type {any} */ (raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n;
      raw.exec(`PRAGMA user_version = ${currentVersion + 1}`);
    } finally {
      raw.close();
    }
  }

  const port = await freePort();
  const proc = new ServiceProcess({
    name: serviceId, cwd: join(workspaceRoot, serviceId), entry, port,
    env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: dbPath, ...env({ dbPath, port }) },
  });
  running.push(proc);

  await assert.rejects(() => proc.start({ timeoutMs: 8_000 }), `${serviceId}: a real process opening a database one version ahead must never become ready`);
  assert.notEqual(proc.child?.exitCode, null, `${serviceId}: the process must actually exit (not just fail to answer /ready), and for the right reason, not hang`);
  assert.notEqual(proc.child?.exitCode, 0, `${serviceId}: must exit non-zero`);
  const sawRefusal = proc.lines.some((l) => l.raw.includes('database is newer than this build supports'));
  assert.ok(sawRefusal, `${serviceId}: expected the ConfigError refusal message in the process output. lines: ${JSON.stringify(proc.lines.slice(-20).map((l) => l.raw))}`);

  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(/** @type {any} */ (raw.prepare('PRAGMA user_version').get()).user_version, currentVersion + 1, `${serviceId}: user_version must be exactly what we forced it to, untouched by the failed attempt`);
    assert.equal(/** @type {any} */ (raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n, migrationsCountBefore, `${serviceId}: schema_migrations must show no new rows from the failed attempt`);
    assertSentinelUnchanged(raw);
  } finally {
    raw.close();
  }
}

// ==================================================================================================
// Positive E2E
// ==================================================================================================

test('notify: real old-schema (v2) fixture with an existing queued message migrates through a real process to v3, /ready, /v1/info, message still there, backup verified', { skip }, async () => {
  /** @type {string} */ let sentinelId;
  const apiKey = randomSecret();
  await positiveMigrationE2E({
    serviceId: 'notify',
    entry: 'src/api-main.js', // API-only: no worker loop, so the seeded 'queued' message is never claimed/delivered as a side effect of this test.
    checkBackup: true,
    seed: (db) => {
      sentinelId = `11111111-1111-4111-8111-${Date.now().toString(16).padStart(12, '0')}`;
      const now = Date.now();
      db.prepare(`
        INSERT INTO messages (id, api_key_id, idempotency_key, channel, payload, status, attempts, max_attempts, next_attempt_at, locked_until, last_error, provider_id, created_at, updated_at, sent_at, owner_token)
        VALUES (?, 'harness', NULL, 'email', ?, 'queued', 0, 5, ?, NULL, NULL, NULL, ?, ?, NULL, NULL)
      `).run(sentinelId, JSON.stringify({ template: 'welcome', to: ['user@example.test'], data: {} }), now + 3_600_000, now, now);
      return sentinelId;
    },
    env: () => ({
      NOTIFY_API_KEYS: `harness:${apiKey}`, SMTP_URL: 'json:', SMTP_FROM: 'Harness <harness@example.test>', WEBHOOK_SIGNING_SECRET: randomSecret(),
    }),
    verify: async ({ proc, dbPath, seeded }) => {
      const res = await fetch(`${proc.baseUrl}/v1/messages/${seeded}`, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'queued', 'pre-existing message survived the migration with its status intact');
      assert.equal(body.channel, 'email');

      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = /** @type {any} */ (raw.prepare('SELECT call_started_at FROM messages WHERE id = ?').get(seeded));
        assert.equal(row.call_started_at, null, 'v3\'s new call_started_at column backfills to NULL for a pre-existing row, not some other default');
        const backups = readdirSync(dirname(dbPath)).filter((f) => f.includes('.pre-v2-'));
        const backupRaw = new DatabaseSync(join(dirname(dbPath), backups[0]), { readOnly: true });
        try {
          const backupRow = /** @type {any} */ (backupRaw.prepare('SELECT status FROM messages WHERE id = ?').get(seeded));
          assert.equal(backupRow?.status, 'queued', 'the pre-migration backup itself contains the sentinel row, unmigrated');
        } finally {
          backupRaw.close();
        }
      } finally {
        raw.close();
      }
    },
  });
});

test('console: real old-schema (v1) fixture with an existing admin migrates through a real process to v2, login still works, totp_seal_state sealed', { skip }, async () => {
  const { PasswordHasher } = await import(pathToFileURL(join(workspaceRoot, 'console', 'src', 'crypto', 'password.js')).href);
  const email = 'admin@example.test';
  const password = 'correct horse battery staple 9';
  const passwordHash = await new PasswordHasher({ logN: 14 }).hash(password);

  await positiveMigrationE2E({
    serviceId: 'console',
    entry: 'server.mjs',
    seed: (db) => {
      const id = '22222222-2222-4222-8222-222222222222';
      const now = Date.now();
      db.prepare(`INSERT INTO admins (id, email, name, password_hash, role, created_at, updated_at) VALUES (?, ?, 'Harness Admin', ?, 'admin', ?, ?)`)
        .run(id, email, passwordHash, now, now);
      return id;
    },
    env: ({ scratch }) => {
      const servicesFile = join(scratch, 'services.json');
      writeFileSync(servicesFile, JSON.stringify({ services: [{ id: 'audit', type: 'audit', url: 'http://127.0.0.1:1', apiKeyEnv: 'AUDIT_API_KEY' }] }));
      return { SERVICES_FILE: servicesFile, AUDIT_API_KEY: randomSecret() };
    },
    verify: async ({ proc, dbPath }) => {
      const res = await fetch(`${proc.baseUrl}/api/session/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-console-request': '1' }, body: JSON.stringify({ email, password }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.totpRequired, false, 'admin with no TOTP secret logs straight in, unaffected by the totp_seal_state migration');
      assert.equal(body.admin.email, email, 'the pre-existing admin row survived the migration');

      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const sealed = /** @type {any} */ (raw.prepare('SELECT fully_sealed_at FROM totp_seal_state WHERE id = 1').get());
        assert.ok(sealed && sealed.fully_sealed_at > 0, 'AdminStore.reseal ran at real startup and marked the (nothing-to-reseal) database fully sealed');
      } finally {
        raw.close();
      }
    },
  });
});

test('webhook-out: real old-schema (v2) fixture with an existing subscription migrates through a real process to v3, /ready, ordered defaults false', { skip }, async () => {
  const apiKey = randomSecret();
  await positiveMigrationE2E({
    serviceId: 'webhook-out',
    entry: 'src/api-main.js',
    seed: (db) => {
      const id = `sub_${randomSecret(8)}`;
      const now = Date.now();
      db.prepare(`
        INSERT INTO subscriptions (id, name, description, url, events, headers, secret_enc, prev_secret_enc, prev_until, status, consecutive_failures, last_delivery_at, last_status, created_by, created_at, updated_at)
        VALUES (?, 'pre-migration-sub', '', 'https://example.test/hook', ?, '{}', 'sealed-placeholder', NULL, NULL, 'active', 0, NULL, NULL, 'harness', ?, ?)
      `).run(id, JSON.stringify(['order.created']), now, now);
      return id;
    },
    env: () => ({
      WEBHOOK_API_KEYS: `harness:${apiKey}:readwrite`, SECRETS_KEY: randomSecret(32),
      TARGET_ALLOW_HTTP: 'true', TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: '127.0.0.1',
    }),
    verify: async ({ proc, seeded }) => {
      const res = await fetch(`${proc.baseUrl}/v1/subscriptions/${seeded}`, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.subscription.status, 'active', 'the pre-existing subscription survived the migration');
      assert.equal(body.subscription.ordered, false, 'v3\'s new ordered column defaults to false for a pre-existing subscription');
    },
  });
});

test('auth: real old-schema (v1) fixture with an existing user migrates through a real process to v2, login still works, outbox is live', { skip }, async () => {
  const { PasswordHasher } = await import(pathToFileURL(join(workspaceRoot, 'auth', 'src', 'crypto', 'password.js')).href);
  const email = 'user@example.test';
  const password = 'correct horse battery staple 9';
  const passwordHash = await new PasswordHasher({ logN: 14 }).hash(password);
  const stubNotify = await startHttpStub();
  const apiKey = randomSecret();
  try {
    await positiveMigrationE2E({
      serviceId: 'auth',
      entry: 'src/index.js',
      seed: (db) => {
        const id = '44444444-4444-4444-8444-444444444444';
        const now = Date.now();
        db.prepare(`INSERT INTO users (id, email, name, password_hash, email_verified_at, password_changed_at, created_at, updated_at) VALUES (?, ?, 'Harness User', ?, ?, ?, ?, ?)`)
          .run(id, email, passwordHash, now, now, now, now);
        return id;
      },
      env: ({ scratch }) => ({
        AUTH_API_KEYS: `harness:${apiKey}`,
        JWT_PRIVATE_KEY_PATH: authKeys(scratch), JWT_ISSUER: 'https://auth.test.local', JWT_AUDIENCE: 'test-app',
        NOTIFY_URL: stubNotify.url, NOTIFY_API_KEY: randomSecret(),
        APP_NAME: 'Harness', VERIFY_URL_TEMPLATE: 'https://harness.test/verify?token={token}', RESET_URL_TEMPLATE: 'https://harness.test/reset?token={token}',
      }),
      verify: async ({ proc, dbPath }) => {
        const res = await fetch(`${proc.baseUrl}/v1/auth/login`, {
          method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.user.email, email, 'the pre-existing user row survived the migration');
        assert.equal(typeof body.tokens.accessToken, 'string');

        const raw = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const n = /** @type {any} */ (raw.prepare('SELECT COUNT(*) AS n FROM outbox').get()).n;
          assert.ok(n >= 1, 'v2\'s new outbox table exists AND is actually written to by the real login flow\'s security event, not just present and empty');
        } finally {
          raw.close();
        }
      },
    });
  } finally {
    await stubNotify.close();
  }
});

test('audit: real old-schema (v1) fixture with an existing chained event migrates through a real process to v2, chain still verifies', { skip }, async () => {
  const { HashChain } = await import(pathToFileURL(join(workspaceRoot, 'audit', 'src', 'chain.js')).href);
  const apiKey = randomSecret();
  /** @type {string} */ let expectedHash;

  await positiveMigrationE2E({
    serviceId: 'audit',
    entry: 'src/index.js',
    seed: (db) => {
      const id = '55555555-5555-4555-8555-555555555555';
      const now = Date.now();
      const row = {
        id, client_id: null, source: 'harness', action: 'seed.event', outcome: 'success',
        actor_type: null, actor_id: null, actor_name: null, target_type: null, target_id: null, target_name: null,
        ip: null, user_agent: null, request_id: null, meta: null, at: now, received_at: now,
      };
      expectedHash = HashChain.hash(HashChain.GENESIS, row);
      db.prepare(`
        INSERT INTO events (id, client_id, source, action, outcome, actor_type, actor_id, actor_name, target_type, target_id, target_name, ip, user_agent, request_id, meta, at, received_at, prev_hash, hash)
        VALUES (?, NULL, 'harness', 'seed.event', 'success', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(id, now, now, HashChain.GENESIS, expectedHash);
      return id;
    },
    env: () => ({ AUDIT_API_KEYS: `harness:${apiKey}:readwrite` }),
    verify: async ({ proc, seeded }) => {
      const eventRes = await fetch(`${proc.baseUrl}/v1/events/${seeded}`, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(eventRes.status, 200);
      const eventBody = await eventRes.json();
      assert.equal(eventBody.event.hash, expectedHash, 'the pre-existing event\'s real hash-chain value survived the migration unchanged');
      assert.equal(eventBody.event.prevHash, HashChain.GENESIS);

      const verifyRes = await fetch(`${proc.baseUrl}/v1/chain/verify`, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(verifyRes.status, 200);
      const verifyBody = await verifyRes.json();
      assert.equal(verifyBody.ok, true, 'the real verify() domain logic (now anchors-aware post v2) still confirms the chain over the pre-existing event');
    },
  });
});

// ==================================================================================================
// Future-schema refusal E2E — one split-capable service (notify), one normal service (auth)
// ==================================================================================================

test('notify: a real process refuses to start against a database one schema version ahead, and leaves it untouched', { skip }, async () => {
  /** @type {string} */ let sentinelId;
  await futureSchemaRefusalE2E({
    serviceId: 'notify',
    entry: 'src/index.js',
    seed: (db) => {
      sentinelId = '66666666-6666-4666-8666-666666666666';
      const now = Date.now();
      db.prepare(`
        INSERT INTO messages (id, api_key_id, idempotency_key, channel, payload, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, 'harness', NULL, 'email', ?, 'sent', 1, 5, ?, ?, ?)
      `).run(sentinelId, JSON.stringify({ to: 'user@example.test' }), now, now, now);
    },
    env: () => ({ NOTIFY_API_KEYS: `harness:${randomSecret()}`, SMTP_URL: 'json:', SMTP_FROM: 'Harness <harness@example.test>', WEBHOOK_SIGNING_SECRET: randomSecret() }),
    assertSentinelUnchanged: (raw) => {
      const row = /** @type {any} */ (raw.prepare('SELECT status FROM messages WHERE id = ?').get(sentinelId));
      assert.equal(row?.status, 'sent', 'the sentinel row must be completely untouched by the refused startup attempt');
    },
  });
});

test('auth: a real process refuses to start against a database one schema version ahead, and leaves it untouched', { skip }, async () => {
  /** @type {string} */ let sentinelId;
  await futureSchemaRefusalE2E({
    serviceId: 'auth',
    entry: 'src/index.js',
    seed: (db) => {
      sentinelId = '77777777-7777-4777-8777-777777777777';
      const now = Date.now();
      db.prepare(`INSERT INTO users (id, email, name, password_hash, password_changed_at, created_at, updated_at) VALUES (?, 'sentinel@example.test', NULL, 'not-a-real-hash', ?, ?, ?)`)
        .run(sentinelId, now, now, now);
    },
    env: ({ dbPath }) => ({
      AUTH_API_KEYS: `harness:${randomSecret()}`,
      JWT_PRIVATE_KEY_PATH: authKeys(dirname(dbPath)), JWT_ISSUER: 'https://auth.test.local', JWT_AUDIENCE: 'test-app',
      NOTIFY_URL: 'http://127.0.0.1:1', NOTIFY_API_KEY: randomSecret(),
      APP_NAME: 'Harness', VERIFY_URL_TEMPLATE: 'https://harness.test/verify?token={token}', RESET_URL_TEMPLATE: 'https://harness.test/reset?token={token}',
    }),
    assertSentinelUnchanged: (raw) => {
      const row = /** @type {any} */ (raw.prepare('SELECT password_hash FROM users WHERE id = ?').get(sentinelId));
      assert.equal(row?.password_hash, 'not-a-real-hash', 'the sentinel row must be completely untouched by the refused startup attempt');
    },
  });
});
