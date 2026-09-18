#!/usr/bin/env node
// Local dev-only OpenAPI contract validator for the atc-web workspace.
// Not wired into any CI/workflow — run manually: node openapi-validation/validate.mjs [service...]
//
// Checks per service:
//   1. openapi.yaml exists and parses as YAML.
//   2. Structural sanity: openapi 3.1.x, info.title/version, non-empty paths,
//      every operation has a unique-within-file operationId and non-empty responses,
//      every internal $ref resolves to a real components.* entry.
//   3. Route parity: every {method, path} in openapi-validation/routes/<service>.json
//      appears in the spec, and vice versa (extras are reported, not necessarily errors --
//      the manifest's own "exclusions" list documents intentional gaps).
// Then, across all services checked in one run:
//   4. Global operationId uniqueness (no two services may reuse the same operationId --
//      keeps a future combined typed-client generation collision-free).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '..', '..');
const ROUTES_DIR = path.join(HERE, 'routes');

const ALL_SERVICES = [
  'gateway', 'notify', 'auth', 'media', 'console', 'audit', 'shortlink',
  'flags', 'scheduler', 'webhook-out', 'search', 'ratelimit', 'geo',
];

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

/** Normalize a path for comparison: collapse any {param} name differences are kept literal (names matter for docs, not for set comparison here -- only method+shape matter), trailing slash stripped. */
function normPath(p) {
  return p.replace(/\/$/, '') || '/';
}

function resolveRef(ref, doc) {
  if (!ref.startsWith('#/')) return { ok: false, reason: `external/non-local $ref not resolved by this validator: ${ref}` };
  const parts = ref.slice(2).split('/');
  let node = doc;
  for (const part of parts) {
    if (node == null || typeof node !== 'object' || !(part in node)) {
      return { ok: false, reason: `$ref does not resolve: ${ref}` };
    }
    node = node[part];
  }
  return { ok: true };
}

function walkRefs(node, doc, errors, seen = new Set()) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, doc, errors, seen);
    return;
  }
  if (typeof node.$ref === 'string') {
    if (!seen.has(node.$ref)) {
      seen.add(node.$ref);
      const r = resolveRef(node.$ref, doc);
      if (!r.ok) errors.push(r.reason);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === '$ref') continue;
    walkRefs(node[key], doc, errors, seen);
  }
}

