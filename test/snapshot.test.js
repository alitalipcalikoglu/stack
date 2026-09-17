import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Snapshot } from '../src/snapshot.js';

/**
 * These tests exercise `Snapshot` against real service checkouts (`ratelimit`, `media`) from this
 * workspace, through their own, real `Database` subclass — not a synthetic stand-in — per the plan's
 * requirement that backup/restore is proven "using each service's Database through the core". Each
 * fixture service directory symlinks the real `src/` and `node_modules` (so `@atc-web/service-core`
 * resolves and any future schema change is exercised automatically) but gets its own `.env` and
 * `data/` pointed at a throwaway temp path — the real workspace checkouts and their real data are
 * never opened or touched.
 */
const workspaceRoot = resolve(new URL('../..', import.meta.url).pathname);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'atc-snapshot-'));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** @param {string} root @param {string} id @param {string} envExtra */
function realServiceFixture(root, id, envExtra = '') {
  const real = join(workspaceRoot, id);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(real, 'src'), join(dir, 'src'), 'dir');
  symlinkSync(join(real, 'node_modules'), join(dir, 'node_modules'), 'dir');
  cpSync(join(real, 'package.json'), join(dir, 'package.json'));
  writeFileSync(join(dir, '.env'), `DB_PATH=./data/${id}.db\n${envExtra}`);
  return dir;
}

/** @param {string} serviceDir */
async function openDb(serviceDir) {
  const { Database } = await import(pathToFileURL(join(serviceDir, 'src/db.js')).href);
  return new Database(join(serviceDir, 'data', `${serviceDir.split('/').pop()}.db`));
}

const fakeExec = async () => ({ code: 0, out: '' });

test('backup then restore round-trips a real service database (ratelimit) unchanged', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'rt-'));
  const dir = realServiceFixture(root, 'ratelimit');
  const db = await openDb(dir);
  db.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('p1', '[]', 'test', 0, 0)").run();
  db.close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir, manifest } = await snap.create();
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].path, 'data/ratelimit.db');

  // Mutate the live database after the backup.
  const live = await openDb(dir);
  live.prepare("DELETE FROM policies WHERE name = 'p1'").run();
  live.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('mutated', '[]', 'test', 0, 0)").run();
  live.close();

  const result = await snap.restore(snapshotDir);
  assert.equal(result.outcome, 'restored');
  assert.deepEqual(result, { outcome: 'restored', restored: ['ratelimit/data/ratelimit.db'], failed: null, rolledBack: [], rollbackFailed: [], skipped: [], runId: result.runId });
  assert.equal(typeof result.runId, 'string');

  const restored = await openDb(dir);
  const names = /** @type {any[]} */ (restored.prepare('SELECT name FROM policies ORDER BY name').all()).map((r) => r.name);
  assert.deepEqual(names, ['p1'], 'the pre-backup row is back; the post-backup mutation is gone');
  restored.close();

  // The live file that restore replaced was moved aside, not deleted.
  const asideDirs = readdirSync(join(dir, 'data')).filter((f) => f.includes('.before-restore-'));
  assert.equal(asideDirs.length, 1);
});

test('backup then restore round-trips a real service database plus its extra directories (media: objects/variants)', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'media-'));
  const dir = realServiceFixture(root, 'media', 'DATA_DIR=./data/files\n');
  mkdirSync(join(dir, 'data', 'files', 'objects', 'ab'), { recursive: true });
  writeFileSync(join(dir, 'data', 'files', 'objects', 'ab', 'original.bin'), 'original blob content');
  mkdirSync(join(dir, 'data', 'files', 'variants', 'ab'), { recursive: true });
  writeFileSync(join(dir, 'data', 'files', 'variants', 'ab', 'thumb.webp'), 'original thumb');

  const db = await openDb(dir);
  db.prepare("INSERT INTO blobs (sha256, size, mime, created_at) VALUES ('ab', 22, 'application/octet-stream', 0)").run();
  db.close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir, manifest } = await snap.create();
  const paths = manifest.entries.map((/** @type {any} */ e) => e.path).sort();
  assert.deepEqual(paths, ['data/files/objects', 'data/files/variants', 'data/media.db']);

  // Mutate the live file storage and database after the backup — a purge, say.
  writeFileSync(join(dir, 'data', 'files', 'objects', 'ab', 'original.bin'), 'CORRUPTED');
  rmSync(join(dir, 'data', 'files', 'variants', 'ab'), { recursive: true, force: true });
  const live = await openDb(dir);
  live.prepare("DELETE FROM blobs WHERE sha256 = 'ab'").run();
  live.close();

  const result = await snap.restore(snapshotDir);
  assert.equal(result.outcome, 'restored');
  assert.equal(result.failed, null);
  assert.equal(result.restored.length, 3, 'db + objects + variants all restored');

  assert.equal(readFileSync(join(dir, 'data', 'files', 'objects', 'ab', 'original.bin'), 'utf8'), 'original blob content');
  assert.equal(readFileSync(join(dir, 'data', 'files', 'variants', 'ab', 'thumb.webp'), 'utf8'), 'original thumb');
  const restored = await openDb(dir);
  assert.equal(/** @type {any} */ (restored.prepare("SELECT sha256 FROM blobs WHERE sha256 = 'ab'").get())?.sha256, 'ab', 'the database row and the blob file agree again — metadata/storage consistency across the same snapshot');
  restored.close();
});

