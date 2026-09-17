import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvFile } from './env-file.js';
import { CONSOLE_ROLES, SERVICES } from './manifest.js';

/**
 * State shared by every service's `env()` during one setup: the in-memory `.env` of each service
 * (loaded from `.env` when it exists, else from `.env.example`), secret generation that keeps
 * existing values, and key issuing between services. Nothing touches disk until `save()`.
 */
export class SetupContext {
  /**
   * @param {object} o
   * @param {string} o.root                 Workspace root holding one folder per service.
   * @param {string} o.host                 Host the services bind and reach each other on.
   * @param {boolean} o.local               Local stack: plain HTTP, private addresses allowed, insecure cookies.
   * @param {(id: string, argv: string[]) => Promise<void>} o.run  Runs a command inside a service folder.
   * @param {(line: string) => void} [o.log]
   */
  constructor({ root, host, local, run, log = () => {} }) {
    this.root = root;
    this.host = host;
    this.local = local;
    this.runner = run;
    this.log = log;
    /** @type {Map<string, EnvFile>} */
    this.envs = new Map();
    /** @type {Map<string, Record<string, string>>} */
    this.files = new Map();
  }

  /** @param {string} id */
  dir(id) {
    return join(this.root, id);
  }

  /** @param {string} id @param {string} rel */
  exists(id, rel) {
    return existsSync(join(this.dir(id), rel));
  }

  /** @param {string} id @param {string[]} argv */
  run(id, argv) {
    this.log(`${id}: ${argv.join(' ')}`);
    return this.runner(id, argv);
  }

  /** @param {string} id */
  env(id) {
    let e = this.envs.get(id);
    if (!e) {
      const dir = this.dir(id);
      const own = join(dir, '.env');
      const example = join(dir, '.env.example');
      if (existsSync(own)) e = EnvFile.load(own);
      else if (existsSync(example)) e = EnvFile.load(example);
      else throw new Error(`${id}: neither .env nor .env.example found in ${dir}`);
      this.envs.set(id, e);
    }
    return e;
  }

  /** @param {string} id */
  url(id) {
    return `http://${this.host}:${SetupContext.port(id)}`;
  }

  /** Public origin of a service: a local stack has no reverse proxy, so it is the service itself. @param {string} id */
  publicUrl(id) {
    const cur = this.env(id).get('PUBLIC_BASE_URL');
    return this.local || !cur || /example\.com/.test(cur) ? this.url(id) : cur;
  }

  /** Keep a value the operator already set; otherwise use the fallback. @param {string} id @param {string} name @param {string} fallback */
  keep(id, name, fallback) {
    const e = this.env(id);
    return e.needs(name) || /example\.(com|internal)/.test(e.get(name) ?? '') ? fallback : /** @type {string} */ (e.get(name));
  }

  /** A 64-hex secret, generated once and kept on later runs. @param {string} id @param {string} name */
  secret(id, name) {
    const e = this.env(id);
    if (e.needs(name)) e.set(name, randomBytes(32).toString('hex'));
    return /** @type {string} */ (e.get(name));
  }

  /**
   * The secret `holder` uses to call `issuer`: found in the issuer's key list, or generated and
   * appended as `holder:secret[:role]`. Placeholder entries from the template are dropped.
   * @param {string} issuer
   * @param {string} holder
   * @param {string} [role]
   */
  issue(issuer, holder, role) {
    const service = SetupContext.service(issuer);
    if (!service.keysVar) throw new Error(`${issuer} issues no API keys`);
    const e = this.env(issuer);
    const entries = (e.get(service.keysVar) ?? '').split(',').map((s) => s.trim()).filter((s) => s && !EnvFile.PLACEHOLDER.test(s.split(':')[1] ?? ''));
    const at = entries.findIndex((s) => s.split(':')[0] === holder);
    let entry = at >= 0 ? entries[at] : null;
    if (entry && (entry.split(':')[2] ?? '') !== (role ?? '')) {
      // The manifest asks for another role than the one issued earlier: keep the secret, update the role.
      entry = [holder, entry.split(':')[1], ...(role ? [role] : [])].join(':');
      entries[at] = entry;
      e.set(service.keysVar, entries.join(','));
    } else if (!entry) {
      entry = [holder, randomBytes(32).toString('hex'), ...(role ? [role] : [])].join(':');
      entries.push(entry);
      e.set(service.keysVar, entries.join(','));
    }
    return entry.split(':')[1];
  }

