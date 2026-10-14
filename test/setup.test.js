'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const rawOpenSync = fs.openSync.bind(fs);
const rawReadSync = fs.readSync.bind(fs);
const rawCloseSync = fs.closeSync.bind(fs);
const rawStatSync = fs.statSync.bind(fs);

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
const { createSetupFixture, findExecutable } = require('./helpers/setup-fixture');

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
    platform: overrides.platform || process.platform,
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
  try {
    await run(fixture);
  } finally {
    restoreFsGuard();
    fixture.dispose();
  }
}

function setupHome(fixture) {
  return fixture.paths.ccxray;
}

function rcFile(fixture, shell = 'bash') {
  return path.join(shell === 'zsh' ? fixture.paths.zdotdir : fixture.paths.home,
    shell === 'zsh' ? '.zshrc' : '.bashrc');
}

function installArgs(extra = []) {
  return ['--shell', 'bash', '--bucket', 'fixture-bucket-01', '--domains', 'example.test', '--yes', ...extra];
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

test('owned-block conflict scans exempt only the marked claude wrapper', () => {
  const values = {
    bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
    retentionDays: 30,
  };
  const posixBlock = setup.renderRcBlock(values, false);
  const posixText = posixBlock.replace(setup.END_MARKER,
    "alias claude-debug=claude\nexport ANTHROPIC_BASE_URL='https://synthetic.invalid'\n" + setup.END_MARKER);
  const posixOwned = setup.parseRcBlock(posixText, false);
  assert.equal(posixOwned.kind, 'owned');
  const posix = setup.scanConflicts(posixText, false, '/fixture/.bashrc', posixOwned);
  assert.equal(posix.conflicts.length, 2);
  assert.ok(posix.conflicts.some(line => line.includes('alias claude-debug')));
  assert.ok(posix.conflicts.some(line => line.includes('environment ANTHROPIC_BASE_URL')));

  const powershellBlock = setup.renderRcBlock(values, true);
  const powershellText = powershellBlock.replace(setup.END_MARKER,
    "Set-Alias -Name claude-dev claude\n$env:ANTHROPIC_BASE_URL = 'https://synthetic.invalid'\n" + setup.END_MARKER);
  const powershellOwned = setup.parseRcBlock(powershellText, true);
  assert.equal(powershellOwned.kind, 'owned');
  const powershell = setup.scanConflicts(
    powershellText, true, 'C:\\fixture\\profile.ps1', powershellOwned,
  );
  assert.equal(powershell.conflicts.length, 2);
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
    setup.parseArgs(['--shell', 'bash', '--bucket', 'fixture-bucket-03']).options,
    [makeOwned('/fixture/bashrc', 'fixture-bucket-01'), makeOwned('/fixture/pwsh-profile', 'fixture-bucket-02')],
  );
  assert.equal(flagged.resolved.bucket, 'fixture-bucket-03');
  assert.deepEqual(flagged.conflicts, []);

  const inherited = setup.resolveValues(options, [makeOwned('/fixture/bashrc', 'fixture-bucket-01')]);
  assert.equal(inherited.resolved.bucket, 'fixture-bucket-01');
  assert.equal(inherited.resolved.retentionDays, 21);
  const cleared = setup.resolveValues(
    setup.parseArgs(['--shell', 'bash', '--cwd-allowlist', '']).options,
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
    assert.equal(followed.chain[0].kind, 'symlink');

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

test('first install requires explicit bucket and domains and never takes values from ambient env', async () => {
  await withFixture(async fixture => {
    const log = makeLogger();
    let result = await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture, { logger: log }));
    assert.equal(result, 2);
    assert.ok(log.lines.some(line => line.includes('first install needs --bucket')));
    assert.equal(fs.existsSync(exportSync.enrollmentPath(setupHome(fixture))), false);

    const next = makeLogger();
    result = await setup.runSetup(['--shell', 'bash', '--bucket', 'fixture-bucket-01', '--yes'],
      depsFor(fixture, { logger: next }));
    assert.equal(result, 2);
    assert.ok(next.lines.some(line => line.includes('first install needs --domains')));
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
      '--shell', 'bash', '--bucket', 'fixture-bucket-03', '--domains', 'EXAMPLE.TEST',
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

test('a non-TTY install refuses before taking the lock or writing files', async () => {
  await withFixture(async fixture => {
    let locks = 0;
    const exportSyncApi = {
      acquireLock: async () => { locks++; return { handle: {} }; },
    };
    const log = makeLogger();
    const result = await setup.runSetup([
      '--shell', 'bash', '--bucket', 'fixture-bucket-01', '--domains', 'example.test',
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
      ['pwsh', { edition: 'Core', host: 'ConsoleHost', currentHost: 'C:\\Users\\fixture\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1' }],
      ['powershell', { edition: 'Desktop', host: 'Windows PowerShell', currentHost: 'C:\\Users\\fixture\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1' }],
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
      '--shell', 'pwsh', '--bucket', 'fixture-bucket-01', '--domains', 'example.test',
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
    const result = await setup.runSetup(['--shell', 'bash', '--bucket', 'fixture-bucket-01', '--domains', 'example.test'], depsFor(fixture, {
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
    const result = await setup.runSetup(['--shell', 'bash', '--bucket', 'fixture-bucket-01', '--domains', 'example.test'], depsFor(fixture, {
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
      '--shell', 'bash', '--bucket', 'fixture-bucket-01', '--domains', 'example.test',
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
        nestedInstallCode = await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture));
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
    const second = await setup.runSetup(['--shell', 'bash', '--yes'], depsFor(fixture, {
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

test('check reports a shadowing alias loaded from a sourced file as the effective command', async () => {
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

test('owned shell probe reports function loaded from the startup file', async () => {
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

test('a complete frame with an incomplete probe drain is unknown, never ok', async () => {
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

    const bash = findExecutable('bash', fixture.env.PATH);
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
    const bash = findExecutable('bash', fixture.env.PATH);
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

test('PowerShell wrapper preserves argument boundaries when pwsh is installed', async t => {
  await withFixture(async fixture => {
    const pwsh = findExecutable('pwsh', fixture.env.PATH);
    if (!pwsh) { t.skip('pwsh is not installed in this environment'); return; }
    const profile = path.join(fixture.paths.root, 'synthetic-profile.ps1');
    fs.writeFileSync(profile, setup.renderRcBlock({
      bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
      retentionDays: 30,
    }, true));
    const quotedProfile = "'" + profile.replace(/'/g, "''") + "'";
    const result = await runChild(fixture, pwsh, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `. ${quotedProfile}; claude 'two words' 'x;y'`,
    ]);
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(setupHome(fixture), 'fake-ccxray.log'), 'utf8'),
      '<claude>\n<two words>\n<x;y>\n');
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
        '--shell', 'bash', '--bucket', 'fixture-bucket-02', '--domains', 'example.test', '--yes',
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
    const pwsh = findExecutable('pwsh', fixture.env.PATH);
    if (!pwsh) { t.skip('pwsh is not installed in this environment'); return; }
    for (const owned of [true, false]) {
      const definition = owned
        ? 'function global:claude { # ccxray-wrapper-v1\n }\n'
        : 'function global:claude { # local implementation\n }\n';
      const result = await runChild(fixture, pwsh, [
        '-NoLogo', '-NonInteractive', '-EncodedCommand',
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

test('default POSIX runner observes process-group SIGKILL escalation', async () => {
  await withFixture(async fixture => {
    const result = await runChild(fixture, process.execPath, [
      '-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
    ], { deadlineMs: 60, graceMs: 30, drainMs: 30 });
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
      const result = await setup.runSetup(['--check', '--shell', 'bash', '--no-probe'], depsFor(fixture, {
        logger: log, credentials,
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
  } finally {
    restoreFsGuard();
    fixture.dispose();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('POSIX wrappers cover every bypass, missing-ccxray fallback, and one-launch failure behavior', async () => {
  await withFixture(async fixture => {
    const bypasses = ['--version', '--help', '-h', 'mcp', 'doctor', 'agents', 'plugin', 'auth', 'attach', 'respawn'];
    const claudeLog = path.join(setupHome(fixture), 'fake-claude.log');
    const ccxrayLog = path.join(setupHome(fixture), 'fake-ccxray.log');
    for (const shell of ['bash', 'zsh']) {
      const executable = findExecutable(shell, fixture.env.PATH);
      if (!executable) continue;
      const installed = await setup.runSetup([
        '--shell', shell, '--bucket', 'fixture-bucket-01', '--domains', 'example.test', '--yes',
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
      fs.mkdirSync(noCcxrayPath);
      fs.symlinkSync(path.join(fixture.paths.bin, 'claude'), path.join(noCcxrayPath, 'claude'));
      const pathWithoutCcxray = noCcxrayPath;
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

test('PowerShell wrapper covers bypasses, fallback, and one-launch failures when pwsh is installed', async t => {
  await withFixture(async fixture => {
    const pwsh = findExecutable('pwsh', fixture.env.PATH);
    if (!pwsh) { t.skip('pwsh is not installed in this environment'); return; }
    const profile = path.join(fixture.paths.root, 'synthetic-profile-matrix.ps1');
    fs.writeFileSync(profile, setup.renderRcBlock({
      bucket: 'fixture-bucket-01', domains: ['example.test'], prefix: 'summaries',
      retentionDays: 30,
    }, true));
    const quotedProfile = "'" + profile.replace(/'/g, "''") + "'";
    const claudeLog = path.join(setupHome(fixture), 'fake-claude.log');
    const ccxrayLog = path.join(setupHome(fixture), 'fake-ccxray.log');
    const invoke = async (command, env = {}) => runChild(fixture, pwsh, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `. ${quotedProfile}; ${command}; exit $LASTEXITCODE`,
    ], { env });

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

    const noCcxrayPath = path.join(fixture.paths.root, 'powershell-path-without-ccxray');
    fs.mkdirSync(noCcxrayPath);
    fs.symlinkSync(path.join(fixture.paths.bin, 'claude'), path.join(noCcxrayPath, 'claude'));
    const pathWithoutCcxray = noCcxrayPath;
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
  });
});
