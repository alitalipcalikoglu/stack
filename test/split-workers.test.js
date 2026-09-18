import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SERVICES } from '../src/manifest.js';
import { Stack } from '../src/stack.js';

const require = createRequire(import.meta.url);

/**
 * Stage 12: `stack up --split-workers`. Fully synthetic fixtures (no dependency on the sibling
 * repos actually being checked out, unlike the STACK_INTEGRATION suite) — a temp root carrying only
 * what {@link Stack#generateSplitEcosystem} and {@link Stack#up}/{@link Stack#down} actually touch:
 * each split-capable service's own `package.json` + `ecosystem.config.cjs` (shaped exactly like the
 * real ones, with a distinct `kill_timeout` per fixture so a passing assertion can't be an accident
 * of every fixture sharing one number) plus the two real entry points it must reference,
 * `src/api-main.js`/`src/worker-main.js`. `exec` is injected throughout, so no real `pm2` binary is
 * needed, matching `pm2 is not installed` being a runtime-only concern (`#requirePm2`).
 */

const root = mkdtempSync(join(tmpdir(), 'atc-stack-split-'));
after(() => rmSync(root, { recursive: true, force: true }));

const SPLIT_IDS = SERVICES.filter((s) => s.splitWorkers).map((s) => s.id);
const NON_SPLIT_IDS = SERVICES.filter((s) => !s.splitWorkers).map((s) => s.id);

/** @param {string} id */
function serviceOf(id) {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error(`no manifest entry for "${id}"`);
  return s;
}

/**
 * A real-shaped combined ecosystem.config.cjs, one distinct kill_timeout per fixture service.
 * @param {string} id @param {number} killTimeoutMs
 */
function ecosystemFixture(id, killTimeoutMs) {
  return `const path = require('node:path');
module.exports = {
  apps: [
    {
      name: '${id}',
      cwd: __dirname,
      script: 'src/index.js',
      node_args: ['--disable-warning=ExperimentalWarning', \`--env-file=\${path.join(__dirname, '.env')}\`],
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      max_memory_restart: '300M',
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: ${killTimeoutMs},
      merge_logs: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
`;
}

// Distinct kill_timeout per split service (150000/630000/222222) so a test that passed by
// coincidence on one shared constant would fail on the others.
/** @type {Record<string, number>} */
const FIXTURE_KILL_TIMEOUT = { notify: 150_000, scheduler: 630_000, 'webhook-out': 222_222 };
for (const id of SPLIT_IDS) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","type":"module"}\n');
  writeFileSync(join(dir, 'ecosystem.config.cjs'), ecosystemFixture(id, FIXTURE_KILL_TIMEOUT[id]));
  writeFileSync(join(dir, 'src', 'api-main.js'), '// fixture\n');
  writeFileSync(join(dir, 'src', 'worker-main.js'), '// fixture\n');
}

test('manifest: exactly notify, scheduler, webhook-out are marked splitWorkers — the three real services with a split template', () => {
  assert.deepEqual(new Set(SPLIT_IDS), new Set(['notify', 'scheduler', 'webhook-out']));
});

