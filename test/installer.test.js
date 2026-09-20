import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Installer } from '../src/installer.js';
import { REPOSITORIES } from '../src/repository-catalog.js';
import { Stack } from '../src/stack.js';

/** @type {string[]} */ const cleanup = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** @typedef {(cwd: string, argv: string[], options?: { stdio?: 'inherit'|'pipe' }) => Promise<{ code: number, out: string }>} Exec */
/** @param {string} cwd @param {string[]} argv */
const command = (cwd, argv) => execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture(id = 'alpha') {
  const base = mkdtempSync(join(tmpdir(), 'atc-installer-test-'));
  cleanup.push(base);
  const origin = join(base, `${id}.git`);
  const seed = join(base, `${id}-seed`);
  const root = join(base, 'workspace');
  mkdirSync(root);
  command(base, ['git', 'init', '--bare', '--initial-branch=main', origin]);
  mkdirSync(seed);
  command(seed, ['git', 'init', '--initial-branch=main']);
  command(seed, ['git', 'config', 'user.name', 'Installer Test']);
  command(seed, ['git', 'config', 'user.email', 'installer@example.invalid']);
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
  writeFileSync(join(seed, 'package-lock.json'), JSON.stringify({ name: id, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: id, version: '1.0.0' } } }));
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n.preserved-secret\n');
  command(seed, ['git', 'add', '.']);
  command(seed, ['git', 'commit', '-m', 'initial']);
  const commit = command(seed, ['git', 'rev-parse', 'HEAD']).trim();
  command(seed, ['git', 'tag', 'v1.0.0']);
  command(seed, ['git', 'remote', 'add', 'origin', origin]);
  command(seed, ['git', 'push', 'origin', 'main', '--tags']);
  return { base, root, origin, seed, id, commit };
}

/** @param {ReturnType<typeof fixture>} f @param {any} [overrides] */
function harness(f, overrides = {}) {
  const calls = /** @type {{ setup: any[], up: any[], wait: number[] }} */ ({ setup: [], up: [], wait: [] });
  const stack = {
    setup: async (/** @type {any} */ o) => { calls.setup.push(o); return { admin: { created: false } }; },
    up: async (/** @type {any} */ o) => { calls.up.push(o); return []; },
    waitReady: async (/** @type {number} */ timeout) => { calls.wait.push(timeout); return [{ id: f.id, ok: true }]; },
    ...overrides.stack,
  };
  const repositories = overrides.repositories ?? [{ id: f.id, remote: f.origin }];
  const release = overrides.release ?? { schemaVersion: 1, channel: 'release', release: 'test', repositories: Object.fromEntries(repositories.map((/** @type {{ id: string }} */ r) => [r.id, { tag: 'v1.0.0', commit: r.id === f.id ? f.commit : overrides.commits?.[r.id] }])) };
  const realExec = Stack.exec;
  const exec = /** @type {Exec} */ (overrides.exec ?? ((cwd, argv, options) => realExec(cwd, argv, options)));
  const installer = new Installer({ root: f.root, stackDir: join(import.meta.dirname, '..'), stack, exec, log: () => {}, repositories, release });
  return { installer, calls, stack };
}

test('canonical catalog contains exactly the 14 official sibling repositories and the release descriptor covers each once', () => {
  assert.deepEqual(REPOSITORIES.map((repository) => repository.id), [
    'service-core', 'gateway', 'notify', 'auth', 'media', 'console', 'audit', 'shortlink',
    'flags', 'scheduler', 'webhook-out', 'search', 'ratelimit', 'geo',
  ]);
  for (const repository of REPOSITORIES) assert.equal(repository.remote, `https://github.com/alitalipcalikoglu/${repository.id}.git`);
  const release = Installer.releaseManifest();
  assert.equal(release.release, '1.1.0');
  assert.deepEqual(Object.keys(release.repositories).sort(), REPOSITORIES.map((repository) => repository.id).sort());
  for (const repository of REPOSITORIES) assert.equal(release.repositories[repository.id].repository, repository.remote);
});

test('a manifest repository identity cannot disagree with the official catalog', async () => {
  const f = fixture();
  const { installer } = harness(f, { release: { schemaVersion: 1, channel: 'release', release: 'bad', repositories: { [f.id]: { repository: 'https://example.invalid/spoof.git', tag: 'v1.0.0', commit: f.commit } } } });
  await assert.rejects(installer.install({ start: false }), /release descriptor repository does not match the official remote/);
});

