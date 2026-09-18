#!/usr/bin/env node
// Entry point. Must be invoked with `--experimental-strip-types` (this process directly imports
// the generated *.ts clients under clients/typescript/ -- see mcp/README.md's "Running" section
// for exactly why and the canonical invocation). Kept as plain .js itself so the flag requirement
// is only about the dependency it loads, not about this file.
import { main } from '../src/server.mjs';

main().catch((err) => {
  console.error('[stack-mcp] fatal:', err);
  process.exitCode = 1;
});
