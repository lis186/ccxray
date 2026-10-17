'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pinExportLockPort } = require('./helpers/export-lock-fixture');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-export-diagnostics-'));
const MODULE_HOME = path.join(ROOT, 'module-home');
const MODULE_LOGS = path.join(MODULE_HOME, 'logs');
const CLOUDSDK_CONFIG = path.join(ROOT, 'gcloud');
const ENV_KEYS = [
  'CCXRAY_HOME', 'LOGS_DIR', 'CLOUDSDK_CONFIG', 'CCXRAY_EXPORT_GCS_KEY_FILE',
  'CCXRAY_EXPORT_DISABLE', 'NODE_TEST_CONTEXT', 'CCXRAY_EXPORT_GCS_BUCKET',
  'CCXRAY_EXPORT_GCS_PREFIX', 'CCXRAY_EXPORT_DOMAINS', 'CCXRAY_EXPORT_CONFIG_DIRS',
  'CCXRAY_EXPORT_CWD_ALLOWLIST', 'CCXRAY_USER_EMAIL', 'CCXRAY_AGENT_ID',
  'CCXRAY_TEAM', 'LOG_RETENTION_DAYS', 'CCXRAY_IMPORT_DISABLE',
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
fs.mkdirSync(MODULE_LOGS, { recursive: true });
fs.mkdirSync(CLOUDSDK_CONFIG, { recursive: true });
fs.writeFileSync(path.join(MODULE_LOGS, 'index.ndjson'), '');
for (const key of ENV_KEYS) delete process.env[key];
Object.assign(process.env, {
  CCXRAY_HOME: MODULE_HOME,
  LOGS_DIR: MODULE_LOGS,
  CLOUDSDK_CONFIG,
  CCXRAY_EXPORT_DISABLE: '1',
  CCXRAY_IMPORT_DISABLE: '1',
});
delete process.env.CCXRAY_EXPORT_GCS_KEY_FILE;

const exportSync = require('../server/export-sync');
const hub = require('../server/hub');
const { exportConfigHash } = exportSync;
const {
  collectExportDiagnostics,
  fetchHubReport,
  renderExportDiagnostics,
} = require('../server/export-diagnostics');

function domain(label) {
  const home = path.join(ROOT, label);
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), '');
  return { home, logsDir };
}

function reportFor(paths, env = {}) {
  return {
    app: 'ccxray',
    pid: process.pid,
    port: 5610,
    version: 'fixture',
    exportState: 'suppressed',
    exportReason: 'explicitly-disabled',
    exportConfigHash: exportConfigHash(env),
    identity: { kind: 'hub', pid: process.pid, port: 5610, home: paths.home, logsDir: paths.logsDir },
    clients: [],
  };
}

function fixtureEnv(paths, overrides = {}) {
  return {
    CCXRAY_HOME: paths.home,
    LOGS_DIR: paths.logsDir,
    CLOUDSDK_CONFIG,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_EXPORT_GCS_BUCKET: undefined,
    CCXRAY_EXPORT_GCS_PREFIX: undefined,
    CCXRAY_EXPORT_DOMAINS: undefined,
    CCXRAY_EXPORT_CONFIG_DIRS: undefined,
    CCXRAY_EXPORT_CWD_ALLOWLIST: undefined,
    CCXRAY_USER_EMAIL: undefined,
    CCXRAY_AGENT_ID: undefined,
    CCXRAY_TEAM: undefined,
    CCXRAY_EXPORT_GCS_KEY_FILE: undefined,
    ...overrides,
  };
}

function writeRecord(file, record) {
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
}

function assertOtherDiagnostics(result, label) {
  const paths = domain(`independent-${label}`);
  const diagnostics = collectExportDiagnostics({
    env: fixtureEnv(paths), report: null, reportReason: result.reason,
  });
  assert.ok(diagnostics.invokingShell.exportConfigHash);
  assert.equal(diagnostics.runningExporter.state, 'unknown');
  assert.equal(diagnostics.configMatch, 'unknown');
  assert.equal(diagnostics.durableHome.home, paths.home);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for fixture handles to close');
}

