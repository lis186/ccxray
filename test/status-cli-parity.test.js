'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { inspectHomeStatus, renderProcessStatus } = require('../server/status');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');
const REPORT_PID = 4312;

function makeStatusHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-status-parity-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'gcloud'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
  return home;
}

function isolatedEnv(home) {
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
  });
  return env;
}

function writeLock(home, { port, sockPath }) {
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({
    pid: process.pid,
    port,
    version: 'fixture',
    ...(sockPath ? { sockPath } : {}),
  }));
}

function runStatus(env, timeoutMs = 10_000) {
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
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut: false });
    });
  });
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

async function closedHttpPort() {
  const server = http.createServer();
  await listen(server, { port: 0, host: '127.0.0.1' });
  const port = server.address().port;
  await closeServer(server);
  return port;
}

async function makeRefusedSocket(sockPath, env) {
  const child = spawn(process.execPath, ['-e',
    "require('node:net').createServer().listen(process.env.SOCK_PATH, () => process.stdout.write('ready'));",
  ], { env: { ...env, SOCK_PATH: sockPath }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(fs.existsSync(sockPath), true, 'closed Unix socket inode is retained');
}

function fixtureReport(port, home, additions = {}) {
  return {
    app: 'ccxray',
    port,
    pid: REPORT_PID,
    version: 'fixture',
    uptime: 9,
    exportState: 'suppressed',
    exportReason: 'explicitly-disabled',
    configWarnings: [],
    identity: { kind: 'hub', pid: REPORT_PID, port, home, logsDir: path.join(home, 'logs') },
    clients: [],
    ...additions,
  };
}

function failedPrefix(env, pid, port) {
  return [
    ...failedBodyPrefix(env, pid, port),
  ];
}

function failedBodyPrefix(env, pid, port) {
  return [
    renderProcessStatus(null,
      `hub detected (pid ${pid}, port ${port}) — exporter state unavailable`),
    inspectHomeStatus(null, { env }).line,
  ];
}

function healthFailurePrefix(env, pid, port, transport) {
  const lines = [];
  if (transport === 'socket') lines.push(`Hub pid ${pid} alive but socket not responding.`);
  else lines.push(`Hub pid ${pid} alive but not responding on port ${port}.`);
  lines.push(`Check ${path.join(env.CCXRAY_HOME, 'hub.log')}`);
  lines.push(...failedBodyPrefix(env, pid, port));
  return lines;
}

function stdoutBeforeDiagnostics(result) {
  const index = result.stdout.indexOf('Shell: ');
  assert.notEqual(index, -1, 'diagnostics must be appended');
  return result.stdout.slice(0, index);
}

function assertDiagnosticsPrinted(result) {
  const shell = result.stdout.indexOf('Shell: ');
  const config = result.stdout.indexOf('Config: ');
  const durable = result.stdout.indexOf('Durable: ');
  assert.ok(shell !== -1 && config > shell && durable > config,
    'Shell, Config, and Durable diagnostics must follow the failure rows');
}

function assertParityResult(result, { status, stdoutLines, stderr = '' }) {
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.status, status, result.stderr);
  assert.equal(stdoutBeforeDiagnostics(result), `${stdoutLines.join('\n')}\n`);
  assert.equal(result.stderr, stderr ? `${stderr}\n` : '');
}

async function runFixture(row, home, env) {
  const socketPath = path.join(home, 'h.sock');
  let server;
  let port;

  if (row.transport === 'socket' && row.stage === 'health' && row.kind === 'refused') {
    await makeRefusedSocket(socketPath, env);
    return { port: 1, sockPath: socketPath };
  }

  if (row.transport === 'http' && row.stage === 'health' && row.kind === 'refused') {
    port = await closedHttpPort();
    return { port };
  }

  if (row.transport === 'socket') {
    server = net.createServer(socket => {
      let input = '';
      socket.on('data', chunk => {
        input += chunk.toString();
        const newline = input.indexOf('\n');
        if (newline === -1) return;
        const message = JSON.parse(input.slice(0, newline));
        if (message.cmd === 'health') {
          if (row.stage === 'health' && row.kind === 'reset') return socket.destroy();
          if (row.stage === 'health' && row.kind === 'timeout') return;
          if (row.stage === 'health' && row.kind === 'bad-json') return socket.end('broken health body\n');
          const health = row.stage === 'health' && row.kind === 'ok-false'
            ? { ok: false }
            : { ok: true };
          if (row.stage === 'status' && row.kind === 'refused') server.close();
          return socket.end(`${JSON.stringify(health)}\n`);
        }
        if (row.kind === 'reset') return socket.destroy();
        if (row.kind === 'timeout') return;
        if (row.kind === 'bad-json') return socket.end('broken status body\n');
        if (row.kind === 'wrong-shape') return socket.end('{}\n');
        if (row.kind === 'null-body') return socket.end('null\n');
        const report = fixtureReport(port, home, row.kind === 'oversized'
          ? { padding: 'x'.repeat(1024 * 1024 + 1) }
          : {});
        return socket.end(`${JSON.stringify(report)}\n`);
      });
    });
    await listen(server, socketPath);
    port = 1;
  } else {
    server = http.createServer((req, res) => {
      if (req.url === '/_api/health') {
        if (row.stage === 'health' && row.kind === 'reset') return req.socket.destroy();
        if (row.stage === 'health' && row.kind === 'timeout') return;
        if (row.stage === 'health' && row.kind === 'bad-json') return res.end('broken health body');
        const health = row.stage === 'health' && row.kind === 'ok-false'
          ? { ok: false }
          : { ok: true };
        if (row.stage === 'status' && row.kind === 'refused') res.setHeader('Connection', 'close');
        res.end(JSON.stringify(health), () => {
          if (row.stage === 'status' && row.kind === 'refused') server.close();
        });
        return;
      }
      if (row.kind === 'reset') return req.socket.destroy();
      if (row.kind === 'timeout') return;
      if (row.kind === 'bad-json') return res.end('broken status body');
      if (row.kind === 'wrong-shape') return res.end('{}');
      if (row.kind === 'null-body') return res.end('null');
      const report = fixtureReport(port, home, row.kind === 'oversized'
        ? { padding: 'x'.repeat(1024 * 1024 + 1) }
        : {});
      res.end(JSON.stringify(report));
    });
    await listen(server, { port: 0, host: '127.0.0.1' });
    port = server.address().port;
  }

  return { port, ...(row.transport === 'socket' ? { sockPath: socketPath } : {}), server };
}

const CASES = [
  ...['refused', 'reset', 'timeout', 'bad-json', 'ok-false'].map(kind => ({
    name: `socket health ${kind}`, transport: 'socket', stage: 'health', kind,
  })),
  ...['refused', 'reset', 'timeout', 'bad-json', 'ok-false'].map(kind => ({
    name: `HTTP health ${kind}`, transport: 'http', stage: 'health', kind,
  })),
  ...['refused', 'reset', 'timeout', 'bad-json', 'wrong-shape', 'null-body', 'oversized'].map(kind => ({
    name: `socket status ${kind}`, transport: 'socket', stage: 'status', kind,
  })),
  ...['refused', 'reset', 'timeout', 'bad-json', 'wrong-shape', 'null-body', 'oversized'].map(kind => ({
    name: `HTTP status ${kind}`, transport: 'http', stage: 'status', kind,
  })),
];

it('ccxray status preserves the 62fcf05 failure text and exit code across both transports', async t => {
  for (const row of CASES) {
    await t.test(row.name, async () => {
      const home = makeStatusHome();
      const env = isolatedEnv(home);
      let fixture;
      try {
        fixture = await runFixture(row, home, env);
        writeLock(home, fixture);
        const result = await runStatus(env, row.stage === 'status' && row.kind === 'timeout' ? 5000 : 10_000);
        const pid = process.pid;
        const port = fixture.port;

        if (row.stage === 'health' && row.kind === 'ok-false') {
          assertParityResult(result, {
            status: 1,
            stdoutLines: healthFailurePrefix(env, pid, port, row.transport),
          });
          return;
        }
        if (row.stage === 'health' && row.transport === 'http') {
          assertParityResult(result, {
            status: 1,
            stdoutLines: healthFailurePrefix(env, pid, port, 'http'),
          });
          return;
        }
        if (row.stage === 'health' && row.kind === 'bad-json' && row.transport === 'socket') {
          // 62fcf05 lets JSON.parse escape from the socket data callback. Its
          // stack text contains runtime and source-location details, so only
          // the process failure is stable across Node versions.
          assert.equal(result.status, 1, result.stderr);
          assert.equal(result.timedOut, false);
          assert.match(result.stderr, /SyntaxError|hubSocketRequest malformed reply/);
          assert.match(result.stdout, /^Shell: /m);
          return;
        }
        if (row.stage === 'status' && row.transport === 'socket' && row.kind === 'bad-json') {
          // Same uncaught-parse limitation as malformed socket health replies.
          assert.equal(result.status, 1, result.stderr);
          assert.equal(result.timedOut, false);
          assert.match(result.stderr, /SyntaxError|hubSocketRequest malformed reply/);
          assert.match(result.stdout, /^Shell: /m);
          return;
        }
        if (row.stage === 'status' && row.transport === 'http' && row.kind === 'timeout') {
          // The old direct HTTP status request had no timeout and never exited
          // for a silent peer. The new diagnostics query is bounded at 3s.
          assert.equal(result.timedOut, false, 'the diagnostics query must remain bounded');
          assert.equal(result.status, 1, result.stderr);
          assert.equal(result.stderr, 'Failed to query hub: timeout\n');
          assert.equal(stdoutBeforeDiagnostics(result), `${failedPrefix(env, pid, port).join('\n')}\n`);
          return;
        }
        if (row.stage === 'status' && (row.kind === 'wrong-shape' || row.kind === 'null-body')) {
          assertParityResult(result, {
            status: 1,
            stdoutLines: failedPrefix(env, pid, port),
            stderr: 'Failed to query hub: malformed-report',
          });
          assertDiagnosticsPrinted(result);
          assert.doesNotMatch(result.stdout, /Machine: .*"proxy":true,"hub":true/);
          return;
        }
        if (row.stage === 'status' && row.kind === 'oversized') {
          assertParityResult(result, {
            status: 1,
            stdoutLines: failedPrefix(env, pid, port),
            stderr: 'Failed to query hub: reply-too-large',
          });
          assertDiagnosticsPrinted(result);
          assert.doesNotMatch(result.stdout, /Machine: .*"proxy":true,"hub":true/);
          return;
        }

        if (row.stage === 'status') {
          let message;
          if (row.kind === 'bad-json' && row.transport === 'http') message = 'broken status body';
          else if (row.kind === 'reset' && row.transport === 'http') message = 'socket hang up';
          else if (row.kind === 'timeout' && row.transport === 'socket') message = 'hubSocketRequest timeout';
          else if (row.transport === 'socket' && row.kind === 'reset') message = 'hubSocketRequest timeout';
          else if (row.kind === 'refused' && row.transport === 'http') {
            assert.match(result.stderr,
              /^Failed to query hub: (?:|.*(?:ECONNREFUSED|ECONNRESET|socket hang up).*)\n$/);
            assert.doesNotMatch(result.stderr, /status-failed/);
            assert.equal(result.status, 1, result.stderr);
            assert.equal(stdoutBeforeDiagnostics(result), `${failedPrefix(env, pid, port).join('\n')}\n`);
            return;
          } else if (row.kind === 'refused' && row.transport === 'socket') {
            assert.match(result.stderr, new RegExp(`^Failed to query hub: connect (?:ECONNREFUSED|ENOENT) ${escapeRegExp(fixture.sockPath)}\\n$`));
            assert.equal(result.status, 1, result.stderr);
            assert.equal(stdoutBeforeDiagnostics(result), `${failedPrefix(env, pid, port).join('\n')}\n`);
            return;
          }
          assertParityResult(result, {
            status: 1,
            stdoutLines: failedPrefix(env, pid, port),
            stderr: `Failed to query hub: ${message}`,
          });
          return;
        }

        if (row.transport === 'socket' && row.kind === 'refused') {
          assertParityResult(result, {
            status: 1,
            stdoutLines: failedPrefix(env, pid, port),
            stderr: `Failed to query hub: connect ECONNREFUSED ${fixture.sockPath}`,
          });
          return;
        }
        if (row.transport === 'socket' && row.kind === 'reset') {
          assertParityResult(result, {
            status: 1,
            stdoutLines: failedPrefix(env, pid, port),
            stderr: 'Failed to query hub: hubSocketRequest timeout',
          });
          return;
        }
        if (row.transport === 'socket' && row.kind === 'timeout') {
          assertParityResult(result, {
            status: 1,
            stdoutLines: failedPrefix(env, pid, port),
            stderr: 'Failed to query hub: hubSocketRequest timeout',
          });
          return;
        }
        assert.fail(`unhandled parity row: ${row.name}`);
      } finally {
        await closeServer(fixture?.server);
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
