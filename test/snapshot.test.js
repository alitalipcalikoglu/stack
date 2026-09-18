import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Real Ed25519 anchor key pair via audit's own `AnchorKeyGenerator` (never a hand-rolled stand-in
 * for key generation) written under `dir/keys/anchor-*`.
 * @param {string} dir
 */
async function generateAnchorKeys(dir) {
  const { AnchorKeyGenerator } = await import(pathToFileURL(join(workspaceRoot, 'audit', 'scripts', 'anchor-keygen.js')).href);
  return new AnchorKeyGenerator(join(dir, 'keys', 'anchor')).run();
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

/**
 * Post-production R1: a real, confirmed bug — restore only replaced a DB entry's main file, never
 * touching a live `-wal`/`-shm` sidecar sitting next to it. SQLite replays a stale WAL into whatever
 * main file it finds at open time, so a service that was not cleanly closed before restore (a real,
 * ordinary case — a crash, `kill -9`, or a forced exit past a shutdown timeout, none of them exotic)
 * had its post-backup writes silently reappear after "restore". Confirmed empirically before writing
 * this test, not assumed: a clean `db.close()`, or a script simply running to its natural end,
 * checkpoints WAL away (verified directly with `node:sqlite`); an explicit `process.exit()` does not
 * — real service processes hit exactly this path via their own documented `forceExitMs` ceiling.
 * These two tests reproduce a real, non-empty WAL (never a hand-created stand-in file) by leaving a
 * live connection's post-backup write un-checkpointed — no `.close()` call — the same real condition
 * a killed process leaves behind, not a synthetic approximation of it.
 */
test('successful restore discards a stale, un-checkpointed WAL — a service that was not cleanly closed leaves exactly this behind', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'wal-restore-'));
  const dir = realServiceFixture(root, 'ratelimit');
  const db = await openDb(dir);
  db.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('pre-backup', '[]', 'test', 0, 0)").run();
  db.close(); // clean close: VACUUM INTO's own backup already sees a flattened, WAL-free file regardless

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();

  // Post-backup write, deliberately left un-checkpointed (no .close()) — reproducing a real service
  // killed/force-exited rather than shut down cleanly.
  const live = await openDb(dir);
  live.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('post-backup', '[]', 'test', 0, 0)").run();

  const dbPath = join(dir, 'data', 'ratelimit.db');
  assert.ok(existsSync(`${dbPath}-wal`), 'precondition: a real WAL sits next to the live file');
  assert.ok(statSync(`${dbPath}-wal`).size > 0, 'precondition: the WAL genuinely holds the post-backup write, not an empty file');

  const result = await snap.restore(snapshotDir);
  assert.equal(result.outcome, 'restored');

  assert.equal(existsSync(`${dbPath}-wal`), false, 'no stale WAL left at the canonical path after a successful restore');
  assert.equal(existsSync(`${dbPath}-shm`), false, 'no stale SHM left at the canonical path after a successful restore');

  const restored = await openDb(dir);
  const names = /** @type {any[]} */ (restored.prepare('SELECT name FROM policies ORDER BY name').all()).map((r) => r.name);
  assert.deepEqual(names, ['pre-backup'], 'the post-backup write does not reappear via stale-WAL replay on the next real SQLite open');
  restored.close();
  live.close();
});

test('failed-restore rollback restores the WAL/SHM sidecars together with the main file, not just the main file', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'wal-rollback-'));
  const mediaDir = realServiceFixture(root, 'media', 'DATA_DIR=./data/files\n');
  const rtDir = realServiceFixture(root, 'ratelimit');
  mkdirSync(join(mediaDir, 'data', 'files', 'objects'), { recursive: true });
  writeFileSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin'), 'blob v1');
  (await openDb(mediaDir)).close();
  const rtdb = await openDb(rtDir);
  rtdb.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('pre-backup', '[]', 'test', 0, 0)").run();
  rtdb.close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();

  writeFileSync(join(mediaDir, 'data', 'files', 'objects', 'x.bin'), 'blob v2 (mutated after backup)');
  const rtLive = await openDb(rtDir);
  rtLive.prepare("INSERT INTO policies (name, limits, created_by, created_at, updated_at) VALUES ('post-backup', '[]', 'test', 0, 0)").run();

  const rtDbPath = join(rtDir, 'data', 'ratelimit.db');
  assert.ok(existsSync(`${rtDbPath}-wal`) && statSync(`${rtDbPath}-wal`).size > 0, 'precondition: real, un-checkpointed WAL on ratelimit before the restore attempt');

  // manifest.entries order (ALL_SERVICES): media/db, media/objects, ratelimit/db — fault the last
  // entry's apply, after ratelimit's db (and its WAL) has already been moved aside in phase 1.
  const snapWithFault = new Snapshot({
    root, exec: fakeExec,
    _fault: (op, target) => op === 'apply' && target.endsWith(join('ratelimit', 'data', 'ratelimit.db')),
  });
  const result = await snapWithFault.restore(snapshotDir);

  assert.equal(result.outcome, 'rolled_back');
  assert.equal(result.rollbackFailed.length, 0);

  assert.ok(existsSync(`${rtDbPath}-wal`), 'the WAL sidecar itself is back at the canonical path after rollback, not dropped');
  const rtCheck = await openDb(rtDir);
  const names = /** @type {any[]} */ (rtCheck.prepare('SELECT name FROM policies ORDER BY name').all()).map((r) => r.name);
  assert.deepEqual(names, ['post-backup', 'pre-backup'], 'rollback brought back the full pre-restore-attempt logical state, including the un-checkpointed post-backup write — not just whatever was in the main file alone');
  rtCheck.close();
  rtLive.close();
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

