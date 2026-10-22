'use strict';

// `ccxray setup --wrap-binaries` (#732): fail-open `claude` / `codex` launcher
// shims so non-interactive launches (spawn, cron, scripts) are recorded when
// the proxy is healthy and run unchanged when it is not.
//
// Layout (all owned files are listed in <home>/shims.json, the only record
// `--remove` trusts):
//   <shimDir>/claude, <shimDir>/codex   the sh shim (server/shim/ccxray-shim.sh)
//   <home>/shim-probe.js                health probe + decision (server/shim/shim-probe.js)
//   a marked PATH block in the shell startup file(s), plus on Linux a
//   systemd user environment.d file so GUI/service launches see the same PATH
//   <home>/shim-bypass.log              appended by the probe, never removed
//
// Invariant: --remove restores the previous state exactly. Every change is
// recorded with what it replaced (a prefix we added, whether we created the
// file or directory), and a file the user has edited since is left in place.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const paths = require('./paths');
const shimProbe = require('./shim/shim-probe');
const { summarizeBypasses, renderBypassLine } = require('./shim-bypass');

const TOOLS = ['claude', 'codex'];
const SHIM_MARKER = 'ccxray-launcher-shim-v1';
const BLOCK_START = '# >>> ccxray shims >>>';
const BLOCK_END = '# <<< ccxray shims <<<';
const MANIFEST_VERSION = 1;
const SESSION_ENV_NAME = '50-ccxray-shims.conf';