test('fresh release workspace clones exact tag, installs, configures, and reruns idempotently', async () => {
  const f = fixture();
  let secret = '';
  const { installer, calls } = harness(f, { stack: {
    setup: async () => {
      const path = join(f.root, f.id, '.preserved-secret');
      if (!existsSync(path)) writeFileSync(path, 'keep-me');
      secret = readFileSync(path, 'utf8');
      return { admin: { created: false } };
    },
  } });
  const first = await installer.install({ start: false });
  assert.deepEqual(first.cloned, [f.id]);
  assert.equal(command(join(f.root, f.id), ['git', 'rev-parse', 'HEAD']).trim(), f.commit);
  assert.equal(command(join(f.root, f.id), ['git', 'branch', '--show-current']).trim(), '');
  assert.equal(secret, 'keep-me');
  const second = await installer.install({ start: false });
  assert.deepEqual(second.reused, [f.id]);
  assert.equal(readFileSync(join(f.root, f.id, '.preserved-secret'), 'utf8'), 'keep-me');
  assert.equal(calls.up.length, 0);
});

test('development mode clones and resolves the official main head', async () => {
  const f = fixture();
  const { installer } = harness(f);
  const result = await installer.install({ ref: 'main', start: false });
  assert.equal(result.commits[f.id], f.commit);
  assert.equal(command(join(f.root, f.id), ['git', 'branch', '--show-current']).trim(), 'main');
});

test('correct clean existing repository is reused and clean main fast-forwards in development mode', async () => {
  const f = fixture();
  command(f.root, ['git', 'clone', '--branch', 'main', f.origin, f.id]);
  writeFileSync(join(f.seed, 'next.txt'), 'next');
  command(f.seed, ['git', 'add', '.']);
  command(f.seed, ['git', 'commit', '-m', 'next']);
  command(f.seed, ['git', 'push', 'origin', 'main']);
  const next = command(f.seed, ['git', 'rev-parse', 'HEAD']).trim();
  const { installer } = harness(f);
  const result = await installer.install({ ref: 'main', start: false });
  assert.deepEqual(result.reused, [f.id]);
  assert.equal(result.commits[f.id], next);
});

test('dirty repository fails closed', async () => {
  const f = fixture();
  command(f.root, ['git', 'clone', f.origin, f.id]);
  writeFileSync(join(f.root, f.id, 'dirty.txt'), 'dirty');
  const { installer } = harness(f);
  await assert.rejects(installer.install({ ref: 'main', start: false }), /\[GIT_VERIFY\] alpha: working tree is dirty/);
});

test('wrong origin fails closed', async () => {
  const f = fixture();
  command(f.root, ['git', 'clone', f.origin, f.id]);
  command(join(f.root, f.id), ['git', 'remote', 'set-url', 'origin', `${f.origin}-wrong`]);
  const { installer } = harness(f);
  await assert.rejects(installer.install({ ref: 'main', start: false }), /origin does not match the official remote/);
});

test('non-Git directory and symlink at the expected path fail closed', async () => {
  const f = fixture();
  mkdirSync(join(f.root, f.id));
  const { installer } = harness(f);
  await assert.rejects(installer.install({ start: false }), /existing directory is not a Git repository/);
  rmSync(join(f.root, f.id), { recursive: true });
  command(f.root, ['ln', '-s', f.seed, f.id]);
  await assert.rejects(installer.install({ start: false }), /expected path is a symlink/);
});

test('release SHA mismatch fails before cloning', async () => {
  const f = fixture();
  const bad = '0'.repeat(40);
  const { installer } = harness(f, { release: { schemaVersion: 1, channel: 'release', release: 'bad', repositories: { [f.id]: { tag: 'v1.0.0', commit: bad } } } });
  await assert.rejects(installer.install({ start: false }), new RegExp(`remote v1.0.0 resolves to .* expected immutable commit ${bad}`));
  assert.equal(existsSync(join(f.root, f.id)), false);
});

test('existing clean repository at a commit after the release fails instead of changing branches or HEAD', async () => {
  const f = fixture();
  writeFileSync(join(f.seed, 'after-release.txt'), 'newer');
  command(f.seed, ['git', 'add', '.']);
  command(f.seed, ['git', 'commit', '-m', 'after release']);
  command(f.seed, ['git', 'push', 'origin', 'main']);
  command(f.root, ['git', 'clone', f.origin, f.id]);
  const before = command(join(f.root, f.id), ['git', 'rev-parse', 'HEAD']).trim();
  const { installer } = harness(f);
  await assert.rejects(installer.install({ start: false }), /expected release v1.0.0/);
  assert.equal(command(join(f.root, f.id), ['git', 'rev-parse', 'HEAD']).trim(), before);
  assert.equal(command(join(f.root, f.id), ['git', 'branch', '--show-current']).trim(), 'main');
});