test('restore refuses a backup with a missing file (incomplete backup) and touches nothing', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'incomplete-'));
  const dir = realServiceFixture(root, 'ratelimit');
  (await openDb(dir)).close();
  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();
  rmSync(join(snapshotDir, 'ratelimit', 'data', 'ratelimit.db'));

  await assert.rejects(() => snap.restore(snapshotDir), /missing from snapshot/);
  assert.equal(existsSync(join(dir, 'data', 'ratelimit.db')), true, 'the live file was never touched');
});

test('restore refuses a backup whose recorded checksum no longer matches (corrupt backup) and touches nothing', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'corrupt-'));
  const dir = realServiceFixture(root, 'ratelimit');
  const db = await openDb(dir);
  db.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('live', '[]', 'test', 0, 0)").run();
  db.close();
  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();
  writeFileSync(join(snapshotDir, 'ratelimit', 'data', 'ratelimit.db'), 'not actually a valid backup file');

  await assert.rejects(() => snap.restore(snapshotDir), /checksum mismatch/);
  const untouched = await openDb(dir);
  assert.equal(/** @type {any} */ (untouched.prepare("SELECT name FROM policies").get())?.name, 'live', 'live file untouched by the refused restore');
  untouched.close();
});

test('restore refuses a manifest entry that resolves outside the snapshot or the service folder (path traversal guard)', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'traversal-'));
  const dir = realServiceFixture(root, 'ratelimit');
  (await openDb(dir)).close();
  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();
  const manifestPath = join(snapshotDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].path = '../../../etc/passwd';
  writeFileSync(manifestPath, JSON.stringify(manifest));

  await assert.rejects(() => snap.restore(snapshotDir), /escapes/);
});

test('a real permission failure preparing one target rolls back everything and touches no live content', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'prep-fail-'));
  const mediaDir = realServiceFixture(root, 'media', 'DATA_DIR=./data/files\n');
  const rtDir = realServiceFixture(root, 'ratelimit');
  mkdirSync(join(mediaDir, 'data', 'files', 'objects'), { recursive: true });
  writeFileSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin'), 'blob');
  (await openDb(mediaDir)).close();
  (await openDb(rtDir)).close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();

  // A genuine OS-level failure: ratelimit's data/ directory forbids the rename phase 1 needs to
  // move its live database aside. media sorts before ratelimit in manifest.entries, so both of
  // media's items (db, objects) have already been moved aside successfully by the time this hits —
  // this proves phase 1's own abort path reverts a real partial prepare, not just a hypothetical one.
  chmodSync(join(rtDir, 'data'), 0o500);
  try {
    const result = await snap.restore(snapshotDir);
    assert.equal(result.outcome, 'rolled_back');
    assert.equal(result.failed?.phase, 'prepare');
    assert.ok(result.failed?.service === 'ratelimit', result.failed?.service);
    assert.equal(result.rollbackFailed.length, 0);
    assert.equal(result.rolledBack.length, 2, 'media db and media objects — the two items phase 1 actually moved aside before hitting ratelimit — confirmed reverted');
    assert.equal(existsSync(join(mediaDir, 'data', 'media.db')), true, 'media db back in place');
    assert.equal(existsSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin')), true, 'media object back in place');
    assert.equal(readdirSync(join(mediaDir, 'data')).some((f) => f.includes('.before-restore-')), false, 'no leftover aside for media — phase 1 abort moved it straight back');
    assert.equal(existsSync(join(rtDir, 'data', 'ratelimit.db')), true, "ratelimit's own db was never even moved — the failed target itself was never touched");
  } finally {
    chmodSync(join(rtDir, 'data'), 0o700);
  }
});

