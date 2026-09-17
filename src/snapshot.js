import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvFile } from './env-file.js';
import { SERVICES } from './manifest.js';

const MANIFEST_VERSION = 1;

/**
 * Read one variable from a service's `.env`, unquoted. Empty string when missing or no `.env` yet.
 * @param {string} serviceDir @param {string} name
 */
function envVar(serviceDir, name) {
  const path = join(serviceDir, '.env');
  return existsSync(path) ? (EnvFile.load(path).toObject()[name] ?? '') : '';
}

/**
 * Express a path (absolute, or relative to `serviceDir`) as relative to `serviceDir`, for the manifest.
 * @param {string} serviceDir @param {string} path
 */
function relTo(serviceDir, path) {
  return relative(serviceDir, resolve(serviceDir, path));
}

/**
 * What a full-stack backup covers, beyond "every service's SQLite database": paths that hold data
 * a database restore alone cannot reconstruct. Anything not listed here (media's `tmp/`, generated
 * `node_modules`, PM2 logs, …) is either regenerable or not data. Resolved per service from its own
 * `.env` (paths are configurable), not hardcoded, so the manifest always records what that service
 * was actually configured to use at backup time.
 * @type {Record<string, (serviceDir: string) => string[]>}
 */
const EXTRA_PATHS = {
  media: (dir) => {
    const dataDir = envVar(dir, 'DATA_DIR') || './data/files';
    return ['objects', 'variants'].map((sub) => relTo(dir, join(dataDir, sub)));
  },
  auth: () => ['keys'],
  gateway: (dir) => [relTo(dir, envVar(dir, 'ROUTES_FILE') || 'routes.json')],
  console: (dir) => [relTo(dir, envVar(dir, 'SERVICES_FILE') || 'services.json')],
};

/** Services backed up by their SQLite database (every stateful service; gateway has none). */
const DB_SERVICES = SERVICES.map((s) => s.id).filter((id) => id !== 'gateway');

/** Services touched by a backup at all (DB services plus gateway, for its `routes.json`). */
const ALL_SERVICES = [...new Set([...DB_SERVICES, ...Object.keys(EXTRA_PATHS)])];

/**
 * @typedef {object} RestoreResult
 * @property {'restored'|'rolled_back'|'rollback_incomplete'} outcome `restored`: every requested item
 *   is now on the snapshot's content. `rolled_back`: the restore failed but every item is confirmed
 *   back at its pre-restore state. `rollback_incomplete`: the restore failed AND reverting at least
 *   one item also failed — check `rollbackFailed` before assuming anything about that item's state
 *   (it may be a partial write, or, in the worst case, absent).
 * @property {string[]} restored Items now on the snapshot's content — only non-empty when `outcome === 'restored'`.
 * @property {{ service: string, path: string, phase: 'prepare'|'apply', error: string }|null} failed
 *   The item whose prepare/apply step actually failed, or `null` when `outcome === 'restored'`.
 * @property {string[]} rolledBack `service/path` labels confirmed reverted to their pre-restore state.
 * @property {{ service: string, path: string, error: string }[]} rollbackFailed Items where reverting
 *   itself failed — never treat these as safe; their live state must be checked by hand.
 * @property {string[]} skipped Requested services the manifest doesn't cover.
 * @property {string} runId Shared suffix on every `.before-restore-<runId>` aside path this call created.
 */

