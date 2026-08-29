'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

  it('A3: preserves unknown warning codes and raw args on the process line', () => {
    const output = renderProcessStatus({
      exportState: 'enabled',
      exportReason: null,
      configWarnings: [{ code: 'future-warning', args: { rawValue: 'keep-me', count: 2 } }],
      identity: { kind: 'hub', pid: 1, port: 5577, home: '/h', logsDir: '/l' },
    });
    assert.match(output, /future-warning: \{"rawValue":"keep-me","count":2\}/);
  });

  it('C1: keeps export state out of the unauthenticated health route', () => {
    const hubSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'hub.js'), 'utf8');
    const healthStart = hubSource.indexOf("pathname === '/_api/health'");
    const hubRouteStart = hubSource.indexOf('// Phase 2.1: hub IPC moved to Unix socket', healthStart);
    const healthBody = hubSource.slice(healthStart, hubRouteStart);
    assert.doesNotMatch(healthBody, /exportState|exportReason|configWarnings/);
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

  it('D4: an unreported status reads and names only the requested home', () => {
    const a = makeDomain();
    const b = makeDomain();
    try {
      writeIndex(b, ['b-tail']);
      writeCursor(b, 'b-tail');
      const fromA = inspectHomeStatus(null, { env: { CCXRAY_HOME: a.home, LOGS_DIR: a.logsDir } });
      const fromB = inspectHomeStatus(null, { env: { CCXRAY_HOME: b.home, LOGS_DIR: b.logsDir } });
      assert.equal(fromA.state, 'undetermined');
      assert.equal(fromB.state, 'undetermined');
      assert.match(fromA.line, new RegExp(a.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(fromA.line, /b-tail/);
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });
});

describe('ccxray status socket surface', () => {
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
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(readerHome, { recursive: true, force: true });
      fs.rmSync(reportedHome, { recursive: true, force: true });
    }
  });
});
