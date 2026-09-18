import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EnvFile } from './env-file.js';
import { SERVICES } from './manifest.js';
import { SetupContext } from './setup-context.js';
import { Snapshot } from './snapshot.js';

/**
 * One row of {@link Stack#matrix}: reachability plus a defensively-parsed `/v1/info`.
 * @typedef {{ id: string, url: string, ok: boolean } & ({ infoOk: true, version: string|null, apiVersion: string|null, schemaVersion: number|null, serviceCore: string|null, capabilities: string[] } | { infoOk: false, infoError: string })} MatrixRow
 */

/**
 * The commands: `setup` (dependencies, secrets, keys, env files, routes, console build, first
 * admin), `up`/`down` (PM2), `dev` (foreground, all processes, one terminal), `status` (health and
 * readiness) and its `matrix()` variant (Stage 7: version/contract matrix from each service's own
 * `/v1/info`).
 */
export class Stack {
  /**
   * @param {object} o
   * @param {string} o.root
   * @param {(line: string) => void} [o.log]
   * @param {(cwd: string, argv: string[], opts?: { stdio?: 'inherit'|'pipe' }) => Promise<{ code: number, out: string }>} [o.exec]
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ root, log = (l) => console.log(l), exec = Stack.exec, fetch: f = fetch }) {
    this.root = root;
    this.log = log;
    this.exec = exec;
    this.fetch = f;
  }

  /**
   * @param {{ host?: string, local?: boolean, install?: boolean, adminEmail?: string, adminPassword?: string }} [o]
   */
  async setup({ host = '127.0.0.1', local = true, install = false, adminEmail = 'admin@console.local', adminPassword } = {}) {
    for (const s of SERVICES) {
      const dir = join(this.root, s.id);
      if (!existsSync(join(dir, 'package.json'))) throw new Error(`${s.id}: folder ${dir} is missing; clone github.com/alitalipcalikoglu/${s.id} next to the others`);
      if (install || !existsSync(join(dir, 'node_modules'))) {
        this.log(`${s.id}: npm ci`);
        await this.#run(dir, ['npm', 'ci', '--no-audit', '--no-fund']);
      }
    }
    const ctx = new SetupContext({ root: this.root, host, local, run: (id, argv) => this.#run(join(this.root, id), argv), log: this.log });
    await ctx.compute();
    ctx.save((path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); this.log(`wrote ${path.replace(`${this.root}/`, '')}`); });
    const admin = await this.#firstAdmin(adminEmail, adminPassword);
    return { services: SERVICES.map((s) => ({ id: s.id, url: ctx.url(s.id) })), admin };
  }

  /**
   * Start everything under PM2 (installed globally) in manifest order.
   * @param {{ splitWorkers?: boolean }} [o]
   *   `splitWorkers`: for every service that ships a split template (`Service#splitWorkers` —
   *   notify, scheduler, webhook-out today), start `<id>-api` + `<id>-worker` instead of the
   *   single combined app, via a freshly generated (never committed) ecosystem file — see
   *   {@link Stack#generateSplitEcosystem}. Every other service is unaffected either way.
   */
  async up({ splitWorkers = false } = {}) {
    await this.#requirePm2();
    for (const s of SERVICES) {
      const dir = join(this.root, s.id);
      const file = splitWorkers && s.splitWorkers ? this.generateSplitEcosystem(s) : 'ecosystem.config.cjs';
      this.log(`${s.id}: pm2 startOrRestart ${file}`);
      await this.#run(dir, ['pm2', 'startOrRestart', file, '--silent']);
    }
    await this.#run(this.root, ['pm2', 'save', '--silent']).catch(() => {});
    return this.status();
  }

  /** @param {{ splitWorkers?: boolean }} [o] */
  async down({ splitWorkers = false } = {}) {
    await this.#requirePm2();
    for (const s of [...SERVICES].reverse()) {
      const names = splitWorkers && s.splitWorkers ? [`${s.id}-api`, `${s.id}-worker`] : [s.id];
      for (const name of names) await this.#run(this.root, ['pm2', 'delete', name, '--silent']).catch(() => {});
    }
    await this.#run(this.root, ['pm2', 'save', '--silent', '--force']).catch(() => {});
  }

  /**
   * Writes `<service>/ecosystem.split.generated.cjs` — two PM2 apps, `<id>-api` and `<id>-worker`,
   * running the service's own real `src/api-main.js`/`src/worker-main.js` entry points (Stage 6;
   * no new runtime code). Everything that isn't the script path and app name is read straight from
   * the service's own committed, already-shutdown-budget-validated `ecosystem.config.cjs` — the
   * combined app's `kill_timeout` (derived there from the service's real config ceilings) is reused
   * verbatim for `<id>-worker`, so this generator can never drift from that derivation or invent its
   * own. `<id>-api` gets a fixed, deliberately small `kill_timeout` (HTTP-only shutdown, no delivery
   * or send in flight there) matching the same constant already used in every service's own
   * commented-out split template. Never committed (the service's own `.gitignore` excludes the
   * generated filename); regenerated on every `stack up --split-workers`, so it is always
   * consistent with the currently checked-out `ecosystem.config.cjs`, never a stale copy.
   * @param {import('./manifest.js').Service} s
   * @returns {string} the generated file's name, relative to the service directory
   */
  generateSplitEcosystem(s) {
    const dir = join(this.root, s.id);
    const combinedPath = join(dir, 'ecosystem.config.cjs');
    const req = createRequire(pathToFileURL(join(dir, 'package.json')).href);
    delete req.cache[req.resolve(combinedPath)]; // always re-read the file currently on disk, never a stale require() cache entry
    const combined = /** @type {{ apps: any[] }} */ (req(combinedPath)).apps[0];
    const app = (/** @type {string} */ name, /** @type {string} */ script, /** @type {object} */ extra) => ({
      name, cwd: '__dirname', script,
      node_args: combined.node_args, exec_mode: 'fork', instances: 1,
      autorestart: true, exp_backoff_restart_delay: 200, max_restarts: 20, max_memory_restart: combined.max_memory_restart,
      wait_ready: true, merge_logs: true, env: { NODE_ENV: 'production' }, ...extra,
    });
    const apps = [
      app(`${s.id}-api`, 'src/api-main.js', { listen_timeout: 10_000, kill_timeout: Stack.SPLIT_API_KILL_TIMEOUT_MS }),
      app(`${s.id}-worker`, 'src/worker-main.js', { kill_timeout: combined.kill_timeout }),
    ];
    const text = `// Generated by "stack up --split-workers" from this service's own ecosystem.config.cjs — do not\n`
      + `// edit or commit (see .gitignore); regenerate any time by running that command again. The\n`
      + `// worker app's kill_timeout (${combined.kill_timeout}ms) is copied verbatim from the combined app\n`
      + `// in ecosystem.config.cjs, not re-derived here, so it can never drift from that file's own\n`
      + `// shutdown-budget reasoning.\n`
      + `module.exports = ${JSON.stringify({ apps }, null, 2).replace(/"__dirname"/g, '__dirname')};\n`;
    const outPath = join(dir, Stack.SPLIT_ECOSYSTEM_FILE);
    writeFileSync(outPath, text);
    return Stack.SPLIT_ECOSYSTEM_FILE;
  }

  /** Run every service in the foreground with prefixed logs; Ctrl-C stops all. Resolves when all exit. */
  async dev() {
    /** @type {import('node:child_process').ChildProcess[]} */
    const children = [];
    const stop = () => { for (const c of children) c.kill('SIGTERM'); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    for (const s of SERVICES) {
      const dir = join(this.root, s.id);
      if (!existsSync(join(dir, '.env'))) throw new Error(`${s.id}: no .env; run setup first`);
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', `--env-file=${join(dir, '.env')}`, 'src/index.js'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      const tag = s.id.padEnd(11);
      const pipe = (/** @type {import('node:stream').Readable|null} */ stream) => stream?.on('data', (d) => { for (const line of String(d).split('\n')) if (line) this.log(`${tag} ${Stack.pretty(line)}`); });
      pipe(child.stdout); pipe(child.stderr);
      child.on('exit', (code) => this.log(`${tag} exited (${code})`));
      children.push(child);
    }
    const ready = await this.#waitReady(20_000);
    this.log('');
    for (const r of ready) this.log(`${r.id.padEnd(11)} ${r.ok ? 'ready' : 'NOT READY'}  ${r.url}`);
    this.log(`\nconsole: ${SetupContext.service('console') && this.#url('console')}`);
    await Promise.all(children.map((c) => new Promise((resolve) => c.on('exit', resolve))));
  }

  /** Health and readiness of every service. */
  async status() {
    const rows = [];
    for (const s of SERVICES) {
      const url = this.#url(s.id);
      const health = await this.#probe(`${url}/health`);
      const ready = await this.#probe(`${url}/ready`);
      rows.push({ id: s.id, url, health, ready, ok: health === 200 && ready === 200 });
    }
    for (const r of rows) this.log(`${r.id.padEnd(11)} ${r.ok ? 'ok  ' : 'DOWN'}  health=${r.health ?? '-'} ready=${r.ready ?? '-'}  ${r.url}`);
    return rows;
  }

  /**
   * Stage 7: version/contract matrix across every service, read from each one's own `/v1/info` —
   * an operator visibility tool, never a runtime coupling mechanism (per plan: NO STARTUP CHECK,
   * services with different `serviceCore` majors must keep starting and serving traffic
   * unaffected by this command; it only ever reads and reports).
   *
   * Reachability (`/health`+`/ready`) and the `/v1/info` fetch are independent and both fully
   * tolerant of failure per service: one unreachable, too-old (no `/v1/info` route yet, 404) or
   * malformed (non-JSON, or JSON that isn't an object) service never aborts the whole command or
   * throws — that row just carries `infoOk: false` and a human-readable `infoError`, every other
   * row still reports normally. Every `/v1/info` field is read defensively (wrong type / missing
   * -> `null`, matching the console About view's tolerance), so an older or partial contract shape
   * degrades to `null`s instead of a crash — a real mixed-version rollout must be able to run this
   * safely mid-migration.
   * @returns {Promise<MatrixRow[]>}
   */
  async matrix() {
    /** @type {MatrixRow[]} */
    const rows = [];
    for (const s of SERVICES) {
      const url = this.#url(s.id);
      const health = await this.#probe(`${url}/health`);
      const ready = await this.#probe(`${url}/ready`);
      const info = await this.#info(url);
      rows.push({ id: s.id, url, ok: health === 200 && ready === 200, ...info });
    }
    this.#printMatrix(rows);
    return rows;
  }

  /**
   * Tolerant `GET <url>/v1/info`: network failure, non-2xx (including a 404 from a service that
   * hasn't adopted the route yet), non-JSON body, or a JSON body that isn't an object all become
   * `{ infoOk: false, infoError }` rather than a thrown error. On success, each contract field is
   * read defensively — present but wrong-typed (or simply absent, an older/partial contract) reads
   * as `null`/`[]`, never crashes the caller.
   * @param {string} url
   * @returns {Promise<{ infoOk: true, version: string|null, apiVersion: string|null, schemaVersion: number|null, serviceCore: string|null, capabilities: string[] } | { infoOk: false, infoError: string }>}
   */
  async #info(url) {
    /** @type {Response} */
    let res;
    try {
      res = await this.fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(3_000) });
    } catch (err) {
      return { infoOk: false, infoError: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) return { infoOk: false, infoError: res.status === 404 ? 'no /v1/info (older version)' : `responded ${res.status}` };
    /** @type {any} */
    let body;
    try {
      body = await res.json();
    } catch {
      return { infoOk: false, infoError: 'malformed /v1/info response (not JSON)' };
    }
    if (!body || typeof body !== 'object') return { infoOk: false, infoError: 'malformed /v1/info response (not an object)' };
    return {
      infoOk: true,
      version: typeof body.version === 'string' ? body.version : null,
      apiVersion: typeof body.apiVersion === 'string' ? body.apiVersion : null,
      schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : null,
      serviceCore: typeof body.serviceCore === 'string' ? body.serviceCore : null,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((/** @type {unknown} */ c) => typeof c === 'string') : [],
    };
  }

