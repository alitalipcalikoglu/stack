import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPOSITORIES } from './repository-catalog.js';

/** @typedef {{ id: string, remote: string }} Repository */
/** @typedef {{ repository?: string, tag: string, commit: string }} ReleaseRepository */

export class InstallError extends Error {
  /** @param {string} phase @param {string} message @param {string} [repository] */
  constructor(phase, message, repository) {
    super(`[${phase}]${repository ? ` ${repository}:` : ''} ${message}`);
    this.name = 'InstallError';
    this.phase = phase;
    this.repository = repository;
  }
}

/**
 * Repository acquisition and verification for `install:all`. Setup and process supervision stay
 * in Stack; this class only gets the source tree into a known state, installs lockfile dependencies,
 * and coordinates those existing mechanisms.
 */
export class Installer {
  /**
   * @param {object} o
   * @param {string} o.root
   * @param {string} o.stackDir
   * @param {import('./stack.js').Stack} o.stack
   * @param {(cwd: string, argv: string[], opts?: { stdio?: 'inherit'|'pipe' }) => Promise<{ code: number, out: string }>} o.exec
   * @param {(line: string) => void} [o.log]
   * @param {readonly Repository[]} [o.repositories]
   * @param {{ schemaVersion: number, channel: string, release: string, repositories: Record<string, ReleaseRepository> }} [o.release]
   */
  constructor({ root, stackDir, stack, exec, log = (line) => console.log(line), repositories = REPOSITORIES, release = Installer.releaseManifest() }) {
    this.root = resolve(root);
    this.stackDir = realpathSync(stackDir);
    this.stack = stack;
    this.exec = exec;
    this.log = log;
    this.repositories = repositories;
    this.release = release;
  }

  static releaseManifest() {
    const directory = new URL('../installation-manifests/', import.meta.url);
    const supported = JSON.parse(readFileSync(new URL('supported.json', directory), 'utf8'));
    if (supported.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(supported.release ?? '')) {
      throw new InstallError('PREFLIGHT', 'supported release pointer is invalid');
    }
    const manifest = JSON.parse(readFileSync(new URL(`v${supported.release}.json`, directory), 'utf8'));
    if (manifest.release !== supported.release) throw new InstallError('PREFLIGHT', 'supported release pointer and installation manifest disagree');
    return manifest;
  }

  /**
   * @param {{ ref?: string, start?: boolean, splitWorkers?: boolean, dryRun?: boolean, host?: string, local?: boolean, adminEmail?: string, adminPassword?: string, readinessTimeoutMs?: number }} [o]
   */
  async install({ ref, start = true, splitWorkers = false, dryRun = false, host = '127.0.0.1', local = true, adminEmail, adminPassword, readinessTimeoutMs = 60_000 } = {}) {
    const mode = ref === undefined ? 'release' : 'development';
    if (ref !== undefined && ref !== 'main') throw new InstallError('PREFLIGHT', 'only the explicit development ref "main" is supported; omit --ref for the supported release');
    await this.#preflight({ start: start && !dryRun });
    this.#validateCatalog();

    /** @type {string[]} */ const cloned = [];
    /** @type {string[]} */ const reused = [];
    /** @type {Record<string, string>} */ const commits = {};
    for (const repository of this.repositories) {
      const result = await this.#prepareRepository(repository, { mode, ref: ref ?? null, dryRun });
      (result.action === 'clone' ? cloned : reused).push(repository.id);
      commits[repository.id] = result.commit;
    }

    if (dryRun) {
      return { mode, ref: mode === 'release' ? this.release.release : ref, root: this.root, cloned, reused, dependencies: [], configured: false, started: false, splitWorkers, ready: 0, commits, dryRun: true };
    }

    /** @type {string[]} */ const dependencies = [];
    for (const repository of this.repositories) {
      const dir = join(this.root, repository.id);
      if (!existsSync(join(dir, 'package-lock.json'))) throw new InstallError('DEPENDENCIES', 'package-lock.json is missing; refusing a non-reproducible install', repository.id);
      this.log(`${repository.id}: npm ci`);
      await this.#run('DEPENDENCIES', repository.id, dir, ['npm', 'ci', '--no-audit', '--no-fund']);
      dependencies.push(repository.id);
    }

    let setup;
    try {
      setup = await this.stack.setup({ host, local, install: false, adminEmail, adminPassword });
    } catch (error) {
      throw this.#phaseError('SETUP', error);
    }

    let ready = 0;
    if (start) {
      try {
        await this.stack.up({ splitWorkers });
      } catch (error) {
        throw this.#phaseError('START', error);
      }
      let rows;
      try {
        rows = await this.stack.waitReady(readinessTimeoutMs);
      } catch (error) {
        throw this.#phaseError('READINESS', error);
      }
      ready = rows.filter((row) => row.ok).length;
      if (ready !== rows.length) {
        const failed = rows.filter((row) => !row.ok).map((row) => row.id).join(', ');
        throw new InstallError('READINESS', `${ready}/${rows.length} services ready before ${readinessTimeoutMs}ms timeout; not ready: ${failed}. Inspect "pm2 logs" and rerun "atc-stack status".`);
      }
    }

    return { mode, ref: mode === 'release' ? this.release.release : ref, root: this.root, cloned, reused, dependencies, configured: true, started: start, splitWorkers, ready, commits, dryRun: false, adminCreated: setup.admin.created };
  }

