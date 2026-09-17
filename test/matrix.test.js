import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SERVICES } from '../src/manifest.js';
import { Stack } from '../src/stack.js';

const root = mkdtempSync(join(tmpdir(), 'atc-stack-matrix-'));
after(() => rmSync(root, { recursive: true, force: true }));
for (const s of SERVICES) {
  mkdirSync(join(root, s.id), { recursive: true });
  writeFileSync(join(root, s.id, '.env'), `PORT=${s.port}\nHOST=127.0.0.1\n`);
}

/**
 * One scenario per real service id, covering every mixed-version/failure case the plan asks for:
 * matching serviceCore majors (the common case), a different major (mismatch warning), a service
 * with no service-core dependency at all (gateway, real design), an unreachable service, a
 * malformed (non-JSON) /v1/info body, a too-old service with no /v1/info route yet (404), and an
 * older-but-valid /v1/info response missing fields the current contract added later.
 * @type {Record<string, 'ok'|'mismatch'|'noCore'|'unreachable'|'malformed'|'notFound'|'partial'>}
 */
const SCENARIO = {
  notify: 'ok', auth: 'ok', scheduler: 'ok', 'webhook-out': 'ok', search: 'ok', geo: 'ok', console: 'ok',
  media: 'mismatch', gateway: 'noCore', shortlink: 'unreachable', audit: 'malformed', flags: 'notFound', ratelimit: 'partial',
};

/** @type {typeof fetch} */
const fetchMock = async (input) => {
  const url = new URL(String(input));
  const id = /** @type {string} */ (SERVICES.find((s) => s.port === Number(url.port))?.id);
  const scenario = SCENARIO[id];
  if (scenario === 'unreachable') throw new Error('connect ECONNREFUSED');
  if (url.pathname === '/health' || url.pathname === '/ready') return /** @type {any} */ ({ status: 200, ok: true });
  if (url.pathname !== '/v1/info') return /** @type {any} */ ({ status: 404, ok: false });
  if (scenario === 'notFound') return /** @type {any} */ ({ status: 404, ok: false });
  if (scenario === 'malformed') return /** @type {any} */ ({ status: 200, ok: true, json: async () => { throw new Error('not json'); } });
  if (scenario === 'partial') return /** @type {any} */ ({ status: 200, ok: true, json: async () => ({ service: id, version: '0.9.0' }) });
  const serviceCore = scenario === 'mismatch' ? '2.0.0' : scenario === 'noCore' ? null : '1.10.0';
  return /** @type {any} */ ({
    status: 200, ok: true,
    json: async () => ({ service: id, version: '1.0.0', apiVersion: 'v1', capabilities: ['x', 'y'], schemaVersion: scenario === 'noCore' ? null : 1, serviceCore }),
  });
};

test('matrix(): reachability and /v1/info are independent per row; one bad service never breaks the rest', async () => {
  /** @type {string[]} */ const logged = [];
  const stack = new Stack({ root, log: (l) => logged.push(l), fetch: fetchMock });
  const rows = await stack.matrix();
  assert.equal(rows.length, SERVICES.length);

  const byId = /** @type {Record<string, any>} */ (Object.fromEntries(rows.map((r) => [r.id, r])));

  assert.equal(byId.notify.ok, true);
  assert.equal(byId.notify.infoOk, true);
  assert.deepEqual(byId.notify.capabilities, ['x', 'y']);
  assert.equal(byId.notify.serviceCore, '1.10.0');

  assert.equal(byId.gateway.infoOk, true, 'a service with no service-core dependency still has a valid /v1/info');
  assert.equal(byId.gateway.serviceCore, null);

  assert.equal(byId.shortlink.ok, false, 'unreachable: health/ready also fail');
  assert.equal(byId.shortlink.infoOk, false);
  assert.match(byId.shortlink.infoError, /unreachable/);

  assert.equal(byId.audit.ok, true, 'audit itself is healthy; only its /v1/info body is broken');
  assert.equal(byId.audit.infoOk, false);
  assert.match(byId.audit.infoError, /malformed/);

  assert.equal(byId.flags.ok, true);
  assert.equal(byId.flags.infoOk, false, 'a too-old service (no /v1/info route yet) degrades, does not crash the command');
  assert.match(byId.flags.infoError, /older version/);

  assert.equal(byId.ratelimit.infoOk, true, 'an older, partial /v1/info response still parses');
  assert.equal(byId.ratelimit.version, '0.9.0');
  assert.equal(byId.ratelimit.apiVersion, null, 'missing optional field reads as null, not a crash');
  assert.equal(byId.ratelimit.schemaVersion, null);
  assert.deepEqual(byId.ratelimit.capabilities, []);

  // Every row present regardless of any single service's failure mode — the whole command
  // completed instead of throwing partway through.
  assert.deepEqual(rows.map((r) => r.id).sort(), SERVICES.map((s) => s.id).sort());

  // The matrix printed something for every row plus the mismatch warning; a mismatched major
  // (media: '2.0.0' vs. everyone else's '1.10.0') is flagged, never a thrown error or a failed exit.
  assert.ok(logged.length >= SERVICES.length + 1);
  const warning = logged.find((l) => l.includes('serviceCore major version mismatch'));
  assert.ok(warning, 'mismatch is surfaced as a visible warning');
  assert.match(warning ?? '', /media/);
  assert.doesNotMatch(warning ?? '', /gateway/, 'a null serviceCore (no dependency) is excluded from the major-mismatch comparison, not treated as its own "major"');
});

test('matrix(): a mismatched serviceCore major never affects the ok/exit-code semantics (no startup check, no runtime coupling)', async () => {
  const stack = new Stack({ root, log: () => {}, fetch: fetchMock });
  const rows = await stack.matrix();
  // media has a different serviceCore major but is otherwise healthy — `ok` reflects only
  // reachability (health/ready), exactly like plain `status()`, never the version comparison.
  const media = rows.find((r) => r.id === 'media');
  assert.equal(media?.ok, true);
});
