import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { EnvFile } from '../src/env-file.js';
import { SERVICES } from '../src/manifest.js';
import { SetupContext } from '../src/setup-context.js';

const root = mkdtempSync(join(tmpdir(), 'atc-stack-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Templates mirroring the real .env.example files: only the variables the manifest touches. */
const TEMPLATES = /** @type {Record<string, string>} */ ({
  notify: '# notify\nPORT=3001\nHOST=0.0.0.0\nNOTIFY_API_KEYS=shop:REPLACE_WITH_64_HEX_CHARS,blog:REPLACE_WITH_64_HEX_CHARS\nSMTP_URL=smtps://user:password@smtp.example.com:465\nSMTP_FROM="Example App <no-reply@example.com>"\nWEBHOOK_SIGNING_SECRET=REPLACE_WITH_64_HEX_CHARS\nWEBHOOK_ALLOW_HTTP=false\n',
  auth: 'PORT=3002\nHOST=0.0.0.0\nAUTH_API_KEYS=shop-backend:REPLACE_WITH_64_HEX_CHARS\nJWT_ISSUER=https://auth.example.com\nJWT_AUDIENCE=shop\nNOTIFY_URL=https://notify.internal:3001\nNOTIFY_API_KEY=REPLACE_WITH_NOTIFY_KEY_FOR_AUTH\nAPP_NAME=Shop\nVERIFY_URL_TEMPLATE=https://shop.example.com/verify-email?token={token}\nRESET_URL_TEMPLATE=https://shop.example.com/reset-password?token={token}\n',
  media: 'PORT=3003\nHOST=0.0.0.0\nPUBLIC_BASE_URL=https://media.example.com\nMEDIA_API_KEYS=shop-backend:REPLACE_WITH_64_HEX_CHARS\nSIGNING_SECRET=REPLACE_WITH_64_HEX_CHARS\nCORS_ORIGINS=https://shop.example.com\n',
  audit: 'PORT=3005\nHOST=0.0.0.0\nAUDIT_API_KEYS=auth:REPLACE_WITH_64_HEX_CHARS:write,console:REPLACE_WITH_64_HEX_CHARS:read\n',
  shortlink: 'PORT=3006\nHOST=0.0.0.0\nPUBLIC_BASE_URL=https://s.example.com\nSHORTLINK_API_KEYS=shop-backend:REPLACE_WITH_64_HEX_CHARS,console:REPLACE_WITH_64_HEX_CHARS\nHASH_SECRET=REPLACE_WITH_64_HEX_CHARS\n',
  flags: 'PORT=3007\nHOST=0.0.0.0\nFLAGS_API_KEYS=console:REPLACE_WITH_64_HEX_CHARS,shop-backend:REPLACE_WITH_64_HEX_CHARS:read:prod\n',
  scheduler: 'PORT=3008\nHOST=0.0.0.0\nSCHEDULER_API_KEYS=console:REPLACE_WITH_64_HEX_CHARS\nSIGNING_SECRET=REPLACE_WITH_64_HEX_CHARS\nTARGET_KEYS=flags:REPLACE_WITH_THE_SCHEDULER_KEY_FROM_FLAGS_API_KEYS\nTARGET_ALLOW_HTTP=false\nTARGET_ALLOW_PRIVATE=false\nTARGET_ALLOWED_HOSTS=\n',
  'webhook-out': 'PORT=3009\nHOST=0.0.0.0\nSECRETS_KEY=REPLACE_WITH_64_HEX_CHARS\nWEBHOOK_API_KEYS=console:REPLACE_WITH_64_HEX_CHARS,shop-backend:REPLACE_WITH_64_HEX_CHARS:publish\nTARGET_ALLOW_HTTP=false\nTARGET_ALLOW_PRIVATE=false\nTARGET_ALLOWED_HOSTS=\n',
  search: 'PORT=3010\nHOST=0.0.0.0\nSEARCH_API_KEYS=console:REPLACE_WITH_64_HEX_CHARS,shop-backend:REPLACE_WITH_64_HEX_CHARS:write:products\n',
  ratelimit: 'PORT=3011\nHOST=0.0.0.0\nRATELIMIT_API_KEYS=console:REPLACE_WITH_64_HEX_CHARS,gateway:REPLACE_WITH_64_HEX_CHARS:check\n',
  geo: 'PORT=3012\nHOST=0.0.0.0\nMMDB_PATH=\nASN_MMDB_PATH=\nGEO_API_KEYS=console:REPLACE_WITH_64_HEX_CHARS,shop-backend:REPLACE_WITH_64_HEX_CHARS:read\n',
  gateway: 'PORT=3000\nHOST=0.0.0.0\nMETRICS_TOKEN=\nAUTH_API_KEY=REPLACE_WITH_THE_GATEWAY_KEY_FROM_AUTH_API_KEYS\nMEDIA_API_KEY=REPLACE_WITH_THE_GATEWAY_KEY_FROM_MEDIA_API_KEYS\nNOTIFY_API_KEY=REPLACE_WITH_THE_GATEWAY_KEY_FROM_NOTIFY_API_KEYS\n',
  console: 'PORT=3004\nHOST=0.0.0.0\nCOOKIE_SECURE=true\nNOTIFY_API_KEY=REPLACE_WITH_THE_CONSOLE_KEY_FROM_NOTIFY_API_KEYS\nAUTH_API_KEY=REPLACE_WITH\nMEDIA_API_KEY=REPLACE_WITH\nGATEWAY_METRICS_TOKEN=REPLACE_WITH\nAUDIT_API_KEY=REPLACE_WITH\nSHORTLINK_API_KEY=REPLACE_WITH\nFLAGS_API_KEY=REPLACE_WITH\nSCHEDULER_API_KEY=REPLACE_WITH\nWEBHOOK_OUT_API_KEY=REPLACE_WITH\nSEARCH_API_KEY=REPLACE_WITH\n',
});
for (const [id, text] of Object.entries(TEMPLATES)) { mkdirSync(join(root, id), { recursive: true }); writeFileSync(join(root, id, '.env.example'), text); }
mkdirSync(join(root, 'auth', 'keys'), { recursive: true }); writeFileSync(join(root, 'auth', 'keys', 'jwt-private.pem'), 'x');
mkdirSync(join(root, 'console', 'public'), { recursive: true }); writeFileSync(join(root, 'console', 'public', 'index.html'), '<html></html>');

test('EnvFile: parse, get, needs, set, serialise', () => {
  const e = EnvFile.parse('# c\nA=1\nB=REPLACE_WITH_X\nC=\nD="quoted value"\nKEYS=a:REPLACE_WITH_64,b:sec\n');
  assert.equal(e.get('A'), '1');
  assert.equal(e.get('D'), '"quoted value"', 'raw');
  assert.equal(e.toObject().D, 'quoted value', 'unquoted for consumers');
  assert.deepEqual(['A', 'B', 'C', 'Z', 'KEYS'].map((k) => e.needs(k)), [false, true, true, true, true]);
  e.set('A', '2').set('Z', 'new');
  assert.equal(e.toString(), '# c\nA=2\nB=REPLACE_WITH_X\nC=\nD="quoted value"\nKEYS=a:REPLACE_WITH_64,b:sec\nZ=new\n');
});

test('setup wires every service: secrets, keys, URLs, console files; second run keeps everything', async () => {
  /** @type {string[]} */ const ran = [];
  const ctx = new SetupContext({ root, host: '127.0.0.1', local: true, run: async (id, argv) => { ran.push(`${id} ${argv.join(' ')}`); } });
  await ctx.compute();
  /** @type {Record<string, string>} */ const written = {};
  ctx.save((p, t) => { written[p.replace(`${root}/`, '')] = t; mkdirSync(join(root, p.replace(`${root}/`, '').split('/')[0]), { recursive: true }); writeFileSync(p, t); });
  assert.deepEqual(ran, [], 'keys and public/ exist, nothing to prepare');
  const env = (/** @type {string} */ id) => EnvFile.parse(written[`${id}/.env`]).toObject();
  const keys = (/** @type {string} */ id, /** @type {string} */ v) => Object.fromEntries(env(id)[v].split(',').map((e) => { const [h, s, ...r] = e.split(':'); return [h, { secret: s, role: r.join(':') }]; }));

  // Placeholders are gone everywhere.
  for (const id of Object.keys(TEMPLATES)) assert.equal(/REPLACE_WITH/.test(written[`${id}/.env`]), false, `${id} has no placeholders left`);
  // Console holds a key issued by every service it shows, with the right role.
  assert.equal(env('console').FLAGS_API_KEY, keys('flags', 'FLAGS_API_KEYS').console.secret);
  assert.equal(keys('audit', 'AUDIT_API_KEYS').console.role, 'read');
  assert.equal(env('console').AUDIT_API_KEY, keys('audit', 'AUDIT_API_KEYS').console.secret);
  assert.equal(env('console').WEBHOOK_OUT_API_KEY, keys('webhook-out', 'WEBHOOK_API_KEYS').console.secret);
  assert.equal(env('console').SEARCH_API_KEY, keys('search', 'SEARCH_API_KEYS').console.secret);
  assert.equal(env('console').RATELIMIT_API_KEY, keys('ratelimit', 'RATELIMIT_API_KEYS').console.secret);
  assert.equal(env('console').GEO_API_KEY, keys('geo', 'GEO_API_KEYS').console.secret);
  assert.equal(env('geo').MMDB_PATH, '', 'operator-owned value kept empty');
  assert.deepEqual(Object.keys(keys('search', 'SEARCH_API_KEYS')), ['console'], 'template placeholders dropped');
  assert.equal(env('console').GATEWAY_METRICS_TOKEN, env('gateway').METRICS_TOKEN);
  assert.equal(env('console').COOKIE_SECURE, 'false');
  assert.match(env('gateway').METRICS_TOKEN, /^[0-9a-f]{64}$/);
  // Template example keys are dropped; real holders kept.
  assert.deepEqual(Object.keys(keys('flags', 'FLAGS_API_KEYS')).sort(), ['console', 'scheduler']);
  assert.equal(keys('flags', 'FLAGS_API_KEYS').scheduler.role, 'write');
  assert.equal(keys('webhook-out', 'WEBHOOK_API_KEYS').scheduler.role, 'publish');
  // Cross-service holders.
  assert.equal(env('auth').NOTIFY_API_KEY, keys('notify', 'NOTIFY_API_KEYS').auth.secret);
  assert.equal(env('gateway').AUTH_API_KEY, keys('auth', 'AUTH_API_KEYS').gateway.secret);
  assert.equal(env('scheduler').TARGET_KEYS, `flags:${keys('flags', 'FLAGS_API_KEYS').scheduler.secret},notify:${keys('notify', 'NOTIFY_API_KEYS').scheduler.secret},webhook-out:${keys('webhook-out', 'WEBHOOK_API_KEYS').scheduler.secret}`);
  // Local URLs and lax outbound settings.
  assert.equal(env('auth').NOTIFY_URL, 'http://127.0.0.1:3001');
  assert.equal(env('auth').JWT_ISSUER, 'http://127.0.0.1:3000');
  assert.equal(env('media').PUBLIC_BASE_URL, 'http://127.0.0.1:3003');
  assert.equal(env('notify').SMTP_URL, 'json:');
  assert.deepEqual([env('scheduler').TARGET_ALLOW_PRIVATE, env('scheduler').TARGET_ALLOWED_HOSTS, env('webhook-out').TARGET_ALLOW_HTTP], ['true', '127.0.0.1,localhost', 'true']);
  assert.equal(env('notify').HOST, '127.0.0.1');
  // Console services.json and gateway routes.
  const services = JSON.parse(written['console/services.json']).services;
  assert.deepEqual(services.map((/** @type {any} */ s) => s.id), SERVICES.filter((s) => s.console).map((s) => s.id));
  assert.deepEqual(services.find((/** @type {any} */ s) => s.id === 'gateway'), { id: 'gateway', type: 'gateway', label: 'Gateway', url: 'http://127.0.0.1:3000', metricsTokenEnv: 'GATEWAY_METRICS_TOKEN' });
  assert.deepEqual(services.find((/** @type {any} */ s) => s.id === 'notify').polling, { enabled: true, intervalSec: 30 });
  const routes = JSON.parse(written['gateway/routes.json']);
  assert.equal(routes.jwt.jwksUrl, 'http://127.0.0.1:3002/.well-known/jwks.json');
  assert.deepEqual(routes.routes.map((/** @type {any} */ r) => r.id), ['auth-public', 'media-user', 'media-files', 'jwks']);

  // Second run: nothing regenerated.
  const again = new SetupContext({ root, host: '127.0.0.1', local: true, run: async () => {} });
  await again.compute();
  /** @type {Record<string, string>} */ const written2 = {};
  again.save((p, t) => { written2[p.replace(`${root}/`, '')] = t; });
  assert.deepEqual(written2, written, 'idempotent');

  // Operator edits survive; a newly listed holder is appended without touching the others.
  const f = EnvFile.load(join(root, 'flags', '.env'));
  f.set('FLAGS_API_KEYS', `${f.get('FLAGS_API_KEYS')},mobile:${'m'.repeat(64)}:read:prod`).save(join(root, 'flags', '.env'));
  const third = new SetupContext({ root, host: '127.0.0.1', local: true, run: async () => {} });
  await third.compute();
  assert.equal(third.env('flags').get('FLAGS_API_KEYS'), f.get('FLAGS_API_KEYS'));
  assert.equal(third.env('console').get('FLAGS_API_KEY'), env('console').FLAGS_API_KEY);
});

test('setup prepares what is missing: JWT keys and the console build', async () => {
  rmSync(join(root, 'auth', 'keys'), { recursive: true });
  rmSync(join(root, 'console', 'public'), { recursive: true });
  /** @type {string[]} */ const ran = [];
  const ctx = new SetupContext({ root, host: '127.0.0.1', local: true, run: async (id, argv) => { ran.push(`${id} ${argv.join(' ')}`); } });
  await ctx.compute();
  assert.deepEqual(ran, ['auth npm run keygen', 'console npm run build']);
});

test('server mode keeps secure defaults and operator URLs', async () => {
  const root2 = mkdtempSync(join(tmpdir(), 'atc-stack-srv-'));
  for (const [id, text] of Object.entries(TEMPLATES)) { mkdirSync(join(root2, id), { recursive: true }); writeFileSync(join(root2, id, '.env.example'), text); }
  mkdirSync(join(root2, 'auth', 'keys'), { recursive: true }); writeFileSync(join(root2, 'auth', 'keys', 'jwt-private.pem'), 'x');
  mkdirSync(join(root2, 'console', 'public'), { recursive: true }); writeFileSync(join(root2, 'console', 'public', 'index.html'), '');
  writeFileSync(join(root2, 'media', '.env'), 'PORT=3003\nHOST=0.0.0.0\nPUBLIC_BASE_URL=https://media.mysite.com\nMEDIA_API_KEYS=shop:' + 's'.repeat(64) + '\nSIGNING_SECRET=' + 'a'.repeat(64) + '\nCORS_ORIGINS=https://mysite.com\n');
  const ctx = new SetupContext({ root: root2, host: '10.0.0.5', local: false, run: async () => {} });
  await ctx.compute();
  assert.equal(ctx.env('media').get('PUBLIC_BASE_URL'), 'https://media.mysite.com');
  assert.equal(ctx.env('media').get('SIGNING_SECRET'), 'a'.repeat(64));
  assert.equal(ctx.env('media').get('CORS_ORIGINS'), 'https://mysite.com');
  assert.match(ctx.env('media').get('MEDIA_API_KEYS') ?? '', new RegExp(`^shop:${'s'.repeat(64)},gateway:[0-9a-f]{64},console:[0-9a-f]{64}$`));
  assert.equal(ctx.env('scheduler').get('TARGET_ALLOW_PRIVATE'), 'false');
  assert.equal(ctx.env('console').get('COOKIE_SECURE'), 'true');
  assert.equal(ctx.env('auth').get('NOTIFY_URL'), 'http://10.0.0.5:3001');
  rmSync(root2, { recursive: true, force: true });
});
