#!/usr/bin/env node
// Deterministic drift check: regenerate every client into a scratch dir, diff byte-for-byte against
// the committed output, exit non-zero on any difference. Never mutates the real source tree.
// Run: node clients/typescript/check.mjs (from anywhere). Not wired into any CI/workflow.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from './services.mjs';
import { generateOne } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function filesEqual(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const [ca, cb] = await Promise.all([readFile(a), readFile(b)]);
  return Buffer.compare(ca, cb) === 0;
}

async function main() {
  // containment guard: refuse to run against anything but a genuine os.tmpdir()-rooted scratch dir,
  // so a future refactor can never turn this into an accidental `rm -rf` of real committed output.
  const scratch = await mkdtemp(path.join(tmpdir(), 'atc-clients-check-'));
  if (!scratch.startsWith(tmpdir())) throw new Error(`refusing to use non-tmpdir scratch path: ${scratch}`);

  const drift = [];
  try {
    for (const service of SERVICES) {
      // eslint-disable-next-line no-await-in-loop
      await generateOne(service, { outRoot: scratch });
    }
    for (const service of SERVICES) {
      const committedDir = path.join(HERE, service);
      const scratchDir = path.join(scratch, service);
      for (const file of ['types.gen.ts', 'index.ts']) {
        const committed = path.join(committedDir, file);
        const fresh = path.join(scratchDir, file);
        // eslint-disable-next-line no-await-in-loop
        if (!(await filesEqual(committed, fresh))) drift.push(`${service}/${file}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  if (drift.length) {
    console.error('DRIFT DETECTED -- committed generated clients do not match a fresh regeneration:');
    for (const f of drift) console.error(`  ${f}`);
    console.error('\nRun `node clients/typescript/generate.mjs` and commit the result.');
    process.exit(1);
  }
  console.log(`clients:check -- ${SERVICES.length}/${SERVICES.length} services match a fresh regeneration exactly. No drift.`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
