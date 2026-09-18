import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll, waitUntil } from './harness.js';

/**
 * Stage 11: a real `media` file's whole life over its actual HTTP API — upload, download, soft
 * delete (already 404s over HTTP), then a genuine production purge pass that removes the bytes
 * from disk, then a 404 on the exact same object once more. Every step is a real `node` child
 * process (never mocks, never an in-process fake, never a direct DB write).
 *
 * media has no HTTP or env trigger for an immediate purge: `Maintenance.INTERVAL_MS` is a
 * hardcoded 3_600_000ms static field with no override, and `Application#start()` only ever runs
 * one purge pass eagerly, at process startup. So the one honest way to observe a real purge within
 * test time is to restart the service: stop the process, start a *new* `ServiceProcess` pointed at
 * the exact same `DATA_DIR`/`DB_PATH`. That fresh process's own real startup
 * (`Maintenance#start()` -> immediate `run()` -> `MediaService#purge()`) is the actual production
 * code path, just observed via a restart instead of waiting an hour. `DELETE_GRACE_DAYS=0` makes
 * the soft-deleted file immediately purge-eligible without faking a clock.
 *
 * Spawns real `node` processes and can take a few seconds, so it only runs on request:
 * `STACK_INTEGRATION=1 npm test`. Plain `npm test` skips it (see harness-self-test.test.js for the
 * always-on tests).
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {string} */ let scratch;
/** @type {string} */ let dataDir;
/** @type {string} */ let dbPath;
/** @type {string} */ let mediaSecret;
/** @type {ServiceProcess|null} */ let media = null;

before(() => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-media-lifecycle-'));
  dataDir = join(scratch, 'media-files');
  dbPath = join(scratch, 'media.db');
  mediaSecret = randomSecret();
});

after(async () => {
  if (!shouldRun) return;
  if (media) await stopAll([media]);
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A real, minimal-but-valid PDF (sniffed via the `%PDF-` magic bytes) — simpler than an image
 * payload since it skips media's image re-encoding/variant pipeline entirely, which this test has
 * no need to exercise.
 */
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

/** @param {number} port */
async function startMedia(port) {
  const proc = new ServiceProcess({
    name: 'media', cwd: join(workspaceRoot, 'media'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info',
      DB_PATH: dbPath, DATA_DIR: dataDir, DELETE_GRACE_DAYS: '0',
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, MEDIA_API_KEYS: `harness:${mediaSecret}`, SIGNING_SECRET: randomSecret(),
    },
  });
  await proc.start();
  return proc;
}

/** @param {string} sha256 */
function canonicalObjectPath(sha256) {
  return join(dataDir, 'objects', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

test('media file lifecycle: upload -> download -> delete -> restart-triggered purge -> gone on disk and 404 forever', { skip }, async (t) => {
  const port = await freePort();
  media = await startMedia(port);
  t.after(async () => { if (media) { await media.stop(); media = null; } });

  // 1. upload
  const uploadRes = await fetch(`${media.baseUrl}/v1/files?visibility=public`, {
    method: 'PUT', headers: { authorization: `Bearer ${mediaSecret}` }, body: pdfBytes,
  });
  const uploadBodyText = await uploadRes.text();
  assert.equal(uploadRes.status, 201, `expected upload to succeed: ${uploadBodyText}. Recent lines: ${JSON.stringify(media.lines.slice(-10).map((l) => l.raw))}`);
  const uploadBody = JSON.parse(uploadBodyText);
  const { id, sha256 } = uploadBody.file;
  assert.ok(id, 'upload response carries a file id');
  assert.ok(/^[0-9a-f]{64}$/.test(sha256), 'upload response carries a sha256');
  assert.equal(uploadBody.file.mime, 'application/pdf', 'media sniffed the real bytes as a PDF');
  const objectPath = canonicalObjectPath(sha256);
  assert.ok(existsSync(objectPath), `canonical object exists right after upload at ${objectPath}`);

  // 2. download while live
  const downloadRes = await fetch(`${media.baseUrl}/files/${id}/original`);
  assert.equal(downloadRes.status, 200, `expected live public download to succeed. Recent lines: ${JSON.stringify(media.lines.slice(-10).map((l) => l.raw))}`);
  const downloaded = Buffer.from(await downloadRes.arrayBuffer());
  assert.ok(downloaded.equals(pdfBytes), 'downloaded bytes match exactly what was uploaded');

  // 3. delete (soft, synchronous)
  const deleteRes = await fetch(`${media.baseUrl}/v1/files/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${mediaSecret}` } });
  assert.equal(deleteRes.status, 204, `expected soft delete to succeed. Recent lines: ${JSON.stringify(media.lines.slice(-10).map((l) => l.raw))}`);

  // 4. immediate 404 over HTTP, no restart needed — soft delete takes effect in the same call
  const afterDeleteRes = await fetch(`${media.baseUrl}/files/${id}/original`);
  assert.equal(afterDeleteRes.status, 404, 'soft-deleted file already 404s over the public route before any purge runs');
  await afterDeleteRes.body?.cancel();
  // the bytes themselves are untouched until purge — proves the 404 above is a soft-delete flag,
  // not an accidental early removal that would make the later purge assertion meaningless.
  assert.ok(existsSync(objectPath), 'canonical object bytes are still on disk immediately after a soft delete (purge has not run yet)');

  // 5. stop this process, then start a fresh one on the same DATA_DIR/DB_PATH — its own real
  // startup (Application#start -> Maintenance#start -> immediate run() -> MediaService#purge())
  // is the only real-production-entry-point way to force a purge pass within test time.
  await media.stop();
  const restartPort = await freePort();
  media = await startMedia(restartPort);
  t.after(async () => { if (media) { await media.stop(); media = null; } });

  // 6. the restart's eager purge pass removes the canonical object from disk; poll briefly in case
  // the purge's own file I/O hasn't settled the instant /ready first answers 200.
  await waitUntil(() => !existsSync(objectPath), {
    timeoutMs: 3_000, intervalMs: 100,
    message: `canonical object removed from disk by restart-triggered purge (${objectPath}). Recent lines: ${JSON.stringify(media?.lines.slice(-15).map((l) => l.raw))}`,
  });
  assert.ok(!existsSync(objectPath), 'canonical object file is gone from disk after the real production purge pass');

  // 7. still 404 on the new process, now backed by an actually-removed object, not just a flag
  const afterPurgeRes = await fetch(`${media.baseUrl}/files/${id}/original`);
  assert.equal(afterPurgeRes.status, 404, 'the same object id still 404s on the restarted process after purge removed its bytes');
  await afterPurgeRes.body?.cancel();
});
