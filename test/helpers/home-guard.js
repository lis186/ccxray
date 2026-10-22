'use strict';
// Test-only preload. Never import this from production code.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const realpath = fs.realpathSync;
const firstProcess = !process.env.NODE_TEST_REAL_HOME;
const realHome = path.resolve(process.env.NODE_TEST_REAL_HOME || os.homedir());
process.env.NODE_TEST_REAL_HOME = realHome;
// Preserve the guard in Node children, even when their HOME changes.
if (!(process.env.NODE_OPTIONS || '').includes(__filename)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(__filename)}`.trim();
}
// Behaviour switches a developer may have exported (`ccxray setup` writes
// CCXRAY_IMPORT_DISABLE=1 into the shell). Unit tests assume the defaults; tests
// that need a switch set it explicitly, and spawned children keep their own env.
// PROXY_HOST would move spawned servers off the loopback addresses that the
// port-conflict fixtures occupy.
if (firstProcess) {
  for (const name of ['CCXRAY_IMPORT_DISABLE', 'CCXRAY_DISABLE_TITLES', 'CCXRAY_SKIP_RECENCY_CHECK',
    'CCXRAY_FAIL_CLOSED', 'CCXRAY_LOOPBACK_REQUIRE_AUTH', 'CCXRAY_LOOPBACK_NO_AUTH',
    'PROXY_HOST', 'CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN']) delete process.env[name];
}
if (firstProcess && !process.env.CCXRAY_HOME) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-suite-'));
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs/index.ndjson'), '');
  process.env.CCXRAY_HOME = home;
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
}
function canonical(value) {
  let current = path.resolve(value), suffix = [];
  while (true) {
    try { return path.join(realpath(current), ...suffix); } catch {}
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    suffix.unshift(path.basename(current)); current = parent;
  }
}
const protectedHome = canonical(realHome);
function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
const isolationRoots = [path.resolve(__dirname, '../..'), os.tmpdir(), process.env.RUNNER_TEMP];
function check(value, write) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return; // fd access was checked when opened
  const physicalPath = canonical(value);
  const relatives = [path.relative(realHome, path.resolve(value)), path.relative(protectedHome, physicalPath)]
    .filter(p => p !== '..' && !p.startsWith('..' + path.sep) && !path.isAbsolute(p));
  if (!relatives.length) return;
  const appData = relatives.some(relative => {
    const parts = relative.split(path.sep);
    return parts[0] === '.ccxray' || /^\.(claude|codex)/.test(parts[0])
      || (parts[0] === '.config' && ['claude', 'gcloud'].includes(parts[1]));
  });
  if (!appData) {
    if (!write) return; // e.g. Puppeteer's installed browser cache
    // CI checkouts and temp dirs may live beneath HOME. Never exempt HOME itself
    // (or its ancestors), and check app data first so aliases cannot expose it.
    const roots = [...isolationRoots, process.env.CCXRAY_HOME].filter(Boolean).map(canonical);
    if (roots.some(root => !within(root, protectedHome) && within(root, physicalPath))) return;
  }
  const error = new Error(`ETEST_HOME: blocked ${write ? 'write' : 'application-data read'} in real HOME; isolate HOME, CCXRAY_HOME and LOGS_DIR`);
  error.code = 'ETEST_HOME';
  process.exitCode = 1; // cannot disappear inside a production catch/default path
  console.error(error.message);
  throw error;
}
function wrap(target, name, verify) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = Object.assign(function(...args) { verify(args); return original.apply(this, args); }, original);
}
for (const target of [fs, fs.promises]) {
  for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'access', 'exists', 'readlink', 'realpath', 'createReadStream']) {
    for (const suffix of ['', 'Sync']) wrap(target, name + suffix, args => check(args[0], false));
  }
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'unlink', 'rm', 'rmdir', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream']) {
    for (const suffix of ['', 'Sync']) wrap(target, name + suffix, args => check(args[0], true));
  }
  for (const name of ['rename', 'link', 'copyFile', 'symlink']) {
    for (const suffix of ['', 'Sync']) wrap(target, name + suffix, args => {
      check(args[0], name === 'rename'); check(args[1], true);
    });
  }
  for (const suffix of ['', 'Sync']) wrap(target, 'open' + suffix, args => {
    const flags = args[1] ?? 'r';
    const write = typeof flags === 'number'
      ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
      : typeof flags === 'string' && /[wa+]/.test(flags);
    check(args[0], write);
  });
}

require('node:module').syncBuiltinESMExports();
