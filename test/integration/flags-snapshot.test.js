import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { freePort, randomSecret, ServiceProcess, stopAll } from './harness.js';

/**
 * Real cross-process flow: a single `flags` service, spawned as its own `node` process, exercised
 * purely over HTTP for the snapshot/ETag/evaluate loop a client SDK actually relies on — create a
 * flag, read its snapshot, evaluate it, change its rollout, and confirm the snapshot's version/etag
 * and the evaluation outcome both move in lockstep, including real conditional-request (304)
 * behaviour. The evaluator's bucketing math itself is already proven deterministically correct by
 * the 500 golden vectors (`flags/test/golden-vectors.test.js`); this test never re-derives that —
 * it only proves the live HTTP surface wires create → snapshot → evaluate → update → snapshot
 * correctly against a real running process.
 *
 * Spawns a real `node` process and so only runs when explicitly requested: `STACK_INTEGRATION=1 npm
 * test`. Plain `npm test` skips it (see harness-self-test.test.js for the always-on tests).
 */
const shouldRun = Boolean(process.env.STACK_INTEGRATION);
const skip = shouldRun ? false : 'set STACK_INTEGRATION=1 to run (spawns a real service process)';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @type {string} */ let scratch;
/** @type {ServiceProcess} */ let flags;
/** @type {string} */ let apiKeySecret;

before(async () => {
  if (!shouldRun) return;
  scratch = mkdtempSync(join(tmpdir(), 'stack-integration-flags-'));
  const port = await freePort();
  apiKeySecret = randomSecret();
  flags = new ServiceProcess({
    name: 'flags', cwd: join(workspaceRoot, 'flags'), entry: 'src/index.js', port,
    env: {
      PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info', DB_PATH: ':memory:',
      // One unscoped readwrite key: touches every configured environment (defaults to dev,staging,prod).
      FLAGS_API_KEYS: `harness:${apiKeySecret}:readwrite`,
    },
  });
  await flags.start();
});

after(async () => {
  if (!shouldRun) return;
  await stopAll([flags]);
  rmSync(scratch, { recursive: true, force: true });
});

/** @param {string} path @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [o] */
async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${flags.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKeySecret}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

