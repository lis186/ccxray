'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const rawOpenSync = fs.openSync.bind(fs);
const rawReadSync = fs.readSync.bind(fs);
const rawWriteSync = fs.writeSync.bind(fs);
const rawCloseSync = fs.closeSync.bind(fs);
const rawStatSync = fs.statSync.bind(fs);
const rawUnlinkSync = fs.unlinkSync.bind(fs);

function rawWriteBytes(file, bytes) {
  const fd = rawOpenSync(file, 'w', 0o600);
  try { rawWriteSync(fd, bytes); } finally { rawCloseSync(fd); }
}

function rawReadBytes(file) {
  const fd = rawOpenSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const buffer = Buffer.alloc(stat.size);
    rawReadSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    rawCloseSync(fd);
  }
}

function rawExists(file) {
  try { rawStatSync(file); return true; }
  catch { return false; }
}
const childProcess = require('node:child_process');
const {
  createSetupFixture,
  findExecutable: findFixtureExecutable,
  fixtureExecutableSearchPath,
} = require('./helpers/setup-fixture');

let bootstrapFixture;
let setup;
let exportSync;
let providers;
let runBounded;

test.before(async () => {
  bootstrapFixture = await createSetupFixture({ name: 'ccxray-setup-bootstrap-' });
  bootstrapFixture.applyProcessEnv();
  setup = require('../server/setup');
  exportSync = require('../server/export-sync');
  providers = require('../server/providers');
  ({ runBounded } = require('../server/bounded-run'));
});

test.after(() => {
  bootstrapFixture?.dispose();
});

function makeLogger() {
  const lines = [];
  return {
    lines,
    log(value) { lines.push(String(value)); },
    error(value) { lines.push(String(value)); },
  };
}

function diagnosticView(overrides = {}) {
  return {
    invokingShell: {
      exportState: 'enabled',
      exportConfigHash: 'fixture-config-hash',
      provenance: 'fixture shell',
    },
    runningExporter: {
      exportState: 'enabled',
      exportConfigHash: 'fixture-config-hash',
      provenance: 'fixture hub',
    },
    configMatch: 'equal',
    durableHome: {
      enrollment: 'absent',
      cursor: { present: false },
      lastAttempt: 'none',
      lastLockLoss: 'none',
      lastFailOpen: 'none',
    },
    ...overrides,
  };
}

function depsFor(fixture, overrides = {}) {
  const env = { ...fixture.env, ...(overrides.env || {}) };
  const logger = overrides.logger || makeLogger();
  const report = overrides.report || null;
  const hubResult = overrides.hubResult || { kind: 'none', reason: 'fixture has no hub' };
  const diagnostics = overrides.diagnostics || diagnosticView();
  const exportDiagnostics = {
    async fetchHubReport() { return hubResult; },
    collectExportDiagnostics() { return diagnostics; },
    ...(overrides.exportDiagnostics || {}),
  };
  const pathsApi = {
    resolveCcxrayHome(value) { return value.CCXRAY_HOME; },
    resolveLogsDir(value) { return value.LOGS_DIR; },
    ...(overrides.paths || {}),
  };
  const statusApi = {
    storagePaths(value, envValue) {
      if (value?.identity?.home && value?.identity?.logsDir) {
        return {
          named: true,
          home: value.identity.home,
          logsDir: value.identity.logsDir,
        };
      }
      return {
        named: false,
        home: envValue.CCXRAY_HOME,
        logsDir: envValue.LOGS_DIR,
      };
    },
    ...(overrides.status || {}),
  };
  const actualSpawn = overrides.spawn || childProcess.spawn;
  const spawn = (file, args, options) => {
    fixture.assertSpawnAllowed(file);
    return actualSpawn(file, args, options);
  };
  const exportSyncApi = { ...exportSync, ...(overrides.exportSync || {}) };
  return {
    env,
    fs: overrides.fs || fixture.guardedFs,
    path,
    os: { homedir: () => fixture.paths.home, ...(overrides.os || {}) },
    // The suite's default cases exercise the POSIX target rules with host paths;
    // Windows-specific cases opt into win32 explicitly below.
    platform: overrides.platform || (process.platform === 'win32' ? 'linux' : process.platform),
    spawn,
    terminate: overrides.terminate,
    runBounded: overrides.runBounded,
    nonce: overrides.nonce,
    now: overrides.now || (() => Date.now()),
    sleep: overrides.sleep,
    input: overrides.input,
    output: overrides.output,
    prompt: overrides.prompt,
    isTTY: overrides.isTTY === undefined ? false : overrides.isTTY,
    logger,
    providers: overrides.providers,
    winLaunch: overrides.winLaunch,
    credentials: overrides.credentials,
    exportSync: exportSyncApi,
    exportDiagnostics,
    status: statusApi,
    paths: pathsApi,
    hooks: overrides.hooks,
  };
}

async function withFixture(run) {
  const fixture = await createSetupFixture();
  const restoreFsGuard = fixture.installGlobalFsGuard?.() || (() => {});
  let runError = null;
  try {
    await run(fixture);
  } catch (error) {
    runError = error;
  } finally {
    restoreFsGuard();
    fixture.dispose();
  }
  const attempts = fixture.outsideAttempts.slice();
  if (runError) {
    if (attempts.length) runError.message += `; fixture boundary attempts: ${JSON.stringify(attempts)}`;
    throw runError;
  }
  assert.deepEqual(attempts, [], `fixture boundary recorded unexpected outside accesses: ${JSON.stringify(attempts)}`);
}

function consumeOutsideAttempts(fixture, expectedOperations) {
  const attempts = fixture.outsideAttempts.splice(0);
  assert.deepEqual(attempts.map(item => item.operation).sort(), [...expectedOperations].sort(),
    `unexpected fixture boundary attempts: ${JSON.stringify(attempts)}`);
}

function setupHome(fixture) {
  return fixture.paths.ccxray;
}

function rcFile(fixture, shell = 'bash') {
  return path.join(shell === 'zsh' ? fixture.paths.zdotdir : fixture.paths.home,
    shell === 'zsh' ? '.zshrc' : '.bashrc');
}

function fixtureExecutable(fixture, name) {
  const wanted = path.parse(name).name.toLowerCase();
  return fixture.allowedShells.find(file => path.parse(file).name.toLowerCase() === wanted) || null;
}

function makeClaudeOnlyPath(fixture, directory) {
  fs.mkdirSync(directory);
  fs.copyFileSync(path.join(fixture.paths.bin, 'claude'), path.join(directory, 'claude'));
  if (process.platform === 'win32') {
    fs.copyFileSync(path.join(fixture.paths.bin, 'claude.cmd'), path.join(directory, 'claude.cmd'));
    fs.copyFileSync(path.join(fixture.paths.bin, 'fake-client.js'), path.join(directory, 'fake-client.js'));
  }
  return directory;
}

function mockedPowerShellDeps(fixture, profile, overrides = {}) {
  const frameNonce = 'fixture-powershell-frame';
  const executable = path.join(fixture.paths.bin, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
  fs.writeFileSync(executable, '', { mode: 0o700 });
  const stdout = [
    '<<ccxray-probe:' + frameNonce + '>>',
    'allHosts=' + profile,
    'currentHost=',
    'edition=Core',
    'host=ConsoleHost',
    'executionPolicy=RemoteSigned',
    'profileSignature=NotSigned',
    '<</ccxray-probe:' + frameNonce + '>>',
    '',
  ].join('\n');
  return depsFor(fixture, {
    ...overrides,
    platform: process.platform,
    nonce: frameNonce,
    runBounded: async () => ({ status: 'exited', exitCode: 0, stdout }),
  });
}

function installArgs(extra = []) {
  return ['--shell', 'bash', '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test', '--yes', ...extra];
}

function installTargetFromFile(fixture, file, label = 'second target') {
  const snapshot = setup.resolveChain(file, fixture.guardedFs);
  const raw = snapshot.kind === 'file' ? fs.readFileSync(snapshot.realPath) : Buffer.alloc(0);
  const decoded = setup.decodeRc(raw);
  const parsed = setup.parseRcBlock(decoded.text, false);
  return {
    shell: 'bash',
    kind: 'posix',
    label,
    labels: [label],
    shells: ['bash'],
    logicalPath: file,
    snapshot,
    raw,
    decoded,
    parsed,
  };
}

test('setup fixture executable discovery expands Windows PATHEXT', () => {
  const recognized = new Set([
    'c:\\tools\\pwsh.exe',
    'c:\\tools\\powershell.exe',
    'c:\\program files\\git\\bin\\bash.exe',
  ]);
  const env = {
    PATH: 'C:\\Tools',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    PATHEXT: '.EXE;.CMD',
  };
  const fakeFs = {
    statSync(file) {
      if (recognized.has(String(file).toLowerCase())) return { isFile: () => true };
      throw Object.assign(new Error('missing fixture executable'), { code: 'ENOENT' });
    },
  };
  const searchPath = fixtureExecutableSearchPath(env, 'win32');
  assert.equal(findFixtureExecutable('pwsh', searchPath, env, 'win32', fakeFs),
    'C:\\Tools\\pwsh.EXE');
  assert.equal(findFixtureExecutable('powershell.exe', searchPath, env, 'win32', fakeFs),
    'C:\\Tools\\powershell.exe');
  assert.equal(findFixtureExecutable('bash', searchPath, env, 'win32', fakeFs),
    'C:\\Program Files\\Git\\bin\\bash.EXE');
});

function runChild(fixture, file, args, overrides = {}) {
  return runBounded({
    file,
    args,
    env: { ...fixture.env, ...(overrides.env || {}) },
    cwd: fixture.paths.home,
    deadlineMs: overrides.deadlineMs || 3000,
    graceMs: overrides.graceMs === undefined ? 100 : overrides.graceMs,
    drainMs: overrides.drainMs === undefined ? 100 : overrides.drainMs,
    maxOutputBytes: overrides.maxOutputBytes || 65536,
  }, {
    spawn(fileArg, argsArg, options) {
      fixture.assertSpawnAllowed(fileArg);
      return childProcess.spawn(fileArg, argsArg, options);
    },
    platform: overrides.platform || process.platform,
    terminate: overrides.terminate,
  });
}

test('setup args reject incompatible modes and retain the documented command surface', () => {
  for (const argv of [
    ['--check', '--bucket', 'fixture-bucket-01'],
    ['--check', '--dry-run'],
    ['--remove', '--browser', 'off'],
    ['--dry-run', '--browser', 'on'],
    ['--no-probe'],
  ]) {
    assert.ok(setup.parseArgs(argv).error, argv.join(' '));
  }
  assert.equal(setup.parseArgs(['--check', '--no-probe', '--shell', 'bash']).options.noProbe, true);
  assert.equal(setup.parseArgs(['--check', '--yes']).error, undefined);
  assert.equal(setup.parseArgs(['--shell', 'fish']).error, setup.usageLine());
});

test('rc block parsing, writing, byte preservation, encodings, and malformed shapes', () => {
  const values = {
    bucket: 'fixture-bucket-01',
    domains: ['example.test'],
    prefix: 'team/daily',
    retentionDays: 17,
    cwdAllowlist: 'repo-a,repo-b',
  };
  const block = setup.renderRcBlock(values, false, '\n');
  const parsed = setup.parseRcBlock(block, false);
  assert.equal(parsed.kind, 'owned');
  assert.deepEqual(parsed.values, values);

  const noFinalNewline = 'export SAFE=1';
  const appended = setup.spliceRc(noFinalNewline, setup.parseRcBlock(noFinalNewline, false), block, '\n');
  assert.ok(appended.startsWith(noFinalNewline + '\n'));
  assert.ok(appended.endsWith(block));

  // Marker-like text inside the owned body must be rejected even when it is
  // not a standalone marker line, so duplicate-line counting alone is not enough.
  const embeddedMarker = block.replace(
    'export CCXRAY_EXPORT_GCS_BUCKET',
    `printf '%s\\n' '${setup.START_MARKER}'\nexport CCXRAY_EXPORT_GCS_BUCKET`,
  );
  assert.equal(setup.parseRcBlock(embeddedMarker, false).kind, 'malformed');

  const crlfBlock = setup.renderRcBlock(values, false, '\r\n');
  const crlfSource = 'export SAFE=1\r\n' + crlfBlock;
  const crlfParsed = setup.parseRcBlock(crlfSource, false);
  const replaced = setup.spliceRc(crlfSource, crlfParsed, setup.renderRcBlock(values, false, '\r\n'), '\r\n');
  assert.equal(replaced, crlfSource);
  assert.ok(!replaced.replace(/\r\n/g, '').includes('\n'));
  const bareCrBlock = setup.renderRcBlock(values, false, '\r');
  const bareCrParsed = setup.parseRcBlock('export SAFE=1\r' + bareCrBlock, false);
  assert.equal(bareCrParsed.kind, 'owned');
  assert.equal(bareCrParsed.newline, '\r');

  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crlfSource)]);
  const decodedUtf8 = setup.decodeRc(utf8);
  assert.equal(setup.encodeRc(decodedUtf8.text, decodedUtf8).equals(utf8), true);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(crlfSource, 'utf16le')]);
  const decodedUtf16 = setup.decodeRc(utf16);
  assert.equal(decodedUtf16.encoding, 'utf16le');
  assert.equal(setup.encodeRc(decodedUtf16.text, decodedUtf16).equals(utf16), true);
  assert.throws(() => setup.decodeRc(Buffer.from([0x61, 0x00, 0x62, 0x00])), TypeError);

  for (const malformed of [
    setup.END_MARKER + '\n' + block,
    setup.START_MARKER + '\n' + block,
    setup.START_MARKER + '\n' + block + setup.START_MARKER + '\n' + setup.END_MARKER,
    block + block,
    block.replace(setup.END_MARKER, setup.START_MARKER + '\n' + setup.END_MARKER),
    block.replace('ccxray-wrapper-v1', 'foreign-function'),
  ]) {
    assert.equal(setup.parseRcBlock(malformed, false).kind, 'malformed');
  }

  const foreign = 'function claude() { echo local; }\nexport SAFE=1';
  const appendedForeign = setup.spliceRc(foreign, setup.parseRcBlock(foreign, false), block, '\n');
  assert.equal(appendedForeign.slice(0, foreign.length), foreign);
});

