import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll, waitUntil } from './harness.js';

/**
 * Stage 11 item 4: the gateway's dependency on the real ratelimit service, proven with both as real
 * `node` child processes, not mocks. This is the one dependency-outage path Stage 9/11 exist to
 * make safe: what happens to a policy-guarded route when the ratelimit process it calls out to is
 * simply gone, and — the point the ground truth in the task spec is most insistent on — that
 * `failOpen` is decided per route, not globally, and that recovery needs no gateway restart or
 * reload once ratelimit comes back (gateway makes no assumption ratelimit stays down).
 *
 * Only gateway and ratelimit are real processes. The upstream every route proxies to is a plain
 * `node:http` server running inside this test process itself (Stage 11's own rule: only the
 * services actually under test — gateway, ratelimit — need to be spawned; a fixture upstream does
 * not).
 *
 * Spawns real processes, so it only runs when explicitly requested: `STACK_INTEGRATION=1 npm test`.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {string} */ let scratch;
/** @type {import('node:http').Server} */ let upstream;
/** @type {number} */ let upstreamPort;
/** @type {number} */ let ratelimitPort;
/** @type {ServiceProcess} */ let ratelimit;
/** @type {ServiceProcess} */ let gateway;
/** @type {string} */ let gatewayApiKeySecret;
/** @type {string} */ let harnessApiKeySecret;
/** @type {string} */ let metricsToken;

const policyName = 'gw-rl-test';

/** @param {number} port */
function ratelimitEnv(port) {
  return {
    PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info',
    DB_PATH: join(scratch, 'ratelimit.db'),
    // gateway's key can only ever hit /v1/check ("check" role); the harness key is readwrite so it
    // can also create and patch the policy directly, as an operator would.
    RATELIMIT_API_KEYS: `gateway:${gatewayApiKeySecret}:check,harness:${harnessApiKeySecret}:readwrite`,
  };
}

before(async () => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-integration-'));
  gatewayApiKeySecret = randomSecret();
  harnessApiKeySecret = randomSecret();
  metricsToken = randomSecret();

  ratelimitPort = await freePort();
  ratelimit = new ServiceProcess({ name: 'ratelimit', cwd: join(workspaceRoot, 'ratelimit'), entry: 'src/index.js', port: ratelimitPort, env: ratelimitEnv(ratelimitPort) });
  await ratelimit.start();

  const policyRes = await fetch(`${ratelimit.baseUrl}/v1/policies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harnessApiKeySecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: policyName, limits: [{ window: 60, limit: 1000 }] }),
  });
  assert.equal(policyRes.status, 201, await policyRes.text());

  upstreamPort = await freePort();
  upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((res, rej) => {
    upstream.once('error', rej);
    upstream.listen(upstreamPort, '127.0.0.1', () => res(undefined));
  });

  const routesPath = join(scratch, 'routes.json');
  writeFileSync(routesPath, JSON.stringify({
    routes: [
      // failOpen:false — abuse protection must win over availability: ratelimit down means this
      // route refuses traffic rather than let it through unchecked.
      { id: 'route-a-closed', pathPrefix: '/a', upstreams: [`http://127.0.0.1:${upstreamPort}`], policy: { name: policyName, subject: 'ip', failOpen: false } },
      // failOpen:true — availability wins: ratelimit down means this route serves traffic anyway.
      { id: 'route-b-open', pathPrefix: '/b', upstreams: [`http://127.0.0.1:${upstreamPort}`], policy: { name: policyName, subject: 'ip', failOpen: true } },
    ],
  }));

  const gatewayPort = await freePort();
  gateway = new ServiceProcess({
    name: 'gateway', cwd: join(workspaceRoot, 'gateway'), entry: 'src/index.js', port: gatewayPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(gatewayPort), HOST: '127.0.0.1', LOG_LEVEL: 'info',
      ROUTES_FILE: routesPath, TRUST_PROXY: 'false', METRICS_TOKEN: metricsToken,
      RATELIMIT_URL: `http://127.0.0.1:${ratelimitPort}`, RATELIMIT_API_KEY: gatewayApiKeySecret,
    },
  });
  await gateway.start();
});

