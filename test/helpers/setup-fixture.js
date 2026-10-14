'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fileURLToPath } = require('node:url');

const syncFsMethods = [
  'accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync',
  'createReadStream', 'existsSync', 'lstatSync', 'mkdirSync', 'mkdtempSync',
  'openSync', 'readFileSync', 'readdirSync', 'readlinkSync', 'realpathSync',
  'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'symlinkSync', 'truncateSync',
  'unlinkSync', 'utimesSync', 'writeFileSync',
];
const originalFs = Object.fromEntries(syncFsMethods.map(name => [name, fs[name].bind(fs)]));
const originalRealpath = fs.realpathSync.native.bind(fs.realpathSync);

const DELETED_ENV = [
  'CCXRAY_EXPORT_GCS_KEY_FILE',
  'ANTHROPIC_BASE_URL',
  'CCXRAY_HUB_CLIENT_PID',
  'CCXRAY_EXPORT_GCS_BUCKET',
  'CCXRAY_EXPORT_GCS_PREFIX',
  'CCXRAY_EXPORT_DOMAINS',
  'CCXRAY_EXPORT_CWD_ALLOWLIST',
  'CCXRAY_EXPORT_CONFIG_DIRS',
  'CCXRAY_USER_EMAIL',
  'CCXRAY_AGENT_ID',
  'CCXRAY_TEAM',
  'LOG_RETENTION_DAYS',
];

