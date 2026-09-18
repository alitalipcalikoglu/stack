// Tests the classification artifact's own invariants -- not tool behavior (see allowlist.test.mjs
// and e2e/ for that). Fast, no process spawning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** @typedef {{ service: string, operationId: string, method: string, path: string, flags: string[], exposedInPhase3: boolean }} CatalogEntry */
/** @type {{ totalOperations: number, entries: CatalogEntry[] }} */
const catalog = JSON.parse(await readFile(path.join(HERE, '..', 'tool-catalog.json'), 'utf8'));

test('catalog accounts for exactly 361 canonical operations, matching the Phase 1 total', () => {
  assert.equal(catalog.totalOperations, 361);
  assert.equal(catalog.entries.length, 361);
});

test('every entry has at least one classification flag and a real service/operationId/method/path', () => {
  const validFlags = new Set(['READ_SAFE', 'MUTATION', 'DESTRUCTIVE', 'HIGH_RISK', 'OPERATOR', 'INTERNAL', 'BINARY', 'ASYNC', 'POOR_MCP_FIT']);
  for (const e of catalog.entries) {
    assert.ok(e.flags.length > 0, `${e.operationId} has no classification flags`);
    for (const f of e.flags) assert.ok(validFlags.has(f), `${e.operationId} has unknown flag ${f}`);
    assert.equal(typeof e.service, 'string');
    assert.equal(typeof e.operationId, 'string');
    assert.match(e.method, /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)$/);
    assert.ok(e.path.startsWith('/'), `${e.operationId}'s path "${e.path}" doesn't start with /`);
  }
});

test('operationIds are globally unique within the catalog (matches Phase 1\'s own global-uniqueness guarantee)', () => {
  const ids = catalog.entries.map((e) => e.operationId);
  assert.equal(new Set(ids).size, ids.length);
});

test('the catalog is a candidate universe, not the exposed tool list: far fewer than 361 entries are exposedInPhase3', async () => {
  const exposedCount = catalog.entries.filter((e) => e.exposedInPhase3).length;
  const { TOOLS } = await import('../src/tools/index.mjs');
  assert.ok(exposedCount > 0, 'reconcile.mjs has not been run, or found nothing');
  assert.ok(exposedCount < 361, 'catalog exposure count must not equal the full 361 -- that would mean every operation became a tool');
  // exposedCount (operation-level) and TOOLS.length (tool-level) are deliberately different numbers
  // -- stack.status alone accounts for 39 of the exposed operations under one tool.
  assert.notEqual(exposedCount, TOOLS.length, 'exposedCount and tool count coincidentally matching would be worth double-checking by hand');
});

test('no auth/console business operation is exposedInPhase3 -- only their operational probes (health/ready/info), via stack.status, are', () => {
  const exposed = catalog.entries.filter((e) => e.exposedInPhase3 && (e.service === 'auth' || e.service === 'console'));
  for (const e of exposed) {
    assert.deepEqual(e.flags, ['READ_SAFE', 'OPERATOR'], `${e.service}.${e.operationId} is exposed but is not a plain operational probe (flags: ${e.flags.join(',')})`);
  }
});

test('no DESTRUCTIVE or HIGH_RISK operation is exposedInPhase3', () => {
  const exposed = catalog.entries.filter((e) => e.exposedInPhase3);
  for (const e of exposed) {
    assert.ok(!e.flags.includes('DESTRUCTIVE'), `${e.operationId} is DESTRUCTIVE and must not be exposed`);
    assert.ok(!e.flags.includes('HIGH_RISK'), `${e.operationId} is HIGH_RISK and must not be exposed`);
  }
});
