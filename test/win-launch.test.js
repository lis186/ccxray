'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { envGet, resolveAgentLaunch, describeResolution } = require('../server/win-launch');

const winPath = path.win32;
const claude = { npmPackage: '@anthropic-ai/claude-code' };

class FakeWindowsFs {
  constructor() {
    this.files = new Map();
    this.descriptors = new Map();
    this.nextDescriptor = 1;
  }

  key(file) { return winPath.normalize(file).replace(/\\+/g, '\\').toLowerCase(); }

  write(file, content) { this.files.set(this.key(file), Buffer.isBuffer(content) ? content : Buffer.from(String(content))); }

  statSync(file) {
    if (!this.files.has(this.key(file))) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    return { isFile: () => true };
  }

  openSync(file) {
    const key = this.key(file);
    if (!this.files.has(key)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    const descriptor = this.nextDescriptor++;
    this.descriptors.set(descriptor, this.files.get(key));
    return descriptor;
  }

  readSync(descriptor, buffer, offset, length, position) {
    const bytes = this.descriptors.get(descriptor).subarray(position, position + length);
    bytes.copy(buffer, offset);
    return bytes.length;
  }

  closeSync(descriptor) { this.descriptors.delete(descriptor); }

  readFileSync(file, encoding) {
    const content = this.files.get(this.key(file));
    if (!content) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    return encoding ? content.toString(encoding) : Buffer.from(content);
  }
}

function fixture(root = 'C:\\npm', options = {}) {
  const fakeFs = new FakeWindowsFs();
  const command = options.command || 'claude';
  const packageDir = winPath.join(root, 'node_modules', ...claude.npmPackage.split('/'));
  const packageJson = winPath.join(packageDir, 'package.json');
  const target = winPath.resolve(packageDir, options.relativeBin || `bin/${command}.exe`);
  const shim = winPath.join(root, `${command}.cmd`);
  const relativeTarget = winPath.relative(root, target).replace(/\\/g, '\\');
  const body = options.body === undefined
    ? `@echo off\r\n"%dp0%\\${relativeTarget}" %*\r\n`
    : options.body;
  const binField = options.binField === undefined ? { [command]: options.relativeBin || `bin/${command}.exe` } : options.binField;
  fakeFs.write(packageJson, JSON.stringify({ bin: binField }));
  fakeFs.write(target, options.targetContent === undefined ? Buffer.from('MZfake') : options.targetContent);
  fakeFs.write(shim, body);
  return {
    fakeFs,
    root,
    packageDir,
    packageJson,
    target,
    shim,
    deps: { platform: 'win32', path: winPath, fs: fakeFs, execPath: 'C:\\node\\node.exe' },
    env: { PATH: root, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  };
}

function resolve(fx, bin = 'claude', args = ['--fixture'], env = fx.env, provider = claude) {
  return resolveAgentLaunch(bin, args, env, provider, fx.deps);
}

describe('Windows executable resolution policy (pure fake filesystem)', () => {
  it('matches Node env lookup order for PATH and PATHEXT case conflicts', () => {
    const fx = fixture('D:\\selected');
    const alternate = fixture('C:\\alternate');
    const env = { Path: alternate.root, PATH: fx.root, PathExt: '.EXE;.CMD', PATHEXT: '.CMD;.EXE' };
    assert.equal(envGet(env, 'PATH'), fx.root);
    assert.equal(envGet(env, 'PATHEXT'), '.CMD;.EXE');
    const plan = resolve(fx, 'claude', [], env);
    assert.equal(plan.kind, 'exe');
    assert.equal(plan.file, fx.target);
    assert.equal(plan.via.shim.toLowerCase(), winPath.join(fx.root, 'claude.CMD').toLowerCase());
  });

  it('uses sorted-first matching when the mixed-case env object is reversed', () => {
    const fx = fixture('D:\\selected');
    const alternate = fixture('C:\\alternate');
    assert.equal(envGet({ path: fx.root, Path: alternate.root }, 'PATH'), alternate.root);
  });

  it('strips quotes and skips empty, cwd, and relative PATH entries', () => {
    const fx = fixture('C:\\tools');
    const env = { PATH: `;.;..\\bin;"${fx.root}"`, PATHEXT: '.CMD' };
    const plan = resolve(fx, 'claude', [], env);
    assert.equal(plan.kind, 'exe');
    assert.equal(plan.file, fx.target);
    assert.equal(resolve(fx, 'claude', [], { PATH: '.;..\\bin', PATHEXT: '.CMD' }).code, 'ENOENT');
  });

  for (const skipped of ['\\tools', '/tools', 'C:tools', '.\\tools', 'relative\\bin']) {
    it(`ignores non-fully-qualified PATH entry ${JSON.stringify(skipped)} even when it contains claude.exe`, () => {
      const fx = fixture('C:\\tools');
      fx.fakeFs.write(winPath.join(skipped, 'claude.EXE'), Buffer.from('MZexe'));
      assert.equal(resolve(fx, 'claude', [], { PATH: skipped, PATHEXT: '.EXE' }).code, 'ENOENT');
    });
  }

  for (const accepted of ['C:\\tools', 'D:/tools', '\\\\srv\\share\\tools']) {
    it(`accepts fully-qualified PATH entry ${JSON.stringify(accepted)}`, () => {
      const fx = fixture(accepted);
      const plan = resolve(fx, 'claude', [], { PATH: accepted, PATHEXT: '.CMD' });
      assert.equal(plan.kind, 'exe');
      assert.ok(winPath.isAbsolute(plan.file));
    });
  }

  it('honors a fully-qualified PATH entry equal to the chosen cwd', () => {
    const cwd = 'C:\\chosen\\cwd';
    const fx = fixture(cwd);
    const plan = resolve(fx, 'claude', [], { PATH: cwd, PATHEXT: '.CMD' });
    assert.equal(plan.kind, 'exe');
    assert.equal(plan.file, fx.target);
  });

  for (const rejected of ['C:tools\\claude.exe', '\\tools\\claude.exe', '.\\claude.exe', 'claude.exe']) {
    it(`rejects non-fully-qualified explicit executable ${JSON.stringify(rejected)}`, () => {
      const fx = fixture();
      assert.equal(resolve(fx, rejected).code, 'EINVAL');
    });
  }

  for (const accepted of ['C:\\tools\\claude.exe', '\\\\srv\\share\\claude.exe']) {
    it(`accepts fully-qualified explicit executable ${JSON.stringify(accepted)}`, () => {
      const fx = fixture();
      fx.fakeFs.write(accepted, Buffer.from('MZexe'));
      assert.equal(resolve(fx, accepted).file, accepted);
    });
  }

  it('uses PATHEXT within a directory and PATH order across directories', () => {
    const first = fixture('C:\\first');
    const second = fixture('C:\\second');
    const commandShim = winPath.join(first.root, 'claude.CMD');
    first.fakeFs.write(commandShim, '@echo off');
    const firstExe = winPath.join(first.root, 'claude.EXE');
    first.fakeFs.write(firstExe, Buffer.from('MZexe'));
    const secondExe = winPath.join(second.root, 'claude.EXE');
    first.fakeFs.write(secondExe, Buffer.from('MZexe'));
    const env = { PATH: `${first.root};${second.root}`, PATHEXT: '.CMD;.EXE' };
    assert.match(resolve(first, 'claude', [], env).message, /C:\\first\\claude\.CMD/);
    assert.equal(resolve(first, 'claude', [], { PATH: `${first.root};${second.root}`, PATHEXT: '.EXE' }).file, firstExe);
    first.fakeFs.files.delete(first.fakeFs.key(firstExe));
    first.fakeFs.files.delete(first.fakeFs.key(commandShim));
    first.fakeFs.write(secondExe, Buffer.from('MZexe'));
    assert.equal(resolve(first, 'claude', [], { PATH: `${first.root};${second.root}`, PATHEXT: '.EXE' }).file, secondExe);
  });

  it('uses the default PATHEXT and selects .exe before a sibling .cmd', () => {
    const fx = fixture('C:\\default-pathext');
    const exe = winPath.join(fx.root, 'claude.EXE');
    fx.fakeFs.write(exe, Buffer.from('MZexe'));
    const plan = resolve(fx, 'claude', [], { PATH: fx.root });
    assert.equal(plan.kind, 'exe');
    assert.equal(plan.file, exe);
  });

  it('accepts MZ executables and reports the npm placeholder stub', () => {
    const exe = fixture();
    assert.equal(resolve(exe).kind, 'exe');
    const stub = fixture('C:\\stub', { targetContent: 'text placeholder' });
    const result = resolve(stub);
    assert.equal(result.code, 'ENOEXEC');
    assert.match(result.message, /install\.cjs/);
  });

  it('rejects a .js PATH hit instead of treating it as a command shim', () => {
    const fx = fixture('C:\\tools');
    fx.fakeFs.write(winPath.join(fx.root, 'claude.JS'), 'module.exports = 1');
    assert.equal(resolve(fx, 'claude', [], { PATH: fx.root, PATHEXT: '.JS;.EXE' }).code, 'EUNSUPPORTEDEXT');
  });

  it('unwraps npm cmd-shims with normalized separators and case', () => {
    const fx = fixture('C:\\npm', { body: '@echo off\r\n"%DP0%/NODE_MODULES/@ANTHROPIC-AI/CLAUDE-CODE/BIN/CLAUDE.EXE" %*' });
    const plan = resolve(fx);
    assert.equal(plan.kind, 'exe');
    assert.equal(plan.file, fx.target);
    assert.equal(plan.via.shim.toLowerCase(), fx.shim.toLowerCase());
    assert.equal(plan.via.pkgJson, fx.packageJson);
  });

  it('rejects an unrelated wrapper placed next to a valid npm package', () => {
    const fx = fixture('C:\\npm', { body: '@echo off\r\nset FOO=1\r\n"C:\\other\\claude.exe" %*' });
    const result = resolve(fx);
    assert.equal(result.code, 'EBATCHWRAPPER');
    assert.match(result.message, /cmd\.exe/);
  });

  it('rejects a wrapper naming a different package target', () => {
    const fx = fixture('C:\\npm', { body: '@echo off\r\n"%dp0%\\node_modules\\other\\bin\\claude.exe" %*' });
    assert.equal(resolve(fx).code, 'EBATCHWRAPPER');
  });

  it('characterizes target-naming wrappers whose setup side effects are bypassed', () => {
    const fx = fixture('C:\\npm', { body: '@echo off\r\nset FOO=1\r\n"%~dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*' });
    assert.equal(resolve(fx).kind, 'exe');
  });

  it('reports a placeholder target with the package install diagnostic', () => {
    const fx = fixture('C:\\npm', { targetContent: 'not a PE image' });
    const result = resolve(fx);
    assert.equal(result.code, 'ENOEXEC');
    assert.match(result.message, /install\.cjs/);
  });

  it('accepts a string bin and rejects missing or escaping package bins', () => {
    const stringBin = fixture('C:\\string', { binField: 'bin/claude.exe' });
    assert.equal(resolve(stringBin).kind, 'exe');
    const missing = fixture('C:\\missing', { binField: { other: 'bin/other.exe' } });
    assert.equal(resolve(missing).code, 'EBADPKG');
    const escape = fixture('C:\\escape', { binField: { claude: '..\\outside.exe' } });
    assert.equal(resolve(escape).code, 'EBADPKG');
  });

  it('runs JavaScript npm bins through process.execPath with the script prepended', () => {
    const fx = fixture('C:\\js', { relativeBin: 'bin/claude.cjs' });
    fx.fakeFs.write(fx.target, 'module.exports = 1');
    fx.fakeFs.write(fx.shim, `@echo off\r\n"%dp0%\\${winPath.relative(fx.root, fx.target)}" %*`);
    const result = resolve(fx, 'claude', ['--arg']);
    assert.equal(result.file, 'C:\\node\\node.exe');
    assert.deepEqual(result.args, [fx.target, '--arg']);
  });

  it('preserves the POSIX identity spawn plan', () => {
    const args = ['-p', 'a\nb'];
    const result = resolveAgentLaunch('claude', args, {}, claude, { platform: 'linux' });
    assert.deepEqual(result, { kind: 'exe', file: 'claude', args });
  });

  it('describes PATH probes and the selected npm target', () => {
    const fx = fixture();
    const described = describeResolution('claude', fx.env, claude, fx.deps);
    assert.ok(described.probes.some(probe => probe.candidate.toLowerCase() === fx.shim.toLowerCase() && probe.exists));
    assert.equal(described.chain.target, fx.target);
  });
});

describe('Windows process execution', () => {
  it('selects the same PATH value that Node passes to the child', { skip: process.platform !== 'win32' }, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-win-launch-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const dirA = path.join(temp, 'npm-a');
    const dirB = path.join(temp, 'npm-b');
    const script = path.join(temp, 'echo.js');
    const capture = path.join(temp, 'capture.json');
    fs.writeFileSync(script, `require('fs').writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify({ argv1: process.argv[1], args: process.argv.slice(2), path: process.env.PATH })); process.exit(37);`);
    const makeNpmAgent = root => {
      const packageDir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
      const target = path.join(packageDir, 'bin', 'claude.exe');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
      fs.copyFileSync(process.execPath, target);
      fs.writeFileSync(path.join(root, 'claude.cmd'), `@echo off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n`);
    };
    makeNpmAgent(dirA);
    makeNpmAgent(dirB);
    const envObj = { ...process.env, Path: dirA, PATH: dirB, ARGV_CAPTURE: capture };
    const provider = require('../server/providers').getAgentProvider('claude');
    const plan = resolveAgentLaunch('claude', [script, 'arg'], envObj, provider);
    assert.ok(plan.file.toLowerCase().startsWith(path.join(dirB, 'node_modules').toLowerCase()));
    const child = spawn(plan.file, plan.args, { env: envObj, stdio: 'ignore' });
    let timer;
    const code = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error('resolved Windows child did not exit within 5s'));
        }, 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(code, 37);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { argv1: script, args: ['arg'], path: envObj.PATH });
  });

  it('keeps doSpawn resolution and spawn failures under one reporter and exit owner', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const doSpawn = source.slice(source.indexOf('const doSpawn = () => {'));
    assert.match(doSpawn, /try\s*\{\s*const plan = resolveAgentLaunch\([\s\S]*?child = spawn\(plan\.file, plan\.args, \{\s*stdio: 'inherit',\s*env: launch\.env,\s*\}\);\s*\} catch \(err\) \{\s*reportLaunchFailure\(err\);\s*finish\(1\);/);
    assert.match(doSpawn, /child\.on\('error', \(err\) => \{\s*reportLaunchFailure\(err\);\s*finish\(1\);/);
    assert.doesNotMatch(doSpawn, /shell\s*:/);
  });
});