test('regression: at least two targets applied successfully, a real I/O failure on the third rolls all three back to their pre-restore state', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'apply-fail-'));
  const mediaDir = realServiceFixture(root, 'media', 'DATA_DIR=./data/files\n');
  const rtDir = realServiceFixture(root, 'ratelimit');
  mkdirSync(join(mediaDir, 'data', 'files', 'objects'), { recursive: true });
  writeFileSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin'), 'blob v1');
  const mdb = await openDb(mediaDir);
  mdb.prepare("INSERT INTO blobs (sha256, size, mime, created_at) VALUES ('x', 1, 'text/plain', 0)").run();
  mdb.close();
  const rtdb = await openDb(rtDir);
  rtdb.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('v1', '[]', 'test', 0, 0)").run();
  rtdb.close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();

  // Mutate every live target after the backup, so "reverted to pre-restore" is distinguishable from
  // "left on the snapshot's content" for all three items.
  writeFileSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin'), 'blob v2 (mutated after backup)');
  const mdb2 = await openDb(mediaDir);
  mdb2.prepare("UPDATE blobs SET mime = 'application/mutated' WHERE sha256 = 'x'").run();
  mdb2.close();
  const rtdb2 = await openDb(rtDir);
  rtdb2.prepare("UPDATE policies SET created_by = 'mutated' WHERE name = 'v1'").run();
  rtdb2.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('v2', '[]', 'mutated', 0, 0)").run();
  rtdb2.close();

  // manifest.entries order (ALL_SERVICES): media/db, media/objects, ratelimit/db — inject a
  // deterministic apply-phase failure on the third, after the first two have genuinely been applied.
  let applyCount = 0;
  const snapWithFault = new Snapshot({
    root, exec: fakeExec,
    _fault: (op, target) => {
      if (op !== 'apply') return false;
      applyCount++;
      return target.endsWith(join('ratelimit', 'data', 'ratelimit.db'));
    },
  });
  const result = await snapWithFault.restore(snapshotDir);

  assert.equal(result.outcome, 'rolled_back');
  assert.equal(applyCount, 3, 'both media items applied before the ratelimit apply was reached and faulted');
  assert.equal(result.failed?.phase, 'apply');
  assert.equal(result.failed?.service, 'ratelimit');
  assert.equal(result.rollbackFailed.length, 0);
  assert.deepEqual(result.rolledBack.sort(), ['media/data/files/objects', 'media/data/media.db', 'ratelimit/data/ratelimit.db'].sort());

  assert.equal(readFileSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin'), 'utf8'), 'blob v2 (mutated after backup)', 'media object reverted to its pre-restore (mutated) content, not left on the snapshot');
  const mediaCheck = await openDb(mediaDir);
  assert.equal(/** @type {any} */ (mediaCheck.prepare("SELECT mime FROM blobs WHERE sha256 = 'x'").get())?.mime, 'application/mutated', 'media db reverted to pre-restore, even though its apply succeeded');
  mediaCheck.close();
  const rtCheck = await openDb(rtDir);
  const names = /** @type {any[]} */ (rtCheck.prepare('SELECT name FROM policies ORDER BY name').all()).map((r) => r.name);
  assert.deepEqual(names, ['v1', 'v2'], 'ratelimit (the failed target) is also back at its pre-restore state — safe and deterministic, not left half-written');
  rtCheck.close();
});

test('rollback-incomplete: a second failure during rollback itself is reported distinctly, never as an ordinary restore failure', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'rollback-incomplete-'));
  const mediaDir = realServiceFixture(root, 'media', 'DATA_DIR=./data/files\n');
  const rtDir = realServiceFixture(root, 'ratelimit');
  mkdirSync(join(mediaDir, 'data', 'files', 'objects'), { recursive: true });
  writeFileSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin'), 'blob');
  (await openDb(mediaDir)).close();
  (await openDb(rtDir)).close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();

  // ratelimit's apply fails (as above); rolling back media's db aside back into place *also* fails —
  // e.g. its aside copy has become unreadable/gone by the time rollback runs.
  const snapWithFault = new Snapshot({
    root, exec: fakeExec,
    _fault: (op, target) => {
      if (op === 'apply') return target.endsWith(join('ratelimit', 'data', 'ratelimit.db'));
      if (op === 'rollback') return target.endsWith(join('media', 'data', 'media.db'));
      return false;
    },
  });
  const result = await snapWithFault.restore(snapshotDir);

  assert.equal(result.outcome, 'rollback_incomplete', 'never reported as a plain restore failure');
  assert.equal(result.restored.length, 0);
  assert.equal(result.failed?.service, 'ratelimit');
  assert.deepEqual(result.rollbackFailed, [{ service: 'media', path: 'data/media.db', error: `injected failure: rollback ${join(mediaDir, 'data', 'media.db')}` }]);
  assert.deepEqual(result.rolledBack.sort(), ['media/data/files/objects', 'ratelimit/data/ratelimit.db'].sort(), 'the two items whose rollback did succeed are still named individually');
});

test('restore refuses a schema newer than the running service supports, via the real Database forward-version guard', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'newer-'));
  const dir = realServiceFixture(root, 'ratelimit');
  (await openDb(dir)).close();
  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir, manifest } = await snap.create();
  // The manifest's own schemaVersion bookkeeping isn't what gates this — the staged database's own
  // `PRAGMA user_version` is. Bump it past what this checkout's MIGRATIONS array supports.
  const { DatabaseSync } = await import('node:sqlite');
  const staged = new DatabaseSync(join(snapshotDir, 'ratelimit', 'data', 'ratelimit.db'));
  staged.exec('PRAGMA user_version = 999');
  staged.close();
  // Recompute the checksum the tampered file must match, so this fails on the version guard, not on
  // the (unrelated) checksum check.
  const { createHash } = await import('node:crypto');
  manifest.entries[0].sha256 = createHash('sha256').update(readFileSync(join(snapshotDir, 'ratelimit', 'data', 'ratelimit.db'))).digest('hex');
  writeFileSync(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest));

  await assert.rejects(() => snap.restore(snapshotDir), /newer than this build supports/);
});
