// Programmatic proof of the hard architectural boundary (README.md "Architecture boundary"):
// stack-mcp never talks to a service except through a generated typed client. Static source scans,
// not a runtime check -- this is exactly the kind of regression a later, well-intentioned edit
// could reintroduce without anyone noticing at review time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..', 'src');
const SERVICES = ['gateway', 'notify', 'auth', 'media', 'console', 'audit', 'shortlink', 'flags', 'scheduler', 'webhook-out', 'search', 'ratelimit', 'geo'];

/** @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const files = await listFiles(SRC_ROOT);
const sources = await Promise.all(files.map(async (f) => ({ file: f, text: await readFile(f, 'utf8') })));

test('no import of a sibling service\'s own src/ tree (only generated clients, own config/registry modules)', () => {
  const offenders = [];
  const importPattern = /\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const { file, text } of sources) {
    for (const m of text.matchAll(importPattern)) {
      const spec = m[1];
      if (/\/(?:gateway|notify|auth|media|console|audit|shortlink|flags|scheduler|webhook-out|search|ratelimit|geo)\/src\//.test(spec)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: imports "${spec}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `found direct imports of a service's own src/ tree:\n${offenders.join('\n')}`);
});

test('every generated-client import goes through clients/typescript/<service>/index.ts, nothing else under clients/', () => {
  const offenders = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/clients\/typescript\/([^'"`]+)/g)) {
      const rest = m[1];
      const ok = SERVICES.some((s) => rest.startsWith(`${s}/index`));
      if (!ok) offenders.push(`${path.relative(SRC_ROOT, file)}: references "clients/typescript/${rest}"`);
    }
  }
  assert.deepEqual(offenders, [], `found a clients/typescript reference that isn't a service's own index.ts:\n${offenders.join('\n')}`);
});

test('no hardcoded service API path or base URL in source (only registry.mjs\'s generic, path-less fetch wrapper touches fetch)', () => {
  const offenders = [];
  for (const { file, text } of sources) {
    const rel = path.relative(SRC_ROOT, file);
    // A literal "/v1/..." path string, or a hardcoded http(s) URL, outside of comments/JSDoc.
    const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/['"`]\/v1\//.test(codeOnly)) offenders.push(`${rel}: contains a literal "/v1/" path string`);
    if (/https?:\/\/(?!.*example)/.test(codeOnly) && !rel.includes('config.mjs')) {
      // config.mjs's own doc comments about example env values are fine; everything else must not
      // hardcode a real-looking URL. (config.mjs itself has no literal URL in code, only regex.)
      offenders.push(`${rel}: contains a hardcoded http(s) URL`);
    }
  }
  assert.deepEqual(offenders, [], `found hardcoded service paths/URLs outside the registry's generic wrapper:\n${offenders.join('\n')}`);
});

test('registry.mjs is the only file that constructs a typed client (via createClient)', () => {
  const constructors = sources.filter(({ text }) => /\bcreateClient\s*\(/.test(text));
  const files_ = constructors.map(({ file }) => path.relative(SRC_ROOT, file));
  assert.deepEqual(files_, ['registry.mjs'], `createClient() must only be called from registry.mjs, found it in: ${files_.join(', ')}`);
});
