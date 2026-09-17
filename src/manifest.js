/**
 * Every service in the stack, in start order. Adding a service means adding one entry here
 * (and, for services the console shows, the console entry's `keys` list and `services.json`).
 *
 * @typedef {object} Service
 * @property {string} id            Folder name under the workspace root, PM2 app name, console service id.
 * @property {number} port
 * @property {string} [keysVar]     Env variable holding `id:secret[:role…]` API keys this service issues.
 * @property {(ctx: import('./setup-context.js').SetupContext) => Record<string, string>} env
 *   Values written to the service's `.env` for a local stack (secrets and cross-service keys included).
 * @property {(ctx: import('./setup-context.js').SetupContext) => Record<string, string>} [files]
 *   Extra files to write into the service folder, by relative path.
 * @property {(ctx: import('./setup-context.js').SetupContext) => Promise<void>} [prepare]
 *   One-off preparation before the env is computed (key pairs, builds).
 * @property {{ type: string, label: string, keyEnv?: string, metricsTokenEnv?: string, polling?: { enabled: boolean, intervalSec: number } }} [console]
 *   How the service appears in the console's `services.json`.
 */

/** @type {Service[]} */
export const SERVICES = [
  {
    id: 'notify', port: 3001, keysVar: 'NOTIFY_API_KEYS',
    env: (c) => ({ SMTP_URL: c.keep('notify', 'SMTP_URL', 'json:'), SMTP_FROM: c.keep('notify', 'SMTP_FROM', '"atc-web <no-reply@localhost>"'), WEBHOOK_SIGNING_SECRET: c.secret('notify', 'WEBHOOK_SIGNING_SECRET'), WEBHOOK_ALLOW_HTTP: c.local ? 'true' : c.keep('notify', 'WEBHOOK_ALLOW_HTTP', 'false') }),
    console: { type: 'notify', label: 'Notify', keyEnv: 'NOTIFY_API_KEY', polling: { enabled: true, intervalSec: 30 } },
  },
  {
    id: 'auth', port: 3002, keysVar: 'AUTH_API_KEYS',
    prepare: async (c) => { if (!c.exists('auth', 'keys/jwt-private.pem')) await c.run('auth', ['npm', 'run', 'keygen']); },
    env: (c) => ({
      NOTIFY_URL: c.url('notify'), NOTIFY_API_KEY: c.issue('notify', 'auth'), JWT_ISSUER: c.url('gateway'), JWT_AUDIENCE: c.keep('auth', 'JWT_AUDIENCE', 'app'),
      APP_NAME: c.keep('auth', 'APP_NAME', 'atc-web'), // Links in verification mails point at your web app, which auth insists is https; a local stack has no app yet.
      VERIFY_URL_TEMPLATE: c.keep('auth', 'VERIFY_URL_TEMPLATE', `https://${c.host}/verify-email?token={token}`), RESET_URL_TEMPLATE: c.keep('auth', 'RESET_URL_TEMPLATE', `https://${c.host}/reset-password?token={token}`),
    }),
    console: { type: 'auth', label: 'Auth', keyEnv: 'AUTH_API_KEY' },
  },
  {
    id: 'media', port: 3003, keysVar: 'MEDIA_API_KEYS',
    env: (c) => ({ PUBLIC_BASE_URL: c.publicUrl('media'), SIGNING_SECRET: c.secret('media', 'SIGNING_SECRET'), CORS_ORIGINS: c.keep('media', 'CORS_ORIGINS', c.url('gateway')) }),
    console: { type: 'media', label: 'Media', keyEnv: 'MEDIA_API_KEY' },
  },
  {
    id: 'audit', port: 3005, keysVar: 'AUDIT_API_KEYS',
    env: () => ({}),
    console: { type: 'audit', label: 'Audit', keyEnv: 'AUDIT_API_KEY', polling: { enabled: true, intervalSec: 60 } },
  },
  {
    id: 'shortlink', port: 3006, keysVar: 'SHORTLINK_API_KEYS',
    env: (c) => ({ PUBLIC_BASE_URL: c.publicUrl('shortlink'), HASH_SECRET: c.secret('shortlink', 'HASH_SECRET') }),
    console: { type: 'shortlink', label: 'Shortlink', keyEnv: 'SHORTLINK_API_KEY' },
  },
  {
    id: 'flags', port: 3007, keysVar: 'FLAGS_API_KEYS',
    env: () => ({}),
    console: { type: 'flags', label: 'Flags', keyEnv: 'FLAGS_API_KEY' },
  },
  {
    id: 'scheduler', port: 3008, keysVar: 'SCHEDULER_API_KEYS',
    env: (c) => ({
      SIGNING_SECRET: c.secret('scheduler', 'SIGNING_SECRET'),
      TARGET_KEYS: `flags:${c.issue('flags', 'scheduler', 'write')},notify:${c.issue('notify', 'scheduler')},webhook-out:${c.issue('webhook-out', 'scheduler', 'publish')}`,
      ...c.outbound('scheduler'),
    }),
    console: { type: 'scheduler', label: 'Scheduler', keyEnv: 'SCHEDULER_API_KEY' },
  },
  {
    id: 'webhook-out', port: 3009, keysVar: 'WEBHOOK_API_KEYS',
    env: (c) => ({ SECRETS_KEY: c.secret('webhook-out', 'SECRETS_KEY'), ...c.outbound('webhook-out') }),
    console: { type: 'webhook-out', label: 'Webhooks', keyEnv: 'WEBHOOK_OUT_API_KEY' },
  },
  {
    id: 'search', port: 3010, keysVar: 'SEARCH_API_KEYS',
    env: () => ({}),
    console: { type: 'search', label: 'Search', keyEnv: 'SEARCH_API_KEY' },
  },
  {
    id: 'gateway', port: 3000,
    env: (c) => ({ METRICS_TOKEN: c.secret('gateway', 'METRICS_TOKEN'), AUTH_API_KEY: c.issue('auth', 'gateway'), MEDIA_API_KEY: c.issue('media', 'gateway'), NOTIFY_API_KEY: c.issue('notify', 'gateway') }),
    files: (c) => ({ 'routes.json': `${JSON.stringify(c.gatewayRoutes(), null, 2)}\n` }),
    console: { type: 'gateway', label: 'Gateway', metricsTokenEnv: 'GATEWAY_METRICS_TOKEN' },
  },
  {
    id: 'console', port: 3004,
    env: (c) => ({
      COOKIE_SECURE: c.local ? 'false' : 'true',
      GATEWAY_METRICS_TOKEN: c.secret('gateway', 'METRICS_TOKEN'),
      ...Object.fromEntries(c.consoleServices().filter((s) => s.console?.keyEnv).map((s) => [/** @type {string} */ (s.console?.keyEnv), c.issue(s.id, 'console', c.consoleRole(s.id))])),
    }),
    files: (c) => ({ 'services.json': `${JSON.stringify(c.consoleServicesJson(), null, 2)}\n` }),
    prepare: async (c) => { if (!c.exists('console', 'public/index.html')) await c.run('console', ['npm', 'run', 'build']); },
  },
];

/** Roles the console's key needs per service; everything else gets the issuer's default role. */
export const CONSOLE_ROLES = /** @type {Record<string, string>} */ ({ audit: 'read' });