test('v1 rendered-block golden byte strings remain owned', () => {
  const fixtures = [
    {
      powershell: false,
      text: "# >>> ccxray setup >>>\nexport CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'\nexport CCXRAY_EXPORT_GCS_PREFIX='summaries'\nexport CCXRAY_EXPORT_DOMAINS='example.test'\nexport LOG_RETENTION_DAYS='30'\nexport CCXRAY_IMPORT_DISABLE='1'\nclaude() {\n  : ccxray-wrapper-v1\n  case \"$1\" in --version|--help|-h|mcp|doctor|agents|plugin|auth|attach|respawn)\n    command claude \"$@\"; return ;; esac\n  if command -v ccxray >/dev/null 2>&1; then ccxray claude \"$@\"; else command claude \"$@\"; fi\n}\n# <<< ccxray setup <<<\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30 },
    },
    {
      powershell: false,
      text: "# >>> ccxray setup >>>\r\nexport CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'\r\nexport CCXRAY_EXPORT_GCS_PREFIX='summaries'\r\nexport CCXRAY_EXPORT_DOMAINS='example.test'\r\nexport LOG_RETENTION_DAYS='30'\r\nexport CCXRAY_IMPORT_DISABLE='1'\r\nclaude() {\r\n  : ccxray-wrapper-v1\r\n  case \"$1\" in --version|--help|-h|mcp|doctor|agents|plugin|auth|attach|respawn)\r\n    command claude \"$@\"; return ;; esac\r\n  if command -v ccxray >/dev/null 2>&1; then ccxray claude \"$@\"; else command claude \"$@\"; fi\r\n}\r\n# <<< ccxray setup <<<\r\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30 },
    },
    {
      powershell: false,
      text: "# >>> ccxray setup >>>\nexport CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'\nexport CCXRAY_EXPORT_GCS_PREFIX='summaries'\nexport CCXRAY_EXPORT_DOMAINS='example.test'\nexport LOG_RETENTION_DAYS='30'\nexport CCXRAY_EXPORT_CWD_ALLOWLIST='repo'\\''s'\nexport CCXRAY_IMPORT_DISABLE='1'\nclaude() {\n  : ccxray-wrapper-v1\n  case \"$1\" in --version|--help|-h|mcp|doctor|agents|plugin|auth|attach|respawn)\n    command claude \"$@\"; return ;; esac\n  if command -v ccxray >/dev/null 2>&1; then ccxray claude \"$@\"; else command claude \"$@\"; fi\n}\n# <<< ccxray setup <<<\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30, cwdAllowlist: "repo's" },
    },
    {
      powershell: false,
      text: "# >>> ccxray setup >>>\r\nexport CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'\r\nexport CCXRAY_EXPORT_GCS_PREFIX='summaries'\r\nexport CCXRAY_EXPORT_DOMAINS='example.test'\r\nexport LOG_RETENTION_DAYS='30'\r\nexport CCXRAY_EXPORT_CWD_ALLOWLIST='repo'\\''s'\r\nexport CCXRAY_IMPORT_DISABLE='1'\r\nclaude() {\r\n  : ccxray-wrapper-v1\r\n  case \"$1\" in --version|--help|-h|mcp|doctor|agents|plugin|auth|attach|respawn)\r\n    command claude \"$@\"; return ;; esac\r\n  if command -v ccxray >/dev/null 2>&1; then ccxray claude \"$@\"; else command claude \"$@\"; fi\r\n}\r\n# <<< ccxray setup <<<\r\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30, cwdAllowlist: "repo's" },
    },
    {
      powershell: true,
      text: "# >>> ccxray setup >>>\n$env:CCXRAY_EXPORT_GCS_BUCKET = 'fixture-bucket-01'\n$env:CCXRAY_EXPORT_GCS_PREFIX = 'summaries'\n$env:CCXRAY_EXPORT_DOMAINS = 'example.test'\n$env:LOG_RETENTION_DAYS = '30'\n$env:CCXRAY_IMPORT_DISABLE = '1'\nfunction claude {\n  # ccxray-wrapper-v1\n  $claudeApp = (Get-Command claude -CommandType Application | Select-Object -First 1).Source\n  $bypass = @('--version','--help','-h','mcp','doctor','agents','plugin','auth','attach','respawn')\n  if ($args.Count -gt 0 -and $bypass -contains $args[0]) { & $claudeApp @args; return }\n  if (Get-Command ccxray -ErrorAction SilentlyContinue) { ccxray claude @args } else { & $claudeApp @args }\n}\n# <<< ccxray setup <<<\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30 },
    },
    {
      powershell: true,
      text: "# >>> ccxray setup >>>\r\n$env:CCXRAY_EXPORT_GCS_BUCKET = 'fixture-bucket-01'\r\n$env:CCXRAY_EXPORT_GCS_PREFIX = 'summaries'\r\n$env:CCXRAY_EXPORT_DOMAINS = 'example.test'\r\n$env:LOG_RETENTION_DAYS = '30'\r\n$env:CCXRAY_IMPORT_DISABLE = '1'\r\nfunction claude {\r\n  # ccxray-wrapper-v1\r\n  $claudeApp = (Get-Command claude -CommandType Application | Select-Object -First 1).Source\r\n  $bypass = @('--version','--help','-h','mcp','doctor','agents','plugin','auth','attach','respawn')\r\n  if ($args.Count -gt 0 -and $bypass -contains $args[0]) { & $claudeApp @args; return }\r\n  if (Get-Command ccxray -ErrorAction SilentlyContinue) { ccxray claude @args } else { & $claudeApp @args }\r\n}\r\n# <<< ccxray setup <<<\r\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30 },
    },
    {
      powershell: true,
      text: "# >>> ccxray setup >>>\n$env:CCXRAY_EXPORT_GCS_BUCKET = 'fixture-bucket-01'\n$env:CCXRAY_EXPORT_GCS_PREFIX = 'summaries'\n$env:CCXRAY_EXPORT_DOMAINS = 'example.test'\n$env:LOG_RETENTION_DAYS = '30'\n$env:CCXRAY_EXPORT_CWD_ALLOWLIST = 'repo''s'\n$env:CCXRAY_IMPORT_DISABLE = '1'\nfunction claude {\n  # ccxray-wrapper-v1\n  $claudeApp = (Get-Command claude -CommandType Application | Select-Object -First 1).Source\n  $bypass = @('--version','--help','-h','mcp','doctor','agents','plugin','auth','attach','respawn')\n  if ($args.Count -gt 0 -and $bypass -contains $args[0]) { & $claudeApp @args; return }\n  if (Get-Command ccxray -ErrorAction SilentlyContinue) { ccxray claude @args } else { & $claudeApp @args }\n}\n# <<< ccxray setup <<<\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30, cwdAllowlist: "repo's" },
    },
    {
      powershell: true,
      text: "# >>> ccxray setup >>>\r\n$env:CCXRAY_EXPORT_GCS_BUCKET = 'fixture-bucket-01'\r\n$env:CCXRAY_EXPORT_GCS_PREFIX = 'summaries'\r\n$env:CCXRAY_EXPORT_DOMAINS = 'example.test'\r\n$env:LOG_RETENTION_DAYS = '30'\r\n$env:CCXRAY_EXPORT_CWD_ALLOWLIST = 'repo''s'\r\n$env:CCXRAY_IMPORT_DISABLE = '1'\r\nfunction claude {\r\n  # ccxray-wrapper-v1\r\n  $claudeApp = (Get-Command claude -CommandType Application | Select-Object -First 1).Source\r\n  $bypass = @('--version','--help','-h','mcp','doctor','agents','plugin','auth','attach','respawn')\r\n  if ($args.Count -gt 0 -and $bypass -contains $args[0]) { & $claudeApp @args; return }\r\n  if (Get-Command ccxray -ErrorAction SilentlyContinue) { ccxray claude @args } else { & $claudeApp @args }\r\n}\r\n# <<< ccxray setup <<<\r\n",
      values: { bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30, cwdAllowlist: "repo's" },
    },
  ];

  for (const { powershell, text, values } of fixtures) {
    const parsed = setup.parseRcBlock(text, powershell);
    assert.equal(parsed.kind, 'owned', JSON.stringify({ powershell, text }));
    assert.deepEqual(parsed.values, values);
  }
});

test('PowerShell blocks use the same values with PowerShell quoting and control flow', () => {
  const values = {
    bucket: 'fixture-bucket-01',
    domains: ['example.test'],
    prefix: 'team/daily',
    retentionDays: 17,
    cwdAllowlist: 'repo-a',
  };
  const block = setup.renderRcBlock(values, true, '\r\n');
  const parsed = setup.parseRcBlock(block, true);
  assert.equal(parsed.kind, 'owned');
  assert.deepEqual(parsed.values, values);
  assert.match(block, /function claude \{/);
  assert.match(block, /# ccxray-wrapper-v1/);
  assert.match(block, /} else {/);
  assert.ok(!block.includes(' && '));
  assert.ok(!block.includes(' || '));
  assert.ok(!block.replace(/\r\n/g, '').includes('\n'));
  const posixQuoted = setup.renderRcBlock({
    ...values,
    cwdAllowlist: "can't",
  }, false);
  const powershellQuoted = setup.renderRcBlock({
    ...values,
    cwdAllowlist: "can't",
  }, true);
  assert.ok(posixQuoted.includes("CCXRAY_EXPORT_CWD_ALLOWLIST='can'\\''t'"));
  assert.ok(powershellQuoted.includes("CCXRAY_EXPORT_CWD_ALLOWLIST = 'can''t'"));
});

test('modified setup blocks are not exempted during conflict scans', () => {
  const values = {
    bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
    retentionDays: 30,
  };
  const posixBlock = setup.renderRcBlock(values, false);
  const posixText = posixBlock.replace(setup.END_MARKER,
    "alias claude-debug=claude\nexport ANTHROPIC_BASE_URL='https://synthetic.invalid'\n" + setup.END_MARKER);
  const posixOwned = setup.parseRcBlock(posixText, false);
  assert.equal(posixOwned.kind, 'malformed');
  const posix = setup.scanConflicts(posixText, false, '/fixture/.bashrc');
  assert.equal(posix.conflicts.length, 3);
  assert.ok(posix.conflicts.some(line => line.includes('function claude')));
  assert.ok(posix.conflicts.some(line => line.includes('alias claude-debug')));
  assert.ok(posix.conflicts.some(line => line.includes('environment ANTHROPIC_BASE_URL')));

  const powershellBlock = setup.renderRcBlock(values, true);
  const powershellText = powershellBlock.replace(setup.END_MARKER,
    "Set-Alias -Name claude-dev claude\n$env:ANTHROPIC_BASE_URL = 'https://synthetic.invalid'\n" + setup.END_MARKER);
  const powershellOwned = setup.parseRcBlock(powershellText, true);
  assert.equal(powershellOwned.kind, 'malformed');
  const powershell = setup.scanConflicts(
    powershellText, true, 'C:\\fixture\\profile.ps1',
  );
  assert.equal(powershell.conflicts.length, 3);
  assert.ok(powershell.conflicts.some(line => line.includes('function claude')));
  assert.ok(powershell.conflicts.some(line => line.includes('alias claude-dev')));
  assert.ok(powershell.conflicts.some(line => line.includes('environment ANTHROPIC_BASE_URL')));
});

test('validated setup values reject shell injection and preserve field precedence', () => {
  assert.ok(setup.validateValues({ bucket: 'Bad Bucket' }).length);
  assert.ok(setup.validateValues({ domains: ['example.test\nexport BAD=1'] }).length);
  assert.ok(setup.validateValues({ prefix: 'bad prefix' }).length);
  assert.ok(setup.validateValues({ cwdAllowlist: 'good, bad name' }).length);
  assert.ok(setup.validateValues({ retentionDays: 0 }).length);
  assert.ok(setup.validateValues({ bucket: 'fixture-bucket-01' + String.fromCharCode(0) }).length);

  const posixScan = setup.scanConflicts(
    'claudex() { :; }\nalias claude-dev=claude\n',
    false,
    '/fixture/.bashrc',
  );
  assert.equal(posixScan.conflicts.length, 2);
  const powershellScan = setup.scanConflicts(
    'function claude2 { }\nSet-Alias -Name claude3 claude\n',
    true,
    'C:\\fixture\\profile.ps1',
  );
  assert.equal(powershellScan.conflicts.length, 2);

  const makeOwned = (file, bucket, domains = ['example.test'], cwdAllowlist = 'repo-a') => {
    const text = setup.renderRcBlock({
      bucket, domains, prefix: 'summaries', retentionDays: 21, cwdAllowlist,
    }, false);
    return {
      snapshot: { realPath: file },
      parsed: setup.parseRcBlock(text, false),
    };
  };
  const options = setup.parseArgs(['--shell', 'bash']).options;
  const disagree = setup.resolveValues(options, [
    makeOwned('/fixture/bashrc', 'fixture-bucket-01'),
    makeOwned('/fixture/pwsh-profile', 'fixture-bucket-02'),
  ]);
  assert.ok(disagree.conflicts.some(item => item.startsWith('bucket:')));

  const flagged = setup.resolveValues(
    setup.parseArgs(['--shell', 'bash', '--export', '--bucket', 'fixture-bucket-03']).options,
    [makeOwned('/fixture/bashrc', 'fixture-bucket-01'), makeOwned('/fixture/pwsh-profile', 'fixture-bucket-02')],
  );
  assert.equal(flagged.resolved.bucket, 'fixture-bucket-03');
  assert.deepEqual(flagged.conflicts, []);

  const inherited = setup.resolveValues(options, [makeOwned('/fixture/bashrc', 'fixture-bucket-01')]);
  assert.equal(inherited.resolved.bucket, 'fixture-bucket-01');
  assert.equal(inherited.resolved.retentionDays, 21);
  const cleared = setup.resolveValues(
    setup.parseArgs(['--shell', 'bash', '--export', '--cwd-allowlist', '']).options,
    [makeOwned('/fixture/bashrc', 'fixture-bucket-01')],
  );
  assert.equal(cleared.resolved.cwdAllowlist, '');
  assert.ok(!setup.renderRcBlock(cleared.resolved, false).includes('CCXRAY_EXPORT_CWD_ALLOWLIST'));
});

test('resolveChain follows links and refuses dangling targets and loops', async () => {
  await withFixture(async fixture => {
    const a = path.join(fixture.paths.home, 'link-a');
    const b = path.join(fixture.paths.home, 'target-b');
    fs.writeFileSync(b, 'before\n');
    fs.symlinkSync(path.basename(b), a);
    const followed = setup.resolveChain(a, fixture.guardedFs);
    assert.equal(followed.realPath, fs.realpathSync(b));
    assert.ok(followed.chain.some(item => path.basename(item.path) === path.basename(a)
      && item.kind === 'symlink'));

    const dangling = path.join(fixture.paths.home, 'dangling');
    fs.symlinkSync('missing-file', dangling);
    assert.throws(() => setup.resolveChain(dangling, fixture.guardedFs), /does not exist/);

    const loopA = path.join(fixture.paths.home, 'loop-a');
    const loopB = path.join(fixture.paths.home, 'loop-b');
    fs.symlinkSync('loop-b', loopA);
    fs.symlinkSync('loop-a', loopB);
    assert.throws(() => setup.resolveChain(loopA, fixture.guardedFs), /symlink loop/);
  });
});

test('resolveChain compares canonical Windows paths when the input uses an 8.3 alias', () => {
  const shortFile = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\fixture\\home\\.bashrc';
  const longFile = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\fixture\\home\\.bashrc';
  const isShortFile = file => path.win32.resolve(file).toLowerCase() === path.win32.resolve(shortFile).toLowerCase();
  const io = {
    lstatSync(file) {
      const isFile = isShortFile(file);
      return {
        isSymbolicLink: () => false,
        isFile: () => isFile,
        isDirectory: () => !isFile,
        dev: 1,
        ino: 2,
        size: 0,
        mtimeMs: 1,
        nlink: 1,
        mode: 0o100600,
      };
    },
    realpathSync: {
      native() { return longFile; },
    },
  };
  const resolved = setup.resolveChain(shortFile, io, { pathApi: path.win32 });
  assert.equal(resolved.realPath, shortFile);
  assert.equal(resolved.kind, 'file');
});

test('resolveChain follows only platform separators and matches native symlink-dot-dot resolution', async () => {
  await withFixture(async fixture => {
    if (path.sep === '/') {
      const literalBackslash = path.join(fixture.paths.home, 'literal\\name.rc');
      fs.writeFileSync(literalBackslash, 'backslash sentinel\n');
      const backslashResult = setup.resolveChain(literalBackslash, fixture.guardedFs);
      assert.equal(backslashResult.realPath, fs.realpathSync.native(literalBackslash));
      assert.equal(backslashResult.kind, 'file');
    }

    const directory = path.join(fixture.paths.home, 'physical');
    const child = path.join(directory, 'child');
    fs.mkdirSync(child, { recursive: true });
    const expected = path.join(directory, 'rc');
    const decoy = path.join(fixture.paths.home, 'rc');
    fs.writeFileSync(expected, 'physical parent\n');
    fs.writeFileSync(decoy, 'lexical parent\n');
    const link = path.join(fixture.paths.home, 'physical-link');
    fs.symlinkSync(path.relative(fixture.paths.home, child), link, 'dir');
    const candidate = `${link}${path.sep}..${path.sep}rc`;
    const native = fs.realpathSync.native(candidate);
    if (process.platform === 'win32') {
      try {
        const resolved = setup.resolveChain(candidate, fixture.guardedFs);
        assert.equal(resolved.realPath, native);
      } catch (error) {
        assert.match(error.message, /path resolver disagrees with realpathSync\.native/);
      }
      return;
    }
    const resolved = setup.resolveChain(candidate, fixture.guardedFs);
    assert.equal(native, fs.realpathSync.native(expected));
    assert.equal(resolved.realPath, native);
    assert.equal(fs.readFileSync(resolved.realPath, 'utf8'), 'physical parent\n');
  });
});

async function assertRawSetupTarget(shell, variable, filename) {
  await withFixture(async fixture => {
    const physicalParent = path.join(fixture.paths.root, shell + '-physical-parent');
    const physicalChild = path.join(physicalParent, 'child');
    fs.mkdirSync(physicalChild, { recursive: true });
    const link = path.join(fixture.paths.home, shell + '-linked-child');
    fs.symlinkSync(physicalChild, link, 'dir');

    const rawBase = link + path.sep + '..';
    const physicalRc = path.join(physicalParent, filename);
    const decoyRc = path.join(fixture.paths.home, filename);
    const physicalBefore = Buffer.from('# physical sentinel\n');
    const decoyBefore = Buffer.from('# decoy sentinel\n');
    fs.writeFileSync(physicalRc, physicalBefore);
    fs.writeFileSync(decoyRc, decoyBefore);

    const log = makeLogger();
    const deps = depsFor(fixture, { env: { [variable]: rawBase }, logger: log });
    const installed = await setup.runSetup([
      '--shell', shell, '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test', '--yes',
    ], deps);
    assert.equal(installed, 0, log.lines.join('\n'));
    assert.ok(fs.readFileSync(physicalRc).includes(Buffer.from(setup.START_MARKER)));
    assert.deepEqual(fs.readFileSync(decoyRc), decoyBefore);

    const removed = await setup.runSetup(['--remove', '--shell', shell, '--yes'], deps);
    assert.equal(removed, 0, log.lines.join('\n'));
    assert.deepEqual(fs.readFileSync(physicalRc), physicalBefore);
    assert.deepEqual(fs.readFileSync(decoyRc), decoyBefore);
  });
}

test('setup target discovery preserves raw HOME symlink-dot-dot semantics', {
  skip: process.platform === 'win32' ? 'bash is unsupported on Windows' : false,
}, async () => {
  await assertRawSetupTarget('bash', 'HOME', '.bashrc');
});

test('setup target discovery preserves symlink-dot-dot semantics', {
  skip: process.platform === 'win32' ? 'zsh is unsupported on Windows' : false,
}, async () => {
  await assertRawSetupTarget('zsh', 'ZDOTDIR', '.zshrc');
});

test('strict ownership rejects injected lines inside marked blocks', async () => {
  const values = {
    bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30,
  };
  const injectionCases = [
    { posix: '}; other() {', powershell: '}; function other {' },
    { posix: '  echo x#; }; other() {', powershell: '  Write-Output x#; }; function other {' },
    { posix: "  echo $'\\''; }; other() {", powershell: "  Write-Output 'x''; }; function other {" },
    { posix: '  alias x=y', powershell: '  Set-Alias x y' },
    { posix: null, powershell: '  Write-Output x`}' },
  ];
  const shellCases = [
    { shell: 'bash', powershell: false },
    { shell: 'pwsh', powershell: true },
  ];
  for (const shellCase of shellCases) {
    const injections = injectionCases
      .map(item => item[shellCase.powershell ? 'powershell' : 'posix'])
      .filter(Boolean);
    for (const injection of injections) {
      const rendered = setup.renderRcBlock(values, shellCase.powershell);
      const rows = rendered.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/);
      const foreignHeader = shellCase.powershell ? 'function foreign {' : 'foreign() {';
      const text = [
        foreignHeader,
        rows[0],
        injection,
        ...rows.slice(1, -1),
        rows[rows.length - 1],
        '}',
        '',
      ].join('\n');
      const parsed = setup.parseRcBlock(text, shellCase.powershell);
      assert.equal(parsed.kind, 'malformed', shellCase.shell + ' injection ' + JSON.stringify(injection));
      assert.equal(parsed.reason, 'setup block was modified (does not match setup output)');

      // Bash and zsh are unsupported on Windows; keep parser coverage there,
      // while the integration checks run for PowerShell.
      if (!shellCase.powershell && process.platform === 'win32') continue;
      await withFixture(async fixture => {
        const file = shellCase.powershell
          ? path.join(fixture.paths.root, 'synthetic-injected-profile.ps1')
          : rcFile(fixture, 'bash');
        const original = Buffer.from(text);
        fs.writeFileSync(file, original);
        const log = makeLogger();
        const deps = shellCase.powershell
          ? mockedPowerShellDeps(fixture, file, { logger: log })
          : depsFor(fixture, { logger: log });
        const installArgsForShell = [
          '--shell', shellCase.shell, '--export', '--bucket', 'fixture-bucket-01',
          '--domains', 'example.test', '--yes',
        ];
        const installed = await setup.runSetup(installArgsForShell, deps);
        assert.equal(installed, 1, log.lines.join('\n'));
        assert.deepEqual(fs.readFileSync(file), original);
        assert.equal(exportSync.readEnrollment(setupHome(fixture)), null);
        assert.ok(log.lines.some(line => line.includes(
          'recover manually: delete everything from the start marker line through the end marker line, then re-run ccxray setup',
        )), log.lines.join('\n'));

        const removed = await setup.runSetup(['--remove', '--shell', shellCase.shell, '--yes'], deps);
        assert.equal(removed, 1, log.lines.join('\n'));
        assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'removed');
        assert.deepEqual(fs.readFileSync(file), original);
        assert.ok(log.lines.some(line => line.includes('export remains removed; shell cleanup incomplete')));
      });
    }
  }
});

