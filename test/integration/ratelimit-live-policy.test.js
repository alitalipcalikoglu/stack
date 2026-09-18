import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll, waitUntil } from './harness.js';

/**
 * Stage 11 item 10: a policy updated live (`PATCH /v1/policies/:name`) while concurrent `/v1/check`
 * traffic is in flight against it, against the real `ratelimit` process (not a mock). The ground
 * truth this test leans on: `policy-store.js#update` is one `UPDATE ... WHERE name = ?` statement,
 * so SQLite's single-process atomicity guarantees a concurrent reader only ever sees the fully-old
 * or fully-new row — never a torn one. What this test does NOT claim (per the Stage 11 spec): which
 * exact in-flight request lands on which side of the update. It only asserts every response, across
 * the whole burst, is well-formed — and that the new policy is deterministically in effect once the
 * update has actually landed.
 *
 * Spawns a real process, so it only runs when explicitly requested: `STACK_INTEGRATION=1 npm test`.
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns a real service process)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {string} */ let scratch;
/** @type {ServiceProcess} */ let ratelimit;
/** @type {string} */ let harnessApiKeySecret;

const policyName = 'live-policy-test';
const INITIAL_LIMITS = [{ window: 60, limit: 1000 }];
const PATCHED_LIMITS = [{ window: 60, limit: 3 }];

before(async () => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-integration-'));
  harnessApiKeySecret = randomSecret();
  const port = await freePort();
  ratelimit = new ServiceProcess({
    name: 'ratelimit', cwd: join(workspaceRoot, 'ratelimit'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info',
      DB_PATH: join(scratch, 'ratelimit.db'), RATELIMIT_API_KEYS: `harness:${harnessApiKeySecret}:readwrite`,
    },
  });
  await ratelimit.start();

  const res = await fetch(`${ratelimit.baseUrl}/v1/policies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harnessApiKeySecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: policyName, limits: INITIAL_LIMITS }),
  });
  assert.equal(res.status, 201, await res.text());
});

after(async () => {
  if (!shouldRun) return;
  await stopAll([ratelimit].filter(Boolean));
  rmSync(scratch, { recursive: true, force: true });
});

/** @param {string} subject */
async function check(subject) {
  const res = await fetch(`${ratelimit.baseUrl}/v1/check`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harnessApiKeySecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ policy: policyName, subject }),
  });
  let body = null;
  let parseError = null;
  try {
    body = await res.json();
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  return { status: res.status, body, parseError };
}

/** @param {string} label @param {number} n */
function freshSubjects(label, n) {
  return Array.from({ length: n }, (_, i) => `${label}-${i}-${randomSecret(4)}`);
}

/**
 * Every response in the burst uses its OWN never-before-seen subject and costs 1, so it is allowed
 * under either the old (1000) or the new (3) limit — the point isn't which limit it landed under,
 * only that the shape is never corrupt or impossible regardless of which side of the PATCH it fell on.
 * @param {{ status: number, body: any, parseError: string|null }[]} results
 */
function assertAllWellFormed(results) {
  for (const r of results) {
    assert.equal(r.parseError, null, `response body must parse as JSON, got error: ${r.parseError}`);
    assert.equal(r.status, 200, `check responded ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body, 'response body present');
    assert.equal(typeof r.body.allowed, 'boolean', `allowed must be a boolean, got ${JSON.stringify(r.body.allowed)}`);
    assert.ok(Number.isFinite(r.body.limit), `limit must be a finite number, got ${JSON.stringify(r.body.limit)}`);
    assert.ok(Number.isFinite(r.body.remaining), `remaining must be a finite number, got ${JSON.stringify(r.body.remaining)}`);
    assert.ok(r.body.remaining >= 0, `remaining must never be negative, got ${r.body.remaining}`);
    assert.equal(r.body.allowed, true, 'a brand-new subject costing 1 must be allowed under either the old (1000) or new (3) limit');
  }
}

test('ratelimit (real process): a policy PATCHed while concurrent /v1/check traffic is in flight never produces a corrupt response, and the new limits are deterministically in effect afterward', { skip }, async () => {
  // ---- Burst, batch 1: ~30 concurrent checks against the policy before any update is sent.
  const batch1 = await Promise.all(freshSubjects('b1', 30).map((s) => check(s)));

  await new Promise((r) => setTimeout(r, 300));

  // ---- Burst, batch 2, concurrently WITH the PATCH itself — genuinely in flight together, not
  // sequenced strictly before/after (Promise.all races them against the real process).
  const batch2Promise = Promise.all(freshSubjects('b2', 30).map((s) => check(s)));
  const patchPromise = fetch(`${ratelimit.baseUrl}/v1/policies/${policyName}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${harnessApiKeySecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limits: PATCHED_LIMITS }),
  });
  const [batch2, patchRes] = await Promise.all([batch2Promise, patchPromise]);
  const patchText = await patchRes.text();
  assert.equal(patchRes.status, 200, patchText);
  const patchedPolicy = JSON.parse(patchText);
  assert.deepEqual(patchedPolicy.policy.limits, PATCHED_LIMITS, 'the patch response itself reports the new limits');

  await new Promise((r) => setTimeout(r, 300));

  // ---- Burst, batch 3: ~30 more concurrent checks after the PATCH has been sent (the update is
  // already awaited above, so by SQLite's single-writer atomicity these are guaranteed post-update —
  // still asserted with the same "always allowed, well-formed" check as the other two batches).
  const batch3 = await Promise.all(freshSubjects('b3', 30).map((s) => check(s)));

  const all = [...batch1, ...batch2, ...batch3];
  assert.equal(all.length, 90, 'sanity: every fired check produced a settled result');
  assertAllWellFormed(all);

  // No response in ANY batch, including the ones genuinely racing the PATCH, ever saw a torn or
  // impossible intermediate state (e.g. remaining negative, or a non-finite/undefined number) —
  // proof the single UPDATE statement is atomic from a concurrent reader's point of view.

  // ---- The process itself must still be alive and responsive after the burst.
  const health = await fetch(`${ratelimit.baseUrl}/health`);
  assert.equal(health.status, 200);

  // ---- Eventually, fresh checks deterministically reflect the NEW policy: a brand-new subject
  // hits denied on its 4th check (limit 3), long before it ever would have under the old limit
  // (1000). Wrapped in waitUntil for robustness even though the PATCH above was already awaited,
  // so this should hold on the very first attempt.
  await waitUntil(async () => {
    const subject = `post-patch-${randomSecret(4)}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await check(subject));
    for (const r of results) if (r.parseError || typeof r.body?.allowed !== 'boolean') return false;
    return results[0].body.allowed === true && results[1].body.allowed === true && results[2].body.allowed === true && results[3].body.allowed === false;
  }, { timeoutMs: 5_000, message: 'a fresh subject is denied on its 4th check, proving the new limit of 3 is deterministically in effect' });
});
