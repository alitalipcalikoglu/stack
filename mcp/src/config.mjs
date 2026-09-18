// Explicit, deterministic MCP configuration. Nothing is auto-discovered: every base URL and
// credential comes from an env var named exactly `STACK_MCP_<SERVICE>_...`. A service with no
// base URL configured is simply not available -- tools that need it fail with a clear, specific
// config error naming exactly what's missing; stack.status silently omits it from the aggregate
// (see server.mjs's per-service try/catch there). No value here is ever logged, echoed in an
// error, or included in any tool output -- see redact() below and errors.mjs's translation layer.

/** @typedef {{ timeoutMs: number, services: Record<string, { baseUrl: string|null, apiKey: string|null }> }} Config */

export const SERVICES = [
  'gateway', 'notify', 'auth', 'media', 'console', 'audit', 'shortlink',
  'flags', 'scheduler', 'webhook-out', 'search', 'ratelimit', 'geo',
];

/** Services this phase's explicit tools (beyond stack.status) actually call, and therefore need an API key for. */
export const API_KEY_SERVICES = ['notify', 'media', 'flags', 'shortlink', 'ratelimit', 'search', 'geo'];

/** @param {string} service */
const envKey = (service) => service.toUpperCase().replace(/-/g, '_');

/** Default request timeout: matches gateway's own `UPSTREAM_TIMEOUT_MS` default (`gateway/src/config.js`) -- reused, not reinvented. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @returns {{
 *   timeoutMs: number,
 *   services: Record<string, { baseUrl: string|null, apiKey: string|null }>,
 * }}
 */
export function loadConfig(env = process.env) {
  const timeoutMsRaw = env.STACK_MCP_TIMEOUT_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutMsRaw !== undefined) {
    const n = Number(timeoutMsRaw);
    if (!Number.isInteger(n) || n < 100) {
      throw new ConfigError(`STACK_MCP_TIMEOUT_MS must be an integer >= 100, got ${JSON.stringify(timeoutMsRaw)}`);
    }
    timeoutMs = n;
  }

  /** @type {Record<string, { baseUrl: string|null, apiKey: string|null }>} */
  const services = {};
  for (const service of SERVICES) {
    const key = envKey(service);
    const baseUrl = env[`STACK_MCP_${key}_BASE_URL`]?.trim() || null;
    const apiKey = env[`STACK_MCP_${key}_API_KEY`]?.trim() || null;
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      throw new ConfigError(`STACK_MCP_${key}_BASE_URL must be an http(s) URL, got ${JSON.stringify(baseUrl)}`);
    }
    services[service] = { baseUrl, apiKey };
  }
  return { timeoutMs, services };
}

export class ConfigError extends Error {}

/**
 * True if this service has enough config for the tools that need it (base URL + API key, if it needs one).
 * @param {Config} config @param {string} service
 */
export function isConfigured(config, service) {
  const s = config.services[service];
  if (!s?.baseUrl) return false;
  if (API_KEY_SERVICES.includes(service) && !s.apiKey) return false;
  return true;
}

/**
 * One-line, human-readable reason a service isn't usable, for a tool's config-error response. Never includes any secret value.
 * @param {Config} config @param {string} service
 */
export function missingConfigReason(config, service) {
  const key = envKey(service);
  const s = config.services[service];
  if (!s?.baseUrl) return `STACK_MCP_${key}_BASE_URL is not set`;
  if (API_KEY_SERVICES.includes(service) && !s.apiKey) return `STACK_MCP_${key}_API_KEY is not set`;
  return null;
}

/**
 * Redacts a value for anywhere it might accidentally end up in a log line -- defense in depth, not the only guard.
 * @param {unknown} value
 */
export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.length <= 8 ? '***' : `${value.slice(0, 2)}***${value.slice(-2)}`;
}