test('modified wrapper revisions are malformed and show the manual recovery instruction', async () => {
  await withFixture(async fixture => {
    const file = rcFile(fixture);
    const values = {
      bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30,
    };
    const generated = setup.renderRcBlock(values, false);
    const revised = generated.replace(
      '  : ccxray-wrapper-v1\n',
      '  : ccxray-wrapper-v1\n  if true; then\n    { :; }\n  fi\n',
    );
    const original = "export FOREIGN='keep-me'\n" + revised;
    fs.writeFileSync(file, original);
    const parsed = setup.parseRcBlock(revised, false);
    assert.equal(parsed.kind, 'malformed');
    assert.equal(parsed.reason, 'setup block was modified (does not match setup output)');
    const log = makeLogger();
    const install = await setup.runSetup([
      '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-02', '--domains', 'example.test', '--yes',
    ], depsFor(fixture, { logger: log }));
    assert.equal(install, 1, log.lines.join('\n'));
    assert.deepEqual(fs.readFileSync(file), Buffer.from(original));
    assert.ok(log.lines.some(line => line.includes(
      'recover manually: delete everything from the start marker line through the end marker line, then re-run ccxray setup',
    )), log.lines.join('\n'));
  });
});

test('owned block round-trip table preserves foreign bytes across encoding and newline combinations', async () => {
  await withFixture(async fixture => {
    const file = rcFile(fixture);
    const values = {
      bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30,
    };
    const encodings = [
      { name: 'utf8', bom: Buffer.from([0xef, 0xbb, 0xbf]), encode: text => Buffer.from(text, 'utf8') },
      { name: 'utf16le', bom: Buffer.from([0xff, 0xfe]), encode: text => Buffer.from(text, 'utf16le') },
    ];
    for (const encoding of encodings) {
      for (const newline of ['\n', '\r\n', '\r']) {
        for (const trailingNewline of [false, true]) {
          for (const hasPrelude of [false, true]) {
            const generated = setup.renderRcBlock(values, false, newline);
            const owned = trailingNewline ? generated : generated.slice(0, -newline.length);
            const prelude = hasPrelude ? `export FOREIGN='sentinel'${newline}` : '';
            const original = Buffer.concat([encoding.bom, encoding.encode(prelude + owned)]);
            fs.writeFileSync(file, original);

            const first = await setup.runSetup([
              '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-02', '--domains', 'example.test', '--yes',
            ], depsFor(fixture));
            assert.equal(first, 0, `${encoding.name}/${JSON.stringify(newline)}/${trailingNewline}/${hasPrelude}`);
            const current = fs.readFileSync(file);
            const preservedPrelude = Buffer.concat([
              encoding.bom,
              encoding.encode(prelude),
            ]);
            assert.ok(current.subarray(0, preservedPrelude.length).equals(preservedPrelude), 'foreign prelude bytes changed');

            const replacement = await setup.runSetup([
              '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-03', '--domains', 'example.test', '--yes',
            ], depsFor(fixture));
            assert.equal(replacement, 0);
            assert.equal(setup.parseRcBlock(setup.decodeRc(fs.readFileSync(file)).text, false).values.bucket, 'fixture-bucket-03');

            const removed = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture));
            assert.equal(removed, 0);
            assert.deepEqual(fs.readFileSync(file), Buffer.concat([encoding.bom, encoding.encode(prelude)]));
          }
        }
      }
    }
  });
});

test('hard-linked startup files are refused with actionable guidance', async () => {
  await withFixture(async fixture => {
    const file = rcFile(fixture);
    const alias = path.join(fixture.paths.home, 'same-rc-inode');
    fs.writeFileSync(file, 'export KEEP=hard-linked\n');
    fs.linkSync(file, alias);
    const before = fs.readFileSync(file);
    const log = makeLogger();
    const result = await setup.runSetup(installArgs(), depsFor(fixture, { logger: log }));
    assert.equal(result, 1, log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('hard-linked') && line.includes('Copy it to a regular file')));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readFileSync(alias), before);
    assert.equal(exportSync.readEnrollment(setupHome(fixture)), null);
  });
});

test('remove tombstones a malformed wrapper and leaves its bytes for manual cleanup', async () => {
  await withFixture(async fixture => {
    const file = rcFile(fixture);
    const malformed = [
      setup.START_MARKER,
      "export CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'",
      'claude() {',
      '  : ccxray-wrapper-v1',
      '  if true; then',
      setup.END_MARKER,
    ].join('\n');
    const original = Buffer.from(malformed);
    fs.writeFileSync(file, original);
    assert.equal(setup.parseRcBlock(malformed, false).kind, 'malformed');
    const log = makeLogger();
    const result = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture, { logger: log }));
    assert.equal(result, 1, log.lines.join('\n'));
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'removed');
    assert.deepEqual(fs.readFileSync(file), original);
    assert.ok(log.lines.some(line => line.includes('export remains removed; shell cleanup incomplete')));
    assert.ok(log.lines.some(line => line.includes(file)));
  });
});

test('browser temp collision leaves the unowned temp file untouched', async () => {
  await withFixture(async fixture => {
    const file = path.join(setupHome(fixture), 'auto-open-browser');
    const nonce = 'r2-browser-collision';
    const temporary = path.join(path.dirname(file), `${path.basename(file)}.ccxray-browser-tmp.${process.pid}.${nonce}`);
    const sentinel = Buffer.from('foreign browser temp sentinel\n');
    fs.writeFileSync(temporary, sentinel);
    const log = makeLogger();
    const result = await setup.runSetup(['--browser', 'off', '--yes'], depsFor(fixture, {
      logger: log, nonce,
    }));
    assert.equal(result, 1);
    assert.deepEqual(fs.readFileSync(temporary), sentinel);
    assert.equal(fs.existsSync(file), false);
  });
});

test('rc temp collision leaves the unowned temp file untouched', async () => {
  await withFixture(async fixture => {
    const file = rcFile(fixture);
    fs.writeFileSync(file, 'export USER_RC=preserve\n');
    const nonce = 'r2-rc-collision';
    const temporary = path.join(path.dirname(file), `${path.basename(file)}.ccxray-rc-tmp.${process.pid}.${nonce}`);
    const sentinel = Buffer.from('foreign rc temp sentinel\n');
    fs.writeFileSync(temporary, sentinel);
    const original = fs.readFileSync(file);
    const log = makeLogger();
    const result = await setup.runSetup(installArgs(), depsFor(fixture, { logger: log, nonce }));
    assert.equal(result, 1);
    assert.deepEqual(fs.readFileSync(temporary), sentinel);
    assert.deepEqual(fs.readFileSync(file), original);
  });
});

test('dry-run output lists every logical alias and prints only the generated block', async () => {
  await withFixture(async fixture => {
    const foreign = "export TOKEN='do-not-print-this-sentinel'\n";
    const values = {
      bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30,
    };
    const block = setup.renderRcBlock(values, false, '\n');
    const raw = Buffer.from(foreign + block);
    const parsed = setup.parseRcBlock(raw.toString('utf8'), false);
    const snapshot = {
      kind: 'file', realPath: path.join(fixture.paths.home, 'shared.rc'), logicalPath: '/alias-one',
      chain: [{ path: path.join(fixture.paths.home, 'shared.rc'), kind: 'file' }],
    };
    const target = {
      label: 'bash', kind: 'posix', logicalPath: '/alias-one', snapshot, raw,
      decoded: setup.decodeRc(raw), parsed,
      logicalTargets: [
        { label: 'pwsh/Core', kind: 'posix', logicalPath: '/alias-one', snapshot, raw },
        { label: 'powershell/Desktop', kind: 'posix', logicalPath: '/alias-two', snapshot, raw },
      ],
    };
    const log = makeLogger();
    const context = {
      targets: [target], values, home: setupHome(fixture),
      diagnostics: { durableHome: { enrollment: 'absent' } },
    };
    const deps = depsFor(fixture, { logger: log });
    setup.printDryRun(context, setup.parseArgs(['--dry-run', '--export']).options, deps,
      { state: 'enrolled', enrolledAt: '2026-10-14T00:00:00.000Z', retentionDays: 30 },
      { absent: true, path: path.join(setupHome(fixture), 'export-cursor.json') }, null);
    const output = log.lines.join('\n');
    assert.ok(output.includes('pwsh/Core: /alias-one'));
    assert.ok(output.includes('powershell/Desktop: /alias-two'));
    assert.ok(output.includes('ccxray-wrapper-v1'));
    assert.ok(!output.includes('do-not-print-this-sentinel'));

    const consent = setup.changeLines(context, { remove: false }, null, null,
      { state: 'enrolled', enrolledAt: '2026-10-14T00:00:00.000Z', retentionDays: 30 }, deps).join('\n');
    assert.ok(consent.includes('pwsh/Core: /alias-one'));
    assert.ok(consent.includes('powershell/Desktop: /alias-two'));
  });
});

test('install edits a symlink target while preserving the startup-file link', async () => {
  await withFixture(async fixture => {
    const logical = rcFile(fixture);
    const real = path.join(fixture.paths.home, 'shared-bashrc');
    fs.writeFileSync(real, 'export USER_RC=kept\n');
    fs.symlinkSync(path.basename(real), logical);
    const result = await setup.runSetup(installArgs(), depsFor(fixture));
    assert.equal(result, 0);
    assert.equal(fs.lstatSync(logical).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(logical), fs.realpathSync(real));
    assert.ok(fs.readFileSync(real, 'utf8').startsWith('export USER_RC=kept\n'));
    assert.ok(fs.readFileSync(real, 'utf8').includes('ccxray-wrapper-v1'));
  });
});

test('--export requires explicit bucket and domains and never takes values from ambient env', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    let result = await setup.runSetup(['--shell', 'bash', '--export', '--yes'], depsFor(fixture, { logger: log }));
    assert.equal(result, 2);
    assert.ok(log.lines.some(line => line.includes('--export needs --bucket')));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);

    const next = makeLogger();
    result = await setup.runSetup(['--shell', 'bash', '--export', '--bucket', 'fixture-bucket-01', '--yes'],
      depsFor(fixture, { logger: next }));
    assert.equal(result, 2);
    assert.ok(next.lines.some(line => line.includes('--export needs --domains')));
    assert.equal(fs.existsSync(rcFile(fixture)), false);
  });
});

test('successful install and re-run keep values, retention, cursor, and the absent browser preference', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    const writeCursorPaths = [];
    const exportSyncApi = {
      writeCursor(file, data) {
        writeCursorPaths.push(file);
        return exportSync.writeCursor(file, data);
      },
    };
    const args = installArgs([
      '--prefix', 'team/daily',
      '--retention-days', '17',
      '--cwd-allowlist', 'repo-a,repo-b',
    ]);
    let result = await setup.runSetup(args, depsFor(fixture, {
      logger: log,
      exportSync: exportSyncApi,
    }));
    assert.equal(result, 0, log.lines.join('\n'));

    const enrollmentFile = exportSync.enrollmentPath(setupHome(fixture));
    const enrollment = JSON.parse(fs.readFileSync(enrollmentFile, 'utf8'));
    assert.equal(enrollment.state, 'enrolled');
    assert.equal(enrollment.retentionDays, 17);
    const cursorFile = path.join(setupHome(fixture), 'export-cursor.json');
    assert.deepEqual(writeCursorPaths, [enrollmentFile]);
    const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    assert.equal(cursor.partial, false);
    assert.equal(cursor.cutoffDt, enrollment.enrolledAt.slice(0, 10));

    const rcPath = rcFile(fixture);
    const firstRc = fs.readFileSync(rcPath, 'utf8');
    assert.match(firstRc, /CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'/);
    assert.match(firstRc, /CCXRAY_EXPORT_DOMAINS='example\.test'/);
    assert.match(firstRc, /LOG_RETENTION_DAYS='17'/);
    assert.match(firstRc, /CCXRAY_EXPORT_CWD_ALLOWLIST='repo-a,repo-b'/);
    assert.match(firstRc, /ccxray-wrapper-v1/);
    assert.ok(log.lines.some(line => line.includes('basenames export unmasked')) === false);
    assert.equal(fs.existsSync(path.join(setupHome(fixture), 'auto-open-browser')), false);

    cursor.seq.keep = 'preserved';
    fs.writeFileSync(cursorFile, JSON.stringify(cursor) + '\n');
    const rerunLog = makeLogger();
    result = await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture, { logger: rerunLog }));
    assert.equal(result, 0, rerunLog.lines.join('\n'));
    const secondRc = fs.readFileSync(rcPath, 'utf8');
    const secondCursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    assert.match(secondRc, /LOG_RETENTION_DAYS='17'/);
    assert.match(secondRc, /CCXRAY_EXPORT_CWD_ALLOWLIST='repo-a,repo-b'/);
    assert.equal(secondCursor.seq.keep, 'preserved');

    const overrideLog = makeLogger();
    result = await setup.runSetup([
      '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-03', '--domains', 'EXAMPLE.TEST',
      '--retention-days', '11', '--yes',
    ], depsFor(fixture, { logger: overrideLog }));
    assert.equal(result, 0, overrideLog.lines.join('\n'));
    const overrideRc = fs.readFileSync(rcPath, 'utf8');
    const updatedEnrollment = JSON.parse(fs.readFileSync(enrollmentFile, 'utf8'));
    assert.match(overrideRc, /CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-03'/);
    assert.match(overrideRc, /CCXRAY_EXPORT_DOMAINS='example\.test'/);
    assert.match(overrideRc, /LOG_RETENTION_DAYS='11'/);
    assert.equal(updatedEnrollment.retentionDays, 11);
  });
});

test('first install without an allowlist warns and re-run keeps that field absent', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    const result = await setup.runSetup(installArgs(), depsFor(fixture, { logger: log }));
    assert.equal(result, 0, log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('basenames export unmasked')));
    assert.ok(!fs.readFileSync(rcFile(fixture), 'utf8').includes('CCXRAY_EXPORT_CWD_ALLOWLIST'));

    const rerun = await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture));
    assert.equal(rerun, 0);
    assert.ok(!fs.readFileSync(rcFile(fixture), 'utf8').includes('CCXRAY_EXPORT_CWD_ALLOWLIST'));
  });
});

// #691: export is opt-in; plain `ccxray setup` is record-only.
function spyCredentials() {
  const calls = [];
  const fail = name => () => { calls.push(name); throw new Error(`credentials.${name} must not run in record-only setup`); };
  return {
    calls,
    api: { discoverCredentials: fail('discoverCredentials'), describeCredentials: fail('describeCredentials'), credentialText: fail('credentialText') },
  };
}

function plantGcloud(fixture) {
  const marker = path.join(fixture.paths.root, 'gcloud-invoked');
  const bin = path.join(fixture.paths.bin, 'gcloud');
  fs.writeFileSync(bin, `#!/bin/sh\necho invoked > '${marker}'\n`, { mode: 0o755 });
  return marker;
}

test('default setup is record-only: wrapper and retention, no export config, no ADC or gcloud', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    const credentials = spyCredentials();
    const marker = plantGcloud(fixture);
    const spawned = [];
    const result = await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture, {
      logger: log,
      credentials: credentials.api,
      spawn: (file, args, options) => { spawned.push(file); return childProcess.spawn(file, args, options); },
    }));
    assert.equal(result, 0, log.lines.join('\n'));
    const rc = fs.readFileSync(rcFile(fixture), 'utf8');
    assert.match(rc, /ccxray-wrapper-v1/);
    assert.match(rc, /LOG_RETENTION_DAYS='30'/);
    assert.match(rc, /CCXRAY_IMPORT_DISABLE='1'/);
    assert.doesNotMatch(rc, /CCXRAY_EXPORT_/);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
    assert.equal(fs.existsSync(path.join(setupHome(fixture), 'export-cursor.json')), false);
    assert.deepEqual(credentials.calls, []);
    assert.equal(fs.existsSync(marker), false, 'gcloud must not run');
    assert.ok(!spawned.some(file => path.basename(String(file)).startsWith('gcloud')));
    assert.ok(!log.lines.some(line => /^(adc|enrollment|claude-account|account-count):/.test(line)), log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('export is off')));

    // The record-only block is owned: a re-run is a byte-identical rewrite.
    const rerun = await setup.runSetup(['--shell', 'bash', '--retention-days', '9', '--yes'], depsFor(fixture, {
      credentials: credentials.api,
    }));
    assert.equal(rerun, 0);
    const rerunRc = fs.readFileSync(rcFile(fixture), 'utf8');
    assert.match(rerunRc, /LOG_RETENTION_DAYS='9'/);
    assert.equal(rerunRc.split(setup.START_MARKER).length, 2);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);

    // --check on a record-only install does not read ADC or fail on it.
    const checkLog = makeLogger();
    const check = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
      logger: checkLog, credentials: credentials.api,
    }));
    assert.equal(check, 0, checkLog.lines.join('\n'));
    assert.ok(checkLog.lines.some(line => line.startsWith('adc: skipped')));
    assert.deepEqual(credentials.calls, []);
  });
});

