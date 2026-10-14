'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fileURLToPath } = require('node:url');

const syncFsMethods = [
  'accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync',
  'closeSync', 'createReadStream', 'existsSync', 'linkSync', 'lstatSync', 'mkdirSync', 'mkdtempSync',
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

function findExecutable(name, searchPath = process.env.PATH || '', env = process.env, platform = process.platform, io = fs) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const extensions = platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidates = platform === 'win32' && !pathApi.extname(name)
    ? extensions.map(extension => name + extension)
    : [name];
  for (const dir of searchPath.split(pathApi.delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const file = pathApi.join(dir, candidate);
      try {
        if (!io.statSync(file).isFile()) continue;
        if (platform !== 'win32') io.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

function fixtureExecutableSearchPath(env = process.env, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const gitBashDirs = platform === 'win32'
    ? [env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter(Boolean)
      .map(programFiles => pathApi.join(programFiles, 'Git', 'bin'))
    : [];
  return [env.PATH || '', ...gitBashDirs].filter(Boolean).join(pathApi.delimiter);
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

  const executableSearchPath = fixtureExecutableSearchPath();
  const allowedShells = ['bash', 'zsh', 'pwsh', 'powershell.exe']
    .map(name => findExecutable(name, executableSearchPath))
    .filter(Boolean);
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const windowsPowerShell = path.join(
      process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    try {
      if (originalFs.statSync(windowsPowerShell).isFile()
          && !allowedShells.some(file => file.toLowerCase() === windowsPowerShell.toLowerCase())) {
        allowedShells.push(windowsPowerShell);
      }
    } catch {}
  }
  const systemDirs = process.platform === 'win32'
    ? [
      process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32'),
      process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].filter(Boolean)
    : ['/bin', '/usr/bin'];
  const shellDirs = [...new Set([
    ...allowedShells.map(file => path.dirname(file)),
    ...systemDirs,
    path.dirname(process.execPath),
  ])];
  const pathApi = process.platform === 'win32' ? path.win32 : path;
  const shellCandidateNames = ['bash', 'zsh', 'pwsh', 'powershell', 'powershell.exe'];
  if (process.platform === 'win32') {
    const extensions = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    shellCandidateNames.push(...['bash', 'zsh', 'pwsh', 'powershell'].flatMap(name =>
      extensions.map(extension => name + extension)));
  }
  const shellExecutableCandidates = new Set(shellDirs.flatMap(dir =>
    shellCandidateNames.map(name => {
      const candidate = pathApi.resolve(pathApi.join(dir, name));
      return process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    })));
  const fixturePath = [paths.bin, ...shellDirs].join(path.delimiter);
  const env = { ...process.env };
  for (const key of DELETED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('CCXRAY_EXPORT_') && key !== 'CCXRAY_EXPORT_DISABLE') delete env[key];
  }
  Object.assign(env, {
    HOME: paths.home,
    ZDOTDIR: paths.zdotdir,
    SHELL: 'bash',
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
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(paths.bin, 'fake-client.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const executable = process.argv[2];',
      'const args = process.argv.slice(3);',
      "const log = path.join(process.env.CCXRAY_HOME, executable === 'ccxray' ? 'fake-ccxray.log' : 'fake-claude.log');",
      "fs.appendFileSync(log, args.map(value => '<' + value + '>\\n').join(''));",
      'process.exit(Number(process.env.CCXRAY_FAKE_EXIT || 0));',
      '',
    ].join('\n'));
    for (const name of ['claude', 'ccxray']) {
      fs.writeFileSync(path.join(paths.bin, name + '.cmd'), [
        '@echo off',
        '"' + process.execPath + '" "%~dp0fake-client.js" ' + name + ' %*',
        'exit /b %errorlevel%',
        '',
      ].join('\r\n'));
    }
  }

  const fixtureLexicalRoot = path.resolve(root);
  const fixtureRoot = path.resolve(originalRealpath(root));
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
  const canonicalizeFixturePath = candidate => {
    if (process.platform !== 'win32' || !allowedRoots.some(base => isUnder(candidate, base))) return candidate;
    try { return path.resolve(originalRealpath(candidate)); }
    catch { return candidate; }
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
    const raw = normalizePath(candidate);
    const absolute = path.isAbsolute(raw) ? raw : `${process.cwd()}${path.sep}${raw}`;
    const parsed = path.parse(absolute);
    let pending = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    const visited = new Set();
    let hops = 0;
    for (let index = 0; index < pending.length; index++) {
      const part = pending[index];
      if (part === '.' || part === '') continue;
      if (part === '..') { current = path.dirname(current); continue; }
      const next = path.resolve(path.join(current, part));
      let stat;
      try { stat = originalFs.lstatSync(next); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        current = next;
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (++hops > 40) throw new Error(`symlink chain exceeds 40 hops at ${next}`);
        const target = originalFs.readlinkSync(next);
        const state = `${next}\0${pending.slice(index).join('/')}`;
        if (visited.has(state)) throw new Error(`symlink loop at ${next}`);
        visited.add(state);
        const targetPath = path.isAbsolute(target) ? target : `${path.dirname(next)}${path.sep}${target}`;
        const targetParsed = path.parse(targetPath);
        pending = targetPath.slice(targetParsed.root.length).split(path.sep).filter(Boolean)
          .concat(pending.slice(index + 1));
        current = targetParsed.root;
        index = -1;
        continue;
      }
      if (index < pending.length - 1 && !stat.isDirectory()) {
        const error = new Error(`${next} is not a directory`);
        error.code = 'ENOTDIR';
        throw error;
      }
      current = canonicalizeFixturePath(next);
    }
    return path.resolve(current);
  };
  const assertPathAllowed = (operation, candidate, { write = false, follow = true } = {}) => {
    if (typeof candidate === 'number') return;
    let lexical;
    let rawPath;
    try {
      rawPath = normalizePath(candidate);
      lexical = path.resolve(rawPath);
    }
    catch (error) {
      outsideAttempts.push({ operation, path: String(candidate), reason: 'unsupported-path' });
      throw error;
    }
    const lexicalInside = allowedRoots.some(base => isUnder(lexical, base));
    if (write) {
      let resolved;
      try { resolved = resolveForBoundary(rawPath); }
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
    try { resolved = resolveForBoundary(rawPath); }
    catch (error) {
      outsideAttempts.push({ operation, path: lexical, reason: error.code || 'resolve-failed' });
      throw error;
    }
    if (!isUnder(resolved, fixtureRoot)) {
      outsideAttempts.push({ operation, path: lexical, resolved, reason: 'outside-fixture-read' });
      assert.fail(`sensitive filesystem read outside fixture root: ${operation} ${lexical} → ${resolved}`);
    }
  };
  const isShellExecutableCandidate = candidate => {
    const raw = normalizePath(candidate);
    const absolute = pathApi.resolve(raw);
    return shellExecutableCandidates.has(process.platform === 'win32' ? absolute.toLowerCase() : absolute);
  };
  const policies = {
    accessSync: { follow: true }, appendFileSync: { write: true }, chmodSync: { write: true },
    chownSync: { write: true }, copyFileSync: { copy: true }, createReadStream: { follow: true },
    closeSync: { descriptor: true }, existsSync: { follow: true }, linkSync: { link: true },
    lstatSync: { follow: false }, mkdirSync: { write: true },
    mkdtempSync: { write: true }, openSync: { open: true }, readFileSync: { follow: true },
    readdirSync: { follow: true }, readlinkSync: { follow: false }, realpathSync: { follow: true },
    renameSync: { rename: true }, rmSync: { write: true }, rmdirSync: { write: true },
    statSync: { follow: true }, symlinkSync: { symlink: true }, truncateSync: { write: true },
    unlinkSync: { write: true }, utimesSync: { write: true }, writeFileSync: { writeFile: true },
  };
  const guardedCall = (target, property, args, delegate = null) => {
    const policy = policies[property];
    if (!policy) return (delegate || target[property]).apply(target, args);
    if (['accessSync', 'lstatSync', 'statSync'].includes(property)
        && isShellExecutableCandidate(args[0])) {
      try { (delegate || target[property]).apply(target, args); }
      catch (error) { if (error.code === 'ENOENT') throw error; }
    }
    if (policy.copy) {
      assertPathAllowed('copyFileSync:source', args[0]);
      assertPathAllowed('copyFileSync:destination', args[1], { write: true });
    } else if (policy.rename) {
      assertPathAllowed('renameSync:source', args[0], { write: true });
      assertPathAllowed('renameSync:destination', args[1], { write: true });
    } else if (policy.symlink) {
      assertPathAllowed('symlinkSync:link', args[1], { write: true });
    } else if (policy.link) {
      assertPathAllowed('linkSync:source', args[0]);
      assertPathAllowed('linkSync:destination', args[1], { write: true });
    } else if (policy.open) {
      assertPathAllowed('openSync', args[0], { write: openWrites(args[1]) });
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
      if (property === 'realpathSync') {
        const guarded = (...args) => guardedCall(target, property, args);
        guarded.native = (...args) => guardedCall(target, property, args, originalRealpath);
        return guarded;
      }
      if (Object.prototype.hasOwnProperty.call(policies, property)) {
        return (...args) => guardedCall(target, property, args);
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const promisePolicies = {
    access: 'read', appendFile: 'write', chmod: 'write', chown: 'write', copyFile: 'copy',
    lstat: 'read', mkdir: 'write', open: 'open', readFile: 'read', readdir: 'read',
    readlink: 'read', realpath: 'read', rename: 'rename', rm: 'write', rmdir: 'write',
    stat: 'read', symlink: 'symlink', truncate: 'write', unlink: 'write', utimes: 'write', writeFile: 'write',
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
          assertPathAllowed(String(property), args[0], { write: openWrites(args[1]) });
        } else {
          assertPathAllowed(String(property), args[0], { write: policy === 'write', follow: policy !== 'write' });
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
      const guarded = function(...args) { return guardedCall(fs, property, args, original); };
      if (property === 'realpathSync') guarded.native = (...args) => guardedCall(fs, property, args, originalRealpath);
      fs[property] = guarded;
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

function openWrites(flags) {
  return typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wax+]/.test(String(flags || 'r'));
}

module.exports = {
  DELETED_ENV, createSetupFixture, findExecutable, fixtureExecutableSearchPath, reservePort,
};