function httpConnectionCount(server) {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) => error ? reject(error) : resolve(count));
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function runHttpDeadlineScenario(target, mode) {
  const activeResponses = new Set();
  const timers = new Set();
  const server = http.createServer((req, res) => {
    activeResponses.add(res);
    res.on('error', () => {});
    res.on('close', () => {
      activeResponses.delete(res);
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    });
    const isHealth = req.url === '/_api/health';
    const isTarget = target === 'health' ? isHealth : req.url === '/_api/hub/status';
    if (isTarget && mode === 'silent') return;
    if (isTarget && mode === 'stream') {
      const timer = setInterval(() => res.write(Buffer.alloc(256, 120)), 5);
      timers.add(timer);
      return;
    }
    if (isHealth) {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.end(JSON.stringify({
      app: 'ccxray', pid: process.pid, port: server.address().port,
      version: 'fixture', exportState: 'suppressed', clients: [],
    }));
  });
  const port = await listen(server);
  hub.writeHubLock(port, process.pid, 'fixture');
  try {
    const started = Date.now();
    const result = await fetchHubReport({ timeoutMs: 120 });
    assert.equal(result.kind, 'unresponsive', `${target}/${mode} HTTP query`);
    assert.ok(Date.now() - started < 1000, 'the query must obey its overall deadline');
    await waitFor(() => activeResponses.size === 0);
    const diagnostics = collectExportDiagnostics({
      env: fixtureEnv(domain(`after-http-${target}-${mode}`)),
      report: null,
      reportReason: result.reason,
    });
    assert.equal(diagnostics.configMatch, 'unknown');
    assert.equal(diagnostics.invokingShell.exportState, 'suppressed');
  } finally {
    for (const timer of timers) clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    hub.deleteHubLock();
  }
}

async function runSocketDeadlineScenario(target, mode) {
  const socketPath = path.join(ROOT, `socket-${target}-${mode}-${process.pid}.sock`);
  const sockets = new Set();
  const timers = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    });
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      const isTarget = target === 'health' ? message.cmd === 'health' : message.cmd === 'status';
      if (isTarget && mode === 'silent') return;
      if (isTarget && mode === 'stream') {
        const timer = setInterval(() => socket.write(Buffer.alloc(256, 120)), 5);
        timers.add(timer);
        return;
      }
      const response = message.cmd === 'health'
        ? { ok: true }
        : { app: 'ccxray', pid: process.pid, port: 5610, version: 'fixture', exportState: 'suppressed', clients: [] };
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  hub.writeHubLock(5610, process.pid, 'fixture', socketPath);
  try {
    const started = Date.now();
    const result = await fetchHubReport({ timeoutMs: 120 });
    assert.equal(result.kind, 'unresponsive', `${target}/${mode} socket query`);
    assert.ok(Date.now() - started < 1000, 'the query must obey its overall deadline');
    await waitFor(() => sockets.size === 0);
    const diagnostics = collectExportDiagnostics({
      env: fixtureEnv(domain(`after-socket-${target}-${mode}`)),
      report: null,
      reportReason: result.reason,
    });
    assert.equal(diagnostics.configMatch, 'unknown');
    assert.equal(diagnostics.runningExporter.state, 'unknown');
  } finally {
    for (const timer of timers) clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    try { fs.unlinkSync(socketPath); } catch {}
    hub.deleteHubLock();
  }
}

