import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll } from './harness.js';
import { Stack } from '../../src/stack.js';

/**
 * Node's global `fetch` (undici) does not reliably deliver a plain string/Buffer request body to
 * this server's raw-stream upload handler in this environment (empirically verified: `curl` and a
 * plain `node:http` request both work; `fetch` with the identical body does not, arriving as zero
 * bytes) — a `fetch`-specific body-delivery quirk against a raw-passthrough content-type parser,
 * not a media bug. Used only for the one call that sends a body; every other call in this file
 * uses plain `fetch`.
 * @param {string} url @param {{ headers?: Record<string,string>, body: string|Buffer }} o
 * @returns {Promise<{ status: number, text: string }>}
 */
function putBody(url, { headers = {}, body }) {
  return new Promise((res, rej) => {
    const buf = Buffer.from(body);
    const req = httpRequest(url, { method: 'PUT', headers: { ...headers, 'content-length': String(buf.length) } }, (r) => {
      /** @type {Buffer[]} */ const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: /** @type {number} */ (r.statusCode), text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', rej);
    req.end(buf);
  });
}

/**
 * Post-production Phase 4: proves the chosen operator-trigger mechanism (`stack maintenance media`
 * / `Stack#maintenance('media')`) end-to-end against a real, live, separately-running media
 * process — not an in-process shortcut. A real file is uploaded and soft-deleted through the real
 * HTTP API, the manual maintenance trigger runs (as a genuinely separate invocation, the same way
 * an operator's CLI call would, while the live server keeps running), and the result is checked
 * through the real API (404) and the real filesystem (canonical bytes actually gone) — not assumed
 * from the summary counters alone.
 *
 * Spawns a real service process, so it only runs when explicitly requested:
 * `STACK_INTEGRATION=1 npm test`.
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
 * A real media checkout: symlinks the real `src/`/`node_modules` so both the spawned real process
 * AND `Stack#maintenance`'s direct construction resolve the exact same code, with their own
 * `.env`/`data` under a throwaway scratch dir.
 * @param {string} scratch @param {Record<string,string>} env
 */
function mediaFixture(scratch, env) {
  const real = join(workspaceRoot, 'media');
  const dir = join(scratch, 'media');
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(real, 'src'), join(dir, 'src'), 'dir');
  symlinkSync(join(real, 'node_modules'), join(dir, 'node_modules'), 'dir');
  cpSync(join(real, 'package.json'), join(dir, 'package.json'));
  writeFileSync(join(dir, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'));
  return dir;
}

test('manual maintenance trigger, run against a real live media process: soft-deleted file is purged, download 404s, canonical bytes are actually gone, summary is accurate', { skip }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'media-maintenance-e2e-'));
  scratchDirs.push(scratch);
  const port = await freePort();
  const apiKey = randomSecret();
  const env = {
    PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn',
    DB_PATH: './data/media.db', DATA_DIR: './data/files',
    PUBLIC_BASE_URL: 'http://127.0.0.1:' + port, SIGNING_SECRET: randomSecret(32),
    MEDIA_API_KEYS: `harness:${apiKey}`, DELETE_GRACE_DAYS: '0',
  };
  const serviceDir = mediaFixture(scratch, env);

  const proc = new ServiceProcess({ name: 'media', cwd: serviceDir, entry: 'src/index.js', port, env: { PATH: process.env.PATH ?? '', ...env } });
  procs.push(proc);
  await proc.start();

  const auth = { authorization: `Bearer ${apiKey}` };
  const uploadRes = await putBody(`http://127.0.0.1:${port}/v1/files?visibility=public`, { headers: auth, body: '%PDF-1.4 real e2e content' });
  assert.equal(uploadRes.status, 201, uploadRes.text);
  const { file } = JSON.parse(uploadRes.text);

  // Readable before deletion — real download through the real public delivery route.
  const beforeRes = await fetch(`http://127.0.0.1:${port}/files/${file.id}/original`);
  assert.equal(beforeRes.status, 200);
  await beforeRes.body?.cancel();

  const canonicalPath = join(serviceDir, 'data', 'files', 'objects', file.sha256.slice(0, 2), file.sha256.slice(2, 4), file.sha256);
  assert.ok(existsSync(canonicalPath), 'sanity: canonical bytes are really on disk before deletion');

  const deleteRes = await fetch(`http://127.0.0.1:${port}/v1/files/${file.id}`, { method: 'DELETE', headers: auth });
  assert.equal(deleteRes.status, 204, await deleteRes.text());
  // Soft-deleted: gone from the metadata API immediately, but bytes still on disk — physical
  // cleanup is purge's job, not delete's.
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/files/${file.id}`, { headers: auth })).status, 404);
  assert.ok(existsSync(canonicalPath), 'bytes are NOT yet removed by a soft delete alone');

  // The manual trigger itself: a completely separate invocation (Stack#maintenance), not the live
  // process's own timer — while that live process keeps running, unaffected.
  const stack = new Stack({ root: scratch });
  const result = await stack.maintenance('media');
  assert.equal(result.errors, 0);
  assert.equal(result.files, 1, 'the one soft-deleted-past-grace file row');
  assert.equal(result.blobs, 1, 'its now-orphaned blob');
  assert.equal(result.trashErrors, 0);

  // Real HTTP re-checks, not just trusting the summary.
  assert.equal((await fetch(`http://127.0.0.1:${port}/files/${file.id}/original`)).status, 404, 'download 404s after the manual purge');
  assert.equal(existsSync(canonicalPath), false, 'canonical bytes are actually gone from disk');

  // The live process itself was never disturbed by the separate maintenance invocation.
  const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(readyRes.status, 200);
  await readyRes.body?.cancel();
});