/**
 * Creates and restores whole-stack snapshots. A snapshot is a plain directory: `manifest.json`
 * (schema version, per-service package version and DB schema version, a sha256 per backed-up item)
 * plus one subfolder per service holding its database file and any extra paths from
 * {@link EXTRA_PATHS}. There is no archive format — `create()` writes a directory, `restore()` reads
 * one; wrap it in a tarball yourself if you need one file to move around.
 *
 * `restore()` never touches a live file until every item it will touch has been validated: the
 * manifest is well-formed, every recorded file/directory is present with a matching hash, and every
 * database, opened from a staged copy through the service's own (current) `Database` subclass,
 * migrates cleanly — which is also where a snapshot newer than the running code gets rejected,
 * since that is exactly the check `Database`'s constructor already makes.
 *
 * Applying is two phases, both scoped to one `runId` shared by every item in the call:
 *
 * 1. **Prepare** — every live target that exists is moved aside (never deleted) to
 *    `<path>.before-restore-<runId>`, one item at a time. If moving a target aside itself fails,
 *    nothing has been applied yet: whatever was already moved aside in this phase is moved straight
 *    back and `restore()` reports `rolled_back` (or `rollback_incomplete` if even that move-back
 *    fails) with nothing changed.
 * 2. **Apply** — the validated snapshot content is written into each target in turn. If an item
 *    fails here, every item already applied in this phase (plus the failed one itself) is reverted
 *    from its phase-1 aside copy, so a failed restore never leaves some services on the new snapshot
 *    and others on the old one — either every requested item ends up on the snapshot (`restored`) or
 *    every one of them ends up back where it started (`rolled_back`). If reverting an item itself
 *    fails (its aside copy is gone, e.g.), that is reported as `rollback_incomplete`, distinctly from
 *    an ordinary failure, with exactly which items are on which side of the swap.
 *
 * This is a best-effort, in-process saga, not a cross-service filesystem transaction: there is no
 * atomicity guarantee across a process kill or power loss mid-apply. A crash between phase 1 and the
 * end of phase 2 leaves some targets on the new content and some `.before-restore-<runId>` aside
 * copies sitting next to the rest, with no automatic detection or resume on the next run — an
 * operator must compare the aside copies against the current files by hand. This is a deliberate
 * scope decision (see `stack/docs/UPGRADE.md`), not an oversight: a restore-journal that detects and
 * resumes an interrupted run is real complexity for a failure mode (concurrent process kill during a
 * restore, which itself needs services already stopped) that in-process error handling does not need.
 *
 * `.before-restore-<runId>` copies are never deleted automatically, on success or failure — see
 * `stack/docs/UPGRADE.md` for retention.
 */
export class Snapshot {
  /**
   * @param {object} o
   * @param {string} o.root Workspace root (parent of every service folder).
   * @param {(cwd: string, argv: string[], opts?: { stdio?: 'inherit'|'pipe' }) => Promise<{ code: number, out: string }>} o.exec
   * @param {(line: string) => void} [o.log]
   * @param {(op: 'prepare'|'apply'|'rollback', target: string) => boolean} [o._fault] Test-only
   *   injection hook: when it returns true for a given phase and target, that filesystem step
   *   throws instead of running, so a specific failure (including a second one, during rollback
   *   itself) can be produced deterministically. Never set outside tests.
   */
  constructor({ root, exec, log = () => {}, _fault }) {
    this.root = root;
    this.exec = exec;
    this.log = log;
    this._fault = _fault ?? (() => false);
  }