describe('export diagnostics reader', () => {
  it('uses the hub-named home and logs directory and compares shell config hashes', () => {
    const shell = domain('shell-home');
    const named = domain('hub-named-home');
    const shellEnv = fixtureEnv(shell, { CCXRAY_EXPORT_GCS_BUCKET: 'shell-bucket' });
    const hubEnv = fixtureEnv(named, { CCXRAY_EXPORT_GCS_BUCKET: 'hub-bucket' });
    const diagnostics = collectExportDiagnostics({ env: shellEnv, report: reportFor(named, hubEnv) });
    assert.equal(diagnostics.configMatch, 'differs');
    assert.equal(diagnostics.durableHome.home, named.home);
    assert.equal(diagnostics.durableHome.logsDir, named.logsDir);
    assert.equal(diagnostics.durableHome.named, true);
    assert.equal(diagnostics.durableHome.provenance, 'named by hub');
    assert.equal(diagnostics.runningExporter.exportConfigHash, exportConfigHash(hubEnv));
    assert.equal(diagnostics.invokingShell.provenance, "this shell's environment — not what the running exporter uses");

    const equal = collectExportDiagnostics({ env: shellEnv, report: reportFor(named, shellEnv) });
    assert.equal(equal.configMatch, 'equal');
    assert.equal(collectExportDiagnostics({ env: shellEnv }).configMatch, 'unknown');
  });

  it('preserves removed and invalid enrollment facts and isolates unreadable last-attempt state', () => {
    const paths = domain('durable-shapes');
    const oldSuccess = {
      attemptedAt: '2026-10-01T00:00:00.000Z', outcome: 'exported', lastSuccessAt: '2026-10-01T00:00:00.000Z',
      phase: 'interval', exportConfigHash: 'a'.repeat(64), stage: null, category: null,
      files: 1, rows: 2, eligibleTurns: 1, excludedTurns: { noAccount: 0, domainMismatch: 0 }, candidateEmails: 1,
    };
    writeRecord(path.join(paths.home, 'export-enrollment.json'), {
      state: 'removed', enrolledAt: '2026-10-02T00:00:00.000Z', retentionDays: 30,
    });
    writeRecord(path.join(paths.home, 'export-last.json'), oldSuccess);
    const report = reportFor(paths);
    const removed = collectExportDiagnostics({ env: fixtureEnv(paths), report });
    const removedLines = renderExportDiagnostics(removed);
    assert.match(removedLines[2], /enrollment=removed/);
    assert.match(removedLines[2], /outcome=exported/);
    assert.match(removedLines[2], /eligible=1 excluded=no-account:0,domain-mismatch:0 candidates=1/);

    fs.writeFileSync(path.join(paths.home, 'export-enrollment.json'), '{broken');
    fs.rmSync(path.join(paths.home, 'export-last.json'));
    fs.mkdirSync(path.join(paths.home, 'export-last.json'));
    writeRecord(path.join(paths.home, 'export-cursor.json'), { lastId: 'synthetic-id', partial: false, cutoffDt: '2026-10-01' });
    const invalid = collectExportDiagnostics({ env: fixtureEnv(paths), report });
    const lines = renderExportDiagnostics(invalid);
    assert.match(lines[2], /enrollment=invalid \(parse:/);
    assert.match(lines[2], /last attempt unreadable\(EISDIR\)/);
    assert.match(lines[2], /cursor lastId=synthetic-id/);
    assert.equal(invalid.durableHome.enrollment.state, 'invalid');
    assert.equal(invalid.durableHome.enrollment.reason, 'parse');
  });

  it('renders absent enrollment when only a stale removed attempt remains', () => {
    const paths = domain('absent-enrollment-stale-removed-attempt');
    writeRecord(path.join(paths.home, 'export-last.json'), {
      attemptedAt: '2026-10-01T00:00:00.000Z', outcome: 'removed',
      lastSuccessAt: '2026-09-30T00:00:00.000Z', files: 0, rows: 0,
    });

    const diagnostics = collectExportDiagnostics({ env: fixtureEnv(paths), report: reportFor(paths) });
    assert.equal(diagnostics.durableHome.enrollment, 'absent');
    const lines = renderExportDiagnostics(diagnostics);
    assert.match(lines[2], /enrollment=absent/);
    assert.match(lines[2], /last attempt .*outcome=removed/);
    assert.match(lines[2], /eligible=unknown excluded=no-account:unknown,domain-mismatch:unknown candidates=unknown/);
  });

  it('prints field-local unreadable codes and still renders the remaining durable facts', () => {
    const paths = domain('unreadable-fields');
    fs.mkdirSync(path.join(paths.home, 'export-cursor.json'));
    writeRecord(path.join(paths.home, 'export-enrollment.json'), {
      state: 'enrolled', enrolledAt: '2026-10-01T00:00:00.000Z', retentionDays: 30,
    });
    fs.writeFileSync(path.join(paths.home, 'export-last.json'), '{not-json');
    const lines = renderExportDiagnostics(collectExportDiagnostics({ env: fixtureEnv(paths) }));
    assert.match(lines[2], /enrollment=enrolled/);
    assert.match(lines[2], /cursor unreadable\(EISDIR\)/);
    assert.match(lines[2], /last attempt unreadable\(parse\)/);
    assert.match(lines[2], /last lock loss: none/);
    assert.match(lines[2], /last fail-open: none/);
  });

  it('reads the last non-empty fail-open record and uses real lock-lost writer envelopes', async () => {
    const failPaths = domain('fail-open-history');
    fs.writeFileSync(path.join(failPaths.home, 'fail-open.log'), [
      JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', reason: 'first', version: '1', agent: 'claude' }),
      '',
      JSON.stringify({ ts: '2026-10-02T00:00:00.000Z', reason: 'second', version: '2', agent: 'codex' }),
      '',
    ].join('\n'));
    const failLine = renderExportDiagnostics(collectExportDiagnostics({ env: fixtureEnv(failPaths) }))[2];
    assert.match(failLine, /last fail-open: 2026-10-02T00:00:00.000Z reason=second version=2 agent=codex/);

    const lossCases = [
      { label: 'pin-invalid', kind: 'pin-invalid', expected: /pin-invalid/ },
      { label: 'addr-in-use', kind: 'EADDRINUSE', expected: /held by another process \(EADDRINUSE\)/ },
      { label: 'win32-eacces', kind: 'EACCES', expected: /permission denied or exclusive binding/ },
    ];
    for (const item of lossCases) {
      const paths = domain(`lock-loss-${item.label}`);
      await pinExportLockPort(paths.home);
      process.env.CCXRAY_HOME = paths.home;
      process.env.LOGS_DIR = paths.logsDir;
      process.env.CCXRAY_EXPORT_DISABLE = undefined;
      delete process.env.CCXRAY_EXPORT_DISABLE;
      process.env.CCXRAY_EXPORT_GCS_BUCKET = 'synthetic-bucket';
      process.env.CCXRAY_EXPORT_DOMAINS = 'example.com';
      exportSync._setUploader(async () => {});

      if (item.kind === 'pin-invalid') {
        fs.writeFileSync(path.join(paths.home, 'export-lock-port'), 'not-a-port\n');
        assert.equal(await exportSync.flushExport({ phase: item.label }), 'lock-lost');
      } else if (item.kind === 'EADDRINUSE') {
        assert.equal(await exportSync.withExportLock(async () => exportSync.flushExport({ phase: item.label })), 'lock-lost');
      } else {
        const originalCreateServer = net.createServer;
        net.createServer = () => {
          const fake = new EventEmitter();
          fake.unref = () => fake;
          fake.listen = () => {
            setImmediate(() => {
              const error = new Error('synthetic bind failure'); error.code = 'EACCES'; fake.emit('error', error);
            });
            return fake;
          };
          return fake;
        };
        try { assert.equal(await exportSync.flushExport({ phase: item.label }), 'lock-lost'); }
        finally { net.createServer = originalCreateServer; }
      }

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      if (item.kind === 'EACCES') Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
      try {
        const line = renderExportDiagnostics(collectExportDiagnostics({ env: fixtureEnv(paths) }))[2];
        assert.match(line, new RegExp(`phase=${item.label}`));
        assert.match(line, item.expected);
      } finally {
        if (item.kind === 'EACCES') Object.defineProperty(process, 'platform', originalPlatform);
      }
      exportSync._setUploader(null);
      delete process.env.CCXRAY_EXPORT_GCS_BUCKET;
    }
  });
});

describe('bounded hub report query', () => {
  it('waits for an asynchronous predicate to become true', async () => {
    let checks = 0;
    await assert.rejects(waitFor(async () => { checks++; return false; }, 30), /timed out/);
    assert.ok(checks > 1, `expected repeated awaited checks, got ${checks}`);
  });

  it('returns no-hub and dead-lockfile outcomes without throwing', async () => {
    hub.deleteHubLock();
    assert.deepEqual(await fetchHubReport({ timeoutMs: 100 }), {
      kind: 'none', lock: null, report: null, reason: null,
    });
    hub.writeHubLock(5610, Number.MAX_SAFE_INTEGER, 'fixture');
    const dead = await fetchHubReport({ timeoutMs: 100 });
    assert.equal(dead.kind, 'dead-lockfile');
    assert.equal(dead.reason, 'dead-pid');
    const diagnostics = collectExportDiagnostics({ report: null, reportReason: dead.reason });
    assert.equal(diagnostics.configMatch, 'unknown');
    assert.equal(diagnostics.runningExporter.state, 'unknown');
    hub.deleteHubLock();
  });

  it('aborts silent and continuously streaming HTTP health and status responses', async () => {
    for (const target of ['health', 'status']) {
      for (const mode of ['silent', 'stream']) await runHttpDeadlineScenario(target, mode);
    }
  });

  it('destroys silent and continuously streaming socket health and status connections', async () => {
    for (const target of ['health', 'status']) {
      for (const mode of ['silent', 'stream']) await runSocketDeadlineScenario(target, mode);
    }
  });

  it('rejects malformed, oversized, and shape-invalid socket reports without crashing', async () => {
    async function runReply(reply, expectedReason) {
      const socketPath = path.join(ROOT, `reply-${Date.now()}-${Math.random()}.sock`);
      const sockets = new Set();
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        let body = '';
        socket.on('data', chunk => {
          body += chunk.toString();
          if (!body.includes('\n')) return;
          const message = JSON.parse(body.split('\n')[0]);
          if (message.cmd === 'health') socket.end('{"ok":true}\n');
          else socket.end(typeof reply === 'function' ? reply() : reply);
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      hub.writeHubLock(5610, process.pid, 'fixture', socketPath);
      try {
        const result = await fetchHubReport({ timeoutMs: 500 });
        assert.equal(result.kind, 'unresponsive');
        assert.equal(result.reason, expectedReason);
        assertOtherDiagnostics(result, `reply-${expectedReason}`);
        await waitFor(() => sockets.size === 0);
      } finally {
        await new Promise(resolve => server.close(resolve));
        try { fs.unlinkSync(socketPath); } catch {}
        hub.deleteHubLock();
      }
    }

    await runReply('{bad json}\n', 'malformed-reply');
    await runReply(() => `${'x'.repeat(1024 * 1024 + 1)}\n`, 'reply-too-large');
    await runReply(JSON.stringify({ app: 'ccxray', pid: 'not-a-number', exportState: 5 }) + '\n', 'malformed-report');
  });

  it('bounds HTTP response size and validates the report shape after its probe', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/_api/health') return res.end('{"ok":true}');
      res.end(JSON.stringify({ app: 'ccxray', pid: 'wrong-type', version: 'fixture', port: server.address().port, exportState: 'enabled' }));
    });
    const port = await listen(server);
    hub.writeHubLock(port, process.pid, 'fixture');
    try {
      const invalid = await fetchHubReport({ timeoutMs: 500 });
      assert.equal(invalid.kind, 'unresponsive');
      assert.equal(invalid.reason, 'malformed-report');
      assertOtherDiagnostics(invalid, 'http-invalid-report');
    } finally {
      await new Promise(resolve => server.close(resolve));
      hub.deleteHubLock();
    }

    const largeServer = http.createServer((req, res) => {
      if (req.url === '/_api/health') return res.end('{"ok":true}');
      res.write(JSON.stringify({ app: 'ccxray', pid: process.pid, version: 'fixture', port: largeServer.address().port, exportState: 'enabled' }));
      res.write(Buffer.alloc(1024 * 1024 + 1, 120));
    });
    const largePort = await listen(largeServer);
    hub.writeHubLock(largePort, process.pid, 'fixture');
    try {
      const large = await fetchHubReport({ timeoutMs: 500 });
      assert.equal(large.kind, 'unresponsive');
      assert.equal(large.reason, 'status-failed');
      assertOtherDiagnostics(large, 'http-large-report');
      await waitFor(async () => await httpConnectionCount(largeServer) === 0);
    } finally {
      await new Promise(resolve => largeServer.close(resolve));
      hub.deleteHubLock();
    }

    const largeHealthBody = JSON.stringify({ ok: true, padding: 'x'.repeat(1024 * 1024 + 1) });
    const largeHealthServer = http.createServer((req, res) => {
      if (req.url === '/_api/health') return res.end(largeHealthBody);
      res.end(JSON.stringify({
        app: 'ccxray', pid: process.pid, port: largeHealthServer.address().port,
        version: 'fixture', exportState: 'enabled', clients: [],
      }));
    });
    const largeHealthPort = await listen(largeHealthServer);
    hub.writeHubLock(largeHealthPort, process.pid, 'fixture');
    try {
      const started = Date.now();
      const largeHealth = await fetchHubReport({ timeoutMs: 500 });
      const elapsed = Date.now() - started;
      assert.equal(largeHealth.kind, 'unresponsive');
      assert.equal(largeHealth.reason, 'health-failed');
      assert.ok(elapsed < 500, `oversized valid health JSON must be rejected before the deadline; took ${elapsed}ms`);
      assertOtherDiagnostics(largeHealth, 'http-large-health');
      await waitFor(async () => await httpConnectionCount(largeHealthServer) === 0);
    } finally {
      await new Promise(resolve => largeHealthServer.close(resolve));
      hub.deleteHubLock();
    }
  });
});

after(async () => {
  exportSync._setUploader(null);
  hub.deleteHubLock();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});
