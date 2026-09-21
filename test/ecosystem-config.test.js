import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SERVICES } from '../src/manifest.js';
import { Stack } from '../src/stack.js';

/**
 * Post-production R1: `geo/ecosystem.config.cjs` had a real, deployment-blocking syntax error (a
 * missing comma) that nothing caught until this was written — `require()`d, the file threw
 * `SyntaxError: Unexpected identifier`, meaning a real `pm2 start ecosystem.config.cjs` would have
 * crashed immediately. This is a load/parse + minimal-shape check only, not a PM2 process
 * supervision test or a reimplementation of PM2's own config semantics — it proves the file is
 * valid JS with the fields `Stack#up()`/`generateSplitEcosystem()` themselves rely on, nothing more.
 *
 * Depends on the real sibling repos being checked out next to `stack` (the same accepted local
 * workspace contract `test/stack.test.js`'s `RouteTable` import and `test/snapshot.test.js` already
 * use) — not gated behind `STACK_INTEGRATION`, since it spawns no process and is fast.
 */
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test('every real service ecosystem.config.cjs parses and has the shape stack itself relies on', () => {
  for (const s of SERVICES) {
    const file = join(workspaceRoot, '..', s.id, 'ecosystem.config.cjs');
    delete require.cache[require.resolve(file)];
    /** @type {{ apps: any[] }} */
    const config = require(file);
    assert.equal(config.apps.length, 1, `${s.id}: expected exactly one app in the combined config`);
    const app = config.apps[0];
    assert.equal(app.name, s.id, `${s.id}: app name must match the service id`);
    assert.equal(app.script, Stack.entry(s), `${s.id}: ecosystem and stack dev must use the same canonical entrypoint`);
    assert.equal(typeof app.kill_timeout, 'number', `${s.id}: kill_timeout must be a number`);
    assert.equal(typeof app.max_memory_restart, 'string', `${s.id}: max_memory_restart must be a string`);
  }
});

test('runtime metadata selects adapter-node only for Console and preserves sibling entrypoints', () => {
  const consoleService = SERVICES.find((s) => s.id === 'console');
  assert.ok(consoleService);
  assert.equal(Stack.entry(consoleService), 'server.mjs');
  for (const service of SERVICES.filter((s) => s.id !== 'console')) {
    assert.equal(Stack.entry(service), 'src/index.js', `${service.id}: sibling runtime must remain unchanged`);
  }
});