async function loadManifest(service) {
  const file = path.join(ROUTES_DIR, `${service}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8'));
}

async function validateService(service, globalOperationIds, globalErrors) {
  const specPath = path.join(WORKSPACE_ROOT, service, 'openapi.yaml');
  const result = { service, ok: true, errors: [], warnings: [], operationCount: 0, pathCount: 0 };

  if (!existsSync(specPath)) {
    result.ok = false;
    result.errors.push(`openapi.yaml not found at ${specPath}`);
    return result;
  }

  let doc;
  try {
    const raw = await readFile(specPath, 'utf8');
    doc = parseYaml(raw);
  } catch (err) {
    result.ok = false;
    result.errors.push(`YAML parse failed: ${err.message}`);
    return result;
  }

  // --- structural checks ---
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.1')) {
    result.ok = false;
    result.errors.push(`openapi field must be 3.1.x, got: ${JSON.stringify(doc.openapi)}`);
  }
  if (!doc.info || typeof doc.info.title !== 'string' || typeof doc.info.version !== 'string') {
    result.ok = false;
    result.errors.push('info.title and info.version are required');
  }
  if (!doc.paths || typeof doc.paths !== 'object' || Object.keys(doc.paths).length === 0) {
    result.ok = false;
    result.errors.push('paths must be a non-empty object');
  }

  const specRoutes = [];
  const fileOperationIds = new Set();
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    result.pathCount += 1;
    if (item == null || typeof item !== 'object') {
      result.errors.push(`path item for ${p} is not an object`);
      continue;
    }
    let anyMethod = false;
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      anyMethod = true;
      result.operationCount += 1;
      specRoutes.push({ method: method.toUpperCase(), path: normPath(p) });

      if (op == null || typeof op !== 'object') {
        result.ok = false;
        result.errors.push(`${method.toUpperCase()} ${p}: operation is not an object`);
        continue;
      }
      if (typeof op.operationId !== 'string' || op.operationId.length === 0) {
        result.ok = false;
        result.errors.push(`${method.toUpperCase()} ${p}: missing operationId`);
      } else {
        if (fileOperationIds.has(op.operationId)) {
          result.ok = false;
          result.errors.push(`${method.toUpperCase()} ${p}: duplicate operationId within file: ${op.operationId}`);
        }
        fileOperationIds.add(op.operationId);
        if (globalOperationIds.has(op.operationId)) {
          globalErrors.push(
            `Global operationId collision: "${op.operationId}" used by both ${globalOperationIds.get(op.operationId)} and ${service} (${method.toUpperCase()} ${p})`
          );
        } else {
          globalOperationIds.set(op.operationId, `${service} (${method.toUpperCase()} ${p})`);
        }
      }
      if (!op.responses || typeof op.responses !== 'object' || Object.keys(op.responses).length === 0) {
        result.ok = false;
        result.errors.push(`${method.toUpperCase()} ${p}: responses must be non-empty`);
      }
    }
    if (!anyMethod) {
      result.warnings.push(`path ${p} has no HTTP method operations`);
    }
  }

  // --- $ref resolution ---
  const refErrors = [];
  walkRefs(doc, doc, refErrors);
  if (refErrors.length) {
    result.ok = false;
    result.errors.push(...refErrors);
  }

  // --- route parity ---
  const manifest = await loadManifest(service);
  if (manifest) {
    const manifestSet = new Set(manifest.routes.map((r) => `${r.method} ${normPath(r.path)}`));
    const specSet = new Set(specRoutes.map((r) => `${r.method} ${r.path}`));
    const missingInSpec = [...manifestSet].filter((k) => !specSet.has(k));
    const extraInSpec = [...specSet].filter((k) => !manifestSet.has(k));
    if (missingInSpec.length) {
      result.ok = false;
      result.errors.push(`missing in spec (present in source-derived manifest): ${missingInSpec.join(', ')}`);
    }
    if (extraInSpec.length) {
      result.warnings.push(`extra in spec (not in manifest -- verify against source, or add to manifest with a reason): ${extraInSpec.join(', ')}`);
    }
    result.manifestRouteCount = manifest.routes.length;
  } else {
    result.warnings.push(`no route manifest found at ${ROUTES_DIR}/${service}.json -- route parity not checked`);
  }

  return result;
}

async function main() {
  const requested = process.argv.slice(2);
  const services = requested.length ? requested : ALL_SERVICES;
  const globalOperationIds = new Map();
  const globalErrors = [];
  const results = [];

  for (const service of services) {
    results.push(await validateService(service, globalOperationIds, globalErrors));
  }

  let anyFail = globalErrors.length > 0;
  for (const r of results) {
    const status = r.ok ? 'OK' : 'FAIL';
    console.log(`\n=== ${r.service}: ${status} (paths=${r.pathCount}, operations=${r.operationCount}${r.manifestRouteCount != null ? `, manifestRoutes=${r.manifestRouteCount}` : ''}) ===`);
    for (const e of r.errors) console.log(`  ERROR: ${e}`);
    for (const w of r.warnings) console.log(`  WARN:  ${w}`);
    if (!r.ok) anyFail = true;
  }

  if (globalErrors.length) {
    console.log(`\n=== global ===`);
    for (const e of globalErrors) console.log(`  ERROR: ${e}`);
  }

  console.log(`\n${anyFail ? 'VALIDATION FAILED' : 'ALL CHECKS PASSED'}`);
  process.exit(anyFail ? 1 : 0);
}

main();
