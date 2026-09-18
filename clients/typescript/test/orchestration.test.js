// Tests our own generation orchestration invariants -- NOT the correctness of openapi-typescript or
// openapi-fetch themselves (that's their own upstream test suites' job). What we own and must keep
// true: every listed service has a spec and a generated client, generation is deterministic, nothing
// is written outside the allowed root, and operation coverage matches the canonical contracts exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { SERVICES } from '../services.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS_ROOT = path.resolve(HERE, '..');
const WORKSPACE_ROOT = path.resolve(CLIENTS_ROOT, '..', '..', '..');

test('service list is non-empty and matches the 13 services with a canonical openapi.yaml', async () => {
  assert.equal(SERVICES.length, 13);
  for (const service of SERVICES) {
    const specPath = path.join(WORKSPACE_ROOT, service, 'openapi.yaml');
    assert.ok(existsSync(specPath), `${service}: no openapi.yaml at ${specPath}`);
  }
});

test('every service has a generated client: types.gen.ts + index.ts, both non-empty', async () => {
  for (const service of SERVICES) {
    const dir = path.join(CLIENTS_ROOT, service);
    for (const file of ['types.gen.ts', 'index.ts']) {
      const p = path.join(dir, file);
      assert.ok(existsSync(p), `${service}/${file} missing`);
      const s = await stat(p);
      assert.ok(s.size > 0, `${service}/${file} is empty`);
    }
  }
});

test('no generated client source exists outside the allowed root (one dir per known service, no stray files/dirs)', async () => {
  const entries = await readdir(CLIENTS_ROOT, { withFileTypes: true });
  const allowedDirs = new Set([...SERVICES, 'node_modules', 'test']);
  const allowedFiles = new Set([
    'package.json', 'package-lock.json', 'tsconfig.json', 'README.md',
    'generate.mjs', 'check.mjs', 'services.mjs',
  ]);
  for (const e of entries) {
    if (e.isDirectory()) {
      assert.ok(allowedDirs.has(e.name), `unexpected directory in clients/typescript: ${e.name}`);
    } else {
      assert.ok(allowedFiles.has(e.name), `unexpected file in clients/typescript: ${e.name}`);
    }
  }
});

test('operation coverage: every operationId in each service\'s openapi.yaml has exactly one generated method, no more, no fewer', async () => {
  let totalSpecOps = 0;
  let totalClientKeys = 0;
  for (const service of SERVICES) {
    const specPath = path.join(WORKSPACE_ROOT, service, 'openapi.yaml');
    const doc = parseYaml(await readFile(specPath, 'utf8'));
    const specOpIds = new Set();
    for (const item of Object.values(doc.paths ?? {})) {
      if (item == null || typeof item !== 'object') continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
        const op = item[method];
        if (op?.operationId) specOpIds.add(op.operationId);
      }
    }

    const indexSrc = await readFile(path.join(CLIENTS_ROOT, service, 'index.ts'), 'utf8');
    const clientOpIds = new Set([...indexSrc.matchAll(/^\s{4}"([^"]+)":\s\(init:/gm)].map((m) => m[1]));

    const missing = [...specOpIds].filter((id) => !clientOpIds.has(id));
    const extra = [...clientOpIds].filter((id) => !specOpIds.has(id));
    assert.deepEqual(missing, [], `${service}: operationIds in spec but missing from generated client`);
    assert.deepEqual(extra, [], `${service}: operationIds in generated client but not in spec`);
    assert.equal(clientOpIds.size, specOpIds.size, `${service}: operationId count mismatch`);

    totalSpecOps += specOpIds.size;
    totalClientKeys += clientOpIds.size;
  }
  assert.equal(totalSpecOps, 361, `total spec operations changed from the Phase 1 baseline (361) -- update this test deliberately if that's expected`);
  assert.equal(totalClientKeys, 361);
});

test('generated banner is present in every types.gen.ts and index.ts (marks the file as generated, do-not-edit)', async () => {
  for (const service of SERVICES) {
    for (const file of ['types.gen.ts', 'index.ts']) {
      const src = await readFile(path.join(CLIENTS_ROOT, service, file), 'utf8');
      assert.match(src, /GENERATED FILE|auto-generated/i, `${service}/${file} has no generated-file banner`);
    }
  }
});

test('no explicit `any` in any generated index.ts (types.gen.ts prose in comments may legitimately contain the word "any")', async () => {
  const offenders = [];
  for (const service of SERVICES) {
    const src = await readFile(path.join(CLIENTS_ROOT, service, 'index.ts'), 'utf8');
    const codeOnly = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (/:\s*any\b|<any>|as any\b/.test(codeOnly)) offenders.push(service);
  }
  assert.deepEqual(offenders, [], `explicit "any" found in generated index.ts for: ${offenders.join(', ')}`);
});
