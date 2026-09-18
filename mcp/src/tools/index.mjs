// THE explicit MCP tool allowlist. This is the only place a tool is ever registered -- nothing in
// this package iterates the OpenAPI specs or tool-catalog.json to auto-register tools. Default
// deny: an operation existing in a service's canonical openapi.yaml does not make it an MCP tool.
//
// Every input schema's fields, constraints and requiredness are copied from that operation's own
// OpenAPI request schema (see the file-and-line citations in each tool's comment) -- never
// invented, never loosened or tightened relative to the real contract. Deep per-value validation
// (e.g. notify's per-template email `data` shape) intentionally stays server-side, not re-derived
// here a third time (see mcp/README.md's "input schemas" section).
import { z } from 'zod';
import { ServiceRegistry } from '../registry.mjs';
import { toErrorResult } from '../errors.mjs';
import { toolResult } from '../output.mjs';
import { SERVICES } from '../config.mjs';

/** @typedef {{ name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, annotations: import('@modelcontextprotocol/sdk/types.js').ToolAnnotations, handler: (args: any, registry: ServiceRegistry) => Promise<any> }} ToolDef */

/**
 * Shared response.status/data extraction + a request-id passthrough (x-request-id is safe/useful
 * for log correlation; every other header is either routine or internal-only per the Phase 0 audit).
 * @param {{ response: Response }} res
 */
function summarize(res) {
  return { status: res.response.status, requestId: res.response.headers.get('x-request-id') };
}