function findExecutable(name, searchPath = process.env.PATH || '') {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      }
    } catch {}
  }
  return null;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function createSetupFixture({ name = 'ccxray-setup-test-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const paths = {
    root,
    home: path.join(root, 'home'),
    zdotdir: path.join(root, 'zsh'),
    claude: path.join(root, 'claude-config'),
    cloudsdk: path.join(root, 'cloudsdk'),
    ccxray: path.join(root, 'ccxray'),
    logs: path.join(root, 'logs'),
    bin: path.join(root, 'bin'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== root) fs.mkdirSync(dir, { recursive: true });
  }
  const port = await reservePort();
  fs.writeFileSync(path.join(paths.ccxray, 'export-lock-port'), `${port}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.claude, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'synthetic.user@example.test' },
  }));
  fs.writeFileSync(path.join(paths.cloudsdk, 'application_default_credentials.json'), JSON.stringify({
    type: 'authorized_user', client_id: 'synthetic-client',
    client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh-token',
  }));
  fs.writeFileSync(path.join(paths.logs, 'index.ndjson'), '');

  const allowedShells = ['bash', 'zsh', 'pwsh', 'powershell.exe']
    .map(name => findExecutable(name))
    .filter(Boolean);
  const shellDirs = [...new Set([
    ...allowedShells.map(file => path.dirname(file)),
    '/bin', '/usr/bin', path.dirname(process.execPath),
  ])];
  const fixturePath = [paths.bin, ...shellDirs].join(path.delimiter);
  const env = { ...process.env };
  for (const key of DELETED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('CCXRAY_EXPORT_') && key !== 'CCXRAY_EXPORT_DISABLE') delete env[key];
  }
  Object.assign(env, {
    HOME: paths.home,
    ZDOTDIR: paths.zdotdir,
    SHELL: '/bin/bash',
    CLAUDE_CONFIG_DIR: paths.claude,
    CLOUDSDK_CONFIG: paths.cloudsdk,
    CCXRAY_HOME: paths.ccxray,
    LOGS_DIR: paths.logs,
    TZ: 'UTC',
    PATH: fixturePath,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
  });
  for (const name of ['claude', 'ccxray']) {
    const file = path.join(paths.bin, name);
    fs.writeFileSync(file, [
      '#!/bin/sh',
      'case "$0" in */ccxray) log="$CCXRAY_HOME/fake-ccxray.log" ;; *) log="$CCXRAY_HOME/fake-claude.log" ;; esac',
      'printf "<%s>\\n" "$@" >> "$log"',
      'exit "${CCXRAY_FAKE_EXIT:-0}"',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.chmodSync(file, 0o700);
  }

  const fixtureLexicalRoot = path.resolve(root);
  const fixtureRoot = path.resolve(fs.realpathSync(root));
  const allowedRoots = [...new Set([fixtureRoot, fixtureLexicalRoot])];
  const allowedExecutables = new Set([
    process.execPath,
    ...allowedShells,
    ...['claude', 'ccxray'].map(name => path.join(paths.bin, name)),
  ].map(file => path.resolve(file)));
  const assertSpawnAllowed = file => {
    assert.ok(allowedExecutables.has(path.resolve(file)), `spawn executable is not allowlisted: ${file}`);
  };
  const executableMetadata = new Set([...allowedExecutables].map(file => path.resolve(file)));
  const metadataAncestors = new Set();
  for (const fixturePath of allowedRoots) {
    for (let current = path.dirname(fixturePath); ; current = path.dirname(current)) {
      metadataAncestors.add(path.resolve(current));
      if (path.dirname(current) === current) break;
    }
  }
  const outsideAttempts = [];
  const isUnder = (candidate, base) => {
    const relative = path.relative(base, candidate);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };
  const normalizePath = candidate => {
    if (typeof candidate === 'string') return candidate;
    if (Buffer.isBuffer(candidate)) return candidate.toString();
    if (candidate instanceof URL) return fileURLToPath(candidate);
    if (candidate && typeof candidate === 'object' && typeof candidate[Symbol.toPrimitive] === 'function') {
      return String(candidate);
    }
    throw new TypeError(`unsupported filesystem path argument: ${String(candidate)}`);
  };
  const resolveForBoundary = candidate => {
    let current = path.resolve(normalizePath(candidate));
    const suffix = [];
    while (true) {
      try {
        originalFs.lstatSync(current);
        const real = originalRealpath(current);
        return path.resolve(real, ...suffix.reverse());
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) return current;
        suffix.push(path.basename(current));
        current = parent;
      }
    }
  };
  const assertPathAllowed = (operation, candidate, { write = false, follow = true } = {}) => {
    if (typeof candidate === 'number') return;
    let lexical;
    try { lexical = path.resolve(normalizePath(candidate)); }
    catch (error) {
      outsideAttempts.push({ operation, path: String(candidate), reason: 'unsupported-path' });
      throw error;
    }
    const lexicalInside = allowedRoots.some(base => isUnder(lexical, base));
    if (write) {
      let resolved;
      try { resolved = resolveForBoundary(lexical); }
      catch (error) {
        outsideAttempts.push({ operation, path: lexical, reason: error.code || 'resolve-failed' });
        throw error;
      }
      if (!isUnder(resolved, fixtureRoot)) {
        outsideAttempts.push({ operation, path: lexical, resolved, reason: 'outside-fixture-write' });
        assert.fail(`sensitive filesystem write outside fixture root: ${operation} ${lexical} → ${resolved}`);
      }
      return;
    }
    if (!follow && lexicalInside) return;
    if (metadataAncestors.has(lexical)
        && ['lstatSync', 'readlinkSync', 'statSync', 'realpathSync'].includes(operation)) return;
    if (executableMetadata.has(lexical)
        && ['accessSync', 'lstatSync', 'statSync', 'realpathSync'].includes(operation)) return;
    let resolved;
    try { resolved = resolveForBoundary(lexical); }
    catch (error) {
      outsideAttempts.push({ operation, path: lexical, reason: error.code || 'resolve-failed' });
      throw error;
    }
    if (!isUnder(resolved, fixtureRoot)) {
      outsideAttempts.push({ operation, path: lexical, resolved, reason: 'outside-fixture-read' });
      assert.fail(`sensitive filesystem read outside fixture root: ${operation} ${lexical} → ${resolved}`);
    }
  };
  const policies = {
    accessSync: { follow: true }, appendFileSync: { write: true }, chmodSync: { write: true },
    chownSync: { write: true }, copyFileSync: { copy: true }, createReadStream: { follow: true },
    existsSync: { follow: true }, lstatSync: { follow: false }, mkdirSync: { write: true },
    mkdtempSync: { write: true }, openSync: { open: true }, readFileSync: { follow: true },
    readdirSync: { follow: true }, readlinkSync: { follow: false }, realpathSync: { follow: true },
    renameSync: { rename: true }, rmSync: { write: true }, rmdirSync: { write: true },
    statSync: { follow: true }, symlinkSync: { symlink: true }, truncateSync: { write: true },
    unlinkSync: { write: true }, utimesSync: { write: true }, writeFileSync: { writeFile: true },
  };
  const guardedCall = (target, property, args, delegate = null) => {
    const policy = policies[property];
    if (!policy) return (delegate || target[property]).apply(target, args);
    if (policy.copy) {
      assertPathAllowed('copyFileSync:source', args[0]);
      assertPathAllowed('copyFileSync:destination', args[1], { write: true });
    } else if (policy.rename) {
      assertPathAllowed('renameSync:source', args[0], { write: true });
      assertPathAllowed('renameSync:destination', args[1], { write: true });
    } else if (policy.symlink) {
      assertPathAllowed('symlinkSync:link', args[1], { write: true });
    } else if (policy.open) {
      const flags = args[1];
      const write = typeof flags === 'number'
        ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
        : /[wax+]/.test(String(flags || 'r'));
      assertPathAllowed('openSync', args[0], { write });
    } else if (policy.writeFile) {
      if (typeof args[0] !== 'number') assertPathAllowed('writeFileSync', args[0], { write: true });
    } else if (policy.write) {
      assertPathAllowed(property, args[0], { write: true });
    } else {
      assertPathAllowed(property, args[0], { follow: policy.follow });
    }
    return (delegate || target[property]).apply(target, args);
  };
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'promises') return guardedPromises;
      if (Object.prototype.hasOwnProperty.call(policies, property)) {
        return (...args) => guardedCall(target, property, args);
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const promisePolicies = {
    access: false, appendFile: true, chmod: true, chown: true, copyFile: 'copy',
    lstat: false, mkdir: true, open: 'open', readFile: false, readdir: false,
    readlink: false, realpath: false, rename: 'rename', rm: true, rmdir: true,
    stat: false, symlink: 'symlink', truncate: true, unlink: true, utimes: true, writeFile: true,
  };
  const guardedPromises = new Proxy(fs.promises, {
    get(target, property) {
      const policy = promisePolicies[property];
      const value = target[property];
      if (!policy || typeof value !== 'function') return value;
      return (...args) => {
        if (policy === 'copy') {
          assertPathAllowed(`${String(property)}:source`, args[0]);
          assertPathAllowed(`${String(property)}:destination`, args[1], { write: true });
        } else if (policy === 'rename') {
          assertPathAllowed(`${String(property)}:source`, args[0], { write: true });
          assertPathAllowed(`${String(property)}:destination`, args[1], { write: true });
        } else if (policy === 'symlink') {
          assertPathAllowed(`${String(property)}:link`, args[1], { write: true });
        } else if (policy === 'open') {
          assertPathAllowed(String(property), args[0], { write: /[wax+]/.test(String(args[1] || 'r')) });
        } else {
          assertPathAllowed(String(property), args[0], { write: policy === true, follow: policy !== true });
        }
        return value.apply(target, args);
      };
    },
  });
  const installGlobalFsGuard = () => {
    const restores = [];
    for (const property of syncFsMethods) {
      const original = fs[property];
      if (typeof original !== 'function') continue;
      fs[property] = function(...args) { return guardedCall(fs, property, args, original); };
      restores.push(() => { fs[property] = original; });
    }
    const promiseRestores = [];
    for (const property of Object.keys(promisePolicies)) {
      const original = fs.promises[property];
      if (typeof original !== 'function') continue;
      fs.promises[property] = guardedPromises[property];
      promiseRestores.push(() => { fs.promises[property] = original; });
    }
    return () => {
      for (const restore of promiseRestores.reverse()) restore();
      for (const restore of restores.reverse()) restore();
    };
  };

  const applyProcessEnv = () => {
    for (const key of DELETED_ENV) delete process.env[key];
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CCXRAY_EXPORT_') && key !== 'CCXRAY_EXPORT_DISABLE') delete process.env[key];
    }
    Object.assign(process.env, env);
  };
  const writeIndex = rows => {
    fs.writeFileSync(path.join(paths.logs, 'index.ndjson'), rows.map(row => `${JSON.stringify(row)}\n`).join(''));
  };
  const dispose = () => fs.rmSync(root, { recursive: true, force: true });

  return {
    paths, env, port, shellDirs, allowedShells, allowedExecutables, allowedRoots,
    assertSpawnAllowed, assertPathAllowed, outsideAttempts, guardedFs, installGlobalFsGuard,
    applyProcessEnv, writeIndex, dispose,
  };
}

module.exports = { DELETED_ENV, createSetupFixture, findExecutable, reservePort };