function quotePosix(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function makeDeps(overrides = {}) {
  const env = overrides.env || process.env;
  return {
    fs,
    env,
    platform: process.platform,
    homedir: () => env.HOME || os.homedir(),
    nodePath: process.execPath,
    now: () => Date.now(),
    isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: question => new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${question} [y/N] `, answer => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
    }),
    logger: console,
    ...overrides,
  };
}

function layout(options, deps) {
  const home = paths.resolveCcxrayHome(deps.env);
  const userHome = deps.homedir();
  return {
    home,
    userHome,
    shimDir: options.shimDir ? path.resolve(options.shimDir) : path.join(home, 'shims'),
    probePath: path.join(home, 'shim-probe.js'),
    manifestPath: path.join(home, 'shims.json'),
  };
}

// absent | { manifest } | { invalid: <reason> }. An existing file that is not
// exactly a regular, readable, version-1 manifest of the expected shape is NEVER
// treated as "not installed": it may be a newer ccxray's record or the user's own
// file, so every command that would replace or delete it refuses instead.
function inspectManifest(lay, deps) {
  let st;
  try { st = lstatOrNull(lay.manifestPath, deps); } catch (err) { return { invalid: `cannot be inspected (${err.message})` }; }
  if (!st) return 'absent';
  if (st.isSymbolicLink()) return { invalid: 'is a symlink' };
  if (!st.isFile()) return { invalid: 'is not a regular file' };
  let m;
  try { m = JSON.parse(deps.fs.readFileSync(lay.manifestPath, 'utf8')); } catch (err) { return { invalid: `is not readable JSON (${err.message})` }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { invalid: 'is not a manifest object' };
  if (m.version !== MANIFEST_VERSION) return { invalid: `has unsupported version ${JSON.stringify(m.version)} (this ccxray understands ${MANIFEST_VERSION})` };
  const listOk = (list, keys) => list === undefined || (Array.isArray(list) && list.every(e => e && typeof e === 'object' && keys.every(k => typeof e[k] === 'string')));
  if (!listOk(m.files, ['path', 'sha256']) || !listOk(m.sessionEnv, ['path', 'sha256']) || !listOk(m.profiles, ['file'])
    || !(m.createdDirs === undefined || (Array.isArray(m.createdDirs) && m.createdDirs.every(d => typeof d === 'string')))
    || typeof m.shimDir !== 'string') return { invalid: 'does not have the expected shape' };
  return { manifest: { ...m, files: m.files || [], sessionEnv: m.sessionEnv || [], profiles: m.profiles || [], createdDirs: m.createdDirs || [] } };
}

function readManifest(lay, deps) {
  const found = inspectManifest(lay, deps);
  return found && found.manifest ? found.manifest : null;
}

function manifestConflict(lay, found) {
  return found && found.invalid ? `${lay.manifestPath} ${found.invalid}` : null;
}

function renderShim(deps, lay, strict) {
  const template = fs.readFileSync(path.join(__dirname, 'shim', 'ccxray-shim.sh'), 'utf8');
  return template
    .replace('@NODE@', quotePosix(deps.nodePath))
    .replace('@PROBE@', quotePosix(lay.probePath))
    .replace('@HOME@', quotePosix(lay.home))
    .replace('@STRICT@', strict ? '1' : '0');
}

function renderPathBlock(shimDir) {
  return [
    BLOCK_START,
    `ccxray_shim_dir=${quotePosix(shimDir)}`,
    'case ":$PATH" in ":$ccxray_shim_dir:"*) ;; *) PATH="$ccxray_shim_dir:$PATH"; export PATH ;; esac',
    'unset ccxray_shim_dir',
    BLOCK_END,
    '',
  ].join('\n');
}

// Startup files that every shell of this kind reads, including non-interactive
// ones where the file exists for that purpose (.zshenv). bash reads no file for
// a non-interactive non-login shell: that case is covered by the session PATH
// (environment.d / --shim-dir), not by a profile.
function profileTargets(options, deps, lay) {
  const shell = options.shell || path.basename(deps.env.SHELL || '');
  if (shell === 'zsh') return { shell, files: [path.join(deps.env.ZDOTDIR || lay.userHome, '.zshenv')] };
  if (shell === 'bash' || shell === 'sh' || shell === '') {
    const login = ['.bash_profile', '.bash_login', '.profile']
      .map(name => path.join(lay.userHome, name)).find(file => deps.fs.existsSync(file))
      || path.join(lay.userHome, '.profile');
    return { shell: shell || 'bash', files: [login, path.join(lay.userHome, '.bashrc')] };
  }
  return { shell, files: [] };
}

function sessionEnvFile(deps, lay) {
  if (deps.platform !== 'linux') return null;
  const config = deps.env.XDG_CONFIG_HOME || path.join(lay.userHome, '.config');
  return path.join(config, 'environment.d', SESSION_ENV_NAME);
}

function firstMissingAncestors(dir, deps) {
  const missing = [];
  for (let d = dir; !deps.fs.existsSync(d); d = path.dirname(d)) {
    missing.push(d);
    if (path.dirname(d) === d) break;
  }
  return missing; // innermost first
}

function plan(options, deps, lay) {
  const strict = Boolean(options.strict);
  const actions = [];
  const shimDirMissing = firstMissingAncestors(lay.shimDir, deps);
  if (shimDirMissing.length) actions.push(`create directory ${lay.shimDir}`);
  for (const tool of TOOLS) actions.push(`write launcher shim ${path.join(lay.shimDir, tool)} (mode 0755${strict ? ', strict by default' : ''})`);
  actions.push(`write probe helper ${lay.probePath}`);
  const targets = profileTargets(options, deps, lay);
  for (const file of targets.files) {
    actions.push(`${deps.fs.existsSync(file) ? 'append' : 'create'} PATH block in ${file}`);
  }
  if (!targets.files.length) {
    actions.push(`NOT editing any shell profile (shell "${targets.shell}" is not supported); put ${lay.shimDir} first on PATH yourself, or use --shim-dir`);
  }
  const envFile = options.noSessionEnv ? null : sessionEnvFile(deps, lay);
  if (envFile) actions.push(`create ${envFile} (systemd user PATH)`);
  actions.push(`write manifest ${lay.manifestPath}`);
  return { actions, targets, envFile, strict, shimDirMissing };
}

// Writes a temp file beside the target and renames it over the target. rename
// replaces a symlink at `file` itself, so nothing is ever written THROUGH a link.
function atomicWrite(file, bytes, mode, deps) {
  const tmp = `${file}.ccxray-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    deps.fs.writeFileSync(tmp, bytes, { mode, flag: 'wx' });
    deps.fs.chmodSync(tmp, mode);
    deps.fs.renameSync(tmp, file);
  } catch (err) {
    try { deps.fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

// Replaces the RESOLVED regular target of a profile (so a symlinked profile stays
// a symlink) through a same-directory temp file and rename: a write that fails
// part way leaves the target's bytes untouched, and the replacement keeps the
// original mode (and owner/group when permitted). A target that is not a regular
// file (directory, FIFO, dangling link) is refused, never replaced.
function writeProfile(file, text, deps) {
  const link = lstatOrNull(file, deps);
  if (!link) { atomicWrite(file, Buffer.isBuffer(text) ? text : Buffer.from(text), 0o644, deps); return; }
  let real;
  try { real = deps.fs.realpathSync(file); } catch (err) { throw new Error(`${file} cannot be resolved (${err.code || err.message})`); }
  const st = deps.fs.statSync(real);
  if (!st.isFile()) throw new Error(`${real} is not a regular file`);
  const mode = st.mode & 0o7777;
  const tmp = `${real}.ccxray-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    deps.fs.writeFileSync(tmp, text, { mode, flag: 'wx' });
    deps.fs.chmodSync(tmp, mode);
    try { deps.fs.chownSync(tmp, st.uid, st.gid); } catch { /* not permitted: keeps the invoking user's ownership */ }
    deps.fs.renameSync(tmp, real);
  } catch (err) {
    try { deps.fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

// Reads an existing profile as raw bytes. Only ENOENT/ENOTDIR mean "absent" (null);
// any other failure (EACCES, EIO, ...) is thrown so nothing is written over content
// that could not be read.
function readProfileBytes(file, deps) {
  try { return deps.fs.readFileSync(path.resolve(file)); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

// Profile bytes are handled as latin1 text (one char per byte, lossless) so the
// ASCII marker search never decodes or re-encodes bytes it does not own.
const toText = bytes => bytes.toString('latin1');
const fromText = text => Buffer.from(text, 'latin1');

function lstatOrNull(file, deps) {
  try { return deps.fs.lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

// Is `file` still the exact regular file this manifest entry installed?
//   absent | ours | { conflict: <reason> }
function ownership(file, entry, deps) {
  let st;
  try { st = lstatOrNull(file, deps); } catch (err) { return { conflict: `cannot be inspected (${err.message})` }; }
  if (!st) return 'absent';
  if (st.isSymbolicLink()) return { conflict: 'is a symlink' };
  if (!st.isFile()) return { conflict: 'is not a regular file' };
  if (!entry) return { conflict: 'already exists and was not installed by ccxray' };
  try {
    if (sha(deps.fs.readFileSync(file)) !== entry.sha256) return { conflict: 'was modified since setup' };
  } catch (err) { return { conflict: `cannot be read (${err.message})` }; }
  return 'ours';
}

function blockRange(text) {
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return null;
  const endMarker = text.indexOf(BLOCK_END, start);
  if (endMarker < 0) return null;
  let end = endMarker + BLOCK_END.length;
  if (text[end] === '\n') end++;
  return { start, end };
}

// Returns [{ kind: 'modified' | 'error', message }]. 'modified' means the user
// owns the file now (edited, replaced, or swapped for a link) and it is left in
// place; 'error' is an I/O failure that keeps the manifest so a retry can finish.
function undo(manifest, lay, deps, log = () => {}) {
  const problems = [];
  const removeOwned = entry => {
    try {
      const state = ownership(entry.path, entry, deps);
      if (state === 'absent') return;
      if (state !== 'ours') { problems.push({ kind: 'modified', message: `${entry.path} ${state.conflict}; left in place` }); return; }
      deps.fs.unlinkSync(entry.path);
      log(`removed ${entry.path}`);
    } catch (err) { if (err.code !== 'ENOENT') problems.push({ kind: 'error', message: `${entry.path}: ${err.message}` }); }
  };
  for (const entry of manifest.files || []) removeOwned(entry);
  for (const entry of manifest.sessionEnv || []) removeOwned(entry);
  for (const profile of manifest.profiles || []) {
    try {
      const text = toText(deps.fs.readFileSync(profile.file));
      const range = blockRange(text);
      if (!range) continue;
      let start = range.start;
      if (profile.prefix && text.slice(0, start).endsWith(profile.prefix)) start -= profile.prefix.length;
      const rest = text.slice(0, start) + text.slice(range.end);
      if (profile.created && rest === '') deps.fs.unlinkSync(profile.file);
      else writeProfile(profile.file, fromText(rest), deps);
      log(`restored ${profile.file}`);
    } catch (err) { if (err.code !== 'ENOENT') problems.push({ kind: 'error', message: `${profile.file}: ${err.message}` }); }
  }
  // The manifest is the recovery record: it survives while any step could still be retried.
  if (!problems.some(p => p.kind === 'error')) {
    try { deps.fs.unlinkSync(lay.manifestPath); } catch { /* already gone */ }
    for (const dir of manifest.createdDirs || []) {
      try { deps.fs.rmdirSync(dir); } catch { /* non-empty or gone: not ours to force */ }
    }
  }
  return problems;
}

// Every file setup would write must be absent or exactly what a previous install
// left (unmodified, regular). Anything else is somebody else's file: refuse
// before the first write, and keep their bytes, mode and links untouched.
function preflight(p, lay, deps, previous, found) {
  const ours = new Map([...(previous?.files || []), ...(previous?.sessionEnv || [])].map(e => [e.path, e]));
  const targets = [lay.probePath, ...TOOLS.map(tool => path.join(lay.shimDir, tool))];
  if (p.envFile) targets.push(p.envFile);
  const conflicts = [];
  const unrecognized = manifestConflict(lay, found);
  if (unrecognized) conflicts.push(unrecognized);
  for (const file of targets) {
    const state = ownership(file, ours.get(file), deps);
    if (state !== 'absent' && state !== 'ours') conflicts.push(`${file} ${state.conflict}`);
  }
  // A profile must be absent or resolve to a regular file we can replace.
  for (const file of p.targets.files) {
    try {
      if (!lstatOrNull(file, deps)) continue;
      if (!deps.fs.statSync(deps.fs.realpathSync(file)).isFile()) { conflicts.push(`${file} does not resolve to a regular file`); continue; }
      readProfileBytes(file, deps); // an existing profile must be readable before anything is touched
    } catch (err) { conflicts.push(`${file} cannot be resolved or read (${err.code || err.message})`); }
  }
  return conflicts;
}

async function install(options, deps, lay) {
  const log = deps.logger;
  const p = plan(options, deps, lay);
  const manifest = { version: MANIFEST_VERSION, shimDir: lay.shimDir, strict: p.strict, files: [], profiles: [], sessionEnv: [], createdDirs: [] };

  const found = inspectManifest(lay, deps);
  const previous = found && found.manifest ? found.manifest : null;
  const conflicts = preflight(p, lay, deps, previous, found);
  if (conflicts.length) {
    for (const c of conflicts) log.error(`Refusing to install: ${c}.`);
    log.error('Nothing was changed. Move the file away, choose another directory with --shim-dir, or use --no-session-env.');
    return 1;
  }
  // Re-run: restore the original state first so the recorded "previous state" stays the original.
  if (previous) {
    const problems = undo(previous, lay, deps);
    for (const problem of problems) log.error(`warning: ${problem.message}`);
    if (problems.some(x => x.kind === 'error')) {
      log.error(`Could not undo the previous install; nothing new was written. Recovery record kept: ${lay.manifestPath}`);
      return 1;
    }
  }

  // Every existing profile is read (as bytes) before the first write. A read that
  // fails for any reason but "absent" aborts here, with nothing created.
  const profileBytes = new Map();
  try {
    for (const file of p.targets.files) profileBytes.set(file, readProfileBytes(file, deps));
  } catch (err) {
    log.error(`Refusing to install: a shell profile cannot be read (${err.code || err.message}). Nothing was changed by this step.`);
    return 1;
  }

  const originals = [];
  const mkdirs = [...new Set([...firstMissingAncestors(lay.shimDir, deps), ...firstMissingAncestors(lay.home, deps)])];
  try {
    manifest.createdDirs.push(...mkdirs);
    deps.fs.mkdirSync(lay.home, { recursive: true, mode: 0o700 });
    deps.fs.mkdirSync(lay.shimDir, { recursive: true, mode: 0o755 });

    const probeBytes = fs.readFileSync(path.join(__dirname, 'shim', 'shim-probe.js'));
    atomicWrite(lay.probePath, probeBytes, 0o644, deps);
    manifest.files.push({ path: lay.probePath, sha256: sha(probeBytes) });
    const shimBytes = Buffer.from(renderShim(deps, lay, p.strict));
    for (const tool of TOOLS) {
      const target = path.join(lay.shimDir, tool);
      atomicWrite(target, shimBytes, 0o755, deps);
      manifest.files.push({ path: target, sha256: sha(shimBytes) });
    }
    const block = renderPathBlock(lay.shimDir);
    for (const file of p.targets.files) {
      const originalBytes = profileBytes.get(file);
      const original = originalBytes === null ? null : toText(originalBytes);
      const stripped = original !== null && blockRange(original)
        ? original.slice(0, blockRange(original).start) + original.slice(blockRange(original).end) : original;
      const prefix = stripped && !stripped.endsWith('\n') ? '\n' : '';
      // Recorded first: a write that fails half way is still rolled back.
      manifest.profiles.push({ file, created: original === null, prefix });
      // The exact original bytes are kept for rollback: block stripping alone could
      // not repair a profile whose own write went wrong.
      originals.push({ file, bytes: originalBytes });
      writeProfile(file, Buffer.concat([fromText(stripped ?? ''), Buffer.from(prefix), Buffer.from(block, 'utf8')]), deps);
    }
    if (p.envFile) {
      const envDirs = firstMissingAncestors(path.dirname(p.envFile), deps);
      manifest.createdDirs.push(...envDirs);
      deps.fs.mkdirSync(path.dirname(p.envFile), { recursive: true });
      const bytes = Buffer.from(`PATH=${lay.shimDir}:$PATH\n`);
      atomicWrite(p.envFile, bytes, 0o644, deps);
      manifest.sessionEnv.push({ path: p.envFile, sha256: sha(bytes) });
    }
    manifest.createdDirs.sort((a, b) => b.length - a.length);
    atomicWrite(lay.manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o600, deps);
  } catch (err) {
    log.error(`Setup failed (${err.message}); rolling back.`);
    // Profiles first, from the saved bytes (mode and symlink are preserved by writeProfile).
    for (const o of originals.reverse()) {
      try {
        if (o.bytes === null) { if (lstatOrNull(o.file, deps)) deps.fs.unlinkSync(o.file); }
        else writeProfile(o.file, o.bytes, deps);
      } catch (e) { log.error(`warning: could not restore ${o.file}: ${e.message}`); }
    }
    const leftovers = undo(manifest, lay, deps);
    for (const problem of leftovers) log.error(`warning: ${problem.message}`);
    return 1;
  }
  log.log(`Installed ccxray launcher shims in ${lay.shimDir} (${TOOLS.join(', ')}).`);
  for (const profile of manifest.profiles) log.log(`  PATH block: ${profile.file}`);
  for (const entry of manifest.sessionEnv) log.log(`  session PATH: ${entry.path}`);
  log.log(coverageNotes(options, deps, lay, p));
  return 0;
}

function coverageNotes(options, deps, lay, p) {
  const lines = [
    '',
    'Coverage:',
    '  - New shells pick up the PATH block; open a new terminal (existing processes keep their PATH).',
    '  - A program that spawns "claude"/"codex" without a shell profile sees only the PATH it inherited. That works when the',
    `    parent started after login with ${lay.shimDir} first on PATH${p.envFile ? ' (Linux systemd user sessions read environment.d at login: log out and in)' : ''},`,
    '    or when you used --shim-dir with a directory already ahead of the real binaries (for example ~/.local/bin).',
    '  - Not covered: macOS GUI/launchd-started parents (set PATH with `launchctl setenv`, which does not persist), absolute-path launches',
    '    ("/usr/local/bin/claude"), parents that hardcode PATH, and Windows (unsupported).',
    '  - The shims run the real binary directly whenever the proxy is down: run `ccxray` (standalone, port 5577) or keep a hub running,',
    '    otherwise every launch is a bypass. See `ccxray setup --wrap-binaries --check`.',
  ];
  return lines.join('\n');
}

async function dryRun(options, deps, lay) {
  const p = plan(options, deps, lay);
  const log = deps.logger;
  log.log('ccxray setup --wrap-binaries (dry run, nothing written):');
  for (const action of p.actions) log.log(`  would ${action}`);
  if (p.targets.files.length) {
    log.log('  PATH block:');
    for (const line of renderPathBlock(lay.shimDir).trimEnd().split('\n')) log.log(`    ${line}`);
  }
  if (p.envFile) log.log(`  ${p.envFile} would contain: PATH=${lay.shimDir}:$PATH`);
  log.log(`  strict mode default: ${p.strict ? 'on (refuse when the proxy is down)' : 'off (fail open)'}`);
  const found = inspectManifest(lay, deps);
  const conflicts = preflight(p, lay, deps, found && found.manifest, found);
  for (const c of conflicts) log.error(`  would REFUSE: ${c}`);
  return conflicts.length ? 1 : 0;
}

function resolveOnPath(tool, pathVar, deps) {
  for (const dir of String(pathVar || '').split(path.delimiter)) {
    const candidate = path.join(dir || '.', tool);
    try {
      if (deps.fs.statSync(candidate).isFile()) { deps.fs.accessSync(candidate, deps.fs.constants.X_OK); return candidate; }
    } catch { /* keep looking */ }
  }
  return null;
}

async function check(options, deps, lay) {
  const log = deps.logger;
  const found = inspectManifest(lay, deps);
  const manifest = found && found.manifest;
  if (found && found.invalid) {
    log.error(`FAIL ${manifestConflict(lay, found)}; this ccxray cannot read it, so the shim state is unknown (nothing was changed).`);
    log.log(renderBypassLine(summarizeBypasses(lay.home, { now: deps.now() })));
    return 1;
  }
  if (!manifest) {
    log.log('Launcher shims: not installed (ccxray setup --wrap-binaries).');
    log.log(renderBypassLine(summarizeBypasses(lay.home, { now: deps.now() })));
    return 0;
  }
  let bad = 0;
  const flag = (ok, text) => { log.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };
  log.log(`Launcher shims: installed in ${manifest.shimDir} (${manifest.strict ? 'strict by default' : 'fail-open'})`);
  for (const entry of manifest.files) {
    let intact = false;
    try { intact = sha(deps.fs.readFileSync(entry.path)) === entry.sha256; } catch { /* missing */ }
    flag(intact, `${path.basename(entry.path)} ${intact ? 'present' : `missing or modified (${entry.path})`}`);
  }
  for (const tool of TOOLS) {
    const found = resolveOnPath(tool, deps.env.PATH, deps);
    const real = dir => { try { return deps.fs.realpathSync(dir); } catch { return dir; } };
    const first = found && real(path.dirname(path.resolve(found))) === real(manifest.shimDir);
    if (first) flag(true, `${tool}: shim is first on this process's PATH`);
    else log.log(`warn ${tool}: this process's PATH resolves it to ${found || 'nothing'}, not the shim (new shells read the profile block; spawn parents need the shim dir early on their PATH)`);
  }
  for (const profile of manifest.profiles) {
    let present = false;
    try { present = toText(deps.fs.readFileSync(profile.file)).includes(BLOCK_START); } catch { /* missing */ }
    flag(present, `PATH block in ${profile.file} ${present ? 'present' : 'missing'}`);
  }
  const port = shimProbe.discoverPort({ ...deps.env, CCXRAY_SHIM_HOME: lay.home }, lay.home);
  const health = await shimProbe.probeHealth(port, shimProbe.timeoutMs(deps.env));
  log.log(`${health.ok ? 'ok  ' : 'warn'} proxy on 127.0.0.1:${port}: ${health.ok ? 'healthy (launches are recorded)' : `not reachable (${health.reason}); launches run directly and are logged as bypasses`}`);
  log.log(renderBypassLine(summarizeBypasses(lay.home, { now: deps.now() })));
  return bad ? 1 : 0;
}

function removalLines(manifest, lay) {
  const lines = [];
  for (const f of [...manifest.files, ...manifest.sessionEnv]) lines.push(`would delete ${f.path}`);
  for (const p of manifest.profiles) lines.push(`would remove the PATH block from ${p.file}${p.created ? ' (and delete the file, which setup created)' : ''}`);
  for (const d of manifest.createdDirs) lines.push(`would remove directory ${d} if empty`);
  lines.push(`would delete ${lay.manifestPath}; the bypass log is kept`);
  return lines;
}

async function remove(options, deps, lay) {
  const log = deps.logger;
  const found = inspectManifest(lay, deps);
  if (found && found.invalid) {
    log.error(`Refusing to remove: ${manifestConflict(lay, found)}. Nothing was changed; inspect or move it away first.`);
    return 1;
  }
  const manifest = found && found.manifest;
  if (!manifest) { log.log('No ccxray launcher shims are installed; nothing to remove.'); return 0; }
  if (options.dryRun) {
    log.log('ccxray setup --wrap-binaries --remove (dry run, nothing written):');
    for (const line of removalLines(manifest, lay)) log.log(`  ${line}`);
    return 0;
  }
  const problems = undo(manifest, lay, deps, text => log.log(text));
  for (const problem of problems) log.error(`warning: ${problem.message}`);
  if (problems.some(x => x.kind === 'error')) log.error(`Removal incomplete; the recovery record ${lay.manifestPath} was kept: re-run the removal.`);
  log.log('Removed ccxray launcher shims. The bypass log (shim-bypass.log) is kept.');
  return problems.length ? 1 : 0;
}

async function runWrapBinaries(options, overrides = {}) {
  const deps = makeDeps(overrides);
  if (deps.platform === 'win32') {
    deps.logger.error('--wrap-binaries is not supported on Windows: the shims are POSIX sh scripts. Use `ccxray claude` / `ccxray codex` instead.');
    return 2;
  }
  if (options.shell === 'pwsh' || options.shell === 'powershell') {
    deps.logger.error('--wrap-binaries edits POSIX shell profiles only; PowerShell is not supported.');
    return 2;
  }
  const lay = layout(options, deps);
  if (options.check) return check(options, deps, lay);
  if (options.remove) return remove(options, deps, lay);
  if (options.dryRun) return dryRun(options, deps, lay);
  if (!options.yes) {
    if (!deps.isTty()) {
      deps.logger.error('Refusing to change shell profiles and PATH without confirmation; re-run with --yes (or --dry-run to preview).');
      return 2;
    }
    await dryRun(options, deps, lay);
    if (!await deps.confirm('Install the launcher shims?')) { deps.logger.log('Cancelled; nothing changed.'); return 1; }
  }
  return install(options, deps, lay);
}

// Plain `ccxray setup --remove` treats shims as part of what setup installed.
// `shimRemovalPlan` feeds its consent prompt; `removeIfInstalled` runs (or, with
// options.dryRun, previews) the removal and returns the exit code.
function shimRemovalPlan(overrides = {}) {
  const deps = makeDeps(overrides);
  const lay = layout({}, deps);
  const manifest = readManifest(lay, deps);
  return manifest ? removalLines(manifest, lay) : [];
}

async function removeIfInstalled(options, overrides = {}) {
  const deps = makeDeps(overrides);
  const lay = layout({}, deps);
  const found = inspectManifest(lay, deps);
  if (found && found.invalid) {
    // Not ours to interpret: leave it, and say so, without failing setup's own removal.
    deps.logger.error(`warning: ${manifestConflict(lay, found)}; launcher shims (if any) were not removed.`);
    return 0;
  }
  if (!found || !found.manifest) return 0;
  return remove(options, deps, lay);
}

module.exports = {
  TOOLS, SHIM_MARKER, BLOCK_START, BLOCK_END,
  runWrapBinaries, removeIfInstalled, shimRemovalPlan, renderPathBlock, readManifest, layout, resolveOnPath,
};
