import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll } from './harness.js';
import { Snapshot } from '../../src/snapshot.js';

/**
 * Post-production Phase 3: proves cryptographic continuity across a real `stack backup`/`restore`
 * round-trip through the real audit process and its real Ed25519 anchor crypto — not key-byte hash
 * equality, and not an in-process `AnchorSigner` call. K1 signs a real anchor over a real event; a
 * `stack backup` snapshot is taken; live state is then mutated (a new event, and the key rotated to
 * K2, which signs its own new anchor); `stack restore` puts the database and the anchor key back
 * together as one unit; a freshly spawned, restored real process's `/v1/chain/verify` re-validates
 * the pre-backup, K1-signed anchor, and a new anchor created after the restore is proven to still be
 * signed under K1 (continuity), not the K2 identity that only ever existed post-backup.
 *
 * `Anchorer#start()` signs an anchor over the current chain head immediately on construction (not
 * only on its minute-granularity timer) — so each "create an anchor" step here is a real process
 * restart, the real startup path a redeploy or rotation would also go through, not a synthetic timer
 * fast-forward.
 *
 * Spawns real service processes, so it only runs when explicitly requested: `STACK_INTEGRATION=1
 * npm test`.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {string[]} */
const scratchDirs = [];
after(() => { for (const d of scratchDirs) rmSync(d, { recursive: true, force: true }); });

/** @param {string} base @returns {Promise<{ privatePath: string, publicPath: string }>} */
async function generateAnchorKeys(base) {
  const { AnchorKeyGenerator } = await import(pathToFileURL(join(workspaceRoot, 'audit', 'scripts', 'anchor-keygen.js')).href);
  return new AnchorKeyGenerator(base).run();
}

/** @param {string} publicKeyPath @returns {Promise<string>} the real, independently-computed keyId (not a guess/copy of the service's own value) */
async function keyIdFromPublicFile(publicKeyPath) {
  const { AnchorSigner } = await import(pathToFileURL(join(workspaceRoot, 'audit', 'src', 'crypto', 'anchor-signer.js')).href);
  const { createPublicKey } = await import('node:crypto');
  return AnchorSigner.keyId(createPublicKey(readFileSync(publicKeyPath, 'utf8')));
}

/**
 * A real audit checkout, not a synthetic stand-in: symlinks the real `src/`/`node_modules` (so
 * `ServiceProcess` spawns the exact real `src/index.js` entry point and `@atc-web/service-core`
 * resolves normally) with its own `.env`/`data`/`keys` under a throwaway scratch dir — same
 * convention `stack/test/snapshot.test.js`'s `realServiceFixture` uses.
 * @param {string} scratch
 */
function auditFixture(scratch) {
  const real = join(workspaceRoot, 'audit');
  const dir = join(scratch, 'audit');
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(real, 'src'), join(dir, 'src'), 'dir');
  symlinkSync(join(real, 'node_modules'), join(dir, 'node_modules'), 'dir');
  cpSync(join(real, 'package.json'), join(dir, 'package.json'));
  writeFileSync(join(dir, '.env'), 'DB_PATH=./data/audit.db\nANCHOR_PRIVATE_KEY_PATH=./keys/anchor-private.pem\n');
  return dir;
}

