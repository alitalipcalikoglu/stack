import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll, waitUntil } from './harness.js';

/**
 * Stage 11: proves the real end-to-end business flow through webhook-out's actual worker —
 * retry/backoff, auto-disable and ordered-delivery blocking — against a real `node:http` receiver,
 * not fake DB mutations. The cross-process SQL-level atomicity of the ordered/per-subscription
 * concurrency cap is already proven by `webhook-out/test/ordering-and-cap.test.js`; this file only
 * exercises the worker's business-level retry/disable/ordering behaviour through the real HTTP API.
 *
 * Each scenario gets its own real `node` webhook-out process (`role: 'combined'`, the default —
 * HTTP API and worker in one process) because each needs different RETRY_SCHEDULE_SEC /
 * DISABLE_AFTER_FAILURES envs, plus its own in-process `node:http` receiver (a real receiver, but
 * the receiver itself doesn't need to be a separate OS process per Stage 11's own rule — only the
 * service under test does).
 *
 * Spawns real service processes, so it only runs when explicitly requested: `STACK_INTEGRATION=1
 * npm test`. Plain `npm test` stays fast and spawns nothing.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns real service processes)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** @type {string} */ let scratch;
/** @type {ServiceProcess[]} */ const services = [];
/** @type {import('node:http').Server[]} */ const receivers = [];

before(() => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'webhook-out-integration-'));
});

