'use strict';

const nodeFs = require('fs');
const nodePath = require('path');

function envGet(env, name) {
  const key = Object.keys(env).sort().find(candidate => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function fullyQualified(value) {
  return typeof value === 'string'
    && (/^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(value));
}

function stubError(exe, pkgJson) {
  return {
    kind: 'error',
    code: 'ENOEXEC',
    message: `${exe} is not an executable (no MZ header)${pkgJson
      ? " — the package's postinstall (install.cjs) did not run or could not download the native binary (npm --ignore-scripts / --omit=optional). Re-run the install with scripts enabled"
      : ''}`,
  };
}

function unsupportedShimMessage(shim, bin) {
  return `${shim} is a batch-file wrapper ccxray does not run (it would need cmd.exe, which cannot carry arbitrary prompt text safely). Supported: the native installer, npm install -g (${bin}.cmd next to node_modules), or a directory containing ${bin}.exe placed earlier on PATH.`;
}

function hasMZ(fs, value) {
  let fd;
  try {
    fd = fs.openSync(value, 'r');
    const bytes = Buffer.alloc(2);
    return fs.readSync(fd, bytes, 0, 2, 0) === 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function resolveAgentLaunch(bin, args, env, provider, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return { kind: 'exe', file: bin, args };

  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath.win32;
  const execPath = deps.execPath || process.execPath;
  const isFile = value => {
    try { return fs.statSync(value).isFile(); } catch { return false; }
  };
  const error = (code, message) => ({ kind: 'error', code, message });

  let file;
  if (path.extname(bin) || /[\\/]/.test(bin)) {
    if (!fullyQualified(bin)) {
      return error('EINVAL', `${bin}: an explicit agent path must be fully qualified (drive-rooted or UNC)`);
    }
    file = bin;
  } else {
    const dirs = String(envGet(env, 'PATH') || '')
      .split(';')
      .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
      .filter(entry => entry && fullyQualified(entry));
    const extensions = String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map(extension => extension.trim())
      .filter(Boolean);
    search: for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = path.join(dir, bin + extension);
        if (isFile(candidate)) {
          file = candidate;
          break search;
        }
      }
    }
    if (!file) return error('ENOENT', `"${bin}" command not found on PATH`);
  }

  const extension = path.extname(file).toLowerCase();
  if (extension === '.exe') return hasMZ(fs, file) ? { kind: 'exe', file, args } : stubError(file);
  if (extension === '.com') return { kind: 'exe', file, args };
  if (extension !== '.cmd' && extension !== '.bat') {
    return error('EUNSUPPORTEDEXT', `${file}: ccxray launches only .exe/.com executables or npm's .cmd shim`);
  }

  const shimDir = path.dirname(file);
  const packageDir = provider?.npmPackage
    && path.join(shimDir, 'node_modules', ...provider.npmPackage.split('/'));
  const packageJson = packageDir && path.join(packageDir, 'package.json');
  if (!packageJson || !isFile(packageJson)) {
    return error('EBATCHWRAPPER', unsupportedShimMessage(file, bin));
  }

  let binField;
  try {
    binField = JSON.parse(fs.readFileSync(packageJson, 'utf8')).bin;
  } catch {
    return error('EBADPKG', `${packageJson}: unreadable`);
  }
  const relativeBin = typeof binField === 'string' ? binField : binField && binField[bin];
  if (typeof relativeBin !== 'string') {
    return error('EBADPKG', `${packageJson}: no bin entry for "${bin}"`);
  }
  const target = path.resolve(packageDir, relativeBin);
  if (!target.toLowerCase().startsWith((packageDir + path.sep).toLowerCase())) {
    return error('EBADPKG', `${packageJson}: bin target escapes the package`);
  }

  const expected = path.relative(shimDir, target).replace(/\//g, '\\').toLowerCase();
  let body;
  try {
    body = fs.readFileSync(file, 'utf8').slice(0, 65536).replace(/\//g, '\\').toLowerCase();
  } catch {
    body = '';
  }
  if (!body.includes(expected)) {
    return error('EBATCHWRAPPER', unsupportedShimMessage(file, bin));
  }
  if (!isFile(target)) return error('ENOENT', `${target} (from ${packageJson}) is missing`);

  const targetExtension = path.extname(target).toLowerCase();
  const via = { shim: file, pkgJson: packageJson };
  if (targetExtension === '.exe') {
    return hasMZ(fs, target) ? { kind: 'exe', file: target, args, via } : stubError(target, packageJson);
  }
  if (targetExtension === '.com') return { kind: 'exe', file: target, args, via };
  if (targetExtension === '.js' || targetExtension === '.cjs' || targetExtension === '.mjs') {
    return { kind: 'exe', file: execPath, args: [target, ...args], via };
  }
  return error('EBATCHWRAPPER', unsupportedShimMessage(file, bin));
}

function describeResolution(bin, env, provider, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') {
    return { bin, platform, result: resolveAgentLaunch(bin, [], env, provider, deps) };
  }
  const path = deps.path || nodePath.win32;
  const fs = deps.fs || nodeFs;
  const dirs = String(envGet(env, 'PATH') || '')
    .split(';')
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'));
  const extensions = String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean);
  const probes = [];
  if (!path.extname(bin) && !/[\\/]/.test(bin)) {
    for (const dir of dirs) {
      if (!fullyQualified(dir)) {
        probes.push({ dir, skipped: 'not fully qualified' });
        continue;
      }
      for (const extension of extensions) {
        const candidate = path.join(dir, bin + extension);
        let exists = false;
        try { exists = fs.statSync(candidate).isFile(); } catch {}
        probes.push({ candidate, exists });
      }
    }
  }
  const result = resolveAgentLaunch(bin, [], env, provider, deps);
  const mz = result.code === 'ENOEXEC'
    ? false
    : result.kind === 'exe' && path.extname(result.file).toLowerCase() === '.exe'
      ? hasMZ(fs, result.file)
      : null;
  const chain = result.via ? {
    shim: result.via.shim,
    packageJson: result.via.pkgJson,
    target: result.file === (deps.execPath || process.execPath) ? result.args[0] : result.file,
  } : null;
  return { bin, platform, pathValue: envGet(env, 'PATH'), pathExtValue: envGet(env, 'PATHEXT'), probes, hit: result.kind === 'error' ? null : result.file, chain, mz, result };
}

module.exports = { envGet, resolveAgentLaunch, describeResolution, stubError, unsupportedShimMessage };