test('generateSplitEcosystem: two apps, correct names, correct entry scripts, kill_timeout reused verbatim from the real combined app (not hardcoded)', () => {
  for (const id of SPLIT_IDS) {
    const stack = new Stack({ root, exec: async () => ({ code: 0, out: '' }) });
    const service = serviceOf(id);
    const relFile = stack.generateSplitEcosystem(service);
    assert.equal(relFile, 'ecosystem.split.generated.cjs');
    const fullPath = join(root, id, relFile);
    assert.ok(existsSync(fullPath), `${id}: generated file exists on disk`);

    // require() it for real — proves it is valid, loadable CommonJS, not just well-formed-looking text.
    delete require.cache[require.resolve(fullPath)];
    const { apps } = require(fullPath);
    assert.equal(apps.length, 2);
    const [api, worker] = apps;
    assert.equal(api.name, `${id}-api`);
    assert.equal(worker.name, `${id}-worker`);
    assert.equal(api.script, 'src/api-main.js');
    assert.equal(worker.script, 'src/worker-main.js');

    // The entry scripts a generated app references must actually exist, resolved the same way PM2 would (cwd + script).
    assert.ok(existsSync(join(root, id, api.script)), `${id}-api: referenced entry file exists`);
    assert.ok(existsSync(join(root, id, worker.script)), `${id}-worker: referenced entry file exists`);

    // The shutdown-budget invariant: api is fixed-small (no delivery/send/run ever in flight there);
    // worker's kill_timeout is the exact value from THIS fixture's own combined app, proving it was
    // read from the real file, not a constant baked into the generator.
    assert.equal(api.kill_timeout, Stack.SPLIT_API_KILL_TIMEOUT_MS);
    assert.equal(worker.kill_timeout, FIXTURE_KILL_TIMEOUT[id]);
    assert.ok(api.kill_timeout < worker.kill_timeout, `${id}: api kill_timeout must stay well under worker's`);

    // No secrets baked in: env carries only NODE_ENV, and node_args' --env-file flag is a path
    // pointing at the operator's own untracked .env, never a literal secret value.
    assert.deepEqual(api.env, { NODE_ENV: 'production' });
    assert.deepEqual(worker.env, { NODE_ENV: 'production' });
    for (const app of apps) {
      const envFileArg = app.node_args.find((/** @type {string} */ a) => a.startsWith('--env-file='));
      assert.ok(envFileArg, `${id}: node_args carries --env-file`);
      assert.ok(envFileArg.endsWith('/.env'), `${id}: --env-file points at the service's own .env file, not an inline value`);
    }
    assert.equal(api.wait_ready, true);
    assert.equal(worker.wait_ready, true);
    assert.equal(api.listen_timeout, 10_000, 'api listens, so it gets a listen_timeout');
    assert.equal(worker.listen_timeout, undefined, 'worker never listens, so it must not carry a listen_timeout');
  }
});

test('generateSplitEcosystem: app names are unique both within one service and across all split-capable services combined', () => {
  const stack = new Stack({ root, exec: async () => ({ code: 0, out: '' }) });
  /** @type {string[]} */ const allNames = [];
  for (const id of SPLIT_IDS) {
    const service = serviceOf(id);
    const relFile = stack.generateSplitEcosystem(service);
    delete require.cache[require.resolve(join(root, id, relFile))];
    const { apps } = require(join(root, id, relFile));
    allNames.push(...apps.map((/** @type {any} */ a) => a.name));
  }
  assert.equal(allNames.length, new Set(allNames).size, `no duplicate PM2 app names across the split fixture: ${JSON.stringify(allNames)}`);
});

test('generateSplitEcosystem: deterministic — regenerating from the same, unchanged ecosystem.config.cjs produces byte-identical output', () => {
  const stack = new Stack({ root, exec: async () => ({ code: 0, out: '' }) });
  const service = serviceOf('webhook-out');
  const path = join(root, 'webhook-out', stack.generateSplitEcosystem(service));
  const first = readFileSync(path, 'utf8');
  const second = readFileSync(join(root, 'webhook-out', stack.generateSplitEcosystem(service)), 'utf8');
  assert.equal(first, second);
});

test('generateSplitEcosystem: reflects an edited kill_timeout on the next generation — never a stale require() cache entry', () => {
  const stack = new Stack({ root, exec: async () => ({ code: 0, out: '' }) });
  const service = serviceOf('scheduler');
  const dir = join(root, 'scheduler');
  const before = require(join(dir, stack.generateSplitEcosystem(service)));
  assert.equal(before.apps[1].kill_timeout, 630_000);

  writeFileSync(join(dir, 'ecosystem.config.cjs'), ecosystemFixture('scheduler', 999_000));
  delete require.cache[require.resolve(join(dir, 'ecosystem.config.cjs'))];
  const relFile = stack.generateSplitEcosystem(service);
  delete require.cache[require.resolve(join(dir, relFile))];
  const after = require(join(dir, relFile));
  assert.equal(after.apps[1].kill_timeout, 999_000, 're-derives from whatever is on disk right now, not a cached 630000');

  writeFileSync(join(dir, 'ecosystem.config.cjs'), ecosystemFixture('scheduler', 630_000)); // restore for later tests in this file
});

