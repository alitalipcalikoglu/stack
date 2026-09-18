#!/usr/bin/env node
// Generates mcp/tool-catalog.json: the full, classified inventory of all 361 canonical operations
// across the 13 services' openapi.yaml. This is the *candidate universe* -- it is NOT the MCP
// server's exposed tool list (see mcp/src/tools/index.mjs for the actual, explicit, small
// allowlist). Re-run whenever a service's openapi.yaml changes: `node mcp/tool-catalog.generate.mjs`.
// Not wired into any CI/workflow.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '..', '..');
const SERVICES = [
  'gateway', 'notify', 'auth', 'media', 'console', 'audit', 'shortlink',
  'flags', 'scheduler', 'webhook-out', 'search', 'ratelimit', 'geo',
];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

/**
 * Classification is intentionally rule-based over (service, method, operationId), not hand-typed
 * per operation -- 361 hand-written classifications would itself be an unreviewable drift trap.
 * A flag set errs conservative: when in doubt, classify UP (more restrictive), never down.
 * @param {string} service @param {string} method @param {string} opId @param {string} p
 */
function classify(service, method, opId, p) {
  const flags = new Set();
  const m = method.toLowerCase();

  // Operational probes (/health, /ready, /v1/info, /metrics) first, and as an early return: these
  // are objectively safe (unauthenticated, read-only, zero side effects, confirmed identically
  // across all 13 services in the Phase 0/1 audits) regardless of which service hosts them, so a
  // whole-service conservative override (e.g. auth's HIGH_RISK below) must never sweep them in.
  // operationId naming for these is NOT consistent across specs (gateway.health.check,
  // notify.health.get, media.ops.health, search.system.health, webhookOut.health.get, ...) -- so
  // detection is "does the operationId contain this word as a whole dot-segment", the same
  // technique src/tools/index.mjs's findOp() uses, not a fixed suffix pattern.
  const segments = opId.toLowerCase().split('.');
  const isProbe = ['health', 'ready', 'metrics'].some((w) => segments.includes(w)) || segments.includes('info');
  if (isProbe) return ['READ_SAFE', 'OPERATOR'];

  // Base method semantics.
  if (m === 'get' || m === 'head') flags.add('READ_SAFE');
  else if (m === 'delete') flags.add('DESTRUCTIVE');
  else flags.add('MUTATION'); // post/put/patch

  // Whole-service conservative overrides (never reached for a probe operation -- see above).
  if (service === 'auth') flags.add('HIGH_RISK'); // Phase 0/1: ungated user-list, account lifecycle, session/token control -- treat the whole surface conservatively.
  if (service === 'console') { flags.add('OPERATOR'); flags.add('POOR_MCP_FIT'); } // cookie+CSRF session model, 105 low-confidence pass-through responses (Phase 1 §G/§O).

  // Keyword-driven upgrades, regardless of service (checked against the operationId's own words).
  const idLower = opId.toLowerCase();
  if (/\.(reload|rotate|revoke|cancel|clear|purge|reset)([.a-z]*)$/.test(idLower) || idLower.includes('database.reload')) {
    flags.add('HIGH_RISK');
  }
  if (idLower.includes('admin') || idLower.includes('policy') || idLower.includes('override')) flags.add('OPERATOR');

  // Binary / non-JSON payloads (path-based heuristic -- these are the operations Phase 1 modeled with
  // format:binary bodies or non-application/json response content).
  if (
    (service === 'media' && /files\.(upload|deliver)/.test(idLower)) ||
    (service === 'audit' && idLower.includes('export')) ||
    (service === 'shortlink' && idLower.includes('qr'))
  ) flags.add('BINARY');

  // Async / state-machine operations (Phase 1 §K's four services).
  if (
    (service === 'notify' && /messages\.(create|get|list|retry)/.test(idLower)) ||
    (service === 'scheduler' && /(jobs\.run|runs\.)/.test(idLower)) ||
    (service === 'webhook-out' && /(events\.publish|deliveries\.|subscriptions\.(test|replay))/.test(idLower)) ||
    (service === 'media' && idLower.includes('files.deliver')) // lazy variant generation
  ) flags.add('ASYNC');

  // Gateway's own operational surface only (4 operations) -- never proxy-surface (there is none in
  // its spec; Phase 1 confirmed gateway.openapi.yaml only documents its own 4 endpoints).
  if (service === 'gateway') flags.add('OPERATOR');

  return [...flags];
}

async function main() {
  const entries = [];
  for (const service of SERVICES) {
    const specPath = path.join(WORKSPACE_ROOT, service, 'openapi.yaml');
    const doc = parseYaml(await readFile(specPath, 'utf8'));
    for (const [p, item] of Object.entries(doc.paths ?? {})) {
      if (item == null || typeof item !== 'object') continue;
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op?.operationId) continue;
        entries.push({
          service,
          operationId: op.operationId,
          method: method.toUpperCase(),
          path: p,
          flags: classify(service, method, op.operationId, p),
          exposedInPhase3: false, // set to true only for entries mcp/src/tools/index.mjs actually registers -- see reconcile step below.
        });
      }
    }
  }
  entries.sort((a, b) => a.operationId.localeCompare(b.operationId));

  const catalog = {
    generatedAt: new Date().toISOString().slice(0, 10),
    totalOperations: entries.length,
    note: 'Candidate universe for MCP tool exposure -- NOT the exposed tool list. See mcp/src/tools/index.mjs for the actual, explicit allowlist (mcp/src/tools/index.mjs is the only place a tool is really registered). exposedInPhase3 here is reconciled against that allowlist by mcp/tool-catalog.reconcile.mjs, not hand-edited.',
    entries,
  };

  await writeFile(path.join(HERE, 'tool-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`tool-catalog.json: ${entries.length} operations classified across ${SERVICES.length} services.`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
