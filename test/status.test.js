'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  FLUSH_INTERVAL_MS,
  inspectHomeStatus,
  readIndexTailId,
  renderProcessStatus,
} = require('../server/status');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');

function makeDomain() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-domain-'));
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  return { home, logsDir, indexPath: path.join(logsDir, 'index.ndjson') };
}

function reportFor(domain, exportState = 'enabled', exportReason = null) {
  return {
    exportState,
    exportReason,
    configWarnings: [],
    identity: {
      kind: 'hub', pid: 4312, port: 5577,
      home: domain.home, logsDir: domain.logsDir,
    },
  };
}

function writeIndex(domain, ids) {
  fs.writeFileSync(domain.indexPath, ids.map(id => JSON.stringify({ id }) + '\n').join(''));
}

function writeCursor(domain, lastId, partial = false, mtimeMs = null) {
  const cursorPath = path.join(domain.home, 'export-cursor.json');
  fs.writeFileSync(cursorPath, JSON.stringify({ lastId, partial, cutoffDt: '2026-08-29' }) + '\n');
  if (mtimeMs !== null) fs.utimesSync(cursorPath, mtimeMs / 1000, mtimeMs / 1000);
}

function machineJson(stdout) {
  const line = stdout.split('\n').find(value => value.startsWith('Machine: '));
  assert.ok(line, `Machine line missing from:\n${stdout}`);
  return JSON.parse(line.slice('Machine: '.length));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runStatusSync(env) {
  return spawnSync(process.execPath, [SERVER_SCRIPT, 'status'], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runStatus(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER_SCRIPT, 'status'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut: false });
    });
  });
}

function isolatedStatusEnv(home, overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    'ANTHROPIC_BASE_URL', 'CCXRAY_HUB_CLIENT_PID', 'CCXRAY_EXPORT_GCS_BUCKET',
    'CCXRAY_EXPORT_GCS_KEY_FILE', 'CCXRAY_EXPORT_GCS_PREFIX', 'CCXRAY_EXPORT_DOMAINS',
    'CCXRAY_EXPORT_CONFIG_DIRS', 'CCXRAY_EXPORT_CWD_ALLOWLIST', 'CCXRAY_USER_EMAIL',
    'CCXRAY_AGENT_ID', 'CCXRAY_TEAM', 'GOOGLE_APPLICATION_CREDENTIALS',
  ]) delete env[key];
  Object.assign(env, {
    HOME: home,
    CCXRAY_HOME: home,
    LOGS_DIR: path.join(home, 'logs'),
    CLOUDSDK_CONFIG: path.join(home, 'gcloud'),
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    PROXY_PORT: '1',
    ...overrides,
  });
  fs.mkdirSync(env.LOGS_DIR, { recursive: true });
  fs.mkdirSync(env.CLOUDSDK_CONFIG, { recursive: true });
  const indexPath = path.join(env.LOGS_DIR, 'index.ndjson');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '');
  return env;
}

function configHashForStatusEnv(env) {
  const modulePath = path.resolve(__dirname, '..', 'server', 'export-sync.js');
  const script = `process.stdout.write(require(${JSON.stringify(modulePath)}).exportConfigHash(process.env));`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeStatusHubLock(home, { pid = process.pid, port, sockPath }) {
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({
    pid, port, version: 'fixture', ...(sockPath ? { sockPath } : {}),
  }));
}