test('record-only dry run names no enrollment or cursor', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    const result = await setup.runSetup(['--shell', 'bash', '--dry-run', '--yes'], depsFor(fixture, {
      logger: log, credentials: spyCredentials().api,
    }));
    assert.equal(result, 0, log.lines.join('\n'));
    const text = log.lines.join('\n');
    assert.doesNotMatch(text, /Would write enrollment|Cursor seed|CCXRAY_EXPORT_/);
    assert.match(text, /Record-only/);
    assert.equal(fs.existsSync(rcFile(fixture)), false);
  });
});

test('export settings without --export are refused before anything is written', async () => {
  await withFixture(async fixture => {
    for (const flags of [['--bucket', 'fixture-bucket-01'], ['--domains', 'example.test'], ['--prefix', 'p'], ['--cwd-allowlist', 'a']]) {
      const log = makeLogger();
      const result = await setup.runSetup(['--shell', 'bash', ...flags, '--yes'], depsFor(fixture, { logger: log }));
      assert.equal(result, 2, flags.join(' '));
      assert.ok(log.lines.some(line => line.includes(`${flags[0]} requires --export`)), log.lines.join('\n'));
    }
    assert.ok(setup.parseArgs(['--export', '--remove']).error);
    assert.ok(setup.parseArgs(['--export', '--browser', 'on']).error);
    assert.ok(setup.parseArgs(['--export', '--check']).error);
    assert.equal(fs.existsSync(rcFile(fixture)), false);
  });
});

test('plain setup leaves an existing export block untouched: no ADC, gcloud, or enrollment write', async () => {
  await withFixture(async fixture => {
    // An install made by 2.x: its owned block carries the export settings.
    const original = 'export PATH=/synthetic/bin\n' + setup.renderRcBlock({
      bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30,
    }, false);
    fs.writeFileSync(rcFile(fixture), original);
    const enrollmentFile = exportSync.enrollmentPath(setupHome(fixture));
    const enrollmentBytes = `${JSON.stringify({ synthetic: 'enrollment-sentinel' })}\n`;
    fs.writeFileSync(enrollmentFile, enrollmentBytes, { mode: 0o600 });
    const credentials = spyCredentials();
    const marker = plantGcloud(fixture);
    const spawned = [];
    const writes = [];
    const exportSyncSpy = {
      writeCursor: (...args) => { writes.push('writeCursor'); return exportSync.writeCursor(...args); },
    };
    const log = makeLogger();
    const result = await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture, {
      logger: log,
      credentials: credentials.api,
      exportSync: exportSyncSpy,
      spawn: (file, args, options) => { spawned.push(file); return childProcess.spawn(file, args, options); },
    }));
    assert.equal(result, 0, log.lines.join('\n'));
    assert.equal(fs.readFileSync(rcFile(fixture), 'utf8'), original, 'export block must be byte-for-byte unchanged');
    assert.equal(fs.readFileSync(enrollmentFile, 'utf8'), enrollmentBytes, 'enrollment must not be rewritten');
    assert.equal(fs.existsSync(path.join(setupHome(fixture), 'export-cursor.json')), false);
    assert.deepEqual(writes, []);
    assert.deepEqual(credentials.calls, []);
    assert.equal(fs.existsSync(marker), false, 'gcloud must not run');
    assert.ok(!spawned.some(file => path.basename(String(file)).startsWith('gcloud')));
    assert.ok(!log.lines.some(line => /^(adc|enrollment|claude-account|account-count):/.test(line)), log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('leave export setup block unchanged')), log.lines.join('\n'));
    const notices = log.lines.filter(line => line.startsWith('Export stays enabled'));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /ccxray setup --export/);
    assert.match(notices[0], /ccxray setup --remove/);
    assert.ok(!log.lines.some(line => line.includes('export is off')));

    const dry = makeLogger();
    assert.equal(await setup.runSetup(['--shell', 'bash', '--dry-run', '--yes'], depsFor(fixture, {
      logger: dry, credentials: credentials.api,
    })), 0);
    assert.ok(dry.lines.some(line => line.includes('Would leave the export setup block unchanged')), dry.lines.join('\n'));
    assert.doesNotMatch(dry.lines.join('\n'), /Would write setup block|Would write enrollment/);
    assert.deepEqual(credentials.calls, []);
  });
});

test('mixed targets: plain setup writes the record-only shell and leaves the export shell; --export upgrades both', async () => {
  await withFixture(async fixture => {
    const bashRc = rcFile(fixture, 'bash');
    const zshRc = rcFile(fixture, 'zsh');
    fs.mkdirSync(path.dirname(zshRc), { recursive: true });
    fs.writeFileSync(bashRc, setup.renderRcBlock({ retentionDays: 30 }, false));
    const exportBlock = setup.renderRcBlock({
      bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30,
    }, false);
    fs.writeFileSync(zshRc, exportBlock);
    const hooks = {
      resolveTargets: async () => ({
        targets: [
          { shell: 'bash', kind: 'posix', logicalPath: bashRc, label: 'bash' },
          { shell: 'zsh', kind: 'posix', logicalPath: zshRc, label: 'zsh' },
        ],
        issues: [],
        notices: [],
      }),
    };
    const credentials = spyCredentials();
    const log = makeLogger();
    const result = await setup.runSetup(['--retention-days', '12', '--yes'], depsFor(fixture, {
      logger: log, credentials: credentials.api, hooks,
    }));
    assert.equal(result, 0, log.lines.join('\n'));
    const bash = fs.readFileSync(bashRc, 'utf8');
    assert.match(bash, /LOG_RETENTION_DAYS='12'/);
    assert.doesNotMatch(bash, /CCXRAY_EXPORT_/);
    assert.equal(fs.readFileSync(zshRc, 'utf8'), exportBlock);
    assert.deepEqual(credentials.calls, []);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
    assert.ok(!log.lines.some(line => /needs --bucket|Conflicting/.test(line)), log.lines.join('\n'));
    assert.equal(log.lines.filter(line => line.startsWith('Export stays enabled for zsh')).length, 1, log.lines.join('\n'));

    // --export takes the bucket and domains from the existing export block.
    const upgrade = makeLogger();
    const upgraded = await setup.runSetup(['--export', '--yes'], depsFor(fixture, { logger: upgrade, hooks }));
    assert.equal(upgraded, 0, upgrade.lines.join('\n'));
    for (const file of [bashRc, zshRc]) {
      assert.match(fs.readFileSync(file, 'utf8'), /CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'/, file);
    }
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'enrolled');
  });
});

test('--export upgrades a record-only install to the export block', async () => {
  await withFixture(async fixture => {
    assert.equal(await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture, {
      credentials: spyCredentials().api,
    })), 0);
    const log = makeLogger();
    const result = await setup.runSetup(installArgs(), depsFor(fixture, { logger: log }));
    assert.equal(result, 0, log.lines.join('\n'));
    assert.match(fs.readFileSync(rcFile(fixture), 'utf8'), /CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'/);
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'enrolled');
    assert.ok(log.lines.some(line => line.includes('basenames export unmasked')));
  });
});

test('a non-TTY install refuses before taking the lock or writing files', async () => {
  await withFixture(async fixture => {
    let locks = 0;
    const exportSyncApi = {
      acquireLock: async () => { locks++; return { handle: {} }; },
    };
    const log = makeLogger();
    const result = await setup.runSetup([
      '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test',
    ], depsFor(fixture, {
      logger: log,
      isTTY: false,
      exportSync: exportSyncApi,
    }));
    assert.equal(result, 2);
    assert.equal(locks, 0);
    assert.equal(fs.existsSync(rcFile(fixture)), false);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
    assert.equal(fs.existsSync(path.join(setupHome(fixture), 'export-cursor.json')), false);
  });
});

test('install preflight reports every conflict and refuses before consent', async () => {
  await withFixture(async fixture => {
    const rcPath = rcFile(fixture);
    fs.writeFileSync(rcPath, [
      'function claude() { echo local; }',
      'alias claude-dev=claude',
      'export ANTHROPIC_BASE_URL=https://synthetic.invalid',
    '. \"$HOME/late-profile\"',
      '',
    ].join('\n'));
    const log = makeLogger();
    let prompts = 0;
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      isTTY: true,
      prompt: async () => { prompts++; return 'yes'; },
    }));
    assert.equal(result, 1);
    assert.equal(prompts, 0);
    assert.ok(log.lines.some(line => line.includes('function claude')));
    assert.ok(log.lines.some(line => line.includes('alias claude-dev')));
    assert.ok(log.lines.some(line => line.includes('ANTHROPIC_BASE_URL')));
    assert.ok(log.lines.some(line => line.includes('late-profile')));
    assert.equal(fs.readFileSync(rcPath, 'utf8').startsWith('function claude()'), true);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('macOS Bash profile warning names an existing file that does not source bashrc', async t => {
  if (process.platform !== 'darwin') {
    t.skip('macOS Bash profile discovery is platform-specific');
    return;
  }
  await withFixture(async fixture => {
    const profile = path.join(fixture.paths.home, '.bash_profile');
    fs.writeFileSync(profile, 'export USER_RC=fixture\n');
    const log = makeLogger();
    const result = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
      logger: log,
    }));
    assert.equal(result, 0, log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes(profile) && line.includes('does not source ~/.bashrc')));
  });
});

test('account count rejects two allowed-domain accounts in the shell population', async () => {
  await withFixture(async fixture => {
    fixture.writeIndex([
      { sessionId: 'synthetic-one', accountEmail: 'one@example.test', receivedAt: Date.now(), provider: 'anthropic' },
      { sessionId: 'synthetic-two', accountEmail: 'two@example.test', receivedAt: Date.now(), provider: 'anthropic' },
    ]);
    const log = makeLogger();
    const result = await setup.runSetup(installArgs(), depsFor(fixture, { logger: log }));
    assert.equal(result, 1);
    assert.ok(log.lines.some(line => line.includes('distinct allowed-domain accounts=2')));
    assert.ok(!log.lines.some(line => line.includes('one@example.test')));
    assert.ok(!log.lines.some(line => line.includes('two@example.test')));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('check accepts the default Claude account config at HOME/.claude.json', async () => {
  await withFixture(async fixture => {
    fs.writeFileSync(path.join(fixture.paths.home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'synthetic.user@example.test' },
    }));
    const log = makeLogger();
    const result = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
      env: {
        HOME: fixture.paths.home,
        CLAUDE_CONFIG_DIR: undefined,
        CCXRAY_EXPORT_DOMAINS: 'example.test',
      },
      logger: log,
    }));

    assert.equal(result, 0, log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('claude-account: ok')
      && line.includes('account domain example.test is allowed')), log.lines.join('\n'));
    assert.ok(!log.lines.some(line => line.includes('claude-account: failed')), log.lines.join('\n'));
  });
});

test('storage selection checks both hub and shell LOGS_DIR populations', async () => {
  await withFixture(async fixture => {
    const hubLogs = path.join(fixture.paths.root, 'hub-logs');
    const shellLogs = path.join(fixture.paths.root, 'shell-logs');
    fs.mkdirSync(hubLogs);
    fs.mkdirSync(shellLogs);
    fs.writeFileSync(path.join(hubLogs, 'index.ndjson'), JSON.stringify({
      sessionId: 'hub-one', accountEmail: 'one@example.test', receivedAt: Date.now(), provider: 'anthropic',
    }) + '\n');
    fs.writeFileSync(path.join(shellLogs, 'index.ndjson'), [
      JSON.stringify({ sessionId: 'shell-one', accountEmail: 'one@example.test', receivedAt: Date.now(), provider: 'anthropic' }),
      JSON.stringify({ sessionId: 'shell-two', accountEmail: 'two@example.test', receivedAt: Date.now(), provider: 'anthropic' }),
    ].join('\n') + '\n');
    const report = {
      identity: { home: setupHome(fixture), logsDir: hubLogs },
      exportState: 'enabled',
      exportConfigHash: 'fixture-config-hash',
    };
    const log = makeLogger();
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      env: { LOGS_DIR: shellLogs },
      report,
      hubResult: { kind: 'ok', report },
      logger: log,
    }));
    assert.equal(result, 1);
    assert.ok(log.lines.some(line => line.includes('index[hub]: distinct allowed-domain accounts=1')));
    assert.ok(log.lines.some(line => line.includes('index[shell]: distinct allowed-domain accounts=2')));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('ANTHROPIC_BASE_URL fails preflight and is skipped inside a ccxray hub client', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    let result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      env: { ANTHROPIC_BASE_URL: 'https://synthetic.invalid' },
    }));
    assert.equal(result, 1);
    assert.ok(log.lines.some(line => line.includes('env-anthropic-base-url: failed')));

    const skipped = makeLogger();
    result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: skipped,
      env: {
        ANTHROPIC_BASE_URL: 'https://synthetic.invalid',
        CCXRAY_HUB_CLIENT_PID: '12345',
      },
    }));
    assert.equal(result, 0, skipped.lines.join('\n'));
    assert.ok(skipped.lines.some(line => line.includes('env-anthropic-base-url: skipped')));
  });
});

test('key-file credentials are refused with safe guidance and are never uploaded', async () => {
  await withFixture(async fixture => {
    const key = path.join(fixture.paths.root, 'synthetic-key.json');
    fs.writeFileSync(key, JSON.stringify({ type: 'service_account', private_key: 'synthetic' }));
    const log = makeLogger();
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      env: { CCXRAY_EXPORT_GCS_KEY_FILE: key },
    }));
    assert.equal(result, 1);
    assert.ok(log.lines.some(line => line.includes('unset CCXRAY_EXPORT_GCS_KEY_FILE')));
    assert.ok(!log.lines.some(line => line.includes('synthetic-key.json')));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('invalid enrollment is refused before the prompt, while removal can tombstone it without ADC', async () => {
  await withFixture(async fixture => {
    const enrollmentPath = exportSync.enrollmentPath(setupHome(fixture));
    fs.writeFileSync(enrollmentPath, '{invalid');
    const installLog = makeLogger();
    let prompts = 0;
    let result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: installLog,
      isTTY: true,
      prompt: async () => { prompts++; return 'yes'; },
    }));
    assert.equal(result, 1);
    assert.equal(prompts, 0);
    assert.ok(installLog.lines.some(line => line.includes('enrollment: failed')));
    assert.equal(fs.readFileSync(enrollmentPath, 'utf8'), '{invalid');

    let credentialCalls = 0;
    const credentials = {
      discoverCredentials() { credentialCalls++; throw new Error('must not discover for remove'); },
      describeCredentials() { credentialCalls++; return ''; },
      credentialText() { credentialCalls++; return ''; },
    };
    const removeLog = makeLogger();
    result = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture, {
      logger: removeLog,
      credentials,
      providers: { getClaudeLaunchAccountEmail() { throw new Error('remove must not read account'); } },
    }));
    assert.equal(result, 0, removeLog.lines.join('\n'));
    assert.equal(credentialCalls, 0);
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'removed');
    assert.ok(removeLog.lines.some(line => line.includes('unset -f claude')));
  });
});

test('remove mode does not fetch hub reports or exporter diagnostics', async () => {
  await withFixture(async fixture => {
    let diagnosticCalls = 0;
    const exportDiagnostics = {
      async fetchHubReport() { diagnosticCalls++; throw new Error('remove must not query the hub'); },
      collectExportDiagnostics() { diagnosticCalls++; throw new Error('remove must not collect diagnostics'); },
    };
    const log = makeLogger();
    const result = await setup.runSetup(
      ['--remove', '--shell', 'bash', '--yes'],
      depsFor(fixture, { logger: log, exportDiagnostics }),
    );
    assert.equal(result, 0, log.lines.join('\n'));
    assert.equal(diagnosticCalls, 0);
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'removed');
  });
});