test('audit anchor cryptographic continuity survives a real stack backup/restore round-trip', { skip }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'audit-anchor-continuity-'));
  scratchDirs.push(scratch);
  const serviceDir = auditFixture(scratch);
  const dbPath = join(serviceDir, 'data', 'audit.db');
  const keyPath = join(serviceDir, 'keys', 'anchor-private.pem');

  const k1 = await generateAnchorKeys(join(serviceDir, 'keys', 'anchor'));
  const k1KeyId = await keyIdFromPublicFile(k1.publicPath);
  const apiKey = randomSecret();
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', DB_PATH: dbPath,
    AUDIT_API_KEYS: `harness:${apiKey}:readwrite`, ANCHOR_PRIVATE_KEY_PATH: './keys/anchor-private.pem', ANCHOR_INTERVAL_MIN: '1',
  };
  const auth = { authorization: `Bearer ${apiKey}` };

  /** @type {ServiceProcess[]} */
  const procs = [];
  /** Spawns real audit, waits for ready, returns it. Every launch is tracked so `finally` below can always stop every one of them, even mid-assertion-failure — a spawned real child process left running otherwise keeps `node --test` itself from ever exiting. */
  const launch = async () => {
    const p = new ServiceProcess({ name: 'audit', cwd: serviceDir, entry: 'src/index.js', port, env });
    procs.push(p);
    await p.start();
    return p;
  };

  try {
    // 1-5: K1 signs a real anchor over a real event.
    let proc = await launch();
    const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test.pre-backup-event' }) });
    assert.equal(postRes.status, 201, await postRes.text());
    await proc.stop();
    proc = await launch(); // Anchorer#start() signs an anchor over the current head immediately.
    const anchor1Res = await fetch(`http://127.0.0.1:${port}/v1/chain/anchors/latest`, { headers: auth });
    assert.equal(anchor1Res.status, 200);
    const anchor1 = (await anchor1Res.json()).anchor;
    assert.equal(anchor1.keyId, k1KeyId, 'the anchor over the pre-backup event is signed by K1');
    const verify1Res = await fetch(`http://127.0.0.1:${port}/v1/chain/verify`, { headers: auth });
    assert.equal((await verify1Res.json()).ok, true, 'K1 anchor verifies against the real chain before backup');
    await proc.stop();

    // 6: real stack backup.
    const snap = new Snapshot({ root: scratch, exec: async () => ({ code: 0, out: '' }) });
    const { dir: snapshotDir } = await snap.create();
    const manifest = JSON.parse(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.entries.some((/** @type {any} */ e) => e.service === 'audit' && e.path === 'keys/anchor-private.pem'), 'the backup actually captured the anchor key, not just the database');

    // 7: mutate live state — a new post-backup event, and the key rotated to K2, which signs its own new anchor.
    proc = await launch();
    const mutateRes = await fetch(`http://127.0.0.1:${port}/v1/events`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test.post-backup-mutation' }) });
    assert.equal(mutateRes.status, 201, await mutateRes.text());
    await proc.stop();
    const k2 = await generateAnchorKeys(join(scratch, 'k2-anchor')); // generated elsewhere: AnchorKeyGenerator refuses to overwrite an existing file.
    writeFileSync(keyPath, readFileSync(k2.privatePath)); // simulates the real operator rotation move: swap the file at the configured path.
    proc = await launch(); // now signs with K2.
    const anchor2Res = await fetch(`http://127.0.0.1:${port}/v1/chain/anchors/latest`, { headers: auth });
    const anchor2 = (await anchor2Res.json()).anchor;
    const k2KeyId = await keyIdFromPublicFile(k2.publicPath);
    assert.equal(anchor2.keyId, k2KeyId, 'sanity: the post-mutation anchor really is signed under the new (K2) identity, not K1');
    await proc.stop();

    // 8: real stack restore — database and anchor key together, one consistency unit.
    const result = await snap.restore(snapshotDir, { services: ['audit'] });
    assert.equal(result.outcome, 'restored');
    assert.deepEqual(readFileSync(keyPath), readFileSync(k1.privatePath), 'the restored key file is byte-for-byte K1 again');

    // 9-12: restored process — pre-backup K1 anchor still verifies; the post-backup mutation is gone;
    // a new anchor created after the restore is signed under K1 again (continuity), not K2.
    proc = await launch();
    const verify2Res = await fetch(`http://127.0.0.1:${port}/v1/chain/verify`, { headers: auth });
    assert.equal((await verify2Res.json()).ok, true, 'the pre-backup K1-signed anchor still verifies after restore');

    const eventsRes = await fetch(`http://127.0.0.1:${port}/v1/events?limit=10`, { headers: auth });
    const actions = (await eventsRes.json()).items.map((/** @type {any} */ e) => e.action);
    assert.ok(!actions.includes('test.post-backup-mutation'), 'the post-backup event is gone — the database was really reverted, not left on its mutated content');
    assert.ok(actions.includes('test.pre-backup-event'), 'the pre-backup event survived the restore');

    // The restored chain head is exactly what anchor1 already covers — Anchorer only signs when the
    // head has advanced past the last anchor's seq (its own re-anchoring-an-unchanged-head guard), so
    // a genuinely NEW anchor needs a genuinely new event first, same as any real post-restore activity.
    const postRestoreRes = await fetch(`http://127.0.0.1:${port}/v1/events`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test.post-restore-event' }) });
    assert.equal(postRestoreRes.status, 201, await postRestoreRes.text());
    await proc.stop();
    proc = await launch(); // signs a fresh anchor over the now-advanced, post-restore head.
    const anchor3Res = await fetch(`http://127.0.0.1:${port}/v1/chain/anchors/latest`, { headers: auth });
    const anchor3 = (await anchor3Res.json()).anchor;
    assert.equal(anchor3.keyId, k1KeyId, 'a NEW anchor created after the restore is signed under K1 again — real continuity, not K2 (which only ever existed post-backup, now gone)');
    assert.notEqual(anchor3.seq, anchor1.seq, 'sanity: this really is a fresh anchor over the new head, not the pre-backup one read back');
    const verify3Res = await fetch(`http://127.0.0.1:${port}/v1/chain/verify`, { headers: auth });
    assert.equal((await verify3Res.json()).ok, true, 'the full chain, including the new post-restore K1 anchor, verifies');
  } finally {
    await stopAll(procs);
  }
});