test('up({}) (no --split-workers): every service, including the three split-capable ones, still starts its plain ecosystem.config.cjs — pre-Stage-12 behaviour unchanged', async () => {
  /** @type {string[][]} */ const calls = [];
  const stack = new Stack({
    root,
    exec: async (cwd, argv) => { calls.push(argv); return { code: 0, out: '' }; },
    fetch: async () => { throw new Error('unreachable in this test'); },
  });
  // status() (called at the end of up()) polls /ready over fetch; short-circuit by overriding it,
  // not relevant to what this test asserts (the exact argv passed to pm2 per service).
  stack.status = async () => [];
  await stack.up();
  const pm2StartCalls = calls.filter((a) => a[0] === 'pm2' && a[1] === 'startOrRestart');
  assert.equal(pm2StartCalls.length, SERVICES.length);
  for (const call of pm2StartCalls) assert.equal(call[2], 'ecosystem.config.cjs', `without --split-workers every service (including split-capable ones) uses the plain file: ${JSON.stringify(call)}`);
});

test('up({ splitWorkers: true }): split-capable services start the generated split file, everyone else keeps the plain one', async () => {
  /** @type {string[][]} */ const calls = [];
  const stack = new Stack({
    root,
    exec: async (cwd, argv) => { calls.push(argv); return { code: 0, out: '' }; },
  });
  stack.status = async () => [];
  await stack.up({ splitWorkers: true });
  const pm2StartCalls = calls.filter((a) => a[0] === 'pm2' && a[1] === 'startOrRestart');
  assert.equal(pm2StartCalls.length, SERVICES.length);
  for (let i = 0; i < SERVICES.length; i++) {
    const expected = SERVICES[i].splitWorkers ? Stack.SPLIT_ECOSYSTEM_FILE : 'ecosystem.config.cjs';
    assert.equal(pm2StartCalls[i][2], expected, `${SERVICES[i].id}: expected ${expected}`);
  }
  // The generated files this produced are the real, valid ones (not just a filename string) —
  // spot-check one.
  const generated = require(join(root, 'notify', Stack.SPLIT_ECOSYSTEM_FILE));
  assert.equal(generated.apps.length, 2);
});

test('down({ splitWorkers: true }): deletes <id>-api and <id>-worker for split-capable services, plain <id> for everyone else', async () => {
  /** @type {string[][]} */ const calls = [];
  const stack = new Stack({ root, exec: async (cwd, argv) => { calls.push(argv); return { code: 0, out: '' }; } });
  await stack.down({ splitWorkers: true });
  const deletes = calls.filter((a) => a[0] === 'pm2' && a[1] === 'delete').map((a) => a[2]);
  for (const id of SPLIT_IDS) { assert.ok(deletes.includes(`${id}-api`), `${id}-api deleted`); assert.ok(deletes.includes(`${id}-worker`), `${id}-worker deleted`); assert.ok(!deletes.includes(id), `${id}: plain name NOT targeted in split mode`); }
  for (const id of NON_SPLIT_IDS) assert.ok(deletes.includes(id), `${id}: plain name deleted (no split template exists for it)`);
});

test('down({}) (no --split-workers): deletes every service by its plain manifest id, including split-capable ones', async () => {
  /** @type {string[][]} */ const calls = [];
  const stack = new Stack({ root, exec: async (cwd, argv) => { calls.push(argv); return { code: 0, out: '' }; } });
  await stack.down();
  const deletes = calls.filter((a) => a[0] === 'pm2' && a[1] === 'delete').map((a) => a[2]);
  assert.deepEqual(deletes, [...SERVICES].reverse().map((s) => s.id));
});
