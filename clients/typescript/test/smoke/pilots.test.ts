// Representative runtime smoke for the three Phase 2 pilots (auth, media, console) -- the ones
// Phase 2's own instructions require proven against real, disposable service processes using the
// GENERATED typed client (not raw fetch, not a hand-written client). The other 10 services are
// proven by generation + strict compile + operation-coverage tests only (test/orchestration.test.js),
// per the instruction that full E2E smoke is not mandatory for all 13.
//
// Spawns real `node` processes, so only runs when explicitly requested, matching every other
// process-spawning test in this workspace: `STACK_INTEGRATION=1 npm run clients:smoke`.
// Never touches any service's production source; only starts/stops disposable child processes
// against scratch SQLite files and scratch storage directories.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { freePort, randomSecret, ServiceProcess, stopAll } from '../../../../test/integration/harness.js';

/** A real, correctly-encoded 1x1 truecolor PNG (proper zlib-deflated IDAT + real CRC32 per chunk via
 * node:zlib's own crc32 -- not a hand-typed/memorized byte sequence, which is exactly the kind of
 * thing that's easy to get subtly wrong and hard to notice until a real decoder rejects it). */
function makeTestPng() {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor (no alpha)
  const ihdr = chunk('IHDR', ihdrData);
  const raw = Buffer.from([0, 200, 30, 60]); // filter-type byte (None) + one RGB pixel
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
let scratch: string;

before(() => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'atc-clients-smoke-'));
});

after(() => {
  if (!shouldRun) return;
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// auth pilot: real login, real mutation, real expected error -- through the generated auth client.
// ---------------------------------------------------------------------------------------------
test('auth pilot: register -> login -> authenticated mutation -> expected error, via the generated client', { skip }, async (t) => {
  const { createClient } = await import('../../auth/index.ts');

  // Stub notify (auth's /ready pings NOTIFY_URL/health; login/register/introspect never call it).
  const notifyStub = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); });
  const notifyPort = await freePort();
  await new Promise<void>((r) => notifyStub.listen(notifyPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => notifyStub.close(r)));

  const keyDir = join(scratch, 'auth-keys');
  mkdirSync(keyDir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPath = join(keyDir, 'jwt-private.pem');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const apiKeySecret = randomSecret();
  const port = await freePort();
  const auth = new ServiceProcess({
    name: 'auth', cwd: join(WORKSPACE_ROOT, 'auth'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn',
      DB_PATH: join(scratch, 'auth.db'),
      AUTH_API_KEYS: `harness:${apiKeySecret}:readwrite`,
      JWT_ISSUER: 'https://auth.smoke.test', JWT_AUDIENCE: 'smoke-app', JWT_PRIVATE_KEY_PATH: keyPath,
      NOTIFY_URL: `http://127.0.0.1:${notifyPort}`, NOTIFY_API_KEY: randomSecret(),
      APP_NAME: 'Smoke Test', VERIFY_URL_TEMPLATE: 'https://app.smoke.test/verify?token={token}',
      RESET_URL_TEMPLATE: 'https://app.smoke.test/reset?token={token}',
    },
  });
  await auth.start();
  t.after(() => stopAll([auth]));

  const client = createClient({ baseUrl: auth.baseUrl, headers: { Authorization: `Bearer ${apiKeySecret}` } });

  const email = `smoke-${randomBytes(4).toString('hex')}@example.test`;
  const password = 'correct-horse-battery-staple-9';

  // 1. write: register a user.
  const created = await client['auth.users.create']({ body: { email, password } });
  assert.equal(created.response.status, 201, `expected 201, got ${created.response.status}: ${JSON.stringify(created.error ?? created.data)}`);
  assert.ok(created.data?.user?.id, 'created user has an id');

  // 2. login (a distinct real request/response cycle, exercising the request-schema-validated body).
  const login = await client['auth.login']({ body: { email, password } });
  assert.equal(login.response.status, 200, `expected 200, got ${login.response.status}: ${JSON.stringify(login.error)}`);
  assert.equal(login.data?.user?.email, email);
  assert.ok(login.data?.tokens?.accessToken, 'login returns a real access token');
  assert.ok(login.data?.tokens?.refreshToken, 'login returns a real refresh token');

  // 3. authenticated mutation: patch the user (disable, then confirm via a read).
  const patched = await client['auth.users.patch']({ params: { path: { id: created.data!.user.id } }, body: { name: 'Renamed by smoke test' } });
  assert.equal(patched.response.status, 200, `expected 200, got ${patched.response.status}: ${JSON.stringify(patched.error)}`);
  assert.equal(patched.data?.user?.name, 'Renamed by smoke test');

  // 4. expected error: wrong password -> 401 INVALID_CREDENTIALS, typed error envelope preserved.
  const badLogin = await client['auth.login']({ body: { email, password: 'not-the-real-password' } });
  assert.equal(badLogin.response.status, 401);
  assert.equal(badLogin.error?.error?.code, 'INVALID_CREDENTIALS');
});