test('partial prior installation reuses the completed repository and clones the missing one', async () => {
  const a = fixture('alpha');
  const b = fixture('beta');
  const target = join(a.root, 'beta');
  const repositories = [{ id: a.id, remote: a.origin }, { id: b.id, remote: b.origin }];
  const release = { schemaVersion: 1, channel: 'release', release: 'test', repositories: { alpha: { tag: 'v1.0.0', commit: a.commit }, beta: { tag: 'v1.0.0', commit: b.commit } } };
  command(a.root, ['git', 'clone', '--no-checkout', a.origin, a.id]);
  command(join(a.root, a.id), ['git', 'checkout', '--detach', a.commit]);
  const { installer } = harness(a, { repositories, release });
  const result = await installer.install({ start: false });
  assert.deepEqual(result.reused, ['alpha']);
  assert.deepEqual(result.cloned, ['beta']);
  assert.equal(existsSync(target), true);
});

test('dependency, setup, startup, and readiness failures are phase-aware', async (t) => {
  await t.test('dependency', async () => {
    const f = fixture();
    const exec = /** @type {Exec} */ (async (cwd, argv, options) => argv[0] === 'npm' && argv[1] === 'ci' ? { code: 7, out: '' } : Stack.exec(cwd, argv, options));
    const { installer } = harness(f, { exec });
    await assert.rejects(installer.install({ start: false }), /\[DEPENDENCIES\] alpha:/);
  });
  await t.test('setup', async () => {
    const f = fixture();
    const { installer } = harness(f, { stack: { setup: async () => { throw new Error('setup broke'); } } });
    await assert.rejects(installer.install({ start: false }), /\[SETUP\] setup broke/);
  });
  await t.test('startup', async () => {
    const f = fixture();
    const exec = /** @type {Exec} */ (async (cwd, argv, options) => argv[0] === 'pm2' ? { code: 0, out: '5' } : Stack.exec(cwd, argv, options));
    const { installer } = harness(f, { exec, stack: { up: async () => { throw new Error('start broke'); } } });
    await assert.rejects(installer.install(), /\[START\] start broke/);
  });
  await t.test('readiness', async () => {
    const f = fixture();
    const exec = /** @type {Exec} */ (async (cwd, argv, options) => argv[0] === 'pm2' ? { code: 0, out: '5' } : Stack.exec(cwd, argv, options));
    const { installer } = harness(f, { exec, stack: { waitReady: async () => [{ id: f.id, ok: false }] } });
    await assert.rejects(installer.install(), /\[READINESS\] 0\/1 services ready/);
  });
});

test('--no-start skips PM2 and --split-workers is forwarded when starting', async () => {
  const f = fixture();
  let pm2Checks = 0;
  const exec = /** @type {Exec} */ (async (cwd, argv, options) => {
    if (argv[0] === 'pm2') { pm2Checks++; return { code: 0, out: '5' }; }
    return Stack.exec(cwd, argv, options);
  });
  const { installer, calls } = harness(f, { exec });
  await installer.install({ ref: 'main', start: false, splitWorkers: true });
  assert.equal(pm2Checks, 0);
  await installer.install({ ref: 'main', splitWorkers: true });
  assert.deepEqual(calls.up.at(-1), { splitWorkers: true });
  assert.equal(pm2Checks, 1);
});

test('missing PM2 fails preflight before any repository is cloned', async () => {
  const f = fixture();
  const exec = /** @type {Exec} */ (async (cwd, argv, options) => argv[0] === 'pm2' ? { code: 1, out: '' } : Stack.exec(cwd, argv, options));
  const { installer } = harness(f, { exec });
  await assert.rejects(installer.install(), /\[PREFLIGHT\] PM2 is required/);
  assert.equal(existsSync(join(f.root, f.id)), false);
});

test('dry-run reports remote intent and performs no filesystem or setup mutation', async () => {
  const f = fixture();
  const { installer, calls } = harness(f);
  const result = await installer.install({ dryRun: true });
  assert.deepEqual(result.cloned, [f.id]);
  assert.equal(result.commits[f.id], f.commit);
  assert.equal(existsSync(join(f.root, f.id)), false);
  assert.equal(calls.setup.length, 0);
});

test('unsupported moving refs fail during preflight', async () => {
  const f = fixture();
  const { installer } = harness(f);
  await assert.rejects(installer.install({ ref: 'feature', start: false }), /only the explicit development ref "main" is supported/);
});
