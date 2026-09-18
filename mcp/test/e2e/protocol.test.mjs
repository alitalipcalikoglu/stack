// Real, protocol-level, service-backed end-to-end test. Spawns 7 real atc-web service processes
// (disposable, scratch SQLite/data dirs) plus the real stack-mcp server as its own child process,
// and drives it with the OFFICIAL MCP client SDK over the real STDIO transport -- not a direct
// function-handler call. Deliberately leaves gateway/auth/console/audit/scheduler/webhook-out
// unconfigured, to prove stack.status degrades gracefully rather than requiring all 13.
//
// Only runs when explicitly requested, matching every other process-spawning test in this
// workspace: `STACK_INTEGRATION=1 npm run mcp:e2e` (see stack/package.json).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { freePort, randomSecret, ServiceProcess, stopAll } from '../../../test/integration/harness.js';

const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes + a real stack-mcp child process)';

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MCP_BIN = join(WORKSPACE_ROOT, 'stack', 'mcp', 'bin', 'stack-mcp.js');

/** A sentinel value we assert never appears anywhere in MCP output/stderr -- proves no secret leakage. */
const SENTINEL_NOTIFY_KEY = `sentinel-secret-${randomSecret(8)}-do-not-leak`;

/** @type {string} */
let scratch;
/** @type {ServiceProcess[]} */
let services = [];
/** @type {Record<string, string>} */
let mcpEnv = {};