/** @type {ToolDef[]} */
export const TOOLS = [
  // ---------------------------------------------------------------------------------------------
  // stack.status -- MCP-native aggregate. Not one OpenAPI operationId: polls every configured
  // service's own /health + /ready + /v1/info (all three unauthenticated on every service, per the
  // Phase 0/1 audits), exactly the "operational aggregate" stack status --matrix already does at
  // the CLI layer. One dead/unconfigured service never fails the whole call -- its row just reports
  // the failure, per-service, so the tool stays useful when the platform is partially up.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'stack.status',
    description:
      'Reports liveness (/health), readiness (/ready) and identity (/v1/info: version, apiVersion, ' +
      'capabilities, schemaVersion) for every configured atc-web service. Read-only, safe to call ' +
      'anytime. A service with no base URL configured for this MCP server is reported as ' +
      '"unconfigured", not as an error -- this tool never fails as a whole because one service is down.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async handler(_args, registry) {
      const rows = await Promise.all(
        SERVICES.map(async (service) => {
          if (!registry.config.services[service]?.baseUrl) return { service, configured: false };
          try {
            const client = await registry.probeClient(service);
            // operationId naming for the 3 operational probes is NOT consistent across the 13
            // specs (a real Phase 1 finding, worth fixing in a future contract pass, not silently
            // patched here): gateway/ratelimit/geo use "<svc>.health.check", most others
            // "<svc>.health.get", media uses "media.ops.health", search uses
            // "search.system.health" (entity and verb swapped). Matching on "does the operationId
            // contain this whole dot-segment" is robust to all three shapes without guessing which
            // one a given service picked.
            /** @param {string} word */
            const findOp = (word) => Object.keys(/** @type {object} */ (client)).find((k) => k.split('.').includes(word));
            const [healthKey, readyKey, infoKey] = [findOp('health'), findOp('ready'), findOp('info')];
            if (!healthKey || !readyKey || !infoKey) {
              return { service, configured: true, healthy: false, ready: false, error: 'could not find health/ready/info operations on the generated client' };
            }
            const [health, ready, info] = await Promise.all([client[healthKey]({}), client[readyKey]({}), client[infoKey]({})]);
            return {
              service,
              configured: true,
              healthy: health.response.status === 200,
              ready: ready.response.status === 200,
              version: info.data?.version ?? null,
              apiVersion: info.data?.apiVersion ?? null,
              schemaVersion: info.data?.schemaVersion ?? null,
              capabilities: info.data?.capabilities ?? null,
            };
          } catch (err) {
            return { service, configured: true, healthy: false, ready: false, error: err instanceof Error ? err.message : 'unreachable' };
          }
        }),
      );
      const upCount = rows.filter((r) => r.healthy).length;
      return toolResult({
        status: 200,
        data: { services: rows },
        summary: `${upCount}/${rows.filter((r) => r.configured).length} configured services healthy (${rows.length - rows.filter((r) => r.configured).length} unconfigured)`,
      });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // flags.evaluate -- authenticated read. flags/openapi.yaml operationId flags.evaluate.post,
  // request body EvaluateBody (env required; context.userId/email/attrs, keys, details all optional).
  // ---------------------------------------------------------------------------------------------
  {
    name: 'flags.evaluate',
    description:
      'Evaluates feature flags for one environment and (optional) targeting context. Read-only ' +
      '(no state changes -- evaluation only increments an in-process counter). An unknown key in ' +
      '`keys` evaluates to reason "missing", not an error.',
    inputSchema: {
      env: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'lowercase, starts with a letter, max 32 chars'),
      userId: z.string().min(1).max(128).optional(),
      email: z.string().min(3).max(254).optional(),
      attrs: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), z.string().max(128)).optional(),
      keys: z.array(z.string()).max(200).optional().describe('Narrows evaluation to these flag keys; omit to evaluate every non-archived flag.'),
      details: z.boolean().optional().describe('true: return {value, reason, ruleId?} per flag. false/omitted: bare values only.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('flags');
      const { env, userId, email, attrs, keys, details } = args;
      const context = userId || email || attrs ? { userId, email, attrs } : undefined;
      const res = await client['flags.evaluate.post']({ body: { env, context, keys, details } });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // geo.ip.lookup -- authenticated read. geo/openapi.yaml operationId geo.ip.lookup, path {ip}, query {lang?}.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'geo.ip.lookup',
    description:
      'Looks up country/region/city/coordinates/timezone (and ASN, if configured) for a public ' +
      'IPv4/IPv6 address. Private/loopback/reserved addresses are classified without a database ' +
      'lookup and always return found:false, never an error. Read-only.',
    inputSchema: {
      ip: z.string().min(2).max(64),
      lang: z.string().regex(/^[A-Za-z0-9-]+$/).min(2).max(35).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('geo');
      const res = await client['geo.ip.lookup']({ params: { path: { ip: args.ip }, query: { lang: args.lang } } });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // media.files.get -- authenticated read + real error path. media/openapi.yaml operationId
  // media.files.get, path {id}. Deliberately metadata-only: this tool never transports file bytes
  // through MCP (see mcp/README.md's "binary" section for why).
  // ---------------------------------------------------------------------------------------------
  {
    name: 'media.files.get',
    description:
      "Reads one file's metadata (name, mime, size, dimensions, visibility, URLs) by id. Does not " +
      'return file bytes -- use the `url` fields in the response to fetch content directly. A ' +
      "nonexistent or another key's file id returns a real 404, not an error thrown by this tool.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('media');
      const res = await client['media.files.get']({ params: { path: { id: args.id } } });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // notify.messages.list -- pagination proof (cursor-based). notify/openapi.yaml operationId
  // notify.messages.list, query {status?, limit?, cursor?}. Field names (items/nextCursor) are
  // notify's own real contract, not normalized to match any other service's list shape.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'notify.messages.list',
    description:
      "Lists the calling API key's own queued/sent/failed messages, newest first. Cursor-paginated: " +
      'pass the previous call\'s `nextCursor` back as `cursor` to get the next page; `nextCursor: ' +
      'null` means there is no more data.',
    inputSchema: {
      status: z.enum(['queued', 'processing', 'sent', 'failed']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20 when omitted.'),
      cursor: z.string().max(128).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('notify');
      const res = await client['notify.messages.list']({
        params: { query: { status: args.status, limit: args.limit !== undefined ? String(args.limit) : undefined, cursor: args.cursor } },
      });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // notify.messages.create -- async submit (safe mutation). notify/openapi.yaml operationId
  // notify.messages.create, body oneOf(MessageCreateEmail, MessageCreateWebhook) discriminated on
  // `channel`. Per-template email `data` shape is intentionally NOT re-derived here (server-side
  // Ajv is the real validator for that) -- this schema only re-derives the OUTER contract shape.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'notify.messages.create',
    description:
      'Queues an email or webhook message for delivery. Returns immediately (202 new / 200 replay ' +
      'of an idempotencyKey) -- this does NOT mean delivery has happened, only that it was accepted. ' +
      'Use notify.messages.get with the returned id to check real delivery status later.',
    inputSchema: {
      channel: z.enum(['email', 'webhook']),
      // email branch
      template: z.enum(['email-verification', 'password-reset', 'generic']).optional(),
      to: z.array(z.string().email()).min(1).max(10).optional(),
      data: z.record(z.string(), z.unknown()).optional().describe('email: validated server-side against the named template\'s schema. webhook: free-form, sent verbatim.'),
      // webhook branch
      url: z.string().url().max(2048).optional(),
      event: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
      idempotencyKey: z.string().min(1).max(128).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async handler(args, registry) {
      const client = await registry.client('notify');
      const body = args.channel === 'email'
        ? { channel: 'email', template: args.template, to: args.to, data: args.data ?? {}, idempotencyKey: args.idempotencyKey }
        : { channel: 'webhook', url: args.url, event: args.event, data: args.data ?? {}, idempotencyKey: args.idempotencyKey };
      const res = await client['notify.messages.create']({ body });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data, summary: `message ${res.data?.id} queued, status ${res.response.status}` });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // notify.messages.get -- async status/read half of the same flow.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'notify.messages.get',
    description:
      'Reads one message\'s current delivery state (queued/processing/sent/failed), attempt count ' +
      'and last error, by id. Use this to check on a message created with notify.messages.create.',
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('notify');
      const res = await client['notify.messages.get']({ params: { path: { id: args.id } } });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // shortlink.links.create -- safe mutation (create, non-destructive). shortlink/openapi.yaml
  // operationId shortlink.links.create, body LinkCreate (url required).
  // ---------------------------------------------------------------------------------------------
  {
    name: 'shortlink.links.create',
    description:
      'Creates a new short link for a URL. Non-destructive -- creates a new resource, never ' +
      'overwrites or deletes anything. Slug is auto-generated if omitted.',
    inputSchema: {
      url: z.string().min(8).max(8192).describe('Absolute http/https URL; must not point at the shortlink service itself.'),
      slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/).optional(),
      permanent: z.boolean().optional().describe('301 vs 302 redirect. Defaults to the service config when omitted.'),
      expiresAt: z.string().max(40).nullable().optional().describe('ISO 8601, must be in the future.'),
      maxClicks: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
      note: z.string().max(500).nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('shortlink');
      const res = await client['shortlink.links.create']({ body: args });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data, summary: `created ${res.data?.link?.shortUrl ?? res.data?.link?.code}` });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // ratelimit.check -- read-only by construction: `peek` is hard-coded true in the handler, never
  // caller-controlled, so this tool can never consume real quota (a non-peek check is a real
  // mutation of a subject's counters -- deliberately left out of the initial allowlist).
  // ratelimit/openapi.yaml operationId ratelimit.check, body CheckRequest.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'ratelimit.check',
    description:
      'Previews (does not consume) what a rate-limit decision would be for a subject against a ' +
      'policy. Always evaluated with peek:true -- this tool can never consume real quota. Note: ' +
      'the real, non-peek endpoint returns HTTP 200 for both an allow and a deny; the business ' +
      'decision is the `allowed` field, never the HTTP status -- this preview shares that shape.',
    inputSchema: {
      policy: z.string().min(1),
      subject: z.string().min(1),
      cost: z.number().int().min(0).optional().describe('Units that would be consumed by a real (non-peek) check. Default 1.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('ratelimit');
      const res = await client['ratelimit.check']({ body: { policy: args.policy, subject: args.subject, cost: args.cost, peek: true } });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data, summary: `allowed=${res.data?.allowed}` });
    },
  },

  // ---------------------------------------------------------------------------------------------
  // search.query -- authenticated read, offset-based pagination (deliberately different pagination
  // style from notify.messages.list's cursor style -- both are real, neither is normalized to
  // match the other; see stack/docs/API_CONTRACT_AUDIT.md §H on the platform's real field-naming
  // inconsistency across services, left as-is per that doc's own deferred-policy note).
  // search/openapi.yaml operationId search.query.get, path {name}, query {q?, limit?, offset?, ...}.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'search.query',
    description:
      'Full-text search over one index. Empty/omitted `q` is a browse (no ranking, score is null ' +
      'on every hit). Offset-based pagination: total/limit/offset in the response, not a cursor.',
    inputSchema: {
      name: z.string().describe('Index name.'),
      q: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(1000).optional().describe('Default 20, clamped server-side to maxPage (default 100).'),
      offset: z.number().int().min(0).optional(),
      highlight: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, registry) {
      const client = await registry.client('search');
      const res = await client['search.query.get']({
        params: {
          path: { name: args.name },
          query: {
            q: args.q,
            limit: args.limit !== undefined ? String(args.limit) : undefined,
            offset: args.offset !== undefined ? String(args.offset) : undefined,
            highlight: args.highlight !== undefined ? String(args.highlight) : undefined,
          },
        },
      });
      if (res.error) throw res;
      return toolResult({ ...summarize(res), data: res.data });
    },
  },
];

/**
 * Wraps a tool's real handler so every real/thrown failure funnels through the one error adapter.
 * @param {ToolDef} tool
 */
export function wrapHandler(tool) {
  return /** @param {Record<string, unknown>} args @param {ServiceRegistry} registry */ async (args, registry) => {
    try {
      return await tool.handler(args, registry);
    } catch (err) {
      // A generated-client call that returned a real {error, response} pair throws `res` itself
      // (see each handler's `if (res.error) throw res`) so it reaches this single translation point
      // too, alongside genuine thrown Errors (config/transport failures).
      return toErrorResult(tool.name.split('.')[0], err);
    }
  };
}
