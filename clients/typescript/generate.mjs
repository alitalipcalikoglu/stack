#!/usr/bin/env node
// Deterministic generator: canonical <service>/openapi.yaml -> stack/clients/typescript/<service>/{types.gen.ts,index.ts}.
// Run: node clients/typescript/generate.mjs [service...] (from anywhere; paths are resolved off this file's location).
// Not wired into any CI/workflow -- local dev tooling only, per project policy.
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { SERVICES } from './services.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '..', '..', '..');
const OPENAPI_TS_BIN = path.join(HERE, 'node_modules', '.bin', 'openapi-typescript');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

const GENERATED_BANNER = `/**
 * GENERATED FILE -- do not edit by hand.
 * Produced from <repo>/openapi.yaml by \`node clients/typescript/generate.mjs\`.
 * Re-run generation instead of patching this file; see clients/typescript/README.md.
 */
`;

function pascalCase(id) {
  return id.replace(/(^|[-_.])([a-z0-9])/g, (_, __, c) => c.toUpperCase());
}

/** Extract {operationId, method, path}[] straight from the spec's own paths object, sorted by operationId for output stability regardless of source YAML key order. */
function extractOperations(doc, service) {
  const ops = [];
  const seen = new Set();
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    if (item == null || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      if (typeof op.operationId !== 'string' || op.operationId.length === 0) {
        throw new Error(`${service}: ${method.toUpperCase()} ${p} has no operationId -- cannot generate a stable client entry for it`);
      }
      if (seen.has(op.operationId)) {
        throw new Error(`${service}: duplicate operationId "${op.operationId}" -- generation requires uniqueness within a spec`);
      }
      seen.add(op.operationId);
      ops.push({ operationId: op.operationId, method: method.toUpperCase(), path: p });
    }
  }
  ops.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return ops;
}

function renderIndexTs(service, ops) {
  const lines = [];
  lines.push(GENERATED_BANNER);
  lines.push(`import createFetchClient from 'openapi-fetch';`);
  lines.push(`import type { FetchOptions } from 'openapi-fetch';`);
  lines.push(`import type { paths, operations, components } from './types.gen.js';`);
  lines.push(`export type { paths, operations, components } from './types.gen.js';`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Caller-supplied configuration. Nothing is read from process.env, a stack config file,`);
  lines.push(` * or any other implicit source -- baseUrl and credentials must always be passed explicitly.`);
  lines.push(` */`);
  lines.push(`export interface ClientConfig {`);
  lines.push(`  /** Origin + path prefix the ${service} service is reachable at, e.g. "https://${service}.internal:4000". */`);
  lines.push(`  baseUrl: string;`);
  lines.push(`  /** Headers merged into every request (e.g. { Authorization: "Bearer <key>" }). Per-call headers passed to an operation win over these. */`);
  lines.push(`  headers?: HeadersInit;`);
  lines.push(`  /** Override the fetch implementation (useful in tests, or for a non-global fetch runtime). Defaults to the ambient global fetch. */`);
  lines.push(`  fetch?: typeof fetch;`);
  lines.push(`  /** Passed straight to every underlying fetch() call's RequestInit.credentials -- set to "include" for cookie-based auth (console). */`);
  lines.push(`  credentials?: RequestCredentials;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * One operationId-keyed method per operation in ${service}'s openapi.yaml (${ops.length} total).`);
  lines.push(` * Each call returns openapi-fetch's own { data, error, response } union -- status, headers and`);
  lines.push(` * the raw Response are always reachable via .response; nothing throws on a non-2xx by default.`);
  lines.push(` * No retry, no timeout, no polling: this is a transport, not a workflow SDK. Pass an AbortSignal`);
  lines.push(` * via the per-call init if you need cancellation/timeout -- the client has no built-in timeout.`);
  lines.push(` */`);
  lines.push(`export function createClient(config: ClientConfig) {`);
  lines.push(`  const client = createFetchClient<paths>({`);
  lines.push(`    baseUrl: config.baseUrl,`);
  lines.push(`    headers: config.headers,`);
  lines.push(`    fetch: config.fetch,`);
  lines.push(`    credentials: config.credentials,`);
  lines.push(`  });`);
  lines.push(`  return {`);
  for (const { operationId, method, path: p } of ops) {
    const key = JSON.stringify(operationId);
    lines.push(`    ${key}: (init: FetchOptions<operations[${key}]>) => client.${method}(${JSON.stringify(p)}, init),`);
  }
  lines.push(`  } as const;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export type ${pascalCase(service)}Client = ReturnType<typeof createClient>;`);
  return lines.join('\n') + '\n';
}

export async function generateOne(service, { outRoot = HERE } = {}) {
  const specPath = path.join(WORKSPACE_ROOT, service, 'openapi.yaml');
  if (!existsSync(specPath)) throw new Error(`${service}: no openapi.yaml at ${specPath}`);
  const raw = await readFile(specPath, 'utf8');
  const doc = parseYaml(raw);

  const outDir = path.join(outRoot, service);
  await mkdir(outDir, { recursive: true });

  // 1. types.gen.ts -- shell out to the real openapi-typescript CLI (JS API surface is internal/less stable across versions; the CLI is the documented, versioned contract).
  const typesOut = path.join(outDir, 'types.gen.ts');
  execFileSync(OPENAPI_TS_BIN, [specPath, '-o', typesOut], { stdio: 'pipe' });
  const generatedTypes = await readFile(typesOut, 'utf8');
  await writeFile(typesOut, GENERATED_BANNER + generatedTypes);

  // 2. index.ts -- deterministic operationId-keyed wrapper over openapi-fetch.
  const ops = extractOperations(doc, service);
  await writeFile(path.join(outDir, 'index.ts'), renderIndexTs(service, ops));

  return { service, operationCount: ops.length, paths: Object.keys(doc.paths ?? {}).length };
}

async function main() {
  const requested = process.argv.slice(2);
  const services = requested.length ? requested : SERVICES;
  const results = [];
  for (const service of services) {
    if (!SERVICES.includes(service)) {
      console.error(`Unknown service "${service}" -- not in services.mjs's SERVICES list`);
      process.exit(1);
    }
    const r = await generateOne(service);
    console.log(`${service}: ${r.paths} paths, ${r.operationCount} operations generated`);
    results.push(r);
  }
  const total = results.reduce((n, r) => n + r.operationCount, 0);
  console.log(`\nTotal operations generated across ${results.length} service(s): ${total}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stdout ? err.stdout.toString() : err.stack || err.message);
    process.exit(1);
  });
}