test('create -> snapshot -> etag -> evaluate -> update -> snapshot, entirely through the real flags HTTP API', { skip }, async () => {
  // 1. Create a boolean flag, enabled in every environment. `enabled` at creation applies
  // identically to every configured env; percentage/rules are not settable at creation (the
  // service hard-codes percentage: 100, rules: [] for every env on insert — confirmed below from
  // the snapshot itself, not assumed).
  const createRes = await call('/v1/flags', { method: 'POST', body: { key: 'test.flag', kind: 'boolean', enabled: true } });
  const createBody = await createRes.json();
  assert.equal(createRes.status, 201, `flag creation should return 201: ${JSON.stringify(createBody)}. Recent lines: ${JSON.stringify(flags.lines.slice(-10).map((l) => l.raw))}`);

  // 2. First snapshot: capture etag1/version1, and confirm the fresh flag's actual rollout state
  // rather than assuming it (this is the live contract, not the golden-vector math).
  const snap1Res = await call('/v1/snapshot/dev');
  const etag1 = snap1Res.headers.get('etag');
  assert.ok(etag1, 'snapshot response carries an etag header');
  assert.equal(snap1Res.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
  const snap1 = await snap1Res.json();
  const version1 = snap1.version;
  assert.equal(etag1, `"dev-${version1}"`, 'etag is exactly "<env>-<version>", not a content hash');
  const state1 = snap1.flags['test.flag'];
  assert.ok(state1, 'the created flag appears in the dev snapshot');
  assert.equal(state1.enabled, true);
  assert.equal(state1.percentage, 100, 'a freshly created flag starts at percentage 100 for every env (not settable at creation)');
  assert.deepEqual(state1.rules, []);
  assert.equal(state1.value, true, 'boolean flag with no explicit value defaults to true (the "on" default for its kind)');

  // 3. Evaluate before the update. With percentage 100 the evaluator short-circuits to the
  // unconditional "default" reason for every context, regardless of bucketing — this is why the
  // update below moves percentage to 0 rather than to 100 (100 is already where creation leaves
  // it, so a 100->100 change would be a no-op and prove nothing).
  const ctx = { userId: 'user-123' };
  const beforeRes = await call('/v1/evaluate', { method: 'POST', body: { env: 'dev', keys: ['test.flag'], context: ctx, details: true } });
  const before = await beforeRes.json();
  assert.equal(beforeRes.status, 200, JSON.stringify(before));
  assert.equal(before.version, version1);
  const beforeEval = before.flags['test.flag'];
  assert.equal(beforeEval.reason, 'default');
  assert.equal(beforeEval.value, true);

  // 4. Update dev's rollout: percentage 100 -> 0. Enabled stays true, but with percentage <= 0 the
  // evaluator's `excluded` branch is unconditional (no bucket hashing involved), so this
  // deterministically flips evaluation to `offValue` for any context, not a coin flip on userId.
  const patchRes = await call('/v1/flags/test.flag/envs/dev', { method: 'PATCH', body: { percentage: 0, rules: [] } });
  const patchBody = await patchRes.json();
  assert.equal(patchRes.status, 200, `env update should return 200: ${JSON.stringify(patchBody)}`);
  assert.equal(patchBody.state.percentage, 0);

  // 5. Second snapshot: version/etag must have moved by exactly one mutation.
  const snap2Res = await call('/v1/snapshot/dev');
  const etag2 = snap2Res.headers.get('etag');
  const snap2 = await snap2Res.json();
  const version2 = snap2.version;
  assert.equal(version2, version1 + 1, 'the PATCH is the only mutation between snapshots, so the per-env version counter advances by exactly 1');
  assert.notEqual(etag2, etag1);
  assert.equal(etag2, `"dev-${version2}"`);
  assert.equal(snap2.flags['test.flag'].percentage, 0);

  // 6. A conditional request against the OLD etag must NOT be treated as still-fresh: state has
  // changed, so this must be a full 200 with the new content, not a 304.
  const staleRes = await call('/v1/snapshot/dev', { headers: { 'if-none-match': etag1 } });
  assert.equal(staleRes.status, 200, 'a stale If-None-Match (old etag) must get the full, current snapshot, not 304');
  const staleBody = await staleRes.json();
  assert.equal(staleBody.version, version2);

  // 7. A conditional request against the CURRENT etag must be a real 304 with no body.
  const freshRes = await call('/v1/snapshot/dev', { headers: { 'if-none-match': etag2 } });
  assert.equal(freshRes.status, 304, 'the current etag must be honoured with 304');
  const freshText = await freshRes.text();
  assert.equal(freshText, '', '304 response must carry no body');

  // 8. Evaluate again with the identical request body used in step 3. The percentage 100 -> 0
  // change must flip the outcome for the same context, using the *new* rollout state end to end
  // (never a mix of old and new).
  const afterRes = await call('/v1/evaluate', { method: 'POST', body: { env: 'dev', keys: ['test.flag'], context: ctx, details: true } });
  const after = await afterRes.json();
  assert.equal(afterRes.status, 200, JSON.stringify(after));
  assert.equal(afterRes.headers.get('x-flags-version'), String(version2));
  assert.equal(after.version, version2, 'evaluate reports the post-update version');
  const afterEval = after.flags['test.flag'];
  assert.equal(afterEval.reason, 'excluded', 'percentage 0 deterministically excludes every context');
  assert.equal(afterEval.value, false, 'excluded evaluates to offValue (false), flipped from the pre-update true');
  assert.notEqual(afterEval.value, beforeEval.value, 'the rollout change actually changed the evaluated outcome, not just internal bookkeeping');
});
