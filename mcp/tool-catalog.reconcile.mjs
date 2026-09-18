#!/usr/bin/env node
// Marks tool-catalog.json entries `exposedInPhase3: true` for exactly the operationIds the real,
// explicit tool allowlist (mcp/src/tools/index.mjs) actually calls -- nothing else. This is a
// reconciliation step, not a generator: it never invents a tool from the catalog, it only records,
// against the real allowlist, which of the 361 classified operations that allowlist happens to use.
// Run after tool-catalog.generate.mjs, and again whenever src/tools/index.mjs changes:
// `node mcp/tool-catalog.generate.mjs && node mcp/tool-catalog.reconcile.mjs`.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The real, hand-verified mapping from each exposed MCP tool to the operationId(s) its handler
// calls. stack.status is the one MCP-native aggregate: it calls the 3 operational probes on every
// one of the 13 services, whatever that service happens to have named them (see
// src/tools/index.mjs's findOp() comment on the real cross-service naming inconsistency).
const OPERATIONAL_PROBE_OPIDS = [
  'gateway.health.check', 'gateway.ready.check', 'gateway.info.get',
  'notify.health.get', 'notify.ready.get', 'notify.info.get',
  'auth.health.get', 'auth.ready.get', 'auth.info.get',
  'media.ops.health', 'media.ops.ready', 'media.ops.info',
  'console.health.get', 'console.ready.get', 'console.info.get',
  'audit.health.get', 'audit.ready.get', 'audit.info.get',
  'shortlink.health.get', 'shortlink.ready.get', 'shortlink.info.get',
  'flags.health.get', 'flags.ready.get', 'flags.info.get',
  'scheduler.health.get', 'scheduler.ready.get', 'scheduler.info.get',
  'webhookOut.health.get', 'webhookOut.ready.get', 'webhookOut.info.get',
  'search.system.health', 'search.system.ready', 'search.system.info',
  'ratelimit.health.check', 'ratelimit.ready.check', 'ratelimit.info.get',
  'geo.health.check', 'geo.ready.check', 'geo.info.get',
];

export const TOOL_TO_OPERATION_IDS = {
  'stack.status': OPERATIONAL_PROBE_OPIDS,
  'flags.evaluate': ['flags.evaluate.post'],
  'geo.ip.lookup': ['geo.ip.lookup'],
  'media.files.get': ['media.files.get'],
  'notify.messages.list': ['notify.messages.list'],
  'notify.messages.create': ['notify.messages.create'],
  'notify.messages.get': ['notify.messages.get'],
  'shortlink.links.create': ['shortlink.links.create'],
  'ratelimit.check': ['ratelimit.check'],
  'search.query': ['search.query.get'],
};

async function main() {
  const { TOOLS } = await import('./src/tools/index.mjs');
  const toolNames = new Set(TOOLS.map((t) => t.name));
  const mappedNames = new Set(Object.keys(TOOL_TO_OPERATION_IDS));
  if (toolNames.size !== mappedNames.size || [...toolNames].some((n) => !mappedNames.has(n))) {
    throw new Error(
      `TOOL_TO_OPERATION_IDS in this file is out of sync with src/tools/index.mjs's real allowlist. ` +
      `Tools: [${[...toolNames].join(', ')}]. Mapped: [${[...mappedNames].join(', ')}]. Update TOOL_TO_OPERATION_IDS.`,
    );
  }

  const exposedOpIds = new Set(Object.values(TOOL_TO_OPERATION_IDS).flat());
  const catalogPath = path.join(HERE, 'tool-catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  let exposedCount = 0;
  for (const entry of catalog.entries) {
    entry.exposedInPhase3 = exposedOpIds.has(entry.operationId);
    if (entry.exposedInPhase3) exposedCount += 1;
  }
  const unmatched = [...exposedOpIds].filter((id) => !catalog.entries.some((e) => e.operationId === id));
  if (unmatched.length) {
    throw new Error(`TOOL_TO_OPERATION_IDS names operationId(s) not found in any spec: ${unmatched.join(', ')}`);
  }

  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Reconciled: ${exposedCount}/${catalog.totalOperations} canonical operations are used by the ${toolNames.size} exposed MCP tools.`);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
