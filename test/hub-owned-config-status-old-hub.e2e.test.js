'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');
const BAD_CLIENT_VALUE = 'relative/not-absolute';

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('status child did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function assertPidGone(pid, label) {
  if (!pid || pid === process.pid) return;
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label} pid ${pid} survived cleanup${lastError ? `: ${lastError.message}` : ''}`);
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    const onError = error => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(...args);
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

function isolatedEnv(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CCXRAY_')) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    CCXRAY_HOME: home,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    CCXRAY_IMPORT_HOMES: BAD_CLIENT_VALUE,
    BROWSER: 'none',
    CI: '1',
    PROXY_PORT: '1',
  };
}

function legacyStatus(port) {
  return {
    app: 'ccxray',
    port,
    pid: process.pid,
    uptime: 7,
    version: '2.3.1',
    clients: [],
  };
}

function createSocketMock(socketPath, port) {
  const server = net.createServer(socket => {
    let input = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk.toString();
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline));
      const payload = request.cmd === 'health' ? { ok: true } : legacyStatus(port);
      socket.end(JSON.stringify(payload) + '\n');
    });
  });
  return { server, address: socketPath, port };
}

function createHttpMock() {
  const server = http.createServer((request, response) => {
    const payload = request.url === '/_api/health'
      ? { ok: true }
      : legacyStatus(server.address().port);
    response.writeHead(request.url === '/_api/health' || request.url === '/_api/hub/status' ? 200 : 404,
      { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  return { server };
}

function writeRenderProbe(home) {
  const marker = path.join(home, 'render-process-status.json');
  const statusPath = path.resolve(__dirname, '..', 'server', 'status.js');
  fs.writeFileSync(path.join(home, 'render-process-status-probe.js'), [
    "'use strict';",
    "const fs = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    `const status = require(${JSON.stringify(statusPath)});`,
    'const original = status.renderProcessStatus;',
    'status.renderProcessStatus = (report, reason) => {',
    '  fs.writeFileSync(marker, JSON.stringify({ reportIsNull: report === null }) + "\\n");',
    '  return original(report, reason);',
    '};',
    '',
  ].join('\n'));
  return { marker, preload: path.join(home, 'render-process-status-probe.js') };
}

function startStatus(env, preload) {
  const child = spawn(process.execPath, ['--require', preload, SERVER, 'status'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.once('exit', (code, signal) => {
    resolve({ code, signal, stdout, stderr });
  }));
  return { child, done };
}

async function runLegacyStatus(t, carrier) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-old-hub-status-e2e-'));
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), '');

  let mock;
  let statusRun;
  try {
    if (carrier === 'socket') {
      mock = createSocketMock(path.join(home, 'hub.sock'), 59991);
      try {
        await listen(mock.server, mock.address);
      } catch (error) {
        if (error.code === 'EPERM') {
          t.skip('blocked by sandbox, not verified here');
          return;
        }
        throw error;
      }
      fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({
        pid: process.pid,
        port: mock.port,
        version: '2.3.1',
        sockPath: mock.address,
      }));
    } else {
      mock = createHttpMock();
      try {
        await listen(mock.server, 0, '127.0.0.1');
      } catch (error) {
        if (error.code === 'EPERM') {
          t.skip('blocked by sandbox, not verified here');
          return;
        }
        throw error;
      }
      const port = mock.server.address().port;
      fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({
        pid: process.pid,
        port,
        version: '2.3.1',
      }));
    }

    const probe = writeRenderProbe(home);
    statusRun = startStatus(isolatedEnv(home), probe.preload);
    const result = await statusRun.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /exporter state unavailable/);
    assert.doesNotMatch(result.stdout, /exportState=/);
    assert.doesNotMatch(result.stdout, new RegExp(BAD_CLIENT_VALUE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const renderObservation = JSON.parse(fs.readFileSync(probe.marker, 'utf8'));
    assert.equal(renderObservation.reportIsNull, true,
      `${carrier} legacy hub status must pass null to renderProcessStatus`);
  } finally {
    if (statusRun) {
      if (statusRun.child.exitCode == null && statusRun.child.signalCode == null) {
        try { statusRun.child.kill('SIGKILL'); } catch {}
      }
      try { await waitForExit(statusRun.child); } catch {}
      await assertPidGone(statusRun.child.pid, `row 8 ${carrier} status`);
    }
    if (mock) await close(mock.server);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('row 8: status against a legacy hub reply', () => {
  it('socket carrier keeps legacy exporter state unavailable and ignores client env', async t => {
    await runLegacyStatus(t, 'socket');
  });

  it('HTTP fallback keeps legacy exporter state unavailable and ignores client env', async t => {
    await runLegacyStatus(t, 'http');
  });
});