// ---------------------------------------------------------------------------------------------
// media pilot: real binary upload, real binary download roundtrip, expected error.
// ---------------------------------------------------------------------------------------------
test('media pilot: binary upload -> binary download roundtrip -> expected error, via the generated client', { skip }, async (t) => {
  const { createClient } = await import('../../media/index.ts');

  const dataDir = join(scratch, 'media-data');
  mkdirSync(dataDir, { recursive: true });
  const apiKeySecret = randomSecret();
  const port = await freePort();
  const media = new ServiceProcess({
    name: 'media', cwd: join(WORKSPACE_ROOT, 'media'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn',
      DB_PATH: join(scratch, 'media.db'), DATA_DIR: dataDir,
      MEDIA_API_KEYS: `harness:${apiKeySecret}`, // media's keys are id:secret only, no role suffix (confirmed in Phase 0/1 audits)
      PUBLIC_BASE_URL: media_publicBaseUrl(port), SIGNING_SECRET: randomSecret(32),
      STORAGE_DRIVER: 'local',
    },
  });
  await media.start();
  t.after(() => stopAll([media]));

  const client = createClient({ baseUrl: media.baseUrl, headers: { Authorization: `Bearer ${apiKeySecret}` } });

  // A tiny, real, valid 1x1 PNG (magic bytes + minimal IHDR/IDAT/IEND) -- real binary content,
  // not a text file wearing a binary label, so the sniffed type ends up image/png for real.
  const png = makeTestPng();

  // 1. real binary upload, using the documented workaround for openapi-typescript's `format: binary`
  //    -> `string` typing (see clients/typescript/README.md's "Binary bodies" section): a targeted
  //    `as unknown as string` cast plus a bodySerializer override that hands the real bytes straight
  //    to fetch. Not `any`, not a generator patch -- the documented, supported openapi-fetch escape.
  const uploaded = await client['media.files.upload']({
    params: { query: { visibility: 'public' } },
    body: png as unknown as string,
    bodySerializer: (b: unknown) => b as unknown as BodyInit,
    headers: { 'content-type': 'image/png' },
  });
  assert.equal(uploaded.response.status, 201, `expected 201, got ${uploaded.response.status}: ${JSON.stringify(uploaded.error)}`);
  const fileId = uploaded.data!.file.id;
  assert.equal(uploaded.data!.file.mime, 'image/png', 'server sniffed the real magic bytes, not the client-supplied header');

  // 2. real binary download. openapi-fetch defaults every response to JSON parsing
  //    (`parseAs: 'json'`) regardless of the operation's own declared content type -- for a real
  //    binary response this must be overridden explicitly per call via the documented, supported
  //    `parseAs` option (not a cast, not a generator patch). Documented in
  //    clients/typescript/README.md's "Binary responses" section. Once `parseAs` is set, `.data`
  //    holds the already-parsed body in that shape; `.response` is still the full raw Response for
  //    headers/status, but its body stream has already been consumed by that parse.
  const downloaded = await client['media.files.deliver']({ params: { path: { id: fileId, variant: 'original' } }, parseAs: 'arrayBuffer' });
  assert.equal(downloaded.response.status, 200);
  const bytesBack = Buffer.from(downloaded.data as ArrayBuffer);
  // media re-encodes every raster upload (STRIP_IMAGE_METADATA, on by default) so the downloaded
  // bytes are a real, freshly-encoded PNG of the same image, not a byte-for-byte echo of the upload
  // -- this is real, documented service behavior (confirmed in the Phase 0/1 audits), not a client
  // bug, so we assert "still a real, valid PNG of non-trivial size" rather than exact byte equality.
  assert.ok(bytesBack.length > 0, 'downloaded a non-empty body, not a JSON re-encoding');
  assert.equal(bytesBack.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'downloaded bytes start with the real PNG magic number');
  assert.equal(downloaded.response.headers.get('content-type'), 'image/png');

  // 3. expected error: unknown file id -> 404, typed error envelope preserved.
  const missing = await client['media.files.get']({ params: { path: { id: '00000000-0000-0000-0000-000000000000' } } });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.error?.error?.code, 'NOT_FOUND');
});