test('PowerShell resolution labels edition and host, reports unknown discovery, and dedupes shared profiles', async () => {
  await withFixture(async fixture => {
    const frameNonce = '0123456789abcdef';
    const allHosts = 'C:\\Users\\fixture\\Documents\\PowerShell\\profile.ps1';
    const rows = new Map([
      ['pwsh', { edition: 'Core', host: 'ConsoleHost', currentHost: 'C:\\Users\\fixture\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1', executionPolicy: 'Restricted', profileSignature: 'NotSigned' }],
      ['powershell', { edition: 'Desktop', host: 'Windows PowerShell', currentHost: 'C:\\Users\\fixture\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1', executionPolicy: 'AllSigned', profileSignature: 'NotSigned' }],
    ]);
    const fakeWindowsFs = {
      statSync(file) {
        const key = String(file).toLowerCase();
        const known = [
          'c:\\tools\\pwsh.exe', 'c:\\tools\\powershell.exe',
          allHosts.toLowerCase(),
          ...[...rows.values()].map(row => row.currentHost.toLowerCase()),
        ];
        if (!known.includes(key)) throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT' });
        return { isFile: () => true };
      },
    };
    const runner = async ({ file }) => {
      const label = path.win32.parse(file).name.toLowerCase();
      const row = rows.get(label);
      if (!row) return { status: 'exited', exitCode: 0, stdout: '' };
      const payload = [
        `allHosts=${allHosts}`, `currentHost=${row.currentHost}`,
        `edition=${row.edition}`, `host=${row.host}`,
        `executionPolicy=${row.executionPolicy}`, `profileSignature=${row.profileSignature}`,
      ].join('\n');
      return {
        status: 'exited', exitCode: 0,
        stdout: `<<ccxray-probe:${frameNonce}>>\n${payload}\n<</ccxray-probe:${frameNonce}>>\n`,
      };
    };
    const common = {
      platform: 'win32',
      env: { PATH: 'C:\\Tools', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows' },
      fs: fakeWindowsFs,
      runBounded: runner,
      nonce: frameNonce,
    };
    const resolved = await setup.resolveTargets(setup.parseArgs([]).options, depsFor(fixture, common));
    assert.deepEqual(resolved.targets.map(target => target.label), [
      'pwsh/Core, ConsoleHost', 'powershell/Desktop, Windows PowerShell',
    ]);
    assert.deepEqual(resolved.targets.map(target => [target.executionPolicy, target.profileSignature]), [
      ['Restricted', 'NotSigned'], ['AllSigned', 'NotSigned'],
    ]);
    assert.equal(resolved.notices.length, 2);

    const deduped = setup.dedupeTargets(resolved.targets.map(target => ({
      ...target,
      snapshot: { realPath: target.logicalPath },
    })), 'win32');
    assert.equal(deduped.length, 1);
    assert.deepEqual(deduped[0].labels, ['pwsh/Core, ConsoleHost', 'powershell/Desktop, Windows PowerShell']);
    assert.deepEqual(deduped[0].shells, ['pwsh', 'powershell']);

    const unknown = await setup.resolveTargets(
      setup.parseArgs(['--shell', 'pwsh']).options,
      depsFor(fixture, {
        platform: 'win32',
        env: { PATH: 'C:\\Tools', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows' },
        fs: fakeWindowsFs,
        nonce: frameNonce,
        runBounded: async () => ({ status: 'exited', exitCode: 0, stdout: 'banner only' }),
      }),
    );
    assert.equal(unknown.targets[0].unknown, 'no-frame');
  });
});

test('--check names PowerShell ExecutionPolicy causes that prevent profile loading', async () => {
  await withFixture(async fixture => {
    const frameNonce = 'policy-check-frame';
    const profile = 'C:\\Users\\fixture\\Documents\\PowerShell\\profile.ps1';
    const windowsFs = new Proxy(fixture.guardedFs, {
      get(target, property) {
        if (property === 'statSync') {
          return file => {
            if (/^[A-Z]:\\/i.test(String(file))) {
              if (/^C:\\Tools\\pwsh\.exe$/i.test(String(file))) return { isFile: () => true };
              throw Object.assign(new Error('missing synthetic Windows path'), { code: 'ENOENT' });
            }
            return target.statSync(file);
          };
        }
        if (property === 'lstatSync') {
          return file => {
            if (/^[A-Z]:\\/i.test(String(file))) throw Object.assign(new Error('missing synthetic Windows path'), { code: 'ENOENT' });
            return target.lstatSync(file);
          };
        }
        return target[property];
      },
    });

    for (const [executionPolicy, profileSignature, expectedStatus, expectedReason] of [
      ['Restricted', 'Valid', 'failed', 'Restricted prevents profile loading'],
      ['AllSigned', 'NotSigned', 'failed', 'AllSigned prevents this profile from loading'],
      ['AllSigned', 'Valid', 'ok', null],
    ]) {
      const log = makeLogger();
      const payload = [
        `allHosts=${profile}`, `currentHost=${profile}`,
        'edition=Core', 'host=ConsoleHost',
        `executionPolicy=${executionPolicy}`, `profileSignature=${profileSignature}`,
      ].join('\n');
      const result = await setup.runSetup(['--check', '--shell', 'pwsh', '--no-probe'], depsFor(fixture, {
        platform: 'win32',
        env: { PATH: 'C:\\Tools', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows' },
        fs: windowsFs,
        logger: log,
        nonce: frameNonce,
        runBounded: async () => ({
          status: 'exited', exitCode: 0,
          stdout: `<<ccxray-probe:${frameNonce}>>\n${payload}\n<</ccxray-probe:${frameNonce}>>\n`,
        }),
        winLaunch: { describeResolution: () => ({ hit: 'C:\\Tools\\claude.exe' }) },
        providers: {
          getAgentProvider: () => ({}),
          getClaudeLaunchAccountEmail: () => null,
        },
        credentials: {
          discoverCredentials: () => ({ discovery: { state: 'adc' }, parse: { state: 'ok', type: 'authorized_user' } }),
          describeCredentials: () => 'fixture ADC',
          credentialText: () => 'fixture ADC',
        },
      }));
      assert.equal(result, expectedStatus === 'failed' ? 1 : 0, log.lines.join('\n'));
      const policyLine = log.lines.find(line => line.startsWith('execution-policy:'));
      assert.ok(policyLine, log.lines.join('\n'));
      assert.ok(policyLine.includes(`${expectedStatus} —`), policyLine);
      if (expectedReason) assert.ok(policyLine.includes(expectedReason), policyLine);
      else assert.ok(policyLine.includes('profile signature Valid'), policyLine);
    }
  });
});

test('PowerShell consent names a missing profile parent directory', async () => {
  await withFixture(async fixture => {
    const fakePwsh = path.join(fixture.paths.bin, 'pwsh');
    fs.writeFileSync(fakePwsh, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(fakePwsh, 0o700);
    const frameNonce = 'fedcba9876543210';
    const profile = path.join(fixture.paths.root, 'missing', 'PowerShell', 'profile.ps1');
    const output = [
      `<<ccxray-probe:${frameNonce}>>`, `allHosts=${profile}`,
      'currentHost=', 'edition=Core', 'host=ConsoleHost',
      `<</ccxray-probe:${frameNonce}>>`, '',
    ].join('\n');
    const prompts = [];
    const log = makeLogger();
    const result = await setup.runSetup([
      '--shell', 'pwsh', '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test',
    ], depsFor(fixture, {
      logger: log,
      isTTY: true,
      nonce: frameNonce,
      runBounded: async () => ({ status: 'exited', exitCode: 0, stdout: output }),
      prompt: async question => { prompts.push(question); return 'no'; },
    }));
    assert.equal(result, 2);
    assert.equal(prompts.length, 2);
    const physicalProfileParent = path.join(fs.realpathSync(fixture.paths.root), 'missing', 'PowerShell');
    assert.ok(log.lines.some(line => line.includes(`will create directory ${physicalProfileParent} and file`)));
    assert.equal(fs.existsSync(path.dirname(profile)), false);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('dry-run and browser-only mode never enroll or acquire the exporter lock', async () => {
  await withFixture(async fixture => {
    let locks = 0;
    const exportSyncApi = {
      acquireLock: async () => { locks++; return { handle: {} }; },
    };
    const dryLog = makeLogger();
    const dry = await setup.runSetup(installArgs(['--dry-run']), depsFor(fixture, {
      logger: dryLog,
      exportSync: exportSyncApi,
    }));
    assert.equal(dry, 0, dryLog.lines.join('\n'));
    assert.equal(locks, 0);
    assert.equal(fs.existsSync(rcFile(fixture)), false);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);

    const browserLog = makeLogger();
    const browser = await setup.runSetup(['--browser', 'off', '--yes'], depsFor(fixture, {
      logger: browserLog,
      exportSync: exportSyncApi,
    }));
    assert.equal(browser, 0, browserLog.lines.join('\n'));
    assert.equal(locks, 0);
    assert.equal(fs.readFileSync(path.join(setupHome(fixture), 'auto-open-browser'), 'utf8'), 'off\n');
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('first install does not overwrite an existing browser preference', async () => {
  await withFixture(async fixture => {
    const file = path.join(setupHome(fixture), 'auto-open-browser');
    fs.writeFileSync(file, 'off\n');
    const result = await setup.runSetup(installArgs(), depsFor(fixture));
    assert.equal(result, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'off\n');
  });
});

test('consent-time symlink retarget and file edit abort phase A without any setup writes', async () => {
  await withFixture(async fixture => {
    const logical = rcFile(fixture);
    const oldTarget = path.join(fixture.paths.home, 'old-rc');
    const newTarget = path.join(fixture.paths.home, 'new-rc');
    fs.writeFileSync(oldTarget, 'export USER_RC=old\n');
    fs.writeFileSync(newTarget, 'export USER_RC=new\n');
    fs.symlinkSync(path.basename(oldTarget), logical);
    const log = makeLogger();
    const result = await setup.runSetup(['--shell', 'bash', '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test'], depsFor(fixture, {
      logger: log,
      isTTY: true,
      prompt: async question => {
        if (question.startsWith('Open the dashboard')) return 'no';
        fs.unlinkSync(logical);
        fs.symlinkSync(path.basename(newTarget), logical);
        return 'yes';
      },
    }));
    assert.equal(result, 1);
    assert.ok(log.lines.some(line => line.includes('changed since preparation')));
    assert.equal(fs.readFileSync(oldTarget, 'utf8'), 'export USER_RC=old\n');
    assert.equal(fs.readFileSync(newTarget, 'utf8'), 'export USER_RC=new\n');
    assert.equal(fs.realpathSync(logical), fs.realpathSync(newTarget));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });

  await withFixture(async fixture => {
    const logical = rcFile(fixture);
    fs.writeFileSync(logical, 'export USER_RC=before\n');
    const log = makeLogger();
    const result = await setup.runSetup(['--shell', 'bash', '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test'], depsFor(fixture, {
      logger: log,
      isTTY: true,
      prompt: async question => {
        if (question.startsWith('Open the dashboard')) return 'no';
        fs.writeFileSync(logical, 'export USER_RC=changed-after-consent\n');
        return 'yes';
      },
    }));
    assert.equal(result, 1);
    assert.ok(log.lines.some(line => line.includes('changed since preparation')));
    assert.equal(fs.readFileSync(logical, 'utf8'), 'export USER_RC=changed-after-consent\n');
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('phase A rejects same-size byte edits even when the original mtime is restored', async () => {
  await withFixture(async fixture => {
    const logical = rcFile(fixture);
    const before = Buffer.from('export SAFE=before\n');
    const after = Buffer.from('export SAFE=change\n');
    assert.equal(before.length, after.length);
    fs.writeFileSync(logical, before);
    const preservedTime = 1_790_000_000;
    fs.utimesSync(logical, preservedTime, preservedTime);
    const stat = fs.statSync(logical);
    const log = makeLogger();
    const result = await setup.runSetup([
      '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test',
    ], depsFor(fixture, {
      logger: log,
      isTTY: true,
      prompt: async question => {
        if (question.startsWith('Open the dashboard')) return 'no';
        fs.writeFileSync(logical, after);
        fs.utimesSync(logical, preservedTime, preservedTime);
        const current = fs.statSync(logical);
        assert.equal(current.size, stat.size);
        assert.equal(current.ino, stat.ino);
        assert.equal(current.mtimeMs, stat.mtimeMs);
        return 'yes';
      },
    }));
    assert.equal(result, 1, log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('changed since preparation')));
    assert.deepEqual(fs.readFileSync(logical), after);
    assert.equal(exportSync.readEnrollment(setupHome(fixture)), null);
  });
});

test('phase B revalidates a later target and retains the earlier committed block', async () => {
  await withFixture(async fixture => {
    const second = path.join(fixture.paths.home, 'second.rc');
    fs.writeFileSync(second, 'export USER_RC=before\n');
    const log = makeLogger();
    let added = false;
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      hooks: {
        afterTargetCommit({ context }) {
          if (added) return;
          added = true;
          context.targets.push(installTargetFromFile(fixture, second));
          fs.writeFileSync(second, 'export USER_RC=changed after first commit\n');
        },
      },
    }));
    assert.equal(result, 1);
    assert.ok(fs.readFileSync(rcFile(fixture), 'utf8').includes('ccxray-wrapper-v1'));
    assert.equal(fs.readFileSync(second, 'utf8'), 'export USER_RC=changed after first commit\n');
    assert.ok(log.lines.some(line => line.includes('enrollment is ACTIVE (state: enrolled)')));
    assert.ok(log.lines.some(line => line.includes(second + ' was not updated')));
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'enrolled');
  });
});

test('phase B2 rejects same-size byte edits with restored mtime before replacing a later target', async () => {
  await withFixture(async fixture => {
    const second = path.join(fixture.paths.home, 'second-same-metadata.rc');
    const before = Buffer.from('export SAFE=before\n');
    const after = Buffer.from('export SAFE=change\n');
    assert.equal(before.length, after.length);
    fs.writeFileSync(second, before);
    const preservedTime = 1_790_000_000;
    fs.utimesSync(second, preservedTime, preservedTime);
    const stat = fs.statSync(second);
    const log = makeLogger();
    let added = false;
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      hooks: {
        afterTargetCommit({ context }) {
          if (added) return;
          added = true;
          context.targets.push(installTargetFromFile(fixture, second));
          fs.writeFileSync(second, after);
          fs.utimesSync(second, preservedTime, preservedTime);
          const current = fs.statSync(second);
          assert.equal(current.size, stat.size);
          assert.equal(current.ino, stat.ino);
          assert.equal(current.mtimeMs, stat.mtimeMs);
        },
      },
    }));
    assert.equal(result, 1, log.lines.join('\n'));
    assert.ok(fs.readFileSync(rcFile(fixture), 'utf8').includes('ccxray-wrapper-v1'));
    assert.deepEqual(fs.readFileSync(second), after);
    assert.ok(log.lines.some(line => line.includes('enrollment is ACTIVE (state: enrolled)')));
    assert.ok(log.lines.some(line => line.includes(second + ' was not updated')));
  });
});

test('phase B separately skips a later target whose symlink was retargeted', async () => {
  await withFixture(async fixture => {
    const logical = path.join(fixture.paths.home, 'second.rc');
    const oldTarget = path.join(fixture.paths.home, 'second-old.rc');
    const newTarget = path.join(fixture.paths.home, 'second-new.rc');
    fs.writeFileSync(oldTarget, 'export USER_RC=old\n');
    fs.writeFileSync(newTarget, 'export USER_RC=new\n');
    fs.symlinkSync(path.basename(oldTarget), logical);
    const log = makeLogger();
    let added = false;
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      hooks: {
        afterTargetCommit({ context }) {
          if (added) return;
          added = true;
          context.targets.push(installTargetFromFile(fixture, logical));
          fs.unlinkSync(logical);
          fs.symlinkSync(path.basename(newTarget), logical);
        },
      },
    }));
    assert.equal(result, 1);
    assert.ok(fs.readFileSync(rcFile(fixture), 'utf8').includes('ccxray-wrapper-v1'));
    assert.equal(fs.readFileSync(oldTarget, 'utf8'), 'export USER_RC=old\n');
    assert.equal(fs.readFileSync(newTarget, 'utf8'), 'export USER_RC=new\n');
    assert.equal(fs.realpathSync(logical), fs.realpathSync(newTarget));
    assert.ok(log.lines.some(line => line.includes('enrollment is ACTIVE (state: enrolled)')));
    assert.ok(log.lines.some(line => line.includes(logical + ' was not updated')));
  });
});

test('install/remove phase-A interleavings are resolved by the operation that validates last', async () => {
  await withFixture(async fixture => {
    let nestedRemoveCode = null;
    const outerLog = makeLogger();
    const outer = await setup.runSetup([
      '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test',
    ], depsFor(fixture, {
      logger: outerLog,
      isTTY: true,
      prompt: async question => {
        if (question.startsWith('Open the dashboard')) return 'no';
        nestedRemoveCode = await setup.runSetup(
          ['--remove', '--shell', 'bash', '--yes'],
          depsFor(fixture),
        );
        return 'yes';
      },
    }));
    assert.equal(nestedRemoveCode, 0);
    assert.equal(outer, 0, outerLog.lines.join('\n'));
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'enrolled');
    assert.ok(fs.readFileSync(rcFile(fixture), 'utf8').includes('ccxray-wrapper-v1'));
  });

  await withFixture(async fixture => {
    const first = await setup.runSetup(installArgs(), depsFor(fixture));
    assert.equal(first, 0);
    const enrollmentBefore = exportSync.readEnrollment(setupHome(fixture));
    let nestedInstallCode = null;
    const outerLog = makeLogger();
    const outer = await setup.runSetup(['--remove', '--shell', 'bash'], depsFor(fixture, {
      logger: outerLog,
      isTTY: true,
      prompt: async () => {
        nestedInstallCode = await setup.runSetup(installArgs(), depsFor(fixture));
        return 'yes';
      },
    }));
    assert.equal(nestedInstallCode, 0);
    assert.equal(outer, 1);
    assert.ok(outerLog.lines.some(line => line.includes('changed since preparation')));
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'enrolled');
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).enrolledAt, enrollmentBefore.enrolledAt);
    assert.ok(fs.readFileSync(rcFile(fixture), 'utf8').includes('ccxray-wrapper-v1'));
  });
});

test('enrollment and removal tombstone are prerequisites for cursor and rc writes', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    const enrollmentPath = exportSync.enrollmentPath(setupHome(fixture));
    const originalRename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (path.resolve(to) === path.resolve(enrollmentPath)) {
        const error = new Error('synthetic enrollment rename failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRename.apply(this, arguments);
    };
    try {
      const result = await setup.runSetup(installArgs(), depsFor(fixture, { logger: log }));
      assert.equal(result, 1);
      assert.equal(fs.existsSync(rcFile(fixture)), false);
      assert.equal(fs.existsSync(path.join(setupHome(fixture), 'export-cursor.json')), false);
      assert.ok(log.lines.some(line => line.includes('No cursor, shell, or browser files were changed')));
    } finally {
      fs.renameSync = originalRename;
    }
  });

  await withFixture(async fixture => {
    const rcPath = rcFile(fixture);
    fs.writeFileSync(rcPath, setup.renderRcBlock({
      bucket: 'fixture-bucket-01',
      domains: ['example.test'],
      prefix: 'summaries',
      retentionDays: 30,
      cwdAllowlist: undefined,
    }, false));
    const log = makeLogger();
    const enrollmentPath = exportSync.enrollmentPath(setupHome(fixture));
    const originalRename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (path.resolve(to) === path.resolve(enrollmentPath)) {
        const error = new Error('synthetic tombstone rename failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRename.apply(this, arguments);
    };
    try {
      const result = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture, { logger: log }));
      assert.equal(result, 1);
      assert.ok(fs.readFileSync(rcPath, 'utf8').includes('ccxray-wrapper-v1'));
      assert.equal(exportSync.readEnrollment(setupHome(fixture)), null);
      assert.ok(log.lines.some(line => line.includes('No shell files were changed')));
    } finally {
      fs.renameSync = originalRename;
    }
  });
});

test('remove writes its tombstone while the owned rc block is still present', async () => {
  await withFixture(async fixture => {
    const rcPath = rcFile(fixture);
    fs.writeFileSync(rcPath, setup.renderRcBlock({
      bucket: 'fixture-bucket-01',
      domains: ['example.test'],
      prefix: 'summaries',
      retentionDays: 30,
      cwdAllowlist: undefined,
    }, false));
    let tombstoneFirst = false;
    const exportSyncApi = {
      writeCursor(file, data) {
        if (file === exportSync.enrollmentPath(setupHome(fixture))) {
          tombstoneFirst = fs.readFileSync(rcPath, 'utf8').includes('ccxray-wrapper-v1');
        }
        return exportSync.writeCursor(file, data);
      },
    };
    const result = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture, {
      exportSync: exportSyncApi,
    }));
    assert.equal(result, 0);
    assert.equal(tombstoneFirst, true);
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'removed');
    assert.ok(!fs.readFileSync(rcPath, 'utf8').includes('ccxray-wrapper-v1'));
  });
});