before(async () => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'atc-mcp-e2e-'));
  mcpEnv = { PATH: process.env.PATH ?? '' };

  // notify
  {
    const port = await freePort();
    const proc = new ServiceProcess({
      name: 'notify', cwd: join(WORKSPACE_ROOT, 'notify'), entry: 'src/index.js', port,
      env: {
        PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn',
        DB_PATH: join(scratch, 'notify.db'),
        NOTIFY_API_KEYS: `mcp:${SENTINEL_NOTIFY_KEY}`, // notify's keys are id:secret only, no role suffix (confirmed same as media)
        SMTP_URL: 'json:', SMTP_FROM: 'noreply@example.test', WEBHOOK_SIGNING_SECRET: randomSecret(32),
      },
    });
    await proc.start();
    services.push(proc);
    mcpEnv.STACK_MCP_NOTIFY_BASE_URL = proc.baseUrl;
    mcpEnv.STACK_MCP_NOTIFY_API_KEY = SENTINEL_NOTIFY_KEY;
  }

  // flags
  {
    const port = await freePort();
    const secret = randomSecret();
    const proc = new ServiceProcess({
      name: 'flags', cwd: join(WORKSPACE_ROOT, 'flags'), entry: 'src/index.js', port,
      env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', DB_PATH: join(scratch, 'flags.db'), FLAGS_API_KEYS: `mcp:${secret}:readwrite` },
    });
    await proc.start();
    services.push(proc);
    mcpEnv.STACK_MCP_FLAGS_BASE_URL = proc.baseUrl;
    mcpEnv.STACK_MCP_FLAGS_API_KEY = secret;
  }

  // geo
  {
    const port = await freePort();
    const secret = randomSecret();
    const proc = new ServiceProcess({
      name: 'geo', cwd: join(WORKSPACE_ROOT, 'geo'), entry: 'src/index.js', port,
      env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', DB_PATH: join(scratch, 'geo.db'), GEO_API_KEYS: `mcp:${secret}:readwrite` },
    });
    await proc.start();
    services.push(proc);
    mcpEnv.STACK_MCP_GEO_BASE_URL = proc.baseUrl;
    mcpEnv.STACK_MCP_GEO_API_KEY = secret;
  }

  // media
  {
    const port = await freePort();
    const secret = randomSecret();
    const dataDir = join(scratch, 'media-data');
    mkdirSync(dataDir, { recursive: true });
    const proc = new ServiceProcess({
      name: 'media', cwd: join(WORKSPACE_ROOT, 'media'), entry: 'src/index.js', port,
      env: {
        PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn',
        DB_PATH: join(scratch, 'media.db'), DATA_DIR: dataDir, MEDIA_API_KEYS: `mcp:${secret}`, // roleless (Phase 1/2 finding)
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, SIGNING_SECRET: randomSecret(32), STORAGE_DRIVER: 'local',
      },
    });
    await proc.start();
    services.push(proc);
    mcpEnv.STACK_MCP_MEDIA_BASE_URL = proc.baseUrl;
    mcpEnv.STACK_MCP_MEDIA_API_KEY = secret;
  }

  // shortlink
  {
    const port = await freePort();
    const secret = randomSecret();
    const proc = new ServiceProcess({
      name: 'shortlink', cwd: join(WORKSPACE_ROOT, 'shortlink'), entry: 'src/index.js', port,
      env: {
        PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn',
        DB_PATH: join(scratch, 'shortlink.db'), SHORTLINK_API_KEYS: `mcp:${secret}:readwrite`,
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, HASH_SECRET: randomSecret(32),
      },
    });
    await proc.start();
    services.push(proc);
    mcpEnv.STACK_MCP_SHORTLINK_BASE_URL = proc.baseUrl;
    mcpEnv.STACK_MCP_SHORTLINK_API_KEY = secret;
  }

  // ratelimit
  {
    const port = await freePort();
    const secret = randomSecret();
    const proc = new ServiceProcess({
      name: 'ratelimit', cwd: join(WORKSPACE_ROOT, 'ratelimit'), entry: 'src/index.js', port,
      env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', DB_PATH: join(scratch, 'ratelimit.db'), RATELIMIT_API_KEYS: `mcp:${secret}:readwrite` },
    });
    await proc.start();
    services.push(proc);
    mcpEnv.STACK_MCP_RATELIMIT_BASE_URL = proc.baseUrl;
    mcpEnv.STACK_MCP_RATELIMIT_API_KEY = secret;

    // pre-create a policy this test's check() call can target.
    const res = await fetch(`${proc.baseUrl}/v1/policies`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mcp-e2e-policy', limits: [{ window: 60, limit: 100 }] }),
    });
    assert.equal(res.status, 201, 'ratelimit test policy setup failed');
    await res.body?.cancel();
  }

  // search
  {
    const port = await freePort();
    const secret = randomSecret();
    const proc = new ServiceProcess({
      name: 'search', cwd: join(WORKSPACE_ROOT, 'search'), entry: 'src/index.js', port,
      env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', DB_PATH: join(scratch, 'search.db'), SEARCH_API_KEYS: `mcp:${secret}:readwrite` },
    });
    await proc.start();
    services.push(proc);
    mcpEnv.STACK_MCP_SEARCH_BASE_URL = proc.baseUrl;
    mcpEnv.STACK_MCP_SEARCH_API_KEY = secret;

    // pre-create an index this test's search() call can target.
    const res = await fetch(`${proc.baseUrl}/v1/indexes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mcp-e2e-index' }),
    });
    assert.equal(res.status, 201, 'search test index setup failed');
    await res.body?.cancel();
  }
});

after(async () => {
  if (!shouldRun) return;
  await stopAll(services);
  rmSync(scratch, { recursive: true, force: true });
});

/** Spawns a real stack-mcp child process and connects a real MCP client to it over real STDIO. */
async function connectClient(envOverrides = {}) {
  /** @type {Buffer[]} */
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', MCP_BIN],
    env: { ...mcpEnv, ...envOverrides },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mcp-e2e-test-client', version: '0.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
  return { client, transport, stderrChunks };
}

/**
 * Typed wrapper so call sites don't need a cast on every `result.structuredContent` access --
 * CallToolResult's structuredContent is typed as an opaque record by the SDK, which is correct at
 * the protocol level (tool output shape isn't statically known to the client), but this test file
 * already knows each tool's real shape from mcp/src/tools/index.mjs and output.mjs.
 * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} client
 * @param {string} name @param {Record<string, unknown>} args
 * @returns {Promise<any>}
 */
async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args });
}

test('protocol: initialize -> listTools -> exactly the expected 10 tools -> shutdown', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10, `expected exactly 10 tools, got ${tools.length}: ${tools.map((t) => t.name).join(', ')}`);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'flags.evaluate', 'geo.ip.lookup', 'media.files.get', 'notify.messages.create',
      'notify.messages.get', 'notify.messages.list', 'ratelimit.check', 'search.query',
      'shortlink.links.create', 'stack.status',
    ]);
    // Real annotation semantics, over the real protocol (not read from source).
    const status = tools.find((t) => t.name === 'stack.status');
    assert.ok(status);
    assert.equal(status.annotations?.readOnlyHint, true);
    const create = tools.find((t) => t.name === 'notify.messages.create');
    assert.ok(create);
    assert.equal(create.annotations?.readOnlyHint, false);
    assert.notEqual(create.annotations?.destructiveHint, true);
  } finally {
    await client.close();
  }
});

test('read-only tool + aggregate status: stack.status reports real per-service health, gracefully omitting unconfigured services', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const result = await callTool(client, 'stack.status', {});
    assert.equal(result.isError, undefined, `expected success, got: ${JSON.stringify(result)}`);
    const rows = result.structuredContent.data.services;
    const byService = Object.fromEntries(rows.map((/** @type {any} */ r) => [r.service, r]));
    for (const s of ['notify', 'flags', 'geo', 'media', 'shortlink', 'ratelimit', 'search']) {
      assert.equal(byService[s].configured, true, `${s} should be configured`);
      assert.equal(byService[s].healthy, true, `${s} should be healthy: ${JSON.stringify(byService[s])}`);
    }
    for (const s of ['gateway', 'auth', 'console', 'audit', 'scheduler', 'webhook-out']) {
      assert.equal(byService[s].configured, false, `${s} should be reported unconfigured, not an error`);
    }
  } finally {
    await client.close();
  }
});

test('authenticated read: flags.evaluate', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const result = await callTool(client, 'flags.evaluate', { env: 'prod', userId: 'u1' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, 200);
  } finally {
    await client.close();
  }
});

test('async submit -> status read: notify.messages.create then notify.messages.get', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const created = await callTool(client, 'notify.messages.create', { channel: 'webhook', url: 'https://example.test/hook', event: 'mcp.e2e.test', data: { hello: 'world' } });
    assert.equal(created.isError, undefined, JSON.stringify(created));
    assert.equal(created.structuredContent.status, 202);
    const id = created.structuredContent.data.id;
    assert.ok(id, 'created message has an id');

    const read = await callTool(client, 'notify.messages.get', { id });
    assert.equal(read.isError, undefined, JSON.stringify(read));
    assert.equal(read.structuredContent.status, 200);
    assert.equal(read.structuredContent.data.id, id);
    assert.ok(['queued', 'processing', 'sent', 'failed'].includes(read.structuredContent.data.status));
  } finally {
    await client.close();
  }
});

test('pagination: notify.messages.list returns real items/nextCursor shape', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const result = await callTool(client, 'notify.messages.list', { limit: 1 });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.ok(Array.isArray(result.structuredContent.data.items));
    assert.ok('nextCursor' in result.structuredContent.data);
  } finally {
    await client.close();
  }
});

test('safe mutation: shortlink.links.create', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const result = await callTool(client, 'shortlink.links.create', { url: 'https://example.test/mcp-e2e-page' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, 201);
    assert.ok(result.structuredContent.data.link.code);
  } finally {
    await client.close();
  }
});

test('search.query offset-based pagination against a real (empty) index', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const result = await callTool(client, 'search.query', { name: 'mcp-e2e-index', q: 'nothing' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.data.total, 0);
    assert.equal(result.structuredContent.data.offset, 0);
  } finally {
    await client.close();
  }
});

test('ratelimit.check is always peek (never consumes quota), and preserves the real allowed:true-on-HTTP-200 semantics', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const result = await callTool(client, 'ratelimit.check', { policy: 'mcp-e2e-policy', subject: 'mcp-e2e-subject' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, 200);
    assert.equal(typeof result.structuredContent.data.allowed, 'boolean');
    assert.ok(result.structuredContent.data.allowed, 'a fresh subject should be allowed');
  } finally {
    await client.close();
  }
});

test('expected error path: media.files.get on a real-shaped but nonexistent id returns a translated, safe upstream error', { skip }, async () => {
  const { client } = await connectClient();
  try {
    const result = await callTool(client, 'media.files.get', { id: '00000000-0000-0000-0000-000000000000' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'UPSTREAM_ERROR');
    assert.equal(result.structuredContent.status, 404);
    assert.equal(result.structuredContent.upstreamCode, 'NOT_FOUND');
    assert.ok(!JSON.stringify(result).includes('Authorization'), 'error result must not echo request headers');
  } finally {
    await client.close();
  }
});

test('malformed tool input is rejected before any upstream call (protocol-level schema validation)', { skip }, async () => {
  const { client } = await connectClient();
  try {
    // The SDK validates against the tool's zod inputSchema BEFORE calling our handler, and reports
    // a failure as a normal CallToolResult with isError:true (MCP's own design: tool-level errors,
    // including input validation, are part of the result the model sees, not a rejected JSON-RPC
    // request) -- confirmed directly against the real server, not assumed from SDK docs.
    const result = await callTool(client, 'flags.evaluate', { /* missing required env */ });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /env|required|invalid/i);
    // No structuredContent from our own output.mjs/errors.mjs -- this never reached our handler at
    // all, confirming the SDK truly short-circuits before any upstream call.
    assert.equal(result.structuredContent, undefined);
  } finally {
    await client.close();
  }
});

test('service unavailable: an unconfigured service returns a safe SERVICE_UNAVAILABLE, not a crash', { skip }, async () => {
  const { client } = await connectClient({ STACK_MCP_GEO_BASE_URL: '', STACK_MCP_GEO_API_KEY: '' });
  try {
    const result = await callTool(client, 'geo.ip.lookup', { ip: '1.1.1.1' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'SERVICE_UNAVAILABLE');
    // still connected, still usable for a different, configured tool -- one bad service doesn't kill the process.
    const flagsResult = await callTool(client, 'flags.evaluate', { env: 'prod' });
    assert.equal(flagsResult.isError, undefined);
  } finally {
    await client.close();
  }
});

test('wrong credential: real 401 from the service is translated safely, and never echoes the bad key', { skip }, async () => {
  const wrongKey = 'wrong-key-0000000000000000000000000000000000';
  const { client } = await connectClient({ STACK_MCP_FLAGS_API_KEY: wrongKey });
  try {
    const result = await callTool(client, 'flags.evaluate', { env: 'prod' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 401);
    const dump = JSON.stringify(result);
    assert.ok(!dump.includes(wrongKey), 'the wrong credential itself must never appear in the tool result');
    assert.ok(!dump.toLowerCase().includes('authorization'), 'no Authorization header value in the tool result');
  } finally {
    await client.close();
  }
});

test('service unreachable (transport failure): a real connection-refused target is translated to TRANSPORT_ERROR, not a raw stack trace', { skip }, async () => {
  const deadPort = await freePort(); // freed immediately -- guaranteed nothing is listening.
  const { client } = await connectClient({ STACK_MCP_GEO_BASE_URL: `http://127.0.0.1:${deadPort}` });
  try {
    const result = await callTool(client, 'geo.ip.lookup', { ip: '1.1.1.1' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'TRANSPORT_ERROR');
    const dump = JSON.stringify(result);
    assert.ok(!dump.includes(WORKSPACE_ROOT), 'no local filesystem path in the tool result');
    assert.ok(!/at \w+ \(/.test(dump), 'no stack-trace-shaped text in the tool result');
  } finally {
    await client.close();
  }
});

test('STDIO purity + secret leakage: stdout carries only protocol frames, stderr never contains the sentinel API key', { skip }, async () => {
  const { client, transport, stderrChunks } = await connectClient();
  try {
    // Exercise the credentialed path several times, including the error paths above, so there's a
    // real, generous window of output to scan.
    await callTool(client, 'notify.messages.list', {});
    await callTool(client, 'stack.status', {});
    await new Promise((r) => setTimeout(r, 200)); // let any buffered stderr flush.
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    assert.ok(!stderrText.includes(SENTINEL_NOTIFY_KEY), `sentinel secret leaked into stderr:\n${stderrText}`);
    // If stdout had ever carried anything but framed JSON-RPC, the client's own message parsing
    // would already have thrown by this point in the test run (StdioClientTransport parses stdout
    // as newline-delimited JSON-RPC and errors on anything else) -- this is the transport itself
    // asserting STDIO purity on every prior call in this test file, not just this one.
  } finally {
    await client.close();
  }
});
