// stack-mcp: a single MCP server foundation over the platform's 13 generated typed clients.
//
// Hard boundary (see README.md): this file, and everything it imports from ./, never talks to a
// service's database, never imports a service's own src/, never hand-rolls an HTTP call to a
// service. Every service call goes through ServiceRegistry -> a generated typed client -> that
// service's real, canonical HTTP API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.mjs';
import { ServiceRegistry } from './registry.mjs';
import { TOOLS, wrapHandler } from './tools/index.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function ownVersion() {
  const pkg = JSON.parse(await readFile(path.join(HERE, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

export async function buildServer(config = loadConfig()) {
  const registry = new ServiceRegistry(config);
  const server = new McpServer({ name: 'stack-mcp', version: await ownVersion() });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      (args) => wrapHandler(tool)(args, registry),
    );
  }

  return { server, registry };
}

export async function main() {
  const { server } = await buildServer();
  const transport = new StdioServerTransport();
  // STDIO is the protocol channel: nothing but the SDK's own framed JSON-RPC traffic may ever touch
  // stdout. All of stack-mcp's own diagnostics go to stderr (or are absent -- see README.md's
  // logging section on why no extra dependency is used for this).
  process.on('uncaughtException', (err) => { console.error('[stack-mcp] uncaught exception:', err); });
  await server.connect(transport);
}