  /**
   * @param {{ dir?: string }} [o]
   * @returns {Promise<{ dir: string, manifest: { manifestVersion: number, createdAt: string, entries: any[] } }>}
   */
  async create({ dir } = {}) {
    const dest = resolve(dir || join(this.root, 'backups', Snapshot.#timestamp()));
    mkdirSync(dest, { recursive: true });
    /** @type {any[]} */
    const entries = [];
    for (const id of ALL_SERVICES) {
      const serviceDir = join(this.root, id);
      if (!existsSync(join(serviceDir, 'package.json'))) { this.log(`${id}: skipped (not installed)`); continue; }
      const packageVersion = JSON.parse(readFileSync(join(serviceDir, 'package.json'), 'utf8')).version ?? '0.0.0';
      const outDir = join(dest, id);
      mkdirSync(outDir, { recursive: true });

      if (DB_SERVICES.includes(id)) {
        const dbPath = Snapshot.#dbPath(serviceDir);
        if (existsSync(dbPath)) {
          const rel = relTo(serviceDir, dbPath);
          const outFile = join(outDir, rel);
          const schemaVersion = Snapshot.#backupDb(dbPath, outFile);
          entries.push({ service: id, kind: 'db', path: rel, schemaVersion, packageVersion, sha256: Snapshot.#hashFile(outFile) });
          this.log(`${id}: ${rel} (schema v${schemaVersion})`);
        } else {
          this.log(`${id}: no database file yet, skipped`);
        }
      }

      for (const rel of EXTRA_PATHS[id]?.(serviceDir) ?? []) {
        const src = join(serviceDir, rel);
        if (!existsSync(src)) { this.log(`${id}: ${rel} does not exist, skipped`); continue; }
        const out = join(outDir, rel);
        const st = lstatSync(src);
        if (st.isSymbolicLink()) throw new Error(`${id}/${rel} is a symlink; refusing to back it up`);
        if (st.isDirectory()) {
          Snapshot.#copyDir(src, out);
          entries.push({ service: id, kind: 'dir', path: rel, packageVersion, sha256: Snapshot.#hashDir(out) });
        } else {
          mkdirSync(dirname(out), { recursive: true });
          Snapshot.#copyFile(src, out);
          entries.push({ service: id, kind: 'file', path: rel, packageVersion, sha256: Snapshot.#hashFile(out) });
        }
        this.log(`${id}: ${rel}`);
      }
    }
    const manifest = { manifestVersion: MANIFEST_VERSION, createdAt: new Date().toISOString(), entries };
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { dir: dest, manifest };
  }

  /**
   * @param {string} snapshotDir
   * @param {{ services?: string[] }} [o] Restrict to these service ids; default every service the
   *   manifest covers.
   * @returns {Promise<RestoreResult>}
   */
  async restore(snapshotDir, { services } = {}) {
    const dir = resolve(snapshotDir);
    const manifest = Snapshot.#loadManifest(dir);
    const wanted = services ?? [...new Set(manifest.entries.map((/** @type {any} */ e) => e.service))];
    for (const id of wanted) if (!ALL_SERVICES.includes(id)) throw new Error(`unknown service "${id}"`);

    // Validate everything before touching anything: files present and hash-correct, symlink-free,
    // paths that stay inside the snapshot and inside the target service folder, and every database
    // opens cleanly (including the forward-version guard) from a staged copy.
    /** @type {any[]} */
    const plan = [];
    for (const entry of manifest.entries) {
      if (!wanted.includes(entry.service)) continue;
      const serviceDir = join(this.root, entry.service);
      const src = Snapshot.#assertInside(dir, join(dir, entry.service, entry.path));
      if (!existsSync(src)) throw new Error(`${entry.service}/${entry.path}: missing from snapshot (incomplete backup)`);
      const actualHash = entry.kind === 'dir' ? Snapshot.#hashDir(src) : Snapshot.#hashFile(src);
      if (actualHash !== entry.sha256) throw new Error(`${entry.service}/${entry.path}: checksum mismatch (corrupt backup)`);
      Snapshot.#assertNoSymlinks(src);
      const target = Snapshot.#assertInside(serviceDir, join(serviceDir, entry.path));
      plan.push({ entry, src, target, serviceDir, label: `${entry.service}/${entry.path}` });
    }
    for (const { entry, src, serviceDir } of plan) {
      if (entry.kind !== 'db') continue;
      await this.#validateStagedDb(serviceDir, src, entry);
    }
    const skipped = wanted.filter((id) => !plan.some((p) => p.entry.service === id));
    const runId = Snapshot.#timestamp();

    // Phase 1 — prepare: move every existing target aside (never delete), one at a time. A failure
    // here means nothing has been applied yet, so undoing it is just moving back what this phase
    // itself already moved.
    /** @type {{ item: any, aside: string|null }[]} */
    const prepared = [];
    for (const item of plan) {
      try {
        prepared.push({ item, aside: this.#moveAside(item.target, runId) });
      } catch (err) {
        return this.#abortPrepare(prepared, item, err, skipped, runId);
      }
    }

    // Phase 2 — apply: write the validated snapshot content into each target.
    /** @type {{ item: any, aside: string|null }[]} */
    const applied = [];
    for (const { item, aside } of prepared) {
      try {
        this.#applyContent(item.entry, item.src, item.target);
        applied.push({ item, aside });
      } catch (err) {
        return this.#rollbackApplied(applied, { item, aside }, err, skipped, runId);
      }
    }

    return { outcome: 'restored', restored: applied.map(({ item }) => item.label), failed: null, rolledBack: [], rollbackFailed: [], skipped, runId };
  }

  /**
   * Phase-1 failure: revert whatever this call already moved aside; nothing was ever applied.
   * @param {{ item: any, aside: string|null }[]} prepared @param {any} failedItem @param {unknown} err
   * @param {string[]} skipped @param {string} runId
   * @returns {RestoreResult}
   */
  #abortPrepare(prepared, failedItem, err, skipped, runId) {
    const rolledBack = [];
    const rollbackFailed = [];
    for (const { item, aside } of prepared) {
      if (!aside) { rolledBack.push(item.label); continue; }
      try {
        this.#revert(aside, item.target, 'rollback');
        rolledBack.push(item.label);
      } catch (revertErr) {
        rollbackFailed.push({ service: item.entry.service, path: item.entry.path, error: Snapshot.#msg(revertErr) });
      }
    }
    return {
      outcome: rollbackFailed.length ? 'rollback_incomplete' : 'rolled_back',
      restored: [],
      failed: { service: failedItem.entry.service, path: failedItem.entry.path, phase: 'prepare', error: Snapshot.#msg(err) },
      rolledBack,
      rollbackFailed,
      skipped,
      runId,
    };
  }

  /**
   * Phase-2 failure: revert the failed item itself plus every item already applied before it, each
   * from its own phase-1 aside copy.
   * @param {{ item: any, aside: string|null }[]} applied @param {{ item: any, aside: string|null }} failed
   * @param {unknown} err @param {string[]} skipped @param {string} runId
   * @returns {RestoreResult}
   */
  #rollbackApplied(applied, failed, err, skipped, runId) {
    const rolledBack = [];
    const rollbackFailed = [];
    for (const { item, aside } of [failed, ...[...applied].reverse()]) {
      try {
        this.#revert(aside, item.target, 'rollback');
        rolledBack.push(item.label);
      } catch (revertErr) {
        rollbackFailed.push({ service: item.entry.service, path: item.entry.path, error: Snapshot.#msg(revertErr) });
      }
    }
    return {
      outcome: rollbackFailed.length ? 'rollback_incomplete' : 'rolled_back',
      restored: [],
      failed: { service: failed.item.entry.service, path: failed.item.entry.path, phase: 'apply', error: Snapshot.#msg(err) },
      rolledBack,
      rollbackFailed,
      skipped,
      runId,
    };
  }

  /**
   * Open a staged copy of a database through the target service's own, current `Database` subclass
   * — the same constructor a real start would call, so a schema newer than this build supports
   * throws here (via `ConfigError`) rather than after the file is already in place, and a genuinely
   * older snapshot migrates forward exactly as a normal upgrade would.
   * @param {string} serviceDir
   * @param {string} dbFile
   * @param {any} entry
   */
  async #validateStagedDb(serviceDir, dbFile, entry) {
    const staged = join(mkdtempSync(join(tmpdir(), 'atc-restore-')), 'staged.db');
    Snapshot.#copyFile(dbFile, staged);
    const { Database } = await import(pathToFileURL(join(serviceDir, 'src/db.js')).href);
    const db = new Database(staged);
    try {
      db.ping();
      const { integrity_check: result } = /** @type {{ integrity_check: string }} */ (db.prepare('PRAGMA integrity_check').get());
      if (result !== 'ok') throw new Error(`${entry.service}/${entry.path}: PRAGMA integrity_check reports "${result}" (corrupt backup)`);
    } finally {
      db.close();
      rmSync(dirname(staged), { recursive: true, force: true });
    }
  }

  /**
   * Phase 1 primitive: move a live target aside if it exists, so phase 2 can freely overwrite it and
   * still have something to revert to. Returns the aside path, or `null` when there was nothing to
   * move (the target didn't exist before this restore — its correct "reverted" state is absent).
   * @param {string} target @param {string} runId
   * @returns {string|null}
   */
  #moveAside(target, runId) {
    if (this._fault('prepare', target)) throw new Error(`injected failure: prepare ${target}`);
    if (!existsSync(target)) return null;
    const aside = `${target}.before-restore-${runId}`;
    mkdirSync(dirname(aside), { recursive: true });
    renameSync(target, aside);
    return aside;
  }

  /**
   * Phase 2 primitive: write the validated snapshot copy into `target` (which phase 1 already
   * cleared, directly or via `#moveAside`).
   * @param {any} entry @param {string} src @param {string} target
   */
  #applyContent(entry, src, target) {
    if (this._fault('apply', target)) throw new Error(`injected failure: apply ${target}`);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.kind === 'dir') Snapshot.#copyDir(src, target);
    else Snapshot.#copyFile(src, target);
  }

  /**
   * Rollback primitive: discard whatever now sits at `target` (a phase-2 write, possibly partial)
   * and move the phase-1 aside copy back — or, when there was no aside copy (the target legitimately
   * didn't exist before), just clear `target` again. Throws (uncaught, by design — the caller records
   * it as a `rollbackFailed` entry) if the aside copy is itself gone or the filesystem refuses.
   * @param {string|null} aside @param {string} target @param {'rollback'} op
   */
  #revert(aside, target, op) {
    if (this._fault(op, target)) throw new Error(`injected failure: ${op} ${target}`);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    if (aside) renameSync(aside, target);
  }

  /** @param {unknown} err */
  static #msg(err) {
    return err instanceof Error ? err.message : String(err);
  }

  /** @param {string} serviceDir */
  static #dbPath(serviceDir) {
    const envPath = join(serviceDir, '.env');
    const rel = (existsSync(envPath) ? EnvFile.load(envPath).toObject().DB_PATH : '') || './data/db.sqlite';
    return resolve(serviceDir, rel);
  }

  /**
   * `VACUUM INTO` a live database file into a fresh, consistent snapshot file — safe to run without
   * stopping the service: it takes its own read-consistent view, even under concurrent WAL writers.
   * @param {string} dbPath @param {string} outFile
   * @returns {number} the source database's schema version
   */
  static #backupDb(dbPath, outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    if (existsSync(outFile)) rmSync(outFile);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const { user_version: schemaVersion } = /** @type {{ user_version: number }} */ (db.prepare('PRAGMA user_version').get());
      db.prepare('VACUUM INTO ?').run(outFile);
      return schemaVersion;
    } finally {
      db.close();
    }
  }

  /** @param {string} dir */
  static #loadManifest(dir) {
    const path = join(dir, 'manifest.json');
    if (!existsSync(path)) throw new Error(`${dir}: not a snapshot (no manifest.json)`);
    /** @type {any} */
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`${dir}: manifest.json is not valid JSON (corrupt backup)`);
    }
    if (manifest.manifestVersion !== MANIFEST_VERSION || !Array.isArray(manifest.entries)) {
      throw new Error(`${dir}: manifest.json is not a recognised snapshot manifest (corrupt or incompatible backup)`);
    }
    return manifest;
  }

  /** Refuse a snapshot or target path that would resolve outside `root` (traversal/symlink guard). @param {string} root @param {string} target */
  static #assertInside(root, target) {
    const r = resolve(root);
    const t = resolve(target);
    if (t !== r && !t.startsWith(r + sep)) throw new Error(`${target}: escapes ${root}`);
    return t;
  }

  /** @param {string} path */
  static #assertNoSymlinks(path) {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`${path}: is a symlink (unsafe in a backup)`);
    if (st.isDirectory()) for (const child of readdirSync(path)) Snapshot.#assertNoSymlinks(join(path, child));
  }

  /** @param {string} src @param {string} dest */
  static #copyFile(src, dest) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
  }

  /** @param {string} src @param {string} dest */
  static #copyDir(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      const s = join(src, name);
      const d = join(dest, name);
      if (lstatSync(s).isSymbolicLink()) throw new Error(`${s}: is a symlink (unsafe in a backup)`);
      if (statSync(s).isDirectory()) Snapshot.#copyDir(s, d);
      else Snapshot.#copyFile(s, d);
    }
  }

  /** @param {string} path */
  static #hashFile(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  /** Deterministic aggregate hash of a directory's contents (sorted relative paths). @param {string} path */
  static #hashDir(path) {
    const files = Snapshot.#listFiles(path).sort();
    const hash = createHash('sha256');
    for (const rel of files) hash.update(`${rel}\0${Snapshot.#hashFile(join(path, rel))}\n`);
    return hash.digest('hex');
  }

  /** @param {string} dir @param {string} [prefix] @returns {string[]} */
  static #listFiles(dir, prefix = '') {
    /** @type {string[]} */
    const out = [];
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) out.push(...Snapshot.#listFiles(abs, rel));
      else out.push(rel);
    }
    return out;
  }

  static #timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }
}
