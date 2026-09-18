#!/usr/bin/env node
// One-off Layer-4 check: /v1/info response-shape parity across all specs. Dev-only, not wired into CI.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVICES = ['gateway', 'notify', 'auth', 'media', 'console', 'audit', 'shortlink', 'flags', 'scheduler', 'webhook-out', 'search', 'ratelimit', 'geo'];

function resolveSchema(schema, doc) {
  if (schema && schema.$ref) {
    const parts = schema.$ref.slice(2).split('/');
    let node = doc;
    for (const p of parts) node = node?.[p];
    return node;
  }
  return schema;
}

for (const service of SERVICES) {
  const specPath = path.join(WORKSPACE_ROOT, service, 'openapi.yaml');
  const doc = parseYaml(await readFile(specPath, 'utf8'));
  const op = doc.paths?.['/v1/info']?.get;
  if (!op) {
    console.log(`${service}: NO /v1/info operation found`);
    continue;
  }
  let schema = op.responses?.['200']?.content?.['application/json']?.schema;
  schema = resolveSchema(schema, doc);
  const props = schema?.properties ?? {};
  const summarize = (name) => {
    let p = resolveSchema(props[name], doc);
    if (!p) return 'MISSING';
    const type = Array.isArray(p.type) ? p.type.join('|') : p.type;
    const nullable = Array.isArray(p.type) ? p.type.includes('null') : p.nullable === true;
    return `${type}${nullable ? '(nullable)' : ''}`;
  };
  console.log(`${service}: service=${summarize('service')} version=${summarize('version')} apiVersion=${summarize('apiVersion')} capabilities=${summarize('capabilities')} schemaVersion=${summarize('schemaVersion')} serviceCore=${summarize('serviceCore')}`);
}