  /** @param {MatrixRow[]} rows */
  #printMatrix(rows) {
    const col = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
    this.log([col('SERVICE', 13), col('STATUS', 6), col('VERSION', 9), col('API', 5), col('SCHEMA', 7), col('SERVICE-CORE', 14), 'CAPABILITIES'].join(''));
    for (const r of rows) {
      const status = r.ok ? 'ok' : 'DOWN';
      const version = r.infoOk ? (r.version ?? '-') : '?';
      const api = r.infoOk ? (r.apiVersion ?? '-') : '?';
      const schema = r.infoOk ? String(r.schemaVersion ?? '-') : '?';
      const core = r.infoOk ? (r.serviceCore ?? '-') : '?';
      const caps = r.infoOk ? (r.capabilities.length ? r.capabilities.join(',') : '-') : `(${r.infoError})`;
      this.log([col(r.id, 13), col(status, 6), col(version, 9), col(api, 5), col(schema, 7), col(core, 14), caps].join(''));
    }
    /** @type {Map<string, string[]>} */
    const majors = new Map();
    for (const r of rows) {
      if (!r.infoOk || !r.serviceCore) continue;
      const major = r.serviceCore.split('.')[0];
      majors.set(major, [...(majors.get(major) ?? []), r.id]);
    }
    if (majors.size > 1) {
      this.log(`\n⚠ serviceCore major version mismatch across services (informational only — no service refuses to start or serve traffic over this): ${[...majors.entries()].map(([m, ids]) => `v${m}.x: ${ids.join(', ')}`).join('  |  ')}`);
    }
  }

  /**
   * Snapshot every stateful service's database plus the non-database state a database restore
   * alone cannot reconstruct (media's blob storage, auth's JWT keys, gateway's routes.json,
   * console's services.json). Safe to run against a live stack — no service is stopped.
   * @param {{ dir?: string }} [o]
   */
  async backup({ dir } = {}) {
    const snapshot = new Snapshot({ root: this.root, exec: this.exec, log: this.log });
    const { dir: written, manifest } = await snapshot.create({ dir });
    this.log(`backup written to ${written} (${manifest.entries.length} items)`);
    return { dir: written, manifest };
  }

  /**
   * Restore a snapshot written by {@link backup}. Stops the affected services under PM2, restores
   * their files (validated before anything is touched, and reverted as a whole if any item fails
   * partway — see {@link Snapshot.restore}), then:
   * - `restored`: starts every affected service on the new snapshot and waits for `/ready`.
   * - `rolled_back`: the restore failed but every item is confirmed back at its original state —
   *   starts every affected service on that original state (safe: it's what was running before this
   *   call) and throws, so the caller still sees this as a failed restore.
   * - `rollback_incomplete`: the restore failed AND reverting at least one item also failed. Nothing
   *   is started — a stopped service is safer than one started against a file in an unknown state.
   *   Throws with every affected item's exact state (`rolledBack` vs `rollbackFailed`) for the
   *   operator to check by hand before starting anything.
   * @param {string} dir
   * @param {{ service?: string }} [o] Restrict to one service; default every service the snapshot covers.
   */
  async restore(dir, { service } = {}) {
    await this.#requirePm2();
    const snapshot = new Snapshot({ root: this.root, exec: this.exec, log: this.log });
    const services = service ? [service] : undefined;
    const manifest = /** @type {{ entries: { service: string }[] }} */ (JSON.parse(readFileSync(join(resolve(dir), 'manifest.json'), 'utf8')));
    const ids = services ?? [...new Set(manifest.entries.map((e) => e.service))];
    for (const id of ids) { this.log(`${id}: pm2 stop`); await this.#run(this.root, ['pm2', 'stop', id, '--silent']).catch(() => {}); }
    const result = await snapshot.restore(dir, { services });

    if (result.outcome === 'rollback_incomplete') {
      this.log(`\nCRITICAL: restore failed and rollback did not fully succeed. Nothing was restarted.`);
      this.log(`confirmed reverted to original: ${result.rolledBack.join(', ') || 'none'}`);
      this.log(`UNKNOWN STATE, needs manual inspection: ${result.rollbackFailed.map((r) => `${r.service}/${r.path} (${r.error})`).join(', ')}`);
      throw new Error(`restore failed and rollback is incomplete for: ${result.rollbackFailed.map((r) => `${r.service}/${r.path}`).join(', ')} — services left stopped, inspect .before-restore-${result.runId} copies before starting anything`);
    }

    for (const id of ids) { this.log(`${id}: pm2 start`); await this.#run(this.root, ['pm2', 'start', id, '--silent']).catch(() => {}); }
    const ready = await this.#waitReady(20_000, ids);
    for (const r of ready) this.log(`${r.id.padEnd(11)} ${r.ok ? 'ready' : 'NOT READY'}  ${r.url}`);

    if (result.outcome === 'rolled_back') {
      throw new Error(`restore failed at ${result.failed?.service}/${result.failed?.path} (${result.failed?.phase}): ${result.failed?.error} — rolled back cleanly, every service restarted on its original data`);
    }
    return result;
  }

  /** @param {string} id */
  #url(id) {
    const env = EnvFile.load(join(this.root, id, '.env'));
    return `http://${env.get('HOST') === '0.0.0.0' ? '127.0.0.1' : env.get('HOST')}:${env.get('PORT')}`;
  }

  /** @param {string} url */
  async #probe(url) {
    try {
      const res = await this.fetch(url, { signal: AbortSignal.timeout(3_000) });
      return res.status;
    } catch {
      return null;
    }
  }

  /** @param {number} timeoutMs @param {string[]} [ids] Restrict to these service ids; default every service. */
  async #waitReady(timeoutMs, ids) {
    const deadline = Date.now() + timeoutMs;
    const pending = new Set(ids ?? SERVICES.map((s) => s.id));
    /** @type {{ id: string, url: string, ok: boolean }[]} */
    const out = [];
    while (pending.size && Date.now() < deadline) {
      for (const id of pending) {
        const url = this.#url(id);
        if (await this.#probe(`${url}/ready`) === 200) { pending.delete(id); out.push({ id, url, ok: true }); }
      }
      if (pending.size) await new Promise((r) => setTimeout(r, 500));
    }
    for (const id of pending) out.push({ id, url: this.#url(id), ok: false });
    return out.sort((a, b) => SERVICES.findIndex((s) => s.id === a.id) - SERVICES.findIndex((s) => s.id === b.id));
  }

  /**
   * Create the console's first administrator when none exists, using the console's own classes.
   * @param {string} email
   * @param {string|undefined} password
   */
  async #firstAdmin(email, password) {
    const dir = join(this.root, 'console');
    const env = EnvFile.load(join(dir, '.env'));
    const dbPath = join(dir, env.get('DB_PATH') || './data/console.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const mod = (/** @type {string} */ rel) => import(pathToFileURL(join(dir, rel)).href);
    const [{ Database }, { AdminStore }, { SessionStore }, { AuditStore }, { PasswordHasher }, { AdminService }] = await Promise.all([
      mod('src/db.js'), mod('src/store/admin-store.js'), mod('src/store/session-store.js'), mod('src/store/audit-store.js'), mod('src/crypto/password.js'), mod('src/domain/admin-service.js'),
    ]);
    const db = new Database(dbPath);
    try {
      const admins = new AdminStore(db);
      if (admins.byEmail(email) || admins.count?.() > 0 || admins.list?.().length) return { email, password: null, created: false };
      const generated = password ?? Stack.password();
      const service = new AdminService({ admins, sessions: new SessionStore(db), audit: new AuditStore(db), hasher: new PasswordHasher({ logN: Number(env.get('SCRYPT_LOG_N') || 15) }) });
      await service.create({ email, name: 'Administrator', password: generated, role: 'admin' }, null, { ip: null, userAgent: 'stack' });
      return { email, password: generated, created: true };
    } finally {
      db.close();
    }
  }

  async #requirePm2() {
    const r = await this.exec(this.root, ['pm2', '--version'], { stdio: 'pipe' }).catch(() => ({ code: 1, out: '' }));
    if (r.code !== 0) throw new Error('pm2 is not installed; run "npm i -g pm2", or use "dev" to run everything in this terminal');
  }

  /** @param {string} cwd @param {string[]} argv */
  async #run(cwd, argv) {
    const r = await this.exec(cwd, argv);
    if (r.code !== 0) throw new Error(`${argv.join(' ')} failed in ${cwd} (exit ${r.code})`);
  }

  /** Generated split-deployment ecosystem filename, relative to a service's own directory. */
  static SPLIT_ECOSYSTEM_FILE = 'ecosystem.split.generated.cjs';

  /**
   * `<id>-api`'s kill_timeout: fixed and small because an HTTP-only replica never has a delivery,
   * send or run in flight to drain — matches the constant already hand-written in every split-
   * capable service's own commented-out template (notify/scheduler/webhook-out `ecosystem.config.cjs`).
   */
  static SPLIT_API_KILL_TIMEOUT_MS = 15_000;

  /** Readable, URL-safe password: 4 groups of 5 base62 characters. */
  static password() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(20);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
    return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
  }

  /** Turn a pino JSON line into `level msg` when it is one. @param {string} line */
  static pretty(line) {
    try {
      const j = JSON.parse(line);
      /** @type {Record<number, string>} */ const levels = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
      if (typeof j.level === 'number' && j.msg) return `${levels[j.level] ?? j.level} ${j.msg}${j.err?.message ? `: ${j.err.message}` : ''}`;
    } catch { /* not JSON */ }
    return line;
  }

  /**
   * @param {string} cwd
   * @param {string[]} argv
   * @param {{ stdio?: 'inherit'|'pipe' }} [opts]
   * @returns {Promise<{ code: number, out: string }>}
   */
  static exec(cwd, argv, { stdio = 'inherit' } = {}) {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = argv;
      const child = spawn(cmd, args, { cwd, stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: process.platform === 'win32' });
      let out = '';
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? 1, out }));
    });
  }
}