describe('ccxray status process level', () => {
  it('D1: iterates every exportState/reason surface value explicitly', () => {
    const rows = [
      ['unconfigured', null],
      ['suppressed', 'explicitly-disabled'],
      ['suppressed', 'test-run'],
      ['refused', 'config-dirs-retired'],
      ['enabled', null],
    ];
    const outputs = rows.map(([exportState, exportReason]) => renderProcessStatus({
      exportState,
      exportReason,
      configWarnings: [],
      identity: { kind: 'hub', pid: 1, port: 5577, home: '/h', logsDir: '/l' },
    }));

    assert.equal(outputs.length, 5);
    for (const [index, [exportState, exportReason]] of rows.entries()) {
      assert.match(outputs[index], new RegExp(`Process: exportState=${exportState}`));
      if (exportReason) assert.match(outputs[index], new RegExp(`exportReason=${exportReason}`));
    }
    assert.match(outputs[0], /exportState=unconfigured/, 'unconfigured must be stated, not silently omitted');
  });

  it('renders only the optional short config hash from a hub report', () => {
    const fullHash = 'b'.repeat(64);
    const output = renderProcessStatus({
      exportState: 'enabled',
      exportReason: null,
      configWarnings: [],
      exportConfigHash: fullHash,
      identity: { kind: 'hub', pid: 1, port: 5990, home: '/h', logsDir: '/l' },
    });
    assert.match(output, /hash=bbbbbbbbbbbb/);
    assert.doesNotMatch(output, new RegExp(fullHash));
  });

  it('D1c: renders the #633 credential stages when reported and omits them when the report predates them', () => {
    const identity = { kind: 'hub', pid: 1, port: 5577, home: '/h', logsDir: '/l' };
    const withCredential = renderProcessStatus({
      exportState: 'enabled',
      exportReason: null,
      configWarnings: [],
      credential: {
        discovery: { state: 'adc', source: '%APPDATA%\\gcloud', pathLabel: '%APPDATA%\\gcloud/application_default_credentials.json' },
        parse: { state: 'ok', type: 'authorized_user' },
        token: { state: 'not-attempted' },
        authorization: { state: 'unknown' },
        ignoredEnv: ['GOOGLE_APPLICATION_CREDENTIALS'],
      },
      identity,
    });
    assert.match(withCredential,
      /credential=discovery:adc at:%APPDATA%\\gcloud\/application_default_credentials\.json parse:ok\(authorized_user\) ignored:GOOGLE_APPLICATION_CREDENTIALS/);
    assert.doesNotMatch(withCredential, /token:/, 'an unexercised token stage must not be rendered as a verdict');
    // Field order: credential sits between configWarnings and identity.
    assert.ok(withCredential.indexOf('credential=') < withCredential.indexOf('identity='));

    const legacy = renderProcessStatus({ exportState: 'enabled', exportReason: null, configWarnings: [], identity });
    assert.doesNotMatch(legacy, /credential/);
    const nullCredential = renderProcessStatus({ exportState: 'suppressed', exportReason: 'test-run', configWarnings: [], credential: null, identity });
    assert.doesNotMatch(nullCredential, /credential/);
  });

  it('A3: preserves unknown warning codes and raw args on the process line', () => {
    const output = renderProcessStatus({
      exportState: 'enabled',
      exportReason: null,
      configWarnings: [{ code: 'future-warning', args: { rawValue: 'keep-me', count: 2 } }],
      identity: { kind: 'hub', pid: 1, port: 5577, home: '/h', logsDir: '/l' },
    });
    assert.match(output, /future-warning: \{"rawValue":"keep-me","count":2\}/);
  });

  it('C1: gates the optional health report with dashboard authentication', () => {
    const hubSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'hub.js'), 'utf8');
    const healthStart = hubSource.indexOf("pathname === '/_api/health'");
    const hubRouteStart = hubSource.indexOf('// Phase 2.1: hub IPC moved to Unix socket', healthStart);
    const healthBody = hubSource.slice(healthStart, hubRouteStart);
    assert.match(healthBody, /isDashboardAuthenticated\(clientReq\)/);
    assert.match(healthBody, /reportTrusted \? assembleExportReport\(\) : \{\}/);
    assert.match(healthBody, /exportReportUnavailableReason: 'authentication-required'/);
  });
});