test('remove tolerates broken ADC and creates a removed tombstone even when no block exists', async () => {
  await withFixture(async fixture => {
    const result = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture));
    assert.equal(result, 0);
    assert.equal(exportSync.readEnrollment(setupHome(fixture)).state, 'removed');
    assert.equal(fs.existsSync(rcFile(fixture)), false);
  });
});

test('contention times out without writes, while non-contention lock loss aborts immediately', async () => {
  await withFixture(async fixture => {
    let clock = 0;
    let attempts = 0;
    const exportSyncApi = {
      acquireLock: async () => { attempts++; return { lost: { code: 'EADDRINUSE' } }; },
      isContention: () => true,
      describeLoss: () => 'synthetic exporter lock contention',
    };
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      now: () => clock,
      sleep: async ms => { clock += ms; },
      exportSync: exportSyncApi,
    }));
    assert.equal(result, 1);
    assert.ok(attempts >= 20);
    assert.equal(fs.existsSync(rcFile(fixture)), false);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });

  await withFixture(async fixture => {
    let attempts = 0;
    const log = makeLogger();
    const exportSyncApi = {
      acquireLock: async () => { attempts++; return { lost: { code: 'EACCES' } }; },
      isContention: () => false,
      describeLoss: () => 'synthetic lock permission loss',
    };
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      exportSync: exportSyncApi,
    }));
    assert.equal(result, 1);
    assert.equal(attempts, 1);
    assert.ok(log.lines.some(line => line.includes('could not start: synthetic lock permission loss')));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('rc commits and lock release occur in the same lock hold', async () => {
  await withFixture(async fixture => {
    const rcPath = rcFile(fixture);
    let held = false;
    let releasedBeforeCommit = false;
    const exportSyncApi = {
      acquireLock: async () => { held = true; return { handle: { fixture: true } }; },
      releaseLock: async () => {
        if (!fs.existsSync(rcPath) || !fs.readFileSync(rcPath, 'utf8').includes('ccxray-wrapper-v1')) {
          releasedBeforeCommit = true;
        }
        held = false;
      },
    };
    const result = await setup.runSetup(installArgs(), depsFor(fixture, { exportSync: exportSyncApi }));
    assert.equal(result, 0);
    assert.equal(held, false);
    assert.equal(releasedBeforeCommit, false);
  });
});

test('existing malformed cursor remains byte-identical and is never reseeded', async () => {
  await withFixture(async fixture => {
    const cursorPath = path.join(setupHome(fixture), 'export-cursor.json');
    const malformed = '{ not a cursor\n';
    fs.writeFileSync(cursorPath, malformed);
    const result = await setup.runSetup(installArgs(), depsFor(fixture));
    assert.equal(result, 0);
    assert.equal(fs.readFileSync(cursorPath, 'utf8'), malformed);
    const names = fs.readdirSync(setupHome(fixture));
    assert.ok(!names.some(name => name.includes('corrupt')));
  });
});

test('cursor seeding uses create-if-absent and preserves a cursor that appears during the race', async () => {
  await withFixture(async fixture => {
    const cursorPath = path.join(setupHome(fixture), 'export-cursor.json');
    const raced = JSON.stringify({
      lastId: 'synthetic-existing',
      seq: { '2026-10-14': 'sequence-kept' },
      partial: true,
      cutoffDt: '2026-10-14',
    }) + '\n';
    let injected = false;
    const targetFs = fixture.guardedFs;
    const injectedFs = new Proxy(targetFs, {
      get(target, property) {
        if (property === 'writeFileSync') {
          return (...args) => {
            if (!injected && path.resolve(args[0]) === path.resolve(cursorPath)) {
              injected = true;
              fs.writeFileSync(cursorPath, raced, { flag: 'wx', mode: 0o600 });
            }
            return target.writeFileSync(...args);
          };
        }
        return target[property];
      },
    });
    const writeCursorPaths = [];
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      fs: injectedFs,
      exportSync: {
        writeCursor(file, data) {
          writeCursorPaths.push(file);
          return exportSync.writeCursor(file, data);
        },
      },
    }));
    assert.equal(result, 0);
    assert.equal(injected, true);
    assert.deepEqual(writeCursorPaths, [exportSync.enrollmentPath(setupHome(fixture))]);
    assert.equal(fs.readFileSync(cursorPath, 'utf8'), raced);
  });
});

test('an interrupted first enrollment can seed its cursor from the original enrollment day', async () => {
  await withFixture(async fixture => {
    const firstDay = Date.parse('2026-10-14T23:59:00.000Z');
    const cursorPath = path.join(setupHome(fixture), 'export-cursor.json');
    let failCursor = true;
    const baseFs = fixture.guardedFs;
    const injectedFs = new Proxy(baseFs, {
      get(target, property) {
        if (property === 'writeFileSync') {
          return (...args) => {
            if (failCursor && typeof args[0] === 'string'
                && path.resolve(args[0]) === path.resolve(cursorPath)) {
              throw new Error('synthetic interruption before cursor seed');
            }
            return target.writeFileSync(...args);
          };
        }
        return target[property];
      },
    });
    const firstLog = makeLogger();
    const first = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: firstLog,
      now: () => firstDay,
      fs: injectedFs,
    }));
    assert.equal(first, 1);
    const enrollment = exportSync.readEnrollment(setupHome(fixture));
    assert.ok(enrollment, firstLog.lines.join('\n'));
    assert.equal(enrollment.state, 'enrolled');
    assert.equal(enrollment.enrolledAt.slice(0, 10), '2026-10-14');

    failCursor = false;
    const secondDay = Date.parse('2026-10-15T00:01:00.000Z');
    const second = await setup.runSetup(installArgs(), depsFor(fixture, {
      now: () => secondDay,
      fs: injectedFs,
    }));
    assert.equal(second, 0);
    const cursor = JSON.parse(fs.readFileSync(path.join(setupHome(fixture), 'export-cursor.json'), 'utf8'));
    assert.equal(cursor.cutoffDt, '2026-10-14');
    assert.equal(cursor.partial, false);
    assert.equal(failCursor, false);
  });
});

test('setup respects a held real exporter lock before seeding the cursor', async () => {
  await withFixture(async fixture => {
    const home = setupHome(fixture);
    const cursorPath = path.join(home, 'export-cursor.json');
    const lock = await exportSync.acquireLock(home);
    assert.ok(lock.handle, 'fixture exporter lock should be acquired');
    let clock = 0;
    const log = makeLogger();
    try {
      const result = await setup.runSetup(installArgs(), depsFor(fixture, {
        logger: log,
        now: () => clock,
        sleep: async ms => { clock += ms; },
      }));
      assert.equal(result, 1);
      assert.ok(clock >= 10_000, `setup should exhaust its bounded lock wait; elapsed=${clock}`);
      assert.equal(fs.existsSync(cursorPath), false, 'setup must not seed a cursor without the exporter lock');
      assert.equal(exportSync.readEnrollment(home), null);
      assert.ok(log.lines.some(line => line.includes('could not start')));
    } finally {
      await exportSync.releaseLock(lock.handle);
    }
  });
});

test('interrupted setup can be removed and a residual-environment flush returns removed', async () => {
  await withFixture(async fixture => {
    const home = setupHome(fixture);
    const log = makeLogger();
    await assert.rejects(setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      hooks: {
        afterTargetCommit() { throw new Error('synthetic interruption after rc commit'); },
      },
    })), /synthetic interruption after rc commit/);
    assert.equal(exportSync.readEnrollment(home).state, 'enrolled');
    assert.ok(fs.readFileSync(rcFile(fixture), 'utf8').includes('ccxray-wrapper-v1'));

    const removed = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture));
    assert.equal(removed, 0);
    assert.equal(exportSync.readEnrollment(home).state, 'removed');

    const savedEnv = { ...process.env };
    const previousLog = console.log;
    try {
      Object.assign(process.env, fixture.env, { CCXRAY_EXPORT_GCS_BUCKET: 'fixture-bucket-01', CCXRAY_EXPORT_DOMAINS: 'example.com' });
      delete process.env.CCXRAY_EXPORT_DISABLE;
      delete process.env.CCXRAY_EXPORT_GCS_KEY_FILE;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.CCXRAY_HUB_CLIENT_PID;
      exportSync._setUploader(async () => { throw new Error('removed flush must not upload'); });
      console.log = () => {};
      assert.equal(await exportSync.flushExport(), 'removed');
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'export-last.json'), 'utf8')).outcome, 'removed');
    } finally {
      console.log = previousLog;
      exportSync._setUploader(null);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
});

test('check continues through an unreachable hub and reports all remaining checks', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    const before = fs.readdirSync(fixture.paths.root).sort();
    const result = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
      logger: log,
      hubResult: { kind: 'unresponsive', reason: 'fixture timeout' },
      diagnostics: diagnosticView({
        durableHome: {
          enrollment: 'absent',
          cursor: { present: false },
          lastAttempt: { outcome: 'upload-failed', attemptedAt: '2026-10-13T00:00:00Z' },
          lastLockLoss: 'none',
          lastFailOpen: 'none',
        },
      }),
    }));
    assert.equal(result, 0, log.lines.join('\n'));
    for (const id of [
      'node-version:', 'claude-resolvable:', 'shell-target:', 'rc-block:',
      'conflict-scan:', 'env-anthropic-base-url:', 'claude-account:',
      'account-count:', 'coverage:', 'adc:', 'invoking-shell:',
      'running-exporter: unknown', 'enrollment: warning', 'cursor: unknown',
      'last-attempt: warning', 'last-lock-loss:', 'last-fail-open:',
      'shell-probe: skipped', 'checks:',
    ]) {
      assert.ok(log.lines.some(line => line.startsWith(id) || line.includes(id)), id);
    }
    assert.deepEqual(fs.readdirSync(fixture.paths.root).sort(), before);
  });
});

test('check reports a shadowing alias loaded from a sourced file as the effective command', {
  skip: process.platform === 'win32' ? 'bash probes are unsupported on Windows' : false,
}, async () => {
  await withFixture(async fixture => {
    const rcPath = rcFile(fixture);
    const sourced = path.join(fixture.paths.home, 'late-alias.sh');
    const values = {
      bucket: 'fixture-bucket-01',
      domains: ['example.test'],
      prefix: 'summaries',
      retentionDays: 30,
      cwdAllowlist: undefined,
    };
    fs.writeFileSync(sourced, "alias claude='command claude'\n");
    fs.writeFileSync(rcPath, setup.renderRcBlock(values, false) + '. "$HOME/late-alias.sh"\n');
    const log = makeLogger();
    const result = await setup.runSetup(['--check', '--shell', 'bash'], depsFor(fixture, { logger: log }));
    assert.equal(result, 1);
    assert.ok(log.lines.some(line => line.includes('conflict-scan: ok') && line.includes('late-alias.sh')));
    assert.ok(log.lines.some(line => line.includes('shell-probe: failed') && line.includes('alias')));
    assert.ok(log.lines.some(line => line.includes('notScanned=') && line.includes('late-alias.sh')));
  });
});

test('coverage is the local-day intersection and reports unmatched captured ids separately', async () => {
  await withFixture(async fixture => {
    const now = Date.now();
    const expectedDir = path.join(fixture.paths.claude, 'projects', 'synthetic-project');
    const subagentDir = path.join(expectedDir, 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    const expectedFile = path.join(expectedDir, 'resumed-session.jsonl');
    fs.writeFileSync(expectedFile, '{"synthetic":true}\n');
    fs.utimesSync(expectedFile, now / 1000, now / 1000);
    const nested = path.join(subagentDir, 'nested-child.jsonl');
    fs.writeFileSync(nested, '{"synthetic":true}\n');
    fs.utimesSync(nested, now / 1000, now / 1000);

    fixture.writeIndex([
      { sessionId: 'resumed-session', accountEmail: 'one@example.test', receivedAt: now, provider: 'anthropic' },
      { sessionId: 'unmatched-session', accountEmail: 'one@example.test', receivedAt: now, provider: 'anthropic' },
      { sessionId: 'inferred-session', accountEmail: 'one@example.test', receivedAt: now, provider: 'anthropic', sessionInferred: true },
      { sessionId: 'imported-session', accountEmail: 'one@example.test', receivedAt: now, provider: 'anthropic', imported: true },
      { sessionId: 'other-provider', accountEmail: 'one@example.test', receivedAt: now, provider: 'openai' },
      { sessionId: 'missing-time', accountEmail: 'one@example.test' },
    ]);
    fs.writeFileSync(rcFile(fixture), setup.renderRcBlock({
      bucket: 'fixture-bucket-01',
      domains: ['example.test'],
      prefix: 'summaries',
      retentionDays: 30,
      cwdAllowlist: undefined,
    }, false));

    const log = makeLogger();
    const result = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
      logger: log,
      now: () => now,
    }));
    assert.equal(result, 0, log.lines.join('\n'));
    const coverage = log.lines.find(line => line.startsWith('coverage:'));
    assert.ok(coverage.includes('captured=1 expected=1 (100%) unmatched=1 skippedRows=1'), coverage);
    assert.ok(!coverage.includes('nested-child'));
  });
});

test('owned shell probe reports function loaded from the startup file', {
  skip: process.platform === 'win32' ? 'bash probes are unsupported on Windows' : false,
}, async () => {
  await withFixture(async fixture => {
    const result = await setup.runSetup(installArgs(), depsFor(fixture));
    assert.equal(result, 0);
    const log = makeLogger();
    const check = await setup.runSetup(['--check', '--shell', 'bash'], depsFor(fixture, { logger: log }));
    assert.equal(check, 0, log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('shell-probe: ok') && line.includes('function, owned')));
    assert.ok(log.lines.some(line => line.includes('shell probe runs the selected startup files')));
  });
});

test('a complete frame with an incomplete probe drain is unknown, never ok', {
  skip: process.platform === 'win32' ? 'bash probes are unsupported on Windows' : false,
}, async () => {
  await withFixture(async fixture => {
    assert.equal(await setup.runSetup(installArgs(), depsFor(fixture)), 0);
    const nonce = '0123456789abcdef';
    const log = makeLogger();
    const result = await setup.runSetup(['--check', '--shell', 'bash'], depsFor(fixture, {
      logger: log,
      nonce,
      runBounded: async () => ({
        status: 'exited',
        exitCode: 0,
        stdout: '<<ccxray-probe:' + nonce + '>>\nkind=function\nowned=1\n<</ccxray-probe:' + nonce + '>>\n',
        stderr: '',
        truncated: false,
        drainComplete: false,
        durationMs: 1,
      }),
    }));
    assert.equal(result, 0);
    assert.ok(log.lines.some(line => line.includes('shell-probe: unknown') && line.includes('drain-incomplete')));
  });
});

test('the framed probe rejects marker text outside its nonce frame', () => {
  const nonce = '0123456789abcdef';
  assert.equal(setup.parseFrame('ccxray-wrapper-v1\n' + '<</ccxray-probe:ffffffffffffffff>>\n', nonce), null);
  assert.equal(setup.parseFrame(
    'noise\n<<ccxray-probe:' + nonce + '>>\nkind=none\n<</ccxray-probe:' + nonce + '>>\n',
    nonce,
  ).kind, 'none');
});

test('bounded runner captures a final frame before exit and bounds a descendant-held pipe', async () => {
  await withFixture(async fixture => {
    const nonce = '0123456789abcdef';
    const frameScript = 'process.stdout.write([\"<<ccxray-probe:' + nonce + '>>\", \"kind=none\", \"<</ccxray-probe:' + nonce + '>>\", \"\"].join(String.fromCharCode(10))); process.exit(0);';
    const frame = await runChild(fixture, process.execPath, ['-e', frameScript]);
    assert.equal(frame.status, 'exited');
    assert.equal(frame.exitCode, 0);
    assert.equal(frame.drainComplete, true);
    assert.equal(setup.parseFrame(frame.stdout, nonce).kind, 'none');

    const bash = fixtureExecutable(fixture, 'bash');
    if (!bash) return;
    const pidFile = path.join(fixture.paths.root, 'descendant.pid');
    const script = 'sleep 5 & echo $! > ' + pidFile + '; printf before-exit; exit 0';
    const started = Date.now();
    const descendant = await runChild(fixture, bash, ['-c', script], { drainMs: 80 });
    assert.equal(descendant.status, 'exited');
    assert.equal(descendant.drainComplete, false);
    assert.ok(descendant.stdout.includes('before-exit'));
    assert.ok(Date.now() - started < 1500);
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
  });
});

