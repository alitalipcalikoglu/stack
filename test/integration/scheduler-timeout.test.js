import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll, waitUntil } from './harness.js';

/**
 * Real cross-process failure-recovery test: a real `scheduler` `node` child process (not a mock,
 * not an in-process fake) is pointed at a local HTTP target that accepts the connection and then
 * never writes a response. That genuinely drives scheduler's outbound call through Node's own
 * socket-idle `timeout` (see `net/http-caller.js` / `@atc-web/service-core`'s `HttpCaller.send`,
 * which uses `http.request`'s `timeout` option, not `AbortSignal.timeout`) rather than a fast,
 * uninteresting connection-refused error. Stage 11 proves the whole retry/backoff/exhaustion cycle
 * survives that, that no run is left stuck `running`, and that the worker keeps processing other
 * work afterward — all observed the way another process would, over `/v1` HTTP, never by reaching
 * into scheduler's process or database directly.
 *
 * Spawns a real service process, so it only runs on request: `STACK_INTEGRATION=1 npm test`. Plain
 * `npm test` skips it (see harness-self-test.test.js for the always-on tests).
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns a real service process)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {string} */ let scratch;
/** @type {ServiceProcess} */ let scheduler;
/** @type {string} */ let apiKeySecret;
/** @type {import('node:http').Server} */ let hangingTarget;
/** @type {string} */ let hangingTargetUrl;

before(async () => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-integration-'));

  // Accepts the connection, then writes nothing, ever: the only way to genuinely exercise the
  // socket-idle timeout instead of a fast connection-refused/ECONNREFUSED error.
  hangingTarget = createServer((_req, _res) => {
    // Deliberately never call res.end() or res.write() — the request just sits open.
  });
  const hangingPort = await freePort();
  await new Promise((res) => hangingTarget.listen(hangingPort, '127.0.0.1', () => res(undefined)));
  hangingTargetUrl = `http://127.0.0.1:${hangingPort}/hang`;

  const schedulerPort = await freePort();
  apiKeySecret = randomSecret();
  scheduler = new ServiceProcess({
    name: 'scheduler', cwd: join(workspaceRoot, 'scheduler'), entry: 'src/index.js', port: schedulerPort,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(schedulerPort), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      SIGNING_SECRET: randomSecret(), SCHEDULER_API_KEYS: `harness:${apiKeySecret}:readwrite`,
      // The target URL is http://127.0.0.1:<port> — allow plain http and loopback explicitly, the
      // same SSRF-allowlist knobs a real operator would set for an internal target.
      TARGET_ALLOW_HTTP: 'true', TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: '127.0.0.1',
      // Fast-test knobs from the Stage 11 brief: fastest legal poll/lease/heartbeat pair, and a
      // 1000ms timeout (the real hard floor — DEFAULT_TIMEOUT_MS/MAX_TIMEOUT_MS/job timeoutMs can't
      // go any lower).
      POLL_MS: '100', DEFAULT_TIMEOUT_MS: '1000', MAX_TIMEOUT_MS: '1000', LEASE_MS: '2000', HEARTBEAT_MS: '250',
    },
  });
  await scheduler.start();
});

after(async () => {
  if (!shouldRun) return;
  await stopAll([scheduler]);
  await new Promise((res) => hangingTarget.close(res));
  rmSync(scratch, { recursive: true, force: true });
});

const authHeader = () => ({ authorization: `Bearer ${apiKeySecret}`, 'content-type': 'application/json' });

/**
 * Creates a job and returns its name. `retry` and `timeoutMs` are top-level create-body fields per
 * the real schema (`scheduler/src/http/schemas.js` `Schemas.create`) — NOT nested under `target`,
 * which only takes `url`/`method`/`headers`/`body`.
 * @param {{ name: string, url: string, timeoutMs: number, retry: { max: number, backoffSec: number } }} o
 */