test('restored audit private key keeps its 0600 permissions, not the process umask default', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'audit-key-perms-'));
  const dir = realServiceFixture(root, 'audit', 'ANCHOR_PRIVATE_KEY_PATH=./keys/anchor-private.pem\n');
  await generateAnchorKeys(dir);
  assert.equal(statSync(join(dir, 'keys', 'anchor-private.pem')).mode & 0o777, 0o600, 'sanity: AnchorKeyGenerator itself writes 0600');
  (await openDb(dir)).close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();
  assert.equal(statSync(join(snapshotDir, 'audit', 'keys', 'anchor-private.pem')).mode & 0o777, 0o600, 'the backup copy itself keeps 0600, not writeFileSync\'s default umask mode');

  // Corrupt live permissions to prove restore actively re-asserts 0600 rather than happening to leave it alone.
  chmodSync(join(dir, 'keys', 'anchor-private.pem'), 0o644);
  const result = await snap.restore(snapshotDir);
  assert.equal(result.outcome, 'restored');
  assert.equal(statSync(join(dir, 'keys', 'anchor-private.pem')).mode & 0o777, 0o600, 'restore writes the private key back at 0600, not world/group-readable');
});

test('audit anchor private key is included in stack backup and checksummed in the manifest', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'audit-key-'));
  const dir = realServiceFixture(root, 'audit', 'ANCHOR_PRIVATE_KEY_PATH=./keys/anchor-private.pem\n');
  await generateAnchorKeys(dir);
  (await openDb(dir)).close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { manifest } = await snap.create();
  const keyEntry = manifest.entries.find((/** @type {any} */ e) => e.service === 'audit' && e.path === 'keys/anchor-private.pem');
  assert.ok(keyEntry, `expected an audit/keys/anchor-private.pem entry, got: ${JSON.stringify(manifest.entries.map((/** @type {any} */ e) => e.path))}`);
  assert.equal(keyEntry.kind, 'file');
  const { createHash } = await import('node:crypto');
  assert.equal(keyEntry.sha256, createHash('sha256').update(readFileSync(join(dir, 'keys', 'anchor-private.pem'))).digest('hex'));
  assert.ok(!JSON.stringify(manifest).includes(readFileSync(join(dir, 'keys', 'anchor-private.pem'), 'utf8')), 'the manifest never carries the key bytes themselves, only its checksum');
});

test('anchoring not configured: no audit key entry, and no error', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'audit-no-key-'));
  const dir = realServiceFixture(root, 'audit');
  (await openDb(dir)).close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { manifest } = await snap.create();
  assert.equal(manifest.entries.filter((/** @type {any} */ e) => e.service === 'audit').length, 1, 'only the database entry — anchoring is off, nothing else to back up');
});

test('anchoring configured but the key file is missing: backup refuses rather than silently completing an incomplete snapshot', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'audit-missing-key-'));
  const dir = realServiceFixture(root, 'audit', 'ANCHOR_PRIVATE_KEY_PATH=./keys/anchor-private.pem\n');
  (await openDb(dir)).close();
  // Deliberately never generated — ANCHOR_PRIVATE_KEY_PATH is configured but nothing exists there.

  const snap = new Snapshot({ root, exec: fakeExec });
  await assert.rejects(() => snap.create(), /ANCHOR_PRIVATE_KEY_PATH is configured.*but the file does not exist/);
});