test('bounded runner escalates ignored SIGTERM, caps output, and settles spawn errors', async () => {
  await withFixture(async fixture => {
    const ignored = await runChild(fixture, process.execPath, [
      '-e', 'process.on(\"SIGTERM\",()=>{}); setInterval(()=>{},1000);',
    ], { deadlineMs: 60, graceMs: 30, drainMs: 30 });
    assert.equal(ignored.status, 'timeout');
    assert.ok(ignored.durationMs < 1500);

    const flood = await runChild(fixture, process.execPath, [
      '-e', 'setInterval(()=>process.stdout.write(\"x\".repeat(4096)),1);',
    ], { maxOutputBytes: 1024, graceMs: 30 });
    assert.equal(flood.status, 'output-capped');
    assert.equal(flood.truncated, true);
    assert.ok(flood.durationMs < 1500);

    const spawnError = await runBounded({
      file: process.execPath,
      args: [],
      env: fixture.env,
      cwd: fixture.paths.home,
    }, {
      platform: process.platform,
      spawn(file, args, options) {
        fixture.assertSpawnAllowed(file);
        const { EventEmitter } = require('node:events');
        const child = new EventEmitter();
        child.once = child.once.bind(child);
        setImmediate(() => child.emit('error', Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT' })));
        return child;
      },
    });
    assert.equal(spawnError.status, 'spawn-error');
    assert.match(spawnError.error, /synthetic ENOENT/);
  });
});

test('bounded runner supports an injected Windows terminator without launching taskkill', async () => {
  await withFixture(async fixture => {
    let terminated = 0;
    const result = await runBounded({
      file: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000);'],
      env: fixture.env,
      cwd: fixture.paths.home,
      deadlineMs: 40,
      graceMs: 40,
      drainMs: 40,
    }, {
      platform: 'win32',
      spawn(file, args, options) {
        fixture.assertSpawnAllowed(file);
        return childProcess.spawn(file, args, { ...options, detached: false });
      },
      terminate(child) {
        terminated++;
        try { child.kill('SIGTERM'); } catch {}
      },
    });
    assert.equal(result.status, 'timeout');
    assert.equal(terminated, 1);
  });
});

test('POSIX wrapper preserves argument boundaries, bypasses version, and propagates proxy failure', async () => {
  await withFixture(async fixture => {
    const install = await setup.runSetup(installArgs(), depsFor(fixture));
    assert.equal(install, 0);
    const bash = fixtureExecutable(fixture, 'bash');
    assert.ok(bash);

    let launched = await runChild(fixture, bash, ['-i', '-c', 'claude \"two words\" \"x;y\"', 'fixture-shell']);
    assert.equal(launched.status, 'exited');
    assert.equal(launched.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(setupHome(fixture), 'fake-ccxray.log'), 'utf8'),
      '<claude>\n<two words>\n<x;y>\n');

    launched = await runChild(fixture, bash, ['-i', '-c', 'claude --version', 'fixture-shell']);
    assert.equal(launched.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(setupHome(fixture), 'fake-claude.log'), 'utf8'), '<--version>\n');

    fs.writeFileSync(path.join(setupHome(fixture), 'fake-ccxray.log'), '');
    const failed = await runChild(fixture, bash, ['-i', '-c', 'claude \"proxied\"', 'fixture-shell'], {
      env: { CCXRAY_FAKE_EXIT: '17' },
    });
    assert.equal(failed.exitCode, 17);
    assert.equal(fs.readFileSync(path.join(setupHome(fixture), 'fake-claude.log'), 'utf8'), '<--version>\n');
  });
});

test('PowerShell wrappers preserve argument boundaries under every installed edition', async t => {
  await withFixture(async fixture => {
    const editions = ['pwsh', 'powershell']
      .map(name => ({ name, executable: fixtureExecutable(fixture, name) }))
      .filter(item => item.executable);
    // windows-latest ships both editions; a missing one must fail, not silently shrink coverage.
    if (process.platform === 'win32') assert.deepEqual(editions.map(item => item.name), ['pwsh', 'powershell']);
    if (!editions.length) { t.skip('no PowerShell edition is installed in this environment'); return; }
    for (const edition of editions) {
      const profile = path.join(fixture.paths.root, 'synthetic-profile-' + edition.name + '.ps1');
      fs.writeFileSync(profile, setup.renderRcBlock({
        bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
        retentionDays: 30,
      }, true));
      const quotedProfile = "'" + profile.replace(/'/g, "''") + "'";
      fs.writeFileSync(path.join(setupHome(fixture), 'fake-ccxray.log'), '');
      const result = await runChild(fixture, edition.executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        '. ' + quotedProfile + "; claude 'two words' 'x;y'",
      ], { deadlineMs: 30000 });
      assert.equal(result.status, 'exited', edition.name + ': ' + result.stderr);
      assert.equal(result.exitCode, 0, edition.name + ': ' + result.stderr);
      assert.equal(fs.readFileSync(path.join(setupHome(fixture), 'fake-ccxray.log'), 'utf8'),
        '<claude>\n<two words>\n<x;y>\n', edition.name);
    }
  });
});

test('CLI dispatch registers setup before server startup', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server/index.js'), 'utf8');
  // Brief §8.3 requires this single source-level dispatch check; behavior is covered below.
  assert.match(source, /cliCommand !== 'setup'/);
  assert.match(source, /if \(process\.argv\[2\] === 'setup'\)/);
  assert.match(source, /require\('\.\/setup'\)\.runSetup/);
});

test('CLI dispatch smoke uses only fixture paths when its runtime dependency is installed', async t => {
  try { require.resolve('ws'); }
  catch { t.skip('ws dependency is unavailable in this checkout'); return; }
  await withFixture(async fixture => {
    const result = await runChild(fixture, process.execPath, [
      path.resolve(__dirname, '../server/index.js'), 'setup', '--browser', 'off', '--yes',
    ], { deadlineMs: 3000 });
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(setupHome(fixture), 'auto-open-browser'), 'utf8'), 'off\n');
    assert.equal(fs.existsSync(rcFile(fixture)), false);
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
  });
});

test('enrollment writer refuses a pre-existing temporary-path symlink', async () => {
  await withFixture(async fixture => {
    const protectedRc = path.join(fixture.paths.root, 'protected.rc');
    const original = Buffer.from('synthetic rc bytes\n');
    fs.writeFileSync(protectedRc, original);
    const enrollmentPath = exportSync.enrollmentPath(setupHome(fixture));
    const temporary = `${enrollmentPath}.tmp.${process.pid}`;
    fs.symlinkSync(protectedRc, temporary);

    assert.throws(() => exportSync.writeCursor(enrollmentPath, {
      state: 'enrolled', enrolledAt: '2026-10-14T00:00:00.000Z', retentionDays: 30,
    }), { code: 'EEXIST' });
    assert.deepEqual(fs.readFileSync(protectedRc), original);
    assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true);
  });
});

test('phase A detects retargeted ancestor symlink for an absent rc file', async () => {
  await withFixture(async fixture => {
    const parentA = path.join(fixture.paths.root, 'profile-a');
    const parentB = path.join(fixture.paths.root, 'profile-b');
    const logicalParent = path.join(fixture.paths.root, 'profile-link');
    fs.mkdirSync(parentA);
    fs.mkdirSync(parentB);
    fs.symlinkSync(parentA, logicalParent, 'dir');
    const log = makeLogger();
    let retargeted = false;
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log,
      env: { HOME: logicalParent },
      hooks: {
        async beforeLock() {
          fs.unlinkSync(logicalParent);
          fs.symlinkSync(parentB, logicalParent, 'dir');
          retargeted = true;
        },
      },
    }));
    assert.equal(retargeted, true);
    assert.equal(result, 1, log.lines.join('\n'));
    assert.ok(log.lines.some(line => /changed since preparation|stale/.test(line) && line.includes('re-run')));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);
    assert.equal(fs.existsSync(path.join(parentB, '.bashrc')), false);
  });
});

test('install, replacement, and removal preserve a payload BOM in UTF-8 and UTF-16LE rc files', async () => {
  await withFixture(async fixture => {
    const rcPath = rcFile(fixture);
    const encodings = [
      { name: 'UTF-8', encoding: 'utf8', fileBom: [0xef, 0xbb, 0xbf] },
      { name: 'UTF-16LE', encoding: 'utf16le', fileBom: [0xff, 0xfe] },
    ];
    for (const item of encodings) {
      const payload = Buffer.from('\uFEFF# foreign sentinel\nexport SAFE=1\n', item.encoding);
      const original = Buffer.concat([Buffer.from(item.fileBom), payload]);
      fs.writeFileSync(rcPath, original);
      const installed = await setup.runSetup(installArgs(), depsFor(fixture));
      assert.equal(installed, 0, item.name);
      let current = fs.readFileSync(rcPath);
      assert.ok(current.subarray(0, original.length).equals(original), `${item.name} install changed foreign bytes`);

      const replacement = await setup.runSetup([
        '--shell', 'bash', '--export', '--bucket', 'fixture-bucket-02', '--domains', 'example.test', '--yes',
      ], depsFor(fixture));
      assert.equal(replacement, 0, item.name);
      current = fs.readFileSync(rcPath);
      assert.ok(current.subarray(0, original.length).equals(original), `${item.name} replacement changed foreign bytes`);

      const removed = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture));
      assert.equal(removed, 0, item.name);
      assert.deepEqual(fs.readFileSync(rcPath), original, `${item.name} removal changed foreign bytes`);
      fs.unlinkSync(rcPath);
    }
  });
});

test('rc ownership rejects marker text after an inline close or a missing close', () => {
  const values = {
    bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries', retentionDays: 30,
  };
  const generated = setup.renderRcBlock(values, false);
  const inlineClose = [
    setup.START_MARKER,
    "export CCXRAY_EXPORT_GCS_BUCKET='fixture-bucket-01'",
    'claude() { echo local; }',
    '# ccxray-wrapper-v1',
    setup.END_MARKER,
  ].join('\n');
  const missingClose = generated.replace('  if command -v ccxray', '  if command -v ccxray').replace('\n}\n' + setup.END_MARKER, '\n' + setup.END_MARKER);
  assert.equal(setup.parseRcBlock(inlineClose, false).kind, 'malformed');
  assert.equal(setup.parseRcBlock(missingClose, false).kind, 'malformed');
});

test('deduplicated PowerShell profiles retain every logical chain and edition probe', async () => {
  await withFixture(async fixture => {
    const shared = path.join(fixture.paths.root, 'shared-profile.ps1');
    const other = path.join(fixture.paths.root, 'other-profile.ps1');
    const linkA = path.join(fixture.paths.root, 'profile-a.ps1');
    const linkB = path.join(fixture.paths.root, 'profile-b.ps1');
    fs.writeFileSync(shared, 'function claude { }\n');
    fs.writeFileSync(other, 'function claude { }\n');
    fs.symlinkSync(shared, linkA);
    fs.symlinkSync(shared, linkB);
    const first = installTargetFromFile(fixture, linkA, 'pwsh/Core, ConsoleHost');
    Object.assign(first, { kind: 'powershell', shell: 'pwsh', exe: path.join(fixture.paths.bin, 'pwsh') });
    const second = installTargetFromFile(fixture, linkB, 'powershell/Desktop, Windows PowerShell');
    Object.assign(second, { kind: 'powershell', shell: 'powershell', exe: path.join(fixture.paths.bin, 'powershell.exe') });

    const [deduped] = setup.dedupeTargets([first, second], process.platform);
    assert.equal(deduped.logicalTargets.length, 2);
    assert.deepEqual(setup.targetProbeDescriptors(deduped).map(target => target.shell), ['pwsh', 'powershell']);

    fs.unlinkSync(linkB);
    fs.symlinkSync(other, linkB);
    assert.equal(setup.verifyTargetSnapshot(deduped, depsFor(fixture)).stale, true);

    const calls = [];
    const log = makeLogger();
    const nonce = '0123456789abcdef';
    const context = {
      resolution: { issues: [] },
      targets: [deduped],
      populations: [],
      values: { domains: [] },
      diagnostics: diagnosticView(),
      hubResult: { kind: 'none', reason: 'fixture' },
      credential: { discovery: { state: 'adc' }, parse: { state: 'ok', type: 'authorized_user' } },
    };
    const checks = await setup.buildCheckReport(context, setup.parseArgs(['--check']).options, depsFor(fixture, {
      platform: 'win32',
      env: { PATH: 'C:\\Tools', PATHEXT: '.EXE' },
      logger: log,
      nonce,
      winLaunch: { describeResolution: () => ({ hit: 'C:\\Tools\\claude.exe' }) },
      providers: { getAgentProvider: () => ({}) },
      runBounded: async ({ file }) => {
        calls.push(file);
        return {
          status: 'exited', exitCode: 0, drainComplete: true, stdout:
            `<<ccxray-probe:${nonce}>>\nkind=function\nowned=1\n<</ccxray-probe:${nonce}>>\n`,
        };
      },
    }));
    assert.deepEqual(calls, [first.exe, second.exe]);
    assert.equal(checks.filter(check => check.id === 'shell-probe').length, 2);
  });
});

test('B2 dangling-link failure is reported and later rc targets still commit', async () => {
  await assertB2FailureContinues('dangling link');
});

test('B2 permission failure is reported and later rc targets still commit', async () => {
  await assertB2FailureContinues('permission');
});

test('B2 PowerShell directory-creation failure is reported and later rc targets still commit', async () => {
  await assertB2FailureContinues('directory creation');
});

async function assertB2FailureContinues(failureKind) {
  await withFixture(async fixture => {
    const secondPath = path.join(fixture.paths.root, `second-${failureKind.replace(/\W/g, '-')}.rc`);
    const thirdPath = path.join(fixture.paths.root, `third-${failureKind.replace(/\W/g, '-')}.rc`);
    const secondFile = path.join(fixture.paths.root, `second-${failureKind.replace(/\W/g, '-')}.target`);
    fs.writeFileSync(secondFile, 'export SECOND=1\n');
    if (failureKind === 'dangling link') fs.symlinkSync(secondFile, secondPath);
    else if (failureKind !== 'directory creation') fs.writeFileSync(secondPath, 'export SECOND=1\n');
    fs.writeFileSync(thirdPath, 'export THIRD=1\n');

    const second = failureKind === 'directory creation'
      ? (() => {
        const logicalPath = path.join(fixture.paths.root, 'late-parent', 'profile.ps1');
        const snapshot = setup.resolveChain(logicalPath, fixture.guardedFs, { allowCreateParent: true });
        const decoded = setup.decodeRc(Buffer.alloc(0));
        return {
          shell: 'pwsh', kind: 'powershell', label: 'late PowerShell profile',
          logicalPath, snapshot, raw: Buffer.alloc(0), decoded,
          parsed: setup.parseRcBlock('', true),
        };
      })()
      : installTargetFromFile(fixture, secondPath, 'second rc');
    const third = installTargetFromFile(fixture, thirdPath, 'third rc');
    let armed = false;
    let failingFs = fixture.guardedFs;
    if (failureKind !== 'dangling link') {
      const targetPath = failureKind === 'permission'
        ? second.snapshot.realPath
        : path.dirname(second.snapshot.realPath);
      failingFs = new Proxy(fixture.guardedFs, {
        get(target, property) {
          if (property === 'lstatSync' && failureKind === 'permission') {
            return file => {
              if (armed && path.resolve(String(file)) === path.resolve(targetPath)) {
                throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' });
              }
              return target.lstatSync(file);
            };
          }
          if (property === 'mkdirSync' && failureKind === 'directory creation') {
            return (directory, options) => {
              if (armed && path.resolve(String(directory)) === path.resolve(targetPath)) {
                throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' });
              }
              return target.mkdirSync(directory, options);
            };
          }
          return Reflect.get(target, property);
        },
      });
    }

    const log = makeLogger();
    const hooks = {
      async afterTargetCommit({ index, context }) {
        if (index !== 0) return;
        if (failureKind === 'dangling link') {
          fs.unlinkSync(secondPath);
          fs.symlinkSync(path.join(fixture.paths.root, 'missing-target'), secondPath);
        }
        armed = true;
        context.targets.push(second, third);
      },
    };
    const result = await setup.runSetup(installArgs(), depsFor(fixture, {
      logger: log, fs: failingFs, hooks,
    }));
    assert.equal(result, 1, log.lines.join('\n'));
    assert.ok(log.lines.some(line => line.includes('enrollment is ACTIVE') && line.includes(second.logicalPath)));
    assert.ok(fs.readFileSync(thirdPath, 'utf8').includes('ccxray-wrapper-v1'), 'later target should still commit');
  });
}

test('generated PowerShell probe embeds and recognizes the wrapper marker', async t => {
  const frameNonce = '0123456789abcdef';
  const script = setup.powershellProbeScript(frameNonce);
  assert.ok(script.includes('ccxray-wrapper-v1'));
  assert.ok(!script.includes('${WRAPPER_MARKER}'));
  await withFixture(async fixture => {
    const pwsh = fixtureExecutable(fixture, 'pwsh');
    if (!pwsh) { t.skip('pwsh is not installed in this environment'); return; }
    for (const owned of [true, false]) {
      const definition = owned
        ? 'function global:claude { # ccxray-wrapper-v1\n }\n'
        : 'function global:claude { # local implementation\n }\n';
      const result = await runChild(fixture, pwsh, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        setup.powershellEncoded(definition + script),
      ]);
      assert.equal(result.status, 'exited');
      assert.equal(result.exitCode, 0, result.stderr);
      const frame = setup.parseFrame(result.stdout, frameNonce);
      assert.equal(frame.kind, 'function');
      assert.equal(frame.owned, owned ? '1' : '0');
    }
  });
});

test('timeout and output-cap results wait for asynchronous termination to finish', async () => {
  await withFixture(async fixture => {
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    async function run(status) {
      let terminationFinished = false;
      const resultPromise = runBounded({
        file: process.execPath,
        args: [],
        env: fixture.env,
        cwd: fixture.paths.home,
        deadlineMs: 5,
        graceMs: 100,
        drainMs: 200,
        maxOutputBytes: status === 'output-capped' ? 4 : 64,
      }, {
        platform: process.platform,
        spawn(file) {
          fixture.assertSpawnAllowed(file);
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => true;
          setTimeout(() => {
            if (status === 'output-capped') child.stdout.write('12345');
          }, 10);
          setTimeout(() => {
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', null, 'SIGKILL');
          }, 20);
          return child;
        },
        async terminate() {
          await new Promise(resolve => setTimeout(resolve, 80));
          terminationFinished = true;
        },
      });
      const result = await resultPromise;
      assert.equal(terminationFinished, true, `${status} settled before terminate completed`);
      assert.equal(result.status, status);
    }
    await run('timeout');
    await run('output-capped');
  });
});