after(async () => {
  if (!shouldRun) return;
  await stopAll([ratelimit, gateway].filter(Boolean));
  await new Promise((res) => upstream?.close(() => res(undefined)));
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A line like `gateway_dependency_errors_total{dependency="ratelimit"} 3` is exactly what
 * `Metrics.render()` emits (one metric per line, `name{labels} value`) — no need for a full
 * Prometheus text parser, just find the one line whose start matches and read its trailing number.
 * @param {string} text
 * @param {string} line  The metric name + label set, e.g. `gateway_dependency_errors_total{dependency="ratelimit"}`.
 */
function metricValue(text, line) {
  const re = new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`, 'm');
  const match = text.match(re);
  assert.ok(match, `metric line "${line}" present in:\n${text}`);
  return Number(match[1]);
}

async function fetchMetrics() {
  const res = await fetch(`${gateway.baseUrl}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return text;
}

test('gateway + ratelimit, both real processes: policy enforcement, a genuine ratelimit outage, and automatic recovery with no gateway restart', { skip }, async () => {
  // ---- Step 4: baseline — ratelimit healthy, both routes genuinely enforce (not a no-op).
  const baselineA = await fetch(`${gateway.baseUrl}/a`);
  assert.equal(baselineA.status, 200, await baselineA.text());
  assert.equal(Number(baselineA.headers.get('ratelimit-limit')), 1000);
  assert.ok(Number.isFinite(Number(baselineA.headers.get('ratelimit-remaining'))) && Number(baselineA.headers.get('ratelimit-remaining')) >= 0, 'route A got a real, sane ratelimit-remaining from ratelimit while it is healthy');

  const baselineB = await fetch(`${gateway.baseUrl}/b`);
  assert.equal(baselineB.status, 200, await baselineB.text());
  assert.equal(Number(baselineB.headers.get('ratelimit-limit')), 1000);
  assert.ok(Number.isFinite(Number(baselineB.headers.get('ratelimit-remaining'))) && Number(baselineB.headers.get('ratelimit-remaining')) >= 0, 'route B got a real, sane ratelimit-remaining from ratelimit while it is healthy');

  const metrics0 = await fetchMetrics();
  const depErr0 = metricValue(metrics0, 'gateway_dependency_errors_total{dependency="ratelimit"}');
  const polUnavail0 = metricValue(metrics0, 'gateway_rejected_total{reason="policy_unavailable"}');
  assert.equal(depErr0, 0, 'no ratelimit dependency failure yet — ratelimit is up');
  assert.equal(polUnavail0, 0, 'no policy-unavailable rejection yet — ratelimit is up');

  // ---- Step 5: stop ratelimit for real.
  await ratelimit.stop();

  // ---- Step 6: failOpen:false must refuse traffic while ratelimit is down.
  const downA = await fetch(`${gateway.baseUrl}/a`);
  const downABody = await downA.json();
  assert.equal(downA.status, 503, JSON.stringify(downABody));
  assert.equal(downABody.error?.code, 'RATE_LIMIT_UNAVAILABLE');
  assert.equal(downA.headers.get('retry-after'), '5');
  // Distinct header family: gateway's own always-on local per-IP limiter, unrelated to the
  // ratelimit service dependency that just failed — it must still be present even on this 503.
  assert.ok(downA.headers.get('x-ratelimit-limit'), 'gateway’s own local limiter headers are unrelated to the failed ratelimit dependency and still present');

  const metrics1 = await fetchMetrics();
  assert.equal(metricValue(metrics1, 'gateway_dependency_errors_total{dependency="ratelimit"}'), depErr0 + 1, 'route A’s failed check counted as a dependency error');
  assert.equal(metricValue(metrics1, 'gateway_rejected_total{reason="policy_unavailable"}'), polUnavail0 + 1, 'route A’s failClosed rejection counted');

  // ---- Step 7: failOpen:true must let traffic through to the real upstream while ratelimit is down.
  const downB = await fetch(`${gateway.baseUrl}/b`);
  const downBBody = await downB.json();
  assert.equal(downB.status, 200, JSON.stringify(downBBody));
  assert.deepEqual(downBBody, { ok: true }, 'route B reached the real upstream, not a stub');
  for (const h of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
    assert.equal(downB.headers.get(h), null, `${h} must be absent — the header-setting code never runs on this failure path`);
  }

  // ---- Step 8: dependency errors counted for BOTH routes; policy_unavailable only for route A.
  const metrics2 = await fetchMetrics();
  assert.equal(metricValue(metrics2, 'gateway_dependency_errors_total{dependency="ratelimit"}'), depErr0 + 2, 'both the failClosed and the failOpen call counted as dependency errors');
  assert.equal(metricValue(metrics2, 'gateway_rejected_total{reason="policy_unavailable"}'), polUnavail0 + 1, 'route B’s failOpen call must NOT add another policy_unavailable rejection');

  // ---- Step 9: gateway itself must still be healthy — an unreachable dependency isn't a gateway outage.
  const health = await fetch(`${gateway.baseUrl}/health`);
  assert.equal(health.status, 200);

  // ---- Step 10: restart ratelimit for real, rebinding the exact same port gateway already has baked in.
  ratelimit = new ServiceProcess({ name: 'ratelimit', cwd: join(workspaceRoot, 'ratelimit'), entry: 'src/index.js', port: ratelimitPort, env: ratelimitEnv(ratelimitPort) });
  await ratelimit.start();

  // ---- Step 11: route A recovers automatically — no gateway restart, no reload, just the next request.
  await waitUntil(async () => {
    const res = await fetch(`${gateway.baseUrl}/a`);
    if (res.status !== 200) { await res.body?.cancel(); return false; }
    return Number.isFinite(Number(res.headers.get('ratelimit-limit'))) && res.headers.get('ratelimit-limit') !== null;
  }, { timeoutMs: 5_000, message: 'route A resumes real ratelimit enforcement after ratelimit restarts, with no gateway restart' });

  const recoveredA = await fetch(`${gateway.baseUrl}/a`);
  assert.equal(recoveredA.status, 200, await recoveredA.text());
  assert.equal(Number(recoveredA.headers.get('ratelimit-limit')), 1000, 'the restarted ratelimit process still has the same policy (persisted to its real DB_PATH file, not :memory:)');
  assert.ok(Number.isFinite(Number(recoveredA.headers.get('ratelimit-remaining'))), 'real ratelimit-remaining is back — enforcement resumed automatically, per-request');
});
