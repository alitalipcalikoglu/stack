#!/usr/bin/env node
import './../src/quiet.js';
import { resolve } from 'node:path';
import { Stack } from '../src/stack.js';

/**
 * atc-stack <command> [options]
 *   setup    --root <dir> --host <host> --public --install --admin-email <email> --admin-password <pw>
 *   up [--split-workers] | down [--split-workers] | status [--matrix] | dev   --root <dir>
 *   backup   --root <dir> --dir <snapshot dir>                     (default dir: <root>/backups/<timestamp>)
 *   restore  <snapshot dir> --root <dir> --service <id>             (default: every service the snapshot covers)
 * `--root` defaults to the parent folder of this checkout (the workspace with one folder per service).
 */
export class Cli {
  /** @param {string[]} argv */
  static parse(argv) {
    const [command, ...rest] = argv;
    /** @type {Record<string, string|boolean>} */
    const flags = {};
    /** @type {string[]} */
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (!a.startsWith('--')) { positional.push(a); continue; }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    }
    return { command, flags, positional };
  }

  /** @param {string[]} argv */
  static async main(argv) {
    const { command, flags, positional } = Cli.parse(argv);
    const root = resolve(String(flags.root ?? resolve(new URL('../..', import.meta.url).pathname)));
    const stack = new Stack({ root });
    switch (command) {
      case 'setup': {
        const r = await stack.setup({ host: String(flags.host ?? '127.0.0.1'), local: !flags.public, install: flags.install === true, adminEmail: flags['admin-email'] === undefined ? undefined : String(flags['admin-email']), adminPassword: flags['admin-password'] === undefined ? undefined : String(flags['admin-password']) });
        console.log('\nservices:');
        for (const s of r.services) console.log(`  ${s.id.padEnd(11)} ${s.url}`);
        console.log(`\nconsole admin: ${r.admin.email}${r.admin.created ? `\npassword:      ${r.admin.password}   (shown once; change it after the first sign-in)` : '   (already existed, unchanged)'}`);
        console.log('\nnext: "npm run dev" (this terminal) or "npm run up" (PM2)');
        return 0;
      }
      case 'up': await stack.up({ splitWorkers: flags['split-workers'] === true }); return 0;
      case 'down': await stack.down({ splitWorkers: flags['split-workers'] === true }); return 0;
      case 'status': {
        if (flags.matrix) { const rows = await stack.matrix(); return rows.every((r) => r.ok) ? 0 : 1; }
        const rows = await stack.status(); return rows.every((r) => r.ok) ? 0 : 1;
      }
      case 'dev': await stack.dev(); return 0;
      case 'backup': {
        const r = await stack.backup({ dir: flags.dir === undefined ? undefined : String(flags.dir) });
        console.log(`\nbackup written to ${r.dir}`);
        return 0;
      }
      case 'restore': {
        if (!positional[0]) { console.error('usage: atc-stack restore <snapshot dir> [--root dir] [--service id]'); return 2; }
        const r = await stack.restore(positional[0], { service: flags.service === undefined ? undefined : String(flags.service) });
        console.log(`\nrestored: ${r.restored.join(', ') || 'none'}`);
        if (r.skipped.length) console.log(`skipped (not in snapshot): ${r.skipped.join(', ')}`);
        return 0;
      }
      default:
        console.log('usage: atc-stack setup [--root dir] [--host host] [--public] [--install] [--admin-email e] [--admin-password p] | up [--split-workers] | down [--split-workers] | status [--matrix] | dev | backup [--dir dir] | restore <snapshot dir> [--service id]');
        return 2;
    }
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('bin/stack.js')) {
  Cli.main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
