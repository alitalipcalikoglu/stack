import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvFile } from './env-file.js';
import { SERVICES } from './manifest.js';
import { SetupContext } from './setup-context.js';
import { Snapshot } from './snapshot.js';

/**
 * The commands: `setup` (dependencies, secrets, keys, env files, routes, console build, first
 * admin), `up`/`down` (PM2), `dev` (foreground, all processes, one terminal), `status`.
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

  /** Start everything under PM2 (installed globally) in manifest order. */
  async up() {
    await this.#requirePm2();
    for (const s of SERVICES) {
      this.log(`${s.id}: pm2 startOrRestart`);
      await this.#run(join(this.root, s.id), ['pm2', 'startOrRestart', 'ecosystem.config.cjs', '--silent']);
    }
    await this.#run(this.root, ['pm2', 'save', '--silent']).catch(() => {});
    return this.status();
  }

  async down() {
    await this.#requirePm2();
    for (const s of [...SERVICES].reverse()) await this.#run(this.root, ['pm2', 'delete', s.id, '--silent']).catch(() => {});
    await this.#run(this.root, ['pm2', 'save', '--silent', '--force']).catch(() => {});
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
   * their files (validated before anything is touched — see {@link Snapshot.restore}), starts them
   * again, and waits for `/ready`. Refuses (via `Snapshot.restore`) before stopping anything when
   * the snapshot is missing, corrupt, or newer than what the running code supports.
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
    for (const id of ids) { this.log(`${id}: pm2 start`); await this.#run(this.root, ['pm2', 'start', id, '--silent']).catch(() => {}); }
    const ready = await this.#waitReady(20_000, ids);
    for (const r of ready) this.log(`${r.id.padEnd(11)} ${r.ok ? 'ready' : 'NOT READY'}  ${r.url}`);
    if (result.failed) throw new Error(`restore failed at ${result.failed.service}: ${result.failed.error} (restored: ${result.restored.join(', ') || 'none'}; skipped: ${result.skipped.join(', ') || 'none'})`);
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