test('tampering with the snapshot copy of the audit private key is caught by checksum validation before anything live is touched', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'audit-tamper-'));
  const dir = realServiceFixture(root, 'audit', 'ANCHOR_PRIVATE_KEY_PATH=./keys/anchor-private.pem\n');
  await generateAnchorKeys(dir);
  const liveKeyBefore = readFileSync(join(dir, 'keys', 'anchor-private.pem'));
  (await openDb(dir)).close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();
  writeFileSync(join(snapshotDir, 'audit', 'keys', 'anchor-private.pem'), 'tampered, not a real key file');

  await assert.rejects(() => snap.restore(snapshotDir), /checksum mismatch/);
  assert.deepEqual(readFileSync(join(dir, 'keys', 'anchor-private.pem')), liveKeyBefore, 'the live private key file was never touched by the refused restore');
});

test('restore failure rolls the audit database and its anchor key back together, as one consistency unit', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'audit-key-rollback-'));
  const dir = realServiceFixture(root, 'audit', 'ANCHOR_PRIVATE_KEY_PATH=./keys/anchor-private.pem\n');
  await generateAnchorKeys(dir);
  const db = await openDb(dir);
  db.prepare("INSERT INTO events (id, client_id, source, action, outcome, at, received_at, prev_hash, hash) VALUES ('e1', NULL, 'harness', 'seed', 'success', 0, 0, ?, 'h1')").run('0'.repeat(64));
  db.close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir } = await snap.create();

  // Mutate BOTH the live database and the live key material after the backup, so "reverted" is
  // distinguishable from "left on the snapshot's content" for both at once.
  const liveDb = await openDb(dir);
  liveDb.prepare("UPDATE events SET action = 'mutated-after-backup' WHERE id = 'e1'").run();
  liveDb.close();
  const mutatedKeyBytes = 'mutated-after-backup, not a real key';
  writeFileSync(join(dir, 'keys', 'anchor-private.pem'), mutatedKeyBytes);

  // manifest.entries for audit alone: db first (DB_SERVICES loop runs before EXTRA_PATHS in
  // `create()`), then the key. Fault the key's apply so the db's apply has already genuinely
  // succeeded by the time this hits — proving rollback reverts both, not just the one that failed.
  const snapWithFault = new Snapshot({
    root, exec: fakeExec,
    _fault: (op, target) => op === 'apply' && target.endsWith(join('audit', 'keys', 'anchor-private.pem')),
  });
  const result = await snapWithFault.restore(snapshotDir);

  assert.equal(result.outcome, 'rolled_back');
  assert.equal(result.failed?.service, 'audit');
  assert.equal(result.failed?.path, 'keys/anchor-private.pem');
  assert.equal(result.rollbackFailed.length, 0);
  assert.deepEqual(result.rolledBack.sort(), ['audit/data/audit.db', 'audit/keys/anchor-private.pem'].sort());

  const restoredDb = await openDb(dir);
  assert.equal(/** @type {any} */ (restoredDb.prepare("SELECT action FROM events WHERE id = 'e1'").get())?.action, 'mutated-after-backup', 'db reverted to its pre-restore (mutated) state, not left on the (failed) snapshot apply');
  restoredDb.close();
  assert.equal(readFileSync(join(dir, 'keys', 'anchor-private.pem'), 'utf8'), mutatedKeyBytes, 'key material reverted to its pre-restore (mutated) state too — DB and key never end up on different sides of the restore');
});

test('auth regression: JWT signing keys are still included, restored, and manifest-validated after the audit key addition', async () => {
  const root = mkdtempSync(join(fixtureRoot, 'auth-key-regression-'));
  const dir = realServiceFixture(root, 'auth');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  mkdirSync(join(dir, 'keys'), { recursive: true });
  writeFileSync(join(dir, 'keys', 'jwt-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, 'keys', 'jwt-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  (await openDb(dir)).close();

  const snap = new Snapshot({ root, exec: fakeExec });
  const { dir: snapshotDir, manifest } = await snap.create();
  const keyEntry = manifest.entries.find((/** @type {any} */ e) => e.service === 'auth' && e.path === 'keys');
  assert.ok(keyEntry, 'auth/keys directory still included');
  assert.equal(keyEntry.kind, 'dir');

  writeFileSync(join(dir, 'keys', 'jwt-private.pem'), 'mutated after backup');
  const result = await snap.restore(snapshotDir);
  assert.equal(result.outcome, 'restored');
  assert.ok(readFileSync(join(dir, 'keys', 'jwt-private.pem'), 'utf8').includes('BEGIN PRIVATE KEY'), 'the real private key is back after restore, not the post-backup mutation');
});