async function createJob({ name, url, timeoutMs, retry }) {
  const res = await fetch(`${scheduler.baseUrl}/v1/jobs`, {
    method: 'POST', headers: authHeader(),
    // A harmless, far-future cron: schedule.at/cron is required by the schema even though this
    // test only ever fires the job through the manual /run endpoint, never through the cron clock.
    body: JSON.stringify({ name, schedule: { cron: '0 0 1 1 *' }, target: { url, method: 'GET' }, timeoutMs, retry }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.job.name;
}

/** @param {string} name */
async function triggerRun(name) {
  const res = await fetch(`${scheduler.baseUrl}/v1/jobs/${name}/run`, { method: 'POST', headers: authHeader() });
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  return body.run;
}

/** @param {number} id */
async function getRun(id) {
  const res = await fetch(`${scheduler.baseUrl}/v1/runs/${id}`, { headers: authHeader() });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.run;
}

test('a job whose target hangs forever times out, retries with backoff, exhausts its attempts, leaves nothing stuck running, and the worker keeps serving other jobs', { skip }, async (t) => {
  const jobName = 'harness-hanging-target';
  await createJob({ name: jobName, url: hangingTargetUrl, timeoutMs: 1000, retry: { max: 2, backoffSec: 1 } });
  const triggered = await triggerRun(jobName);
  assert.equal(triggered.status, 'pending');

  // 3 attempts x ~1s socket timeout + ~1s + ~2s backoff between them ≈ 6-8s; generous headroom.
  const finalRun = await waitUntil(async () => {
    const run = await getRun(triggered.id);
    return run.status === 'failed' ? run : null;
  }, {
    timeoutMs: 15_000, intervalMs: 250,
    message: `run ${triggered.id} (job ${jobName}) to reach status "failed". Recent scheduler lines: ${JSON.stringify(scheduler.lines.slice(-10).map((l) => l.raw))}`,
  });

  assert.equal(finalRun.attempt, 3, `maxAttempts = retry.max(2) + 1 = 3 attempts exhausted. Run: ${JSON.stringify(finalRun)}`);
  assert.equal(finalRun.maxAttempts, 3);
  assert.equal(finalRun.attempts.length, 3, `one recorded attempt per try. Run: ${JSON.stringify(finalRun)}`);
  for (const attempt of finalRun.attempts) {
    assert.ok(attempt.error, `attempt ${attempt.n} should carry a non-null error. Attempt: ${JSON.stringify(attempt)}`);
    assert.match(attempt.error, /timed out/i, `attempt ${attempt.n}'s error should describe the socket timeout, not some other failure. Attempt: ${JSON.stringify(attempt)}`);
    assert.equal(attempt.httpStatus, null, 'the hanging target never sent a status line');
  }

  // No run left stuck `running` for this job — immediately, and again a couple seconds later to be
  // sure the terminal state doesn't "un-terminal" itself (e.g. a stray heartbeat or reclaim sweep).
  const assertNothingRunning = async () => {
    const res = await fetch(`${scheduler.baseUrl}/v1/runs?status=running&job=${jobName}`, { headers: authHeader() });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.items.length, 0, `expected no run stuck running for ${jobName}, got: ${JSON.stringify(body.items)}`);
  };
  await assertNothingRunning();
  await new Promise((r) => setTimeout(r, 2_500));
  await assertNothingRunning();

  // The scheduler process itself survived the whole ordeal.
  const healthRes = await fetch(`${scheduler.baseUrl}/health`);
  assert.equal(healthRes.status, 200);

  // And the worker loop is still actively processing new work, not wedged: a second, trivial job
  // against a target that answers immediately with 200 should reach `succeeded` quickly.
  const okTarget = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  const okPort = await freePort();
  await new Promise((res) => okTarget.listen(okPort, '127.0.0.1', () => res(undefined)));
  t.after(() => new Promise((res) => okTarget.close(() => res(undefined))));

  const okJobName = 'harness-ok-target';
  await createJob({ name: okJobName, url: `http://127.0.0.1:${okPort}/ok`, timeoutMs: 1000, retry: { max: 0, backoffSec: 1 } });
  const okTriggered = await triggerRun(okJobName);

  const okRun = await waitUntil(async () => {
    const run = await getRun(okTriggered.id);
    return run.status === 'succeeded' ? run : null;
  }, {
    timeoutMs: 5_000, intervalMs: 200,
    message: `run ${okTriggered.id} (job ${okJobName}) to reach status "succeeded" — proves the worker loop is still alive after the hanging-target ordeal. Recent scheduler lines: ${JSON.stringify(scheduler.lines.slice(-10).map((l) => l.raw))}`,
  });
  assert.equal(okRun.httpStatus, 200);
});