describe('ccxray status home level', () => {
  it('D2: iterates cursor-unreadable, no-index, never-flushed, current/partial, and both behind states', () => {
    const now = Date.now();
    const rows = [
      {
        name: 'cursor-unreadable',
        setup: domain => {
          fs.writeFileSync(path.join(domain.home, 'export-cursor.json'), '{torn cursor\n');
          writeIndex(domain, ['tail']);
        },
        expected: 'cursor-unreadable',
      },
      {
        name: 'no-index',
        setup: domain => writeCursor(domain, 'tail'),
        expected: 'no-index',
      },
      {
        name: 'never-flushed',
        setup: domain => writeIndex(domain, ['tail']),
        expected: 'never-flushed',
      },
      {
        name: 'current',
        setup: domain => {
          writeIndex(domain, ['tail']);
          writeCursor(domain, 'tail');
        },
        expected: 'current',
      },
      {
        name: 'current partial',
        setup: domain => {
          writeIndex(domain, ['tail']);
          writeCursor(domain, 'tail', true);
        },
        expected: 'current (partial)',
      },
      {
        name: 'behind-pending',
        setup: domain => {
          writeIndex(domain, ['old', 'tail']);
          writeCursor(domain, 'old', false, now - FLUSH_INTERVAL_MS);
        },
        expected: 'behind-pending',
      },
      {
        name: 'behind-overdue',
        setup: domain => {
          writeIndex(domain, ['old', 'tail']);
          writeCursor(domain, 'old', false, now - (2 * FLUSH_INTERVAL_MS) - 1);
        },
        expected: 'behind-overdue',
      },
    ];

    for (const row of rows) {
      const domain = makeDomain();
      try {
        row.setup(domain);
        const result = inspectHomeStatus(reportFor(domain), { nowMs: now });
        assert.equal(result.state, row.expected, row.name);
        assert.match(result.line, /read cursor .*export-cursor\.json/);
        assert.match(result.line, /index .*index\.ndjson/);
        if (row.name === 'current partial') assert.match(result.line, /partial/);
        if (row.name === 'behind-overdue') {
          assert.match(result.line, /conditional/);
          assert.match(result.line, /re-check in 1h/);
          assert.match(result.line, /may be failing/);
        }
      } finally {
        fs.rmSync(domain.home, { recursive: true, force: true });
      }
    }
  });

  it('D2b: iterates every never-flushed process-state branch, including unknown', () => {
    const rows = [
      {
        name: 'unconfigured',
        state: 'unconfigured',
        reason: null,
        detail: 'never-flushed — expected: exporter is unconfigured',
      },
      {
        name: 'suppressed with reason',
        state: 'suppressed',
        reason: 'explicitly-disabled',
        detail: 'never-flushed — expected: exporter is suppressed (explicitly-disabled)',
      },
      {
        name: 'suppressed without reason',
        state: 'suppressed',
        reason: null,
        detail: 'never-flushed — expected: exporter is suppressed',
      },
      {
        name: 'refused',
        state: 'refused',
        reason: 'config-dirs-retired',
        detail: 'never-flushed — exporter refusal (config-dirs-retired) corroborates the process state',
      },
      {
        name: 'enabled',
        state: 'enabled',
        reason: null,
        detail: 'never-flushed — alarm: enabled exporter has not completed a flush',
      },
      {
        name: 'unknown',
        state: null,
        reason: null,
        detail: 'never flushed; no exporter process reachable — cannot tell whether export is configured for this home',
      },
    ];

    for (const row of rows) {
      const domain = makeDomain();
      try {
        writeIndex(domain, ['tail']);
        const result = inspectHomeStatus(reportFor(domain, row.state, row.reason), { nowMs: Date.now() });
        assert.equal(result.state, 'never-flushed', row.name);
        assert.ok(result.line.includes(row.detail),
          `${row.name}: expected line to include ${row.detail}; actual: ${result.line}`);
      } finally {
        fs.rmSync(domain.home, { recursive: true, force: true });
      }
    }
  });

  it('B4: reads only a bounded tail, widens once, and never guesses past a torn final line', () => {
    const domain = makeDomain();
    try {
      fs.writeFileSync(domain.indexPath, `${'x'.repeat(200)}\n${JSON.stringify({ id: 'tail' })}\n`);
      assert.deepEqual(readIndexTailId(domain.indexPath, { maxBytes: 16 }), { kind: 'tail', id: 'tail' });

      fs.appendFileSync(domain.indexPath, '{"id":"torn"');
      assert.deepEqual(readIndexTailId(domain.indexPath, { maxBytes: 16 }), { kind: 'unreadable' });
    } finally {
      fs.rmSync(domain.home, { recursive: true, force: true });
    }
  });

  it('D3: keeps a refused process report distinct from a fresh same-home cursor', () => {
    const domain = makeDomain();
    try {
      writeIndex(domain, ['tail']);
      writeCursor(domain, 'tail');
      const report = reportFor(domain, 'refused', 'config-dirs-retired');
      const processLine = renderProcessStatus(report);
      const homeLine = inspectHomeStatus(report).line;
      assert.match(processLine, /Process: exportState=refused/);
      assert.match(homeLine, /Home: .*current/);
      assert.doesNotMatch(homeLine, /refused/);
      assert.doesNotMatch(processLine, /current/);
    } finally {
      fs.rmSync(domain.home, { recursive: true, force: true });
    }
  });

  it('D4: an unreported status reports the read cursor fact without comparing it to the index', () => {
    const now = Date.now();
    const rows = [
      {
        name: 'cursor absent',
        setup: domain => writeIndex(domain, ['index-tail']),
        assertLine: line => {
          assert.match(line, /cursor absent/);
          assert.match(line, /never flushed/);
        },
        neverFlushed: true,
      },
      {
        name: 'cursor present',
        setup: domain => {
          writeIndex(domain, ['index-tail']);
          writeCursor(domain, 'real-id', false, now - (3 * FLUSH_INTERVAL_MS));
        },
        assertLine: line => {
          assert.match(line, /cursor present/);
          assert.match(line, /lastId=real-id/);
          assert.match(line, /cursor age 3h/);
        },
        neverFlushed: false,
      },
      {
        name: 'cursor present partial',
        setup: domain => {
          writeIndex(domain, ['index-tail']);
          writeCursor(domain, 'partial-id', true, now - (2 * FLUSH_INTERVAL_MS));
        },
        assertLine: line => {
          assert.match(line, /cursor present \(partial\)/);
          assert.match(line, /lastId=partial-id/);
          assert.match(line, /cursor age 2h/);
          assert.match(line, /partial/);
        },
        neverFlushed: false,
      },
      {
        name: 'cursor unreadable',
        setup: domain => {
          writeIndex(domain, ['index-tail']);
          fs.writeFileSync(path.join(domain.home, 'export-cursor.json'), '{torn cursor\n');
        },
        assertLine: line => assert.match(line, /cursor unreadable/),
        neverFlushed: false,
      },
    ];

    for (const row of rows) {
      const domain = makeDomain();
      try {
        row.setup(domain);
        const result = inspectHomeStatus(null, {
          env: { CCXRAY_HOME: domain.home, LOGS_DIR: domain.logsDir },
          nowMs: now,
        });
        assert.equal(result.state, 'undetermined', row.name);
        assert.equal(/never flushed/.test(result.line), row.neverFlushed, row.name);
        row.assertLine(result.line);
        assert.match(result.line, new RegExp(domain.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(result.line, /read cursor .*export-cursor\.json/);
        assert.match(result.line, /index .*index\.ndjson/);
      } finally {
        fs.rmSync(domain.home, { recursive: true, force: true });
      }
    }

    const a = makeDomain();
    const b = makeDomain();
    try {
      writeIndex(b, ['b-tail']);
      writeCursor(b, 'b-tail');
      const fromA = inspectHomeStatus(null, { env: { CCXRAY_HOME: a.home, LOGS_DIR: a.logsDir } });
      const fromB = inspectHomeStatus(null, { env: { CCXRAY_HOME: b.home, LOGS_DIR: b.logsDir } });
      assert.equal(fromA.state, 'undetermined');
      assert.equal(fromB.state, 'undetermined');
      assert.doesNotMatch(fromA.line, /b-tail/);
      assert.doesNotMatch(fromA.line, new RegExp(b.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(fromB.line, new RegExp(b.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(fromB.line, new RegExp(a.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      fs.rmSync(a.home, { recursive: true, force: true });
      fs.rmSync(b.home, { recursive: true, force: true });
    }
  });

  it('D5: with no discoverable hub, status says unavailable and does not infer local export configuration', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-no-hub-'));
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-no-hub-other-'));
    try {
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), JSON.stringify({ id: 'local-tail' }) + '\n');
      fs.writeFileSync(path.join(home, 'export-cursor.json'), JSON.stringify({ lastId: 'local-tail' }) + '\n');
      const result = runStatusSync({
        ...process.env,
        HOME: otherHome,
        CCXRAY_HOME: home,
        LOGS_DIR: path.join(home, 'logs'),
        CCXRAY_EXPORT_GCS_BUCKET: 'must-not-be-inspected-as-process-state',
        PROXY_PORT: '1',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Process: exporter state unavailable/);
      assert.match(result.stdout, /cannot tell whether export is configured/);
      assert.doesNotMatch(result.stdout, /never[- ]flushed/,
        'unreachable process state must not fabricate a never-flushed claim');
      assert.doesNotMatch(result.stdout, /exportState=enabled/);
      assert.match(result.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(result.stdout, /^Shell: .*hash=[a-f0-9]{64} — this shell's environment/m);
      assert.match(result.stdout, /^Config: unknown — no reachable exporter$/m);
      assert.match(result.stdout, /^Durable: .* \(from this shell — no exporter named a home\)/m);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it('D5b: durable removal stays visible when the last attempt is an older success', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-removed-'));
    try {
      fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
      fs.writeFileSync(path.join(home, 'export-enrollment.json'), JSON.stringify({
        state: 'removed', enrolledAt: '2026-10-01T00:00:00.000Z', retentionDays: 30,
      }));
      fs.writeFileSync(path.join(home, 'export-last.json'), JSON.stringify({
        attemptedAt: '2026-10-01T00:00:00.000Z', outcome: 'exported',
        lastSuccessAt: '2026-10-01T00:00:00.000Z', files: 1, rows: 2,
      }));
      const result = runStatusSync({
        ...process.env,
        CCXRAY_HOME: home,
        LOGS_DIR: path.join(home, 'logs'),
        CCXRAY_EXPORT_DISABLE: '1',
        CCXRAY_EXPORT_GCS_BUCKET: undefined,
        CCXRAY_EXPORT_GCS_KEY_FILE: undefined,
        CLOUDSDK_CONFIG: path.join(home, 'empty-gcloud'),
        PROXY_PORT: '1',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Durable: .*enrollment=removed .*outcome=exported/m);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('ccxray status socket surface', () => {
  it('D7: actual status compares hub hashes and reads diagnostics from hub-named storage', async () => {
    const readerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-hash-reader-'));
    const reportedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-hash-hub-'));
    const logsDir = path.join(reportedHome, 'reported-logs');
    const socketPath = path.join(readerHome, 'status.sock');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'index.ndjson'), '');
    fs.writeFileSync(path.join(reportedHome, 'export-enrollment.json'), JSON.stringify({
      state: 'enrolled', enrolledAt: '2026-10-01T00:00:00.000Z', retentionDays: 30,
    }));

    let currentReport;
    const server = net.createServer(socket => {
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = JSON.parse(input);
        const payload = request.cmd === 'health' ? { ok: true } : currentReport;
        socket.end(JSON.stringify(payload) + '\n');
      });
    });

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });

      const shellEnv = isolatedStatusEnv(readerHome, { CCXRAY_EXPORT_GCS_BUCKET: 'shell-bucket' });
      const equalHubHash = configHashForStatusEnv(shellEnv);
      const differentHubEnv = { ...shellEnv, CCXRAY_EXPORT_GCS_BUCKET: 'hub-bucket' };
      const differentHubHash = configHashForStatusEnv(differentHubEnv);
      assert.notEqual(equalHubHash, differentHubHash);

      for (const scenario of [
        { hash: equalHubHash, line: 'Config: equal' },
        { hash: differentHubHash, line: 'Config: DIFFERS — close every ccxray session and start again' },
      ]) {
        currentReport = {
          app: 'ccxray', port: 5997, pid: 4312, version: '2.3.1', uptime: 9,
          exportState: 'suppressed', exportReason: 'explicitly-disabled',
          exportConfigHash: scenario.hash,
          identity: { kind: 'hub', pid: 4312, port: 5997, home: reportedHome, logsDir },
          clients: [],
        };
        writeStatusHubLock(readerHome, { port: 5997, sockPath: socketPath });
        const result = await runStatus(shellEnv);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.split(/\r?\n/).includes(scenario.line), result.stdout);
        assert.match(result.stdout, new RegExp(`^Durable: ${escapeRegExp(reportedHome)} \\(named by hub\\) — enrollment=enrolled`, 'm'));
        assert.doesNotMatch(result.stdout, new RegExp(`^Durable: ${escapeRegExp(readerHome)}`, 'm'));
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(readerHome, { recursive: true, force: true });
      fs.rmSync(reportedHome, { recursive: true, force: true });
    }
  });

  it('D8: dead-lockfile and unresponsive status branches exit 1 and still print diagnostics', async () => {
    const deadHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-dead-home-'));
    try {
      const env = isolatedStatusEnv(deadHome);
      writeStatusHubLock(deadHome, { pid: 2_147_000_000, port: 5998 });
      const result = runStatusSync(env);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /Hub lockfile exists but process is dead/);
      assert.match(result.stdout, /^Config: unknown — no reachable exporter$/m);
      assert.match(result.stdout, new RegExp(`^Durable: ${escapeRegExp(deadHome)} \\(from this shell`, 'm'));
      assert.equal(fs.existsSync(path.join(deadHome, 'hub.json')), false);
    } finally {
      fs.rmSync(deadHome, { recursive: true, force: true });
    }

    for (const transport of ['socket', 'http']) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `ccxray-status-${transport}-unresponsive-`));
      let server;
      let socketPath;
      try {
        const env = isolatedStatusEnv(home);
        let port;
        if (transport === 'socket') {
          socketPath = path.join(home, 'unresponsive.sock');
          server = net.createServer(socket => {
            let input = '';
            socket.on('data', chunk => {
              input += chunk;
              if (!input.includes('\n')) return;
              const request = JSON.parse(input);
              if (request.cmd === 'health') socket.end('{"ok":false}\n');
            });
          });
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, resolve);
          });
          port = 5999;
        } else {
          server = http.createServer((req, res) => res.end('{"ok":false}'));
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          port = server.address().port;
        }

        writeStatusHubLock(home, { port, sockPath: socketPath });
        const result = await runStatus(env);
        assert.equal(result.status, 1, result.stderr);
        if (transport === 'socket') {
          assert.match(result.stdout, new RegExp(`^Hub pid ${process.pid} alive but socket not responding\\.$`, 'm'));
        } else {
          assert.match(result.stdout, new RegExp(`^Hub pid ${process.pid} alive but not responding on port ${port}\\.$`, 'm'));
        }
        assert.ok(result.stdout.split(/\r?\n/).includes(`Check ${path.join(home, 'hub.log')}`), result.stdout);
        assert.match(result.stdout, /^Config: unknown — no reachable exporter$/m);
        assert.match(result.stdout, new RegExp(`^Durable: ${escapeRegExp(home)} \\(from this shell`, 'm'));
      } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('D9: preserves 62fcf05 wording for silent HTTP health timeout', async () => {
    const httpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-silent-health-'));
    const silentServer = http.createServer(() => {});
    try {
      const env = isolatedStatusEnv(httpHome);
      await new Promise((resolve, reject) => {
        silentServer.once('error', reject);
        silentServer.listen(0, '127.0.0.1', resolve);
      });
      const port = silentServer.address().port;
      writeStatusHubLock(httpHome, { port });

      const result = await runStatus(env);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stdout.split(/\r?\n/).includes(
        `Hub pid ${process.pid} alive but not responding on port ${port}.`,
      ), result.stdout);
      assert.ok(result.stdout.split(/\r?\n/).includes(`Check ${path.join(httpHome, 'hub.log')}`), result.stdout);
      assert.ok(result.stdout.indexOf(`Check ${path.join(httpHome, 'hub.log')}`)
        < result.stdout.indexOf('Shell: '), 'diagnostics must follow the legacy status messages');
    } finally {
      if (silentServer.listening) await new Promise(resolve => silentServer.close(resolve));
      fs.rmSync(httpHome, { recursive: true, force: true });
    }
  });

  it('D10: preserves the original socket refusal message and path from 62fcf05', async () => {
    const socketHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-socket-refusal-'));
    let listener;
    try {
      const env = isolatedStatusEnv(socketHome);
      const sockPath = path.join(socketHome, 'refused.sock');
      listener = spawn(process.execPath, ['-e',
        "const net = require('node:net'); net.createServer().listen(process.env.SOCK_PATH, () => process.stdout.write('ready'));",
      ], { env: { ...env, SOCK_PATH: sockPath }, stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.stdout.once('data', resolve);
      });
      listener.kill('SIGKILL');
      await new Promise(resolve => listener.once('exit', resolve));
      assert.equal(fs.existsSync(sockPath), true, 'the closed socket inode must remain for ECONNREFUSED');
      writeStatusHubLock(socketHome, { port: 5999, sockPath });
      const result = await runStatus(env);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.split(/\r?\n/).includes(
        `Failed to query hub: connect ECONNREFUSED ${sockPath}`,
      ), result.stderr);
      assert.match(result.stdout, /^Shell: /m, 'new diagnostics must still be appended');
      assert.ok(result.stdout.indexOf('Home: ') < result.stdout.indexOf('Shell: '),
        'diagnostics must follow the legacy status messages');
    } finally {
      if (listener && listener.exitCode === null && listener.signalCode === null) listener.kill('SIGKILL');
      fs.rmSync(socketHome, { recursive: true, force: true });
    }
  });

  it('D6: parses Machine JSON and includes the reporting pid', async t => {
    const readerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-reader-'));
    const reportedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-reported-'));
    const logsDir = path.join(reportedHome, 'separate-logs');
    const socketPath = path.join(reportedHome, 'status.sock');
    const lockPath = path.join(readerHome, 'hub.json');
    const server = net.createServer(socket => {
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = JSON.parse(input);
        const payload = request.cmd === 'health'
          ? { ok: true }
          : {
            app: 'ccxray', port: 5997, pid: 4312, version: '2.3.1', uptime: 9,
            exportState: 'enabled', exportReason: null, configWarnings: [],
            identity: { kind: 'hub', pid: 4312, port: 5997, home: reportedHome, logsDir },
            clients: [],
          };
        socket.end(JSON.stringify(payload) + '\n');
      });
    });

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
    } catch (err) {
      server.close();
      fs.rmSync(readerHome, { recursive: true, force: true });
      fs.rmSync(reportedHome, { recursive: true, force: true });
      if (err.code === 'EPERM') {
        t.skip('blocked by sandbox, not verified here');
        return;
      }
      throw err;
    }

    try {
      fs.mkdirSync(logsDir, { recursive: true });
      writeIndex({ indexPath: path.join(logsDir, 'index.ndjson') }, ['reported-tail']);
      writeCursor({ home: reportedHome }, 'reported-tail');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: 5997, sockPath: socketPath }));

      const result = await runStatus({
        ...process.env,
        HOME: readerHome,
        CCXRAY_HOME: readerHome,
        PROXY_PORT: '1',
      });
      assert.equal(result.status, 0, result.stderr);
      const machine = machineJson(result.stdout);
      assert.equal(machine.pid, 4312);
      assert.match(result.stdout, /Process: exportState=enabled/);
      assert.match(result.stdout, new RegExp(reportedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(result.stdout, /Home: .*current/);
      assert.doesNotMatch(result.stdout, /exporter state unavailable/);
      assert.match(result.stdout, /^Config: unknown — no reachable exporter$/m,
        'an older hub report without a hash must stay unknown');
      assert.match(result.stdout, new RegExp(`^Durable: .*${reportedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(named by hub\\)`, 'm'));
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(readerHome, { recursive: true, force: true });
      fs.rmSync(reportedHome, { recursive: true, force: true });
    }
  });
});