  /**
   * Outbound-call settings for services that call others: on a local stack, plain HTTP to loopback;
   * on a server the operator's values (or the secure template defaults) stay.
   * @param {string} id
   * @returns {Record<string, string>}
   */
  outbound(id) {
    if (!this.local) return {};
    void id;
    return { TARGET_ALLOW_HTTP: 'true', TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: `${this.host},localhost` };
  }

  consoleServices() {
    return SERVICES.filter((s) => s.console);
  }

  /** @param {string} id */
  consoleRole(id) {
    return CONSOLE_ROLES[id];
  }

  consoleServicesJson() {
    return {
      services: this.consoleServices().map((s) => {
        const c = /** @type {NonNullable<import('./manifest.js').Service['console']>} */ (s.console);
        return { id: s.id, type: c.type, label: c.label, url: this.url(s.id), ...(c.keyEnv ? { apiKeyEnv: c.keyEnv } : {}), ...(c.metricsTokenEnv ? { metricsTokenEnv: c.metricsTokenEnv } : {}), ...(c.polling ? { polling: c.polling } : {}) };
      }),
    };
  }

  /** Gateway routes for a local stack: auth, media and JWKS through the gateway; nothing else. */
  gatewayRoutes() {
    const existing = join(this.dir('gateway'), 'routes.json');
    if (existsSync(existing) && !this.local) return JSON.parse(readFileSync(existing, 'utf8'));
    return {
      jwt: { jwksUrl: `${this.url('auth')}/.well-known/jwks.json`, issuer: this.url('gateway'), audience: this.env('auth').get('JWT_AUDIENCE') || 'app' },
      routes: [
        { id: 'auth-public', pathPrefix: '/api/auth/', stripPrefix: '/api/auth', upstreams: [this.url('auth')], methods: ['POST', 'OPTIONS'], injectApiKey: 'AUTH_API_KEY', cors: ['*'], rateLimit: 60, bodyLimit: 16384 },
        { id: 'media-user', pathPrefix: '/api/media/', stripPrefix: '/api/media', upstreams: [this.url('media')], auth: 'user', injectApiKey: 'MEDIA_API_KEY', cors: ['*'], bodyLimit: 26214400, timeoutMs: 120000 },
        { id: 'media-files', pathPrefix: '/files/', upstreams: [this.url('media')], methods: ['GET', 'HEAD', 'OPTIONS'], cors: ['*'], rateLimit: 1200, timeoutMs: 120000 },
        { id: 'jwks', pathPrefix: '/.well-known/jwks.json', upstreams: [this.url('auth')], methods: ['GET', 'HEAD'] },
      ],
    };
  }

  /** Compute every service's env and files (in manifest order, so issuers exist before holders). */
  async compute() {
    for (const s of SERVICES) await s.prepare?.(this);
    for (const s of SERVICES) {
      const e = this.env(s.id);
      e.set('PORT', String(s.port)).set('HOST', this.host);
      for (const [k, v] of Object.entries(s.env(this))) e.set(k, v);
      if (s.files) this.files.set(s.id, s.files(this));
    }
    return this;
  }

  /** Write every `.env` and extra file. @param {(path: string, text: string) => void} write */
  save(write) {
    for (const [id, e] of this.envs) write(join(this.dir(id), '.env'), e.toString());
    for (const [id, files] of this.files) for (const [rel, text] of Object.entries(files)) write(join(this.dir(id), rel), text);
  }

  /** @param {string} id */
  static service(id) {
    const s = SERVICES.find((x) => x.id === id);
    if (!s) throw new Error(`unknown service "${id}"`);
    return s;
  }

  /** @param {string} id */
  static port(id) {
    return SetupContext.service(id).port;
  }
}