after(async () => {
  if (!shouldRun) return;
  await stopAll(services);
  await Promise.all(receivers.map((s) => new Promise((r) => s.close(r))));
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A real `node:http` receiver that fails (500) the FIRST request it sees for a given delivery
 * (identified by the `x-webhook-delivery` header webhook-out's real `HttpCaller` sends) and
 * succeeds (200) every request after that. Reused by scenarios 1 and 3, which both need "fails
 * once, then recovers on retry" but at different subscriptions/timings.
 */
function failFirstThenSucceed() {
  /** @type {Map<string, number>} */
  const counts = new Map();
  return {
    countFor: (/** @type {string} */ deliveryId) => counts.get(deliveryId) ?? 0,
    /** @param {import('node:http').IncomingMessage} req */
    handle: (req) => {
      const deliveryId = /** @type {string} */ (req.headers['x-webhook-delivery']);
      const n = (counts.get(deliveryId) ?? 0) + 1;
      counts.set(deliveryId, n);
      return n === 1 ? 500 : 200;
    },
  };
}

/** Always fails. Used by scenario 2 to exhaust the retry schedule and trip auto-disable. */
function alwaysFail() {
  return { handle: () => 500 };
}

/**
 * Starts a real HTTP server on `port` that drains the request body then answers with the status
 * `handler.handle(req)` returns. Resolves once listening.
 * @param {number} port
 * @param {{ handle: (req: import('node:http').IncomingMessage) => number }} handler
 */
function startReceiver(port, handler) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const status = handler.handle(req);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

/**
 * Spawns a real webhook-out process (`role: 'combined'`, the default) with a fresh in-memory DB,
 * pointed at 127.0.0.1 targets (the local receivers), and returns it plus the one `readwrite` API
 * key it accepts.
 * @param {{ name: string, retryScheduleSec: string, disableAfterFailures?: number }} o
 */
async function startWebhookOut({ name, retryScheduleSec, disableAfterFailures = 10 }) {
  const port = await freePort();
  const apiKey = randomSecret();
  const proc = new ServiceProcess({
    name, cwd: join(workspaceRoot, 'webhook-out'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      WEBHOOK_API_KEYS: `harness:${apiKey}:readwrite`,
      SECRETS_KEY: randomSecret(32),
      TARGET_ALLOW_HTTP: 'true', TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: '127.0.0.1',
      RETRY_SCHEDULE_SEC: retryScheduleSec,
      DISABLE_AFTER_FAILURES: String(disableAfterFailures),
      POLL_MS: '100', DELIVERY_TIMEOUT_MS: '2000',
    },
  });
  await proc.start();
  services.push(proc);
  return { proc, apiKey };
}

/** @param {{ baseUrl: string }} proc @param {string} apiKey */
function authed(proc, apiKey) {
  return (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
    fetch(`${proc.baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
}

/**
 * Creates a subscription and returns its id.
 * @param {ReturnType<typeof authed>} call
 * @param {{ name: string, url: string, events: string[], ordered?: boolean }} o
 */
async function createSubscription(call, { name, url, events, ordered = false }) {
  const res = await call('/v1/subscriptions', { method: 'POST', body: JSON.stringify({ name, url, events, ordered }) });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.subscription.id;
}

/**
 * Publishes an event and returns { eventId, deliveryId } for the (single) matching subscription.
 * @param {ReturnType<typeof authed>} call
 * @param {{ type: string, data: unknown }} o
 */
async function publishAndGetDelivery(call, { type, data }) {
  const res = await call('/v1/events', { method: 'POST', body: JSON.stringify({ type, data }) });
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  assert.equal(body.deliveries, 1, `expected exactly one matching subscription; got ${body.deliveries}`);
  const eventRes = await call(`/v1/events/${body.event.id}`);
  const eventBody = await eventRes.json();
  assert.equal(eventBody.deliveries.length, 1);
  return { eventId: body.event.id, deliveryId: eventBody.deliveries[0].id };
}

/** @param {ReturnType<typeof authed>} call @param {number} deliveryId */
async function getDelivery(call, deliveryId) {
  const res = await call(`/v1/deliveries/${deliveryId}`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.delivery;
}

/** @param {ReturnType<typeof authed>} call @param {string} subscriptionId */
async function getSubscription(call, subscriptionId) {
  const res = await call(`/v1/subscriptions/${subscriptionId}`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.subscription;
}

test('scenario 1: a delivery that fails once (500) then succeeds (200) on retry reaches "succeeded" with the exact attempt history, and the real receiver saw exactly 2 requests', { skip }, async (t) => {
  const receiverPort = await freePort();
  const receiver = failFirstThenSucceed();
  const server = await startReceiver(receiverPort, receiver);
  receivers.push(server);
  t.after(() => new Promise((r) => server.close(r)));

  const { proc, apiKey } = await startWebhookOut({ name: 'webhook-out-s1', retryScheduleSec: '1' }); // maxAttempts = 2
  const call = authed(proc, apiKey);

  const subId = await createSubscription(call, { name: 'retry-then-succeed', url: `http://127.0.0.1:${receiverPort}/hook`, events: ['order.created'] });
  const { deliveryId } = await publishAndGetDelivery(call, { type: 'order.created', data: { orderId: 'o-1' } });

  const delivery = await waitUntil(async () => {
    const d = await getDelivery(call, deliveryId);
    return d.status === 'succeeded' ? d : null;
  }, { timeoutMs: 12_000, message: `delivery ${deliveryId} to reach status "succeeded"` });

  assert.equal(delivery.attempt, 2, `expected 2 attempts, got attempts: ${JSON.stringify(delivery.attempts)}`);
  assert.equal(delivery.attempts.length, 2);
  assert.equal(delivery.attempts[0].httpStatus, 500);
  assert.equal(delivery.attempts[1].httpStatus, 200);
  assert.equal(receiver.countFor(String(deliveryId)), 2, 'the real receiver process (in-process HTTP server) actually received exactly 2 requests for this delivery');
  assert.notEqual(delivery.status, 'running', 'no stuck running state after the delivery finished');
  assert.equal(subId.startsWith('sub_'), true);
});

test('scenario 2: a delivery that exhausts the retry schedule reaches terminal "failed" with maxAttempts honoured, and the subscription is auto-disabled only after the real configured DISABLE_AFTER_FAILURES consecutive failures (not a hardcoded 5)', { skip }, async (t) => {
  const receiverPort = await freePort();
  const receiver = alwaysFail();
  const server = await startReceiver(receiverPort, receiver);
  receivers.push(server);
  t.after(() => new Promise((r) => server.close(r)));

  // DISABLE_AFTER_FAILURES=2 (not the real default of 10, and explicitly not "5" per any plan-style
  // claim) and RETRY_SCHEDULE_SEC=1,1 -> maxAttempts=3, so exhaustion takes ~2s per delivery.
  const { proc, apiKey } = await startWebhookOut({ name: 'webhook-out-s2', retryScheduleSec: '1,1', disableAfterFailures: 2 });
  const call = authed(proc, apiKey);

  const subId = await createSubscription(call, { name: 'always-fails', url: `http://127.0.0.1:${receiverPort}/hook`, events: ['order.failed'] });

  const { deliveryId: d1 } = await publishAndGetDelivery(call, { type: 'order.failed', data: { orderId: 'o-2a' } });
  const delivery1 = await waitUntil(async () => {
    const d = await getDelivery(call, d1);
    return d.status === 'failed' ? d : null;
  }, { timeoutMs: 12_000, message: `delivery ${d1} to reach terminal status "failed"` });
  assert.equal(delivery1.attempt, 3, `expected maxAttempts (3) attempts exhausted, got attempts: ${JSON.stringify(delivery1.attempts)}`);
  assert.equal(delivery1.attempts.every((/** @type {any} */ a) => a.httpStatus === 500), true);

  let sub = await getSubscription(call, subId);
  assert.equal(sub.status, 'active', 'only 1 consecutive terminal failure so far; threshold is 2, so the subscription must still be active');

  const healthRes1 = await fetch(`${proc.baseUrl}/health`);
  assert.equal(healthRes1.status, 200, 'worker process still alive and responsive after the first exhausted delivery');

  const { deliveryId: d2 } = await publishAndGetDelivery(call, { type: 'order.failed', data: { orderId: 'o-2b' } });
  await waitUntil(async () => {
    const d = await getDelivery(call, d2);
    return d.status === 'failed' ? d : null;
  }, { timeoutMs: 12_000, message: `delivery ${d2} to reach terminal status "failed"` });

  sub = await waitUntil(async () => {
    const s = await getSubscription(call, subId);
    return s.status === 'disabled' ? s : null;
  }, { timeoutMs: 5_000, message: `subscription ${subId} to be auto-disabled after 2 consecutive failed deliveries` });
  assert.equal(sub.consecutiveFailures, 2);

  const healthRes2 = await fetch(`${proc.baseUrl}/health`);
  assert.equal(healthRes2.status, 200, 'worker process still alive and responsive after auto-disable');
});

test('scenario 3: an ordered subscription never lets delivery N+1 run while delivery N is still pending/running/retrying, proven through the real worker and real HTTP API (not the SQL layer directly)', { skip }, async (t) => {
  const receiverPort = await freePort();
  const receiver = failFirstThenSucceed();
  const server = await startReceiver(receiverPort, receiver);
  receivers.push(server);
  t.after(() => new Promise((r) => server.close(r)));

  // RETRY_SCHEDULE_SEC starting at 2s gives an observable window where delivery N sits in
  // "retrying" (not yet re-attempted) so N+1's non-overtaking can actually be checked mid-flight.
  const { proc, apiKey } = await startWebhookOut({ name: 'webhook-out-s3', retryScheduleSec: '2,2' });
  const call = authed(proc, apiKey);

  const subId = await createSubscription(call, { name: 'ordered-sub', url: `http://127.0.0.1:${receiverPort}/hook`, events: ['order.ordered'], ordered: true });

  const { deliveryId: idA } = await publishAndGetDelivery(call, { type: 'order.ordered', data: { orderId: 'a' } });
  const { deliveryId: idB } = await publishAndGetDelivery(call, { type: 'order.ordered', data: { orderId: 'b' } });
  assert.ok(idB > idA, 'delivery B was queued after delivery A (higher id), as the ordered-blocking claim query keys on');

  // While A is in flight or retrying (its first attempt fails and its retry is ~2s out), B must
  // never be claimed: poll several times over ~1.2s to catch a "running" B if the worker ever let
  // it overtake, rather than checking only once.
  const deadline = Date.now() + 1_200;
  let sawRunning = false;
  const bStatuses = [];
  while (Date.now() < deadline) {
    const b = await getDelivery(call, idB);
    bStatuses.push(b.status);
    if (b.status === 'running') sawRunning = true;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(sawRunning, false, `delivery B (N+1) must never become "running" while A (N) is still active; observed B statuses: ${JSON.stringify(bStatuses)}`);
  assert.ok(bStatuses.every((s) => s === 'pending'), `delivery B must stay "pending" the whole window while A is retrying; observed: ${JSON.stringify(bStatuses)}`);

  const finalA = await waitUntil(async () => {
    const d = await getDelivery(call, idA);
    return d.status === 'succeeded' ? d : null;
  }, { timeoutMs: 15_000, message: `delivery A (${idA}) to reach "succeeded"` });
  const finalB = await waitUntil(async () => {
    const d = await getDelivery(call, idB);
    return d.status === 'succeeded' ? d : null;
  }, { timeoutMs: 15_000, message: `delivery B (${idB}) to reach "succeeded"` });

  assert.ok(finalA.finishedAt, 'delivery A has a finishedAt once terminal');
  assert.ok(finalB.attempts[0]?.startedAt, 'delivery B has a first-attempt startedAt once it ran');
  assert.ok(
    new Date(finalA.finishedAt).getTime() <= new Date(finalB.attempts[0].startedAt).getTime(),
    `A must finish before B's first attempt starts; A.finishedAt=${finalA.finishedAt}, B.attempts[0].startedAt=${finalB.attempts[0].startedAt}`,
  );
  assert.equal(receiver.countFor(String(idA)), 2);
  assert.equal(receiver.countFor(String(idB)), 2);
  assert.ok(subId.startsWith('sub_'));
});