  /** @param {{ start: boolean }} o */
  async #preflight({ start }) {
    if (!existsSync(this.root)) throw new InstallError('PREFLIGHT', `workspace root does not exist: ${this.root}`);
    if (this.root === resolve('/') || this.root === resolve(homedir()) || this.root === this.stackDir) {
      throw new InstallError('PREFLIGHT', `refusing unsafe workspace root: ${this.root}; choose a dedicated parent directory for the sibling repositories`);
    }
    const rootStat = lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new InstallError('PREFLIGHT', `workspace root must be a real directory, not a symlink: ${this.root}`);
    try {
      accessSync(this.root, constants.R_OK | constants.W_OK);
    } catch {
      throw new InstallError('PREFLIGHT', `workspace root is not readable and writable: ${this.root}`);
    }
    if (!existsSync(join(this.stackDir, '.git')) || !existsSync(join(this.stackDir, 'package.json'))) throw new InstallError('PREFLIGHT', `stack CLI is not running from a valid stack checkout: ${this.stackDir}`);
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) throw new InstallError('PREFLIGHT', `Node 22.13+ is required; found ${process.versions.node}`);
    await this.#tool('git', ['--version']);
    await this.#tool('npm', ['--version']);
    if (start) await this.#tool('pm2', ['--version'], 'PM2 is required for default startup; install it with "npm i -g pm2", or rerun with --no-start');
  }

  #validateCatalog() {
    const ids = this.repositories.map((repository) => repository.id);
    if (new Set(ids).size !== ids.length) throw new InstallError('PREFLIGHT', 'installer repository catalog contains duplicate ids');
    if (ids.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new InstallError('PREFLIGHT', 'installer repository catalog contains an unsafe repository id');
    if (this.release.schemaVersion !== 1 || this.release.channel !== 'release') throw new InstallError('PREFLIGHT', 'unsupported installation manifest');
    for (const repository of this.repositories) {
      const entry = this.release.repositories[repository.id];
      if (!entry || !/^v[^\s]+$/.test(entry.tag) || !/^[0-9a-f]{40}$/.test(entry.commit)) throw new InstallError('PREFLIGHT', 'release descriptor entry is missing or invalid', repository.id);
      if (entry.repository !== undefined && entry.repository !== repository.remote) throw new InstallError('PREFLIGHT', 'release descriptor repository does not match the official remote', repository.id);
    }
  }

  /** @param {Repository} repository @param {{ mode: string, ref: string|null, dryRun: boolean }} o */
  async #prepareRepository(repository, { mode, ref, dryRun }) {
    const path = join(this.root, repository.id);
    const exists = existsSync(path);
    if (exists) this.#validateExistingPath(repository, path);
    const expected = this.release.repositories[repository.id];

    if (dryRun) {
      const commit = mode === 'release'
        ? await this.#verifyRemoteRelease(repository, expected)
        : await this.#remoteHead(repository, /** @type {string} */ (ref));
      if (exists) await this.#verifyExisting(repository, path, { mode, ref, expected, mutate: false, remoteCommit: commit });
      this.log(`${repository.id}: ${exists ? 'reuse' : 'clone'} ${mode === 'release' ? `${expected.tag} @ ${commit}` : `${ref} @ ${commit}`} (dry-run)`);
      return { action: exists ? 'reuse' : 'clone', commit };
    }

    if (!exists) {
      this.log(`${repository.id}: clone ${repository.remote}`);
      if (mode === 'release') {
        const remoteCommit = await this.#verifyRemoteRelease(repository, expected);
        await this.#run('CLONE', repository.id, this.root, ['git', 'clone', '--no-checkout', '--origin', 'origin', repository.remote, path]);
        await this.#run('GIT_VERIFY', repository.id, path, ['git', 'checkout', '--detach', expected.commit]);
        await this.#verifyExisting(repository, path, { mode, ref, expected, mutate: false, remoteCommit });
        return { action: 'clone', commit: expected.commit };
      }
      await this.#run('CLONE', repository.id, this.root, ['git', 'clone', '--branch', /** @type {string} */ (ref), '--single-branch', '--origin', 'origin', repository.remote, path]);
      const commit = await this.#verifyExisting(repository, path, { mode, ref, expected, mutate: false });
      return { action: 'clone', commit };
    }

    const commit = await this.#verifyExisting(repository, path, { mode, ref, expected, mutate: true });
    this.log(`${repository.id}: reuse ${commit}`);
    return { action: 'reuse', commit };
  }

  /** @param {Repository} repository @param {string} path */
  #validateExistingPath(repository, path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new InstallError('GIT_VERIFY', `expected path is a symlink; use a real checkout at ${path}`, repository.id);
    if (!stat.isDirectory()) throw new InstallError('GIT_VERIFY', `expected path is not a directory; move it aside and rerun`, repository.id);
    if (!existsSync(join(path, '.git'))) throw new InstallError('GIT_VERIFY', `existing directory is not a Git repository; move it aside or clone the official repository there`, repository.id);
  }

  /** @param {Repository} repository @param {string} path @param {{ mode: string, ref: string|null, expected: ReleaseRepository, mutate: boolean, remoteCommit?: string }} o */
  async #verifyExisting(repository, path, { mode, ref, expected, mutate, remoteCommit }) {
    const origin = (await this.#git(repository.id, path, ['remote', 'get-url', 'origin'])).trim();
    if (origin !== repository.remote) throw new InstallError('GIT_VERIFY', `origin does not match the official remote ${repository.remote}; correct the remote or move this checkout aside`, repository.id);
    const dirty = await this.#git(repository.id, path, ['status', '--porcelain=v1']);
    if (dirty.trim()) throw new InstallError('GIT_VERIFY', 'working tree is dirty; commit or otherwise resolve local changes, then rerun', repository.id);

    if (mode === 'release') {
      const resolvedRemote = remoteCommit ?? await this.#verifyRemoteRelease(repository, expected);
      if (mutate) await this.#run('GIT_VERIFY', repository.id, path, ['git', 'fetch', '--no-write-fetch-head', 'origin', `refs/tags/${expected.tag}:refs/tags/${expected.tag}`]);
      const tagCommit = (await this.#git(repository.id, path, ['rev-parse', `${expected.tag}^{}`])).trim();
      if (tagCommit !== expected.commit || resolvedRemote !== expected.commit) throw new InstallError('GIT_VERIFY', `${expected.tag} does not resolve to expected immutable commit ${expected.commit}; refusing installation`, repository.id);
      const head = (await this.#git(repository.id, path, ['rev-parse', 'HEAD'])).trim();
      if (head !== expected.commit) throw new InstallError('GIT_VERIFY', `clean checkout is at ${head}, expected release ${expected.tag} at ${expected.commit}; checkout that exact release in detached HEAD state or use --ref main explicitly`, repository.id);
      return head;
    }

    const branch = (await this.#git(repository.id, path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)).trim();
    if (branch !== ref) throw new InstallError('GIT_VERIFY', `current branch is ${branch || '(detached)'}, expected ${ref}; switch branches explicitly and rerun`, repository.id);
    const intended = remoteCommit ?? await this.#remoteHead(repository, /** @type {string} */ (ref));
    if (mutate) {
      await this.#run('GIT_VERIFY', repository.id, path, ['git', 'fetch', '--no-write-fetch-head', 'origin', `refs/heads/${ref}:refs/remotes/origin/${ref}`]);
      const fetched = (await this.#git(repository.id, path, ['rev-parse', `refs/remotes/origin/${ref}`])).trim();
      if (fetched !== intended) throw new InstallError('GIT_VERIFY', `fetched ${ref} resolved unexpectedly (${fetched}, expected ${intended}); rerun after checking the remote`, repository.id);
      const ancestor = await this.exec(path, ['git', 'merge-base', '--is-ancestor', 'HEAD', fetched], { stdio: 'pipe' });
      if (ancestor.code !== 0) throw new InstallError('GIT_VERIFY', `local ${ref} has diverged from origin/${ref}; reconcile it manually, then rerun`, repository.id);
      await this.#run('GIT_VERIFY', repository.id, path, ['git', 'merge', '--ff-only', fetched]);
    }
    const head = (await this.#git(repository.id, path, ['rev-parse', 'HEAD'])).trim();
    if (head !== intended) throw new InstallError('GIT_VERIFY', `${ref} is at ${head}, expected current official commit ${intended}`, repository.id);
    return head;
  }

  /** @param {Repository} repository @param {ReleaseRepository} expected */
  async #verifyRemoteRelease(repository, expected) {
    const out = await this.#git(repository.id, this.root, ['ls-remote', '--tags', repository.remote, `refs/tags/${expected.tag}`, `refs/tags/${expected.tag}^{}`]);
    const rows = out.trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/));
    const peeled = rows.find((row) => row[1] === `refs/tags/${expected.tag}^{}`)?.[0];
    const direct = rows.find((row) => row[1] === `refs/tags/${expected.tag}`)?.[0];
    const commit = peeled ?? direct;
    if (commit !== expected.commit) throw new InstallError('GIT_VERIFY', `remote ${expected.tag} resolves to ${commit ?? '(missing)'}, expected immutable commit ${expected.commit}`, repository.id);
    return commit;
  }

  /** @param {Repository} repository @param {string} ref */
  async #remoteHead(repository, ref) {
    const out = await this.#git(repository.id, this.root, ['ls-remote', '--heads', repository.remote, `refs/heads/${ref}`]);
    const commit = out.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new InstallError('GIT_VERIFY', `official branch ${ref} is missing`, repository.id);
    return commit;
  }

  /** @param {string} repository @param {string} cwd @param {string[]} args @param {boolean} [allowFailure] */
  async #git(repository, cwd, args, allowFailure = false) {
    const result = await this.exec(cwd, ['git', ...args], { stdio: 'pipe' }).catch((error) => { throw this.#phaseError('GIT_VERIFY', error, repository); });
    if (result.code !== 0 && !allowFailure) throw new InstallError('GIT_VERIFY', `git ${args[0]} failed (exit ${result.code}): ${Installer.safeOutput(result.out)}`, repository);
    return result.code === 0 ? result.out : '';
  }

  /** @param {string} command @param {string[]} args @param {string} [message] */
  async #tool(command, args, message) {
    const result = await this.exec(this.root, [command, ...args], { stdio: 'pipe' }).catch(() => ({ code: 1, out: '' }));
    if (result.code !== 0) throw new InstallError('PREFLIGHT', message ?? `${command} is required and was not found`);
  }

  /** @param {string} phase @param {string} repository @param {string} cwd @param {string[]} argv */
  async #run(phase, repository, cwd, argv) {
    const result = await this.exec(cwd, argv).catch((error) => { throw this.#phaseError(phase, error, repository); });
    if (result.code !== 0) throw new InstallError(phase, `${argv[0]} ${argv[1] ?? ''} failed (exit ${result.code}); fix the reported error and rerun install:all`, repository);
  }

  /** @param {string} phase @param {unknown} error @param {string} [repository] */
  #phaseError(phase, error, repository) {
    if (error instanceof InstallError) return error;
    return new InstallError(phase, error instanceof Error ? error.message : String(error), repository);
  }

  /** @param {string} value */
  static safeOutput(value) {
    return value.trim().split('\n').slice(-2).join(' ').slice(0, 400) || 'no diagnostic output';
  }
}