test('default POSIX runner observes process-group SIGKILL escalation after child readiness', async t => {
  if (process.platform === 'win32') { t.skip('POSIX process-group escalation'); return; }
  await withFixture(async fixture => {
    fixture.assertSpawnAllowed(process.execPath);
    const child = childProcess.spawn(process.execPath, [
      '-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("READY\\n"); setInterval(()=>{},1000);',
    ], {
      cwd: fixture.paths.home,
      env: fixture.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not report readiness')), 2000);
      const onData = chunk => {
        if (!String(chunk).includes('READY')) return;
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        child.stdout.pause();
        resolve();
      };
      child.stdout.on('data', onData);
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const result = await runBounded({
      file: process.execPath,
      args: [],
      env: fixture.env,
      cwd: fixture.paths.home,
      deadlineMs: 80,
      graceMs: 40,
      drainMs: 40,
    }, {
      platform: process.platform,
      spawn: () => child,
    });
    assert.equal(result.status, 'timeout');
    assert.equal(result.signal, 'SIGKILL');
  });
});

test('remove rejects unsupported or missing shell targets before consent, lock, or tombstone', async () => {
  await withFixture(async fixture => {
    for (const [args, extra, message] of [
      [['--remove', '--shell', 'powershell', '--yes'], {}, /powershell is supported only on Windows/],
      [['--remove', '--shell', 'pwsh', '--yes'], {
        platform: 'win32', env: { PATH: '', PATHEXT: '.EXE', SystemRoot: '' },
      }, /pwsh was not found on PATH/],
    ]) {
      const log = makeLogger();
      let lockCalls = 0;
      const result = await setup.runSetup(args, depsFor(fixture, {
        ...extra,
        logger: log,
        hooks: { beforeLock() { lockCalls++; } },
      }));
      assert.equal(result, 1, log.lines.join('\n'));
      assert.equal(lockCalls, 0);
      assert.equal(exportSync.readEnrollment(setupHome(fixture)), null);
      assert.ok(log.lines.some(line => message.test(line)));
    }
  });
});

test('check fails for malformed or unreadable explicitly selected key-file credentials', async () => {
  await withFixture(async fixture => {
    for (const parse of [
      { state: 'error', type: null, error: 'malformed key file' },
      { state: 'error', type: null, error: 'permission denied' },
    ]) {
      const log = makeLogger();
      const credentials = {
        discoverCredentials() { return { discovery: { state: 'key-file' }, parse }; },
        describeCredentials() { return 'synthetic key file failure'; },
        credentialText() { return 'synthetic key file failure'; },
      };
      // #691: the credential is only checked when export is configured; the
      // explicitly selected key file is that configuration here.
      const result = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
        logger: log, credentials, env: { CCXRAY_EXPORT_GCS_KEY_FILE: path.join(fixture.paths.root, 'synthetic-key.json') },
      }));
      assert.equal(result, 1, log.lines.join('\n'));
      assert.ok(log.lines.some(line => line.includes('adc: failed') && line.includes('synthetic key file failure')));
    }
  });
});

test('fixture boundary blocks escaped dependency reads and writes through string, Buffer, and URL paths', async () => {
  const fixture = await createSetupFixture();
  const outside = path.join(path.dirname(fixture.paths.root), `ccxray-setup-outside-${process.pid}`);
  fs.mkdirSync(outside, { recursive: true });
  const outsideAccount = path.join(outside, '.claude.json');
  const outsideFile = path.join(outside, 'protected.rc');
  fs.writeFileSync(outsideAccount, JSON.stringify({
    oauthAccount: { emailAddress: 'outside@example.test' },
  }));
  fs.writeFileSync(outsideFile, 'outside sentinel\n');
  const outsideOriginal = rawReadBytes(outsideFile);
  const escapedDir = path.join(fixture.paths.root, 'escaped');
  fs.symlinkSync(outside, escapedDir, 'dir');
  fs.writeFileSync(rcFile(fixture), setup.renderRcBlock({
    bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
    retentionDays: 30,
  }, false));
  const restoreFsGuard = fixture.installGlobalFsGuard?.() || (() => {});
  try {
    assert.equal(providers.getClaudeLaunchAccountEmail({ CLAUDE_CONFIG_DIR: outside }), null);
    assert.ok(fixture.outsideAttempts.some(item => item.operation === 'readFileSync'));

    assert.throws(() => exportSync.writeCursor(path.join(outside, 'export-enrollment.json'), {
      state: 'enrolled', enrolledAt: '2026-10-14T00:00:00.000Z', retentionDays: 30,
    }), /outside fixture root/);
    assert.equal(rawReadBytes(outsideFile).toString('utf8'), 'outside sentinel\n');

    const cursor = setup.cursorSeed(outside, {
      state: 'enrolled', enrolledAt: '2026-10-14T00:00:00.000Z', retentionDays: 30,
    }, depsFor(fixture));
    assert.equal(cursor.kind, 'failed');
    assert.throws(() => setup.resolveChain(outsideFile, fixture.guardedFs), /outside fixture root/);

    assert.throws(() => fixture.guardedFs.readFileSync(path.join(escapedDir, 'protected.rc'), 'utf8'), /outside fixture root/);
    const insideFile = path.join(fixture.paths.root, 'path-types.txt');
    fs.writeFileSync(insideFile, 'fixture sentinel\n');
    assert.equal(fixture.guardedFs.readFileSync(Buffer.from(insideFile), 'utf8'), 'fixture sentinel\n');
    assert.equal(fixture.guardedFs.readFileSync(pathToFileURL(insideFile), 'utf8'), 'fixture sentinel\n');
    assert.throws(() => fixture.guardedFs.readFileSync(Buffer.from(outsideFile), 'utf8'), /outside fixture root/);
    assert.throws(() => fixture.guardedFs.readFileSync(pathToFileURL(outsideFile), 'utf8'), /outside fixture root/);
    assert.deepEqual(rawReadBytes(outsideFile), outsideOriginal);
    consumeOutsideAttempts(fixture, [
      'readFileSync', 'openSync', 'writeFileSync', 'lstatSync',
      'readFileSync', 'readFileSync', 'readFileSync',
    ]);
  } finally {
    restoreFsGuard();
    fixture.dispose();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('setup dependencies refuse symlink-escaped account, enrollment, cursor, and rc paths', async () => {
  const fixture = await createSetupFixture();
  const outside = path.join(path.dirname(fixture.paths.root), `ccxray-setup-sentinel-${process.pid}`);
  fs.mkdirSync(outside, { recursive: true });
  const configLink = path.join(fixture.paths.root, 'config-escape');
  const homeLink = path.join(fixture.paths.root, 'home-escape');
  fs.symlinkSync(outside, configLink, 'dir');
  fs.symlinkSync(outside, homeLink, 'dir');
  const accountFile = path.join(outside, '.claude.json');
  const enrollmentFile = exportSync.enrollmentPath(outside);
  const rcFileOutside = path.join(outside, 'foreign.rc');
  fs.writeFileSync(accountFile, JSON.stringify({ oauthAccount: { emailAddress: 'one@example.test' } }));
  fs.writeFileSync(enrollmentFile, JSON.stringify({
    state: 'enrolled', enrolledAt: '2026-10-14T00:00:00.000Z', retentionDays: 30,
  }) + '\n');
  fs.writeFileSync(rcFileOutside, 'export FOREIGN=1\n');
  const enrollmentBefore = rawReadBytes(enrollmentFile);
  fs.writeFileSync(rcFile(fixture), setup.renderRcBlock({
    bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
    retentionDays: 30,
  }, false));
  const restoreFsGuard = fixture.installGlobalFsGuard?.() || (() => {});
  try {
    const accountLog = makeLogger();
    const accountCheck = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
      logger: accountLog,
      env: { CLAUDE_CONFIG_DIR: configLink },
    }));
    assert.equal(accountCheck, 1, accountLog.lines.join('\n'));
    assert.ok(accountLog.lines.some(line => line.includes('claude-account: failed')));

    const removeLog = makeLogger();
    const exportSyncApi = {
      acquireLock: async () => ({ handle: { fixture: true } }),
      releaseLock: async () => {},
    };
    const removed = await setup.runSetup(['--remove', '--shell', 'bash', '--yes'], depsFor(fixture, {
      logger: removeLog,
      env: { CCXRAY_HOME: homeLink },
      exportSync: exportSyncApi,
    }));
    assert.equal(removed, 1, removeLog.lines.join('\n'));
    assert.ok(removeLog.lines.some(line => line.includes('Could not write removal tombstone')));
    assert.deepEqual(rawReadBytes(enrollmentFile), enrollmentBefore);
    assert.equal(rawExists(path.join(outside, 'export-cursor.json')), false);

    const cursor = setup.cursorSeed(homeLink, {
      state: 'enrolled', enrolledAt: '2026-10-14T00:00:00.000Z', retentionDays: 30,
    }, depsFor(fixture));
    assert.equal(cursor.kind, 'failed');
    assert.throws(() => fixture.guardedFs.readFileSync(path.join(configLink, 'foreign.rc'), 'utf8'), /outside fixture root/);
    assert.throws(() => fixture.guardedFs.readFileSync(Buffer.from(accountFile), 'utf8'), /outside fixture root/);
    assert.throws(() => fixture.guardedFs.readFileSync(pathToFileURL(accountFile), 'utf8'), /outside fixture root/);
    assert.deepEqual(rawReadBytes(enrollmentFile), enrollmentBefore);
    consumeOutsideAttempts(fixture, [
      'readFileSync', 'readdirSync', 'readFileSync', 'readFileSync',
      'readFileSync', 'openSync', 'readFileSync',
      // #732: --remove also inspects <home>/shims.json (launcher shims) after the tombstone, but through lstat:
      // an absent file is never read (an existing one is read inside the fixture home only).
      'writeFileSync',
      'readFileSync', 'readFileSync', 'readFileSync',
    ]);
  } finally {
    restoreFsGuard();
    fixture.dispose();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('fixture boundary guards promise reads, numeric open writes, dangling links, and native realpath', async () => {
  let outsideReadFile;
  let outsideDanglingTarget;
  try {
    await withFixture(async fixture => {
      const outside = path.dirname(fixture.paths.root);
      outsideReadFile = path.join(outside, `ccxray-setup-promise-read-${process.pid}.txt`);
      outsideDanglingTarget = path.join(outside, `ccxray-setup-dangling-write-${process.pid}.txt`);
      rawWriteBytes(outsideReadFile, Buffer.from('outside promise sentinel\n'));

      await assert.rejects(
        Promise.resolve().then(() => fixture.guardedFs.promises.readFile(outsideReadFile, 'utf8')),
        /outside fixture root/,
      );

      const danglingLink = path.join(fixture.paths.root, 'dangling-write-link');
      fs.symlinkSync(outsideDanglingTarget, danglingLink);
      await assert.rejects(
        Promise.resolve().then(() => fixture.guardedFs.promises.open(
          danglingLink,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
          0o600,
        )),
        /outside fixture root/,
      );
      assert.equal(rawExists(outsideDanglingTarget), false);

      assert.equal(typeof fixture.guardedFs.realpathSync.native, 'function');
      assert.throws(() => fixture.guardedFs.realpathSync.native(outsideReadFile), /outside fixture root/);
      consumeOutsideAttempts(fixture, ['readFile', 'open', 'realpathSync']);
    });
  } finally {
    if (outsideReadFile && rawExists(outsideReadFile)) rawUnlinkSync(outsideReadFile);
    if (outsideDanglingTarget && rawExists(outsideDanglingTarget)) rawUnlinkSync(outsideDanglingTarget);
  }
});

test('fixture teardown detects swallowed outside-read exceptions', async () => {
  let teardownError = null;
  try {
    await withFixture(async fixture => {
      const outsideConfig = path.join(path.dirname(fixture.paths.root), `ccxray-swallowed-${process.pid}`);
      assert.equal(providers.getClaudeLaunchAccountEmail({ CLAUDE_CONFIG_DIR: outsideConfig }), null);
    });
  } catch (error) {
    teardownError = error;
  }
  assert.match(teardownError?.message || '', /fixture boundary recorded unexpected outside accesses/);
});

test('POSIX wrappers cover every bypass, missing-ccxray fallback, and one-launch failure behavior', async () => {
  await withFixture(async fixture => {
    const bypasses = ['--version', '--help', '-h', 'mcp', 'doctor', 'agents', 'plugin', 'auth', 'attach', 'respawn'];
    const claudeLog = path.join(setupHome(fixture), 'fake-claude.log');
    const ccxrayLog = path.join(setupHome(fixture), 'fake-ccxray.log');
    for (const shell of ['bash', 'zsh']) {
      const executable = fixtureExecutable(fixture, shell);
      if (!executable) continue;
      const installed = await setup.runSetup([
        '--shell', shell, '--export', '--bucket', 'fixture-bucket-01', '--domains', 'example.test', '--yes',
      ], depsFor(fixture));
      assert.equal(installed, 0, `${shell} install`);
      for (const command of bypasses) {
        fs.writeFileSync(claudeLog, '');
        fs.writeFileSync(ccxrayLog, '');
        const result = await runChild(fixture, executable, ['-i', '-c', `claude '${command}'`, 'fixture-shell']);
        assert.equal(result.exitCode, 0, `${shell} ${command}: ${result.stderr}`);
        assert.equal(fs.readFileSync(claudeLog, 'utf8'), `<${command}>\n`, `${shell} bypass ${command}`);
        assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '', `${shell} proxied bypass ${command}`);
      }

      fs.writeFileSync(claudeLog, '');
      fs.writeFileSync(ccxrayLog, '');
      const proxied = await runChild(fixture, executable, [
        '-i', '-c', 'claude "two words" "x;y"', 'fixture-shell',
      ]);
      assert.equal(proxied.exitCode, 0, `${shell} proxy: ${proxied.stderr}`);
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '<claude>\n<two words>\n<x;y>\n');
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '');

      fs.writeFileSync(claudeLog, '');
      fs.writeFileSync(ccxrayLog, '');
      const failedProxy = await runChild(fixture, executable, ['-i', '-c', 'claude request', 'fixture-shell'], {
        env: { CCXRAY_FAKE_EXIT: '17' },
      });
      assert.equal(failedProxy.exitCode, 17, `${shell} proxy exit`);
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '<claude>\n<request>\n');
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '', `${shell} must not launch Claude again after proxy failure`);

      const noCcxrayPath = path.join(fixture.paths.root, `${shell}-path-without-ccxray`);
      const pathWithoutCcxray = makeClaudeOnlyPath(fixture, noCcxrayPath);
      fs.writeFileSync(claudeLog, '');
      fs.writeFileSync(ccxrayLog, '');
      const fallback = await runChild(fixture, executable, ['-i', '-c', 'claude fallback', 'fixture-shell'], {
        env: { PATH: pathWithoutCcxray },
      });
      assert.equal(fallback.exitCode, 0, `${shell} fallback: ${fallback.stdout} ${fallback.stderr}`);
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '<fallback>\n');
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '');

      fs.writeFileSync(claudeLog, '');
      const failedFallback = await runChild(fixture, executable, ['-i', '-c', 'claude fallback', 'fixture-shell'], {
        env: { PATH: pathWithoutCcxray, CCXRAY_FAKE_EXIT: '23' },
      });
      assert.equal(failedFallback.exitCode, 23, `${shell} fallback exit`);
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '<fallback>\n');
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '');
    }
  });
});

test('PowerShell wrappers cover bypasses, fallback, and one-launch failures under every installed edition', async t => {
  await withFixture(async fixture => {
    const editions = ['pwsh', 'powershell']
      .map(name => ({ name, executable: fixtureExecutable(fixture, name) }))
      .filter(item => item.executable);
    // windows-latest ships both editions; a missing one must fail, not silently shrink coverage.
    if (process.platform === 'win32') assert.deepEqual(editions.map(item => item.name), ['pwsh', 'powershell']);
    if (!editions.length) { t.skip('no PowerShell edition is installed in this environment'); return; }
    for (const edition of editions) {
      const pwsh = edition.executable;
      const profile = path.join(fixture.paths.root, 'synthetic-profile-matrix-' + edition.name + '.ps1');
      fs.writeFileSync(profile, setup.renderRcBlock({
        bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
        retentionDays: 30,
      }, true));
      const quotedProfile = "'" + profile.replace(/'/g, "''") + "'";
      const claudeLog = path.join(setupHome(fixture), 'fake-claude.log');
      const ccxrayLog = path.join(setupHome(fixture), 'fake-ccxray.log');
      const invoke = async (command, env = {}) => runChild(fixture, pwsh, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        '. ' + quotedProfile + '; ' + command + '; exit $LASTEXITCODE',
      ], { env, deadlineMs: 15000 });

      for (const command of ['--version', '--help', '-h', 'mcp', 'doctor', 'agents', 'plugin', 'auth', 'attach', 'respawn']) {
        fs.writeFileSync(claudeLog, '');
        fs.writeFileSync(ccxrayLog, '');
        const result = await invoke(`claude '${command}'`);
        assert.equal(result.exitCode, 0, `${command}: ${result.stdout} ${result.stderr}`);
        assert.equal(fs.readFileSync(claudeLog, 'utf8'), `<${command}>\n`, `${result.stdout} ${result.stderr}`);
        assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '');
      }

      fs.writeFileSync(claudeLog, '');
      fs.writeFileSync(ccxrayLog, '');
      const proxied = await invoke("claude 'two words' 'x;y'");
      assert.equal(proxied.exitCode, 0, proxied.stderr);
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '<claude>\n<two words>\n<x;y>\n');
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '');

      fs.writeFileSync(claudeLog, '');
      fs.writeFileSync(ccxrayLog, '');
      const failedProxy = await invoke('claude request', { CCXRAY_FAKE_EXIT: '17' });
      assert.equal(failedProxy.exitCode, 17);
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '<claude>\n<request>\n');
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '');

      const noCcxrayPath = path.join(fixture.paths.root, 'powershell-path-without-ccxray-' + edition.name);
      const pathWithoutCcxray = makeClaudeOnlyPath(fixture, noCcxrayPath);
      fs.writeFileSync(claudeLog, '');
      fs.writeFileSync(ccxrayLog, '');
      const fallback = await invoke('claude fallback', { PATH: pathWithoutCcxray });
      assert.equal(fallback.exitCode, 0, fallback.stderr);
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '<fallback>\n');
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '');

      fs.writeFileSync(claudeLog, '');
      const failedFallback = await invoke('claude fallback', {
        PATH: pathWithoutCcxray, CCXRAY_FAKE_EXIT: '23',
      });
      assert.equal(failedFallback.exitCode, 23);
      assert.equal(fs.readFileSync(claudeLog, 'utf8'), '<fallback>\n');
      assert.equal(fs.readFileSync(ccxrayLog, 'utf8'), '');
    }
  });
});
