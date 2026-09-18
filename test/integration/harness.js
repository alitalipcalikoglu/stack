import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Spawns real service processes from the workspace (not mocks, not in-process fakes) for
 * cross-service integration tests: each service runs as its own `node` child process, exactly as
 * it would in production, wired together over real HTTP on ephemeral localhost ports with
 * generated env. Everything here talks to a service only the way another service would: over the
 * wire, through its public `/v1` API and `/health`/`/ready` probes.
 */

/** An OS-assigned free TCP port on localhost, released immediately so a child process can bind it. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** @param {number} [bytes] */
export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString('hex'); // 48 hex chars, comfortably over every service's 32-char minimum
}

/** One line of a service's stdout/stderr, parsed as JSON when it is (pino's default format), kept raw otherwise. */
export class LogLine {
  /** @param {string} raw @param {'stdout'|'stderr'} stream */
  constructor(raw, stream) {
    this.raw = raw;
    this.stream = stream;
    /** @type {Record<string, unknown>|null} */
    this.json = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.json = parsed;
    } catch {
      // Not every line is JSON (a stack trace, a stray console.log); keep it as raw text.
    }
  }
}

/** A running service under test: the real `node` process, its captured log lines, and its base URL. */
export class ServiceProcess {
  /**
   * @param {object} o
   * @param {string} o.name          For error messages and log filtering, not passed to the child.
   * @param {string} o.cwd           The service's repository root (e.g. `<workspace>/auth`).
   * @param {string} o.entry         Entry file relative to `cwd`, e.g. `src/index.js`.
   * @param {Record<string, string>} o.env  Full environment for the child (nothing is inherited
   *   beyond what Node itself needs; callers pass everything the service's Config requires).
   * @param {number} o.port          Must match `env.PORT`; used to build `baseUrl` and poll `/ready`.
   */
  constructor({ name, cwd, entry, env, port }) {
    this.name = name;
    this.cwd = cwd;
    this.entry = entry;
    this.env = env;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    /** @type {LogLine[]} */
    this.lines = [];
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
  }

  /**
   * Starts the process and waits for `GET /ready` to answer 200, polling every `pollMs`.
   * Rejects (and leaves the process for inspection) if it exits early or never becomes ready.
   * @param {{ timeoutMs?: number, pollMs?: number }} [o]
   */
  async start({ timeoutMs = 20_000, pollMs = 150 } = {}) {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', this.entry], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    /** @type {Error|null} */
    let exitError = null;
    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) exitError = new Error(`${this.name} exited early with code ${code}${signal ? ` (${signal})` : ''}`);
    });
    for (const [stream, key] of /** @type {const} */ ([[child.stdout, 'stdout'], [child.stderr, 'stderr']])) {
      let buf = '';
      stream?.on('data', (/** @type {Buffer} */ chunk) => {
        buf += chunk.toString('utf8');
        const parts = buf.split('\n');
        buf = /** @type {string} */ (parts.pop());
        for (const line of parts) if (line) this.lines.push(new LogLine(line, key));
      });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitError) throw exitError;
      try {
        const res = await fetch(`${this.baseUrl}/ready`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) { await res.body?.cancel(); return this; }
        await res.body?.cancel();
      } catch {
        // Not listening yet, or /ready itself failing (e.g. a dependency not up yet); keep polling.
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`${this.name} did not become ready within ${timeoutMs}ms. Last lines:\n${this.lines.slice(-20).map((l) => l.raw).join('\n')}`);
  }

  /** SIGTERM, then SIGKILL after `graceMs` if it hasn't exited. Resolves once the process is gone. */
  async stop(graceMs = 5_000) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
    });
  }

  /**
   * The most recent parsed JSON log line matching `predicate`, or `undefined`. Use to assert what
   * a service actually logged (its `reqId`, `traceId`, an access-log entry, …) rather than
   * inferring it from the HTTP response alone.
   * @param {(fields: Record<string, unknown>) => boolean} predicate
   */
  findLog(predicate) {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      if (l.json && predicate(l.json)) return l.json;
    }
    return undefined;
  }
}

/**
 * Stops every process in `services`, in parallel, swallowing individual errors so one failure doesn't hide the others.
 * @param {ServiceProcess[]} services
 */
export async function stopAll(services) {
  await Promise.all(services.map((s) => s.stop().catch(() => {})));
}

/**
 * Polls `check()` until it returns a truthy value or `timeoutMs` elapses. Bounded replacement for
 * sleep-driven assertions: every asynchronous recovery in Stage 11 (retry, reclaim, exhaustion,
 * flush) waits through this instead of a fixed `setTimeout`, so tests are only as slow as the real
 * recovery takes and never hang forever.
 * @template T
 * @param {() => Promise<T> | T} check
 * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [o]
 * @returns {Promise<T>} the first truthy result
 */
export async function waitUntil(check, { timeoutMs = 5_000, intervalMs = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = /** @type {T} */ (undefined);
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Builds an "N-1" fixture database using the real service's own `Database` subclass with its last
 * migration held back — real migration SQL, real schema, just one version short of current. This
 * is the one shared way every migration-lifecycle integration test (concurrent-startup race,
 * single-process HTTP E2E) produces an "old schema" fixture, so none of them re-implement a
 * service's migration SQL as a second, parallel definition.
 *
 * Returns the fixture database OPEN so the caller can seed real pre-migration domain data into it
 * (via direct SQL matching that old schema's actual columns — a service's current domain Store
 * classes are written against the CURRENT schema and will fail to prepare against a deliberately
 * held-back one) before closing it and handing the file to a real service process.
 * @param {string} workspaceRoot @param {string} serviceId @param {string} dbPath
 * @returns {Promise<{ db: any, fullMigrationCount: number }>}
 */
export async function openOldFixtureDb(workspaceRoot, serviceId, dbPath) {
  const mod = await import(pathToFileURL(join(workspaceRoot, serviceId, 'src', 'db.js')).href);
  /** @type {{ new (path: string): any, MIGRATIONS: readonly string[] }} */
  const RealDb = mod.Database;
  const full = RealDb.MIGRATIONS;
  if (full.length < 2) throw new Error(`${serviceId}: needs at least 2 real migrations for a meaningful "one behind" fixture, has ${full.length}`);
  /** @type {any} */
  const OldDb = class extends /** @type {any} */ (RealDb) {
    static MIGRATIONS = full.slice(0, -1);
  };
  const db = new OldDb(dbPath);
  return { db, fullMigrationCount: full.length };
}
