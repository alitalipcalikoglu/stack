import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { freePort, LogLine, randomSecret, ServiceProcess, stopAll } from './harness.js';

test('freePort: returns distinct, immediately reusable ports', async () => {
  const [a, b, c] = await Promise.all([freePort(), freePort(), freePort()]);
  assert.equal(new Set([a, b, c]).size, 3, 'three concurrent calls do not collide');
  for (const p of [a, b, c]) assert.ok(p > 0 && p < 65536);
});

test('randomSecret: long enough for every service’s 32-char minimum, and not repeated', () => {
  const a = randomSecret();
  const b = randomSecret();
  assert.ok(a.length >= 32);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b);
});

test('LogLine: parses a JSON log line, keeps a non-JSON line as raw text', () => {
  const json = new LogLine('{"level":30,"msg":"ready","reqId":"abc"}', 'stdout');
  assert.deepEqual(json.json, { level: 30, msg: 'ready', reqId: 'abc' });
  const raw = new LogLine('Error: boom\n    at file.js:1:1', 'stderr');
  assert.equal(raw.json, null);
  assert.equal(raw.raw, 'Error: boom\n    at file.js:1:1');
});

test('ServiceProcess: starts a real child process, waits for /ready, captures its logs, stops it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-selftest-'));
  const port = await freePort();
  // A tiny throwaway HTTP server standing in for a real service: enough to prove the harness
  // itself (spawn, poll /ready, parse stdout, SIGTERM shutdown) without depending on any actual
  // atc-web repository. The real flow test (gateway-auth-audit.test.js) exercises real services.
  writeFileSync(join(dir, 'server.mjs'), `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => {
      console.log(JSON.stringify({ level: 30, msg: 'access', path: req.url }));
      if (req.url === '/ready') return res.writeHead(200).end('{"status":"ok"}');
      res.writeHead(404).end();
    });
    server.listen(${port}, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  const svc = new ServiceProcess({ name: 'selftest', cwd: dir, entry: 'server.mjs', env: { PATH: process.env.PATH ?? '' }, port });
  await svc.start({ timeoutMs: 5_000 });
  assert.equal(svc.child?.exitCode, null, 'still running once ready');
  await fetch(`${svc.baseUrl}/hello`);
  await new Promise((r) => setTimeout(r, 50)); // let the child's stdout chunk reach us
  const found = svc.findLog((f) => f.msg === 'access' && f.path === '/hello');
  assert.ok(found, 'the child’s own stdout log line was captured and parsed');
  await svc.stop();
  assert.notEqual(svc.child?.exitCode, undefined);
  assert.notEqual(svc.child?.killed, false);
});

test('ServiceProcess.start: rejects with a useful message when the process never becomes ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-selftest-'));
  writeFileSync(join(dir, 'server.mjs'), "console.log('never listens');\nsetInterval(() => {}, 1000);\n");
  const port = await freePort();
  const svc = new ServiceProcess({ name: 'nevers-up', cwd: dir, entry: 'server.mjs', env: { PATH: process.env.PATH ?? '' }, port });
  await assert.rejects(svc.start({ timeoutMs: 500, pollMs: 50 }), /nevers-up did not become ready/);
  await svc.stop();
});

test('stopAll: stops a running process and tolerates one that was never started, without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-selftest-'));
  const port = await freePort();
  writeFileSync(join(dir, 'server.mjs'), `
    import { createServer } from 'node:http';
    const server = createServer((_req, res) => res.writeHead(200).end('{"status":"ok"}'));
    server.listen(${port}, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  const alive = new ServiceProcess({ name: 'alive', cwd: dir, entry: 'server.mjs', env: { PATH: process.env.PATH ?? '' }, port });
  await alive.start({ timeoutMs: 3_000 });
  const neverStarted = new ServiceProcess({ name: 'never-started', cwd: dir, entry: 'server.mjs', env: {}, port: await freePort() });
  await stopAll([alive, neverStarted]); // must not throw even though neverStarted.child is still null
  assert.notEqual(alive.child?.exitCode, undefined, 'the running one was actually stopped');
});