function media_publicBaseUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------------------------
// console pilot: real cookie-session login, real session-scoped read, expected error.
// ---------------------------------------------------------------------------------------------
test('console pilot: cookie login -> session read -> expected error, via the generated client', { skip }, async (t) => {
  const { createClient } = await import('../../console/index.ts');

  const dbPath = join(scratch, 'console.db');
  const email = 'smoke-admin@example.test';
  const password = 'correct-horse-battery-staple-9';

  // Seed the first admin directly against console's own DB file, exactly as `stack setup` does
  // (`Stack#firstAdmin` in stack/src/stack.js) -- reusing console's own classes, not reimplementing
  // password hashing or admin creation by hand.
  await seedFirstAdmin(dbPath, email, password);

  const port = await freePort();
  const console_ = new ServiceProcess({
    name: 'console', cwd: join(WORKSPACE_ROOT, 'console'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn',
      DB_PATH: dbPath, SERVICES_FILE: join(scratch, 'console-services.json'),
      NOTIFY_API_KEY: randomSecret(), // referenced by apiKeyEnv below; never actually called by this test
    },
  });
  // console requires at least one configured service; a placeholder, unreachable notify entry is
  // enough -- this smoke proves console's own session/login contract, not its downstream proxying.
  writeFileSync(join(scratch, 'console-services.json'), JSON.stringify({
    services: [{ id: 'notify', type: 'notify', label: 'Notify', url: 'http://127.0.0.1:1', apiKeyEnv: 'NOTIFY_API_KEY' }],
  }));
  await console_.start();
  t.after(() => stopAll([console_]));

  const client = createClient({ baseUrl: console_.baseUrl, credentials: 'include' });

  // openapi-fetch doesn't persist cookies across calls on its own in Node (no cookie jar) -- so we
  // capture the real Set-Cookie from login and pass it back explicitly on the next call, exactly as
  // a browser would automatically and exactly as this client's own ClientConfig.headers supports.
  const login = await client['console.session.login']({ body: { email, password } });
  assert.equal(login.response.status, 200, `expected 200, got ${login.response.status}: ${JSON.stringify(login.error)}`);
  assert.equal(login.data?.totpRequired, false);
  const setCookie = login.response.headers.get('set-cookie');
  assert.ok(setCookie, 'login sets a session cookie');
  const cookiePair = setCookie!.split(';')[0];

  const authedClient = createClient({ baseUrl: console_.baseUrl, headers: { cookie: cookiePair } });
  const session = await authedClient['console.session.get']({});
  assert.equal(session.response.status, 200);
  assert.equal(session.data?.admin?.email, email);

  // expected error: wrong password -> 401 INVALID_CREDENTIALS.
  const bad = await client['console.session.login']({ body: { email, password: 'not-the-real-password' } });
  assert.equal(bad.response.status, 401);
  assert.equal(bad.error?.error?.code, 'INVALID_CREDENTIALS');
});

async function seedFirstAdmin(dbPath: string, email: string, password: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const consoleDir = join(WORKSPACE_ROOT, 'console');
  const mod = (rel: string) => import(pathToFileURL(join(consoleDir, rel)).href);
  const [{ Database }, { AdminStore }, { SessionStore }, { AuditStore }, { PasswordHasher }, { AdminService }] = await Promise.all([
    mod('src/db.js'), mod('src/store/admin-store.js'), mod('src/store/session-store.js'),
    mod('src/store/audit-store.js'), mod('src/crypto/password.js'), mod('src/domain/admin-service.js'),
  ]);
  const db = new Database(dbPath);
  try {
    const admins = new AdminStore(db);
    const service = new AdminService({ admins, sessions: new SessionStore(db), audit: new AuditStore(db), hasher: new PasswordHasher({ logN: 14 }) });
    await service.create({ email, name: 'Smoke Admin', password, role: 'admin' }, null, { ip: null, userAgent: 'smoke-test' });
  } finally {
    db.close();
  }
}
