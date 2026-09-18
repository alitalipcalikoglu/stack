// Service-client registry: the ONLY place stack-mcp constructs a typed client. No business
// semantics live here -- base URL + credential injection + a default request timeout, nothing else.
// Every service call goes: MCP tool -> this registry's client -> the service's real HTTP API. No
// direct DB access, no sibling `src/` import, no hand-rolled fetch of a service's endpoints.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfigured, missingConfigReason } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS_ROOT = path.resolve(HERE, '..', '..', 'clients', 'typescript');

export class ServiceUnavailableError extends Error {
  /** @param {string} service @param {string} reason */
  constructor(service, reason) {
    super(`${service} is not available: ${reason}`);
    this.service = service;
  }
}

/** A request-scoped fetch that applies the registry's default timeout unless the caller already passed a signal. */
/** @param {number} timeoutMs */
function timeoutFetch(timeoutMs) {
  return (/** @type {string | URL | Request} */ url, /** @type {RequestInit} */ init = {}) => {
    if (init.signal) return fetch(url, init);
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };
}

export class ServiceRegistry {
  /** @param {ReturnType<typeof import('./config.mjs').loadConfig>} config */
  constructor(config) {
    this.config = config;
    /** @type {Map<string, unknown>} */
    this.clients = new Map();
  }

  /**
   * Returns a ready-to-call typed client for `service`, or throws ServiceUnavailableError with a
   * safe, specific (never secret-bearing) reason if it isn't configured.
   * @param {string} service
   */
  async client(service) {
    if (!isConfigured(this.config, service)) {
      throw new ServiceUnavailableError(service, missingConfigReason(this.config, service) ?? 'not configured');
    }
    if (this.clients.has(service)) return this.clients.get(service);

    const { createClient } = await import(`file://${path.join(CLIENTS_ROOT, service, 'index.ts')}`);
    const { baseUrl, apiKey } = this.config.services[service];
    const client = createClient({
      baseUrl,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      fetch: timeoutFetch(this.config.timeoutMs),
    });
    this.clients.set(service, client);
    return client;
  }

  /**
   * A client usable for the always-public operational probes (health/ready/info) even when no API
   * key is configured for this service -- those three routes are unauthenticated on every service
   * (confirmed in the Phase 0/1 audits), so stack.status only ever needs a base URL, never a key.
   * @param {string} service
   */
  async probeClient(service) {
    const s = this.config.services[service];
    if (!s?.baseUrl) throw new ServiceUnavailableError(service, `STACK_MCP_${service.toUpperCase().replace(/-/g, '_')}_BASE_URL is not set`);
    const cacheKey = `probe:${service}`;
    if (this.clients.has(cacheKey)) return this.clients.get(cacheKey);
    const { createClient } = await import(`file://${path.join(CLIENTS_ROOT, service, 'index.ts')}`);
    const client = createClient({ baseUrl: s.baseUrl, fetch: timeoutFetch(this.config.timeoutMs) });
    this.clients.set(cacheKey, client);
    return client;
  }
}
