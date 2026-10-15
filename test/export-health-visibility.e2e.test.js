'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');
const children = new Set();
const servers = new Set();
const homes = new Set();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-export-health-'));
  homes.add(home);
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'cloudsdk'), { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'index.ndjson'), `${JSON.stringify({
    id: 'synthetic-export-health-entry',
    sessionId: 'synthetic-export-health-session',
  })}\n`);
  fs.writeFileSync(path.join(home, 'pricing-cache.json'), JSON.stringify({
    fetchedAt: Date.now(),
    pricing: {},
    context: {},
  }));
  return home;
}

function isolatedEnv(home, port, { longWarning = false, requireAuth = false } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CCXRAY_')) delete env[key];
  }
  for (const key of [
    'NODE_TEST_CONTEXT',
    'LOGS_DIR',
    'PROXY_PORT',
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'CHATGPT_BASE_URL',
    'CODEX_CHATGPT_BASE_URL',
    'XAI_BASE_URL',
    'GROK_BASE_URL',
    'STORAGE_BACKEND',
    'AUTH_TOKEN',
  ]) delete env[key];

  const credentialPath = path.join(home, 'secrets', 'synthetic-service-account.json');
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, JSON.stringify({
    type: 'service_account',
    client_email: 'fixture@example.invalid',
    private_key: 'synthetic-private-key-DO-NOT-EMIT',
  }));

  return {
    ...env,
    BROWSER: 'none',
    CI: '1',
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    CCXRAY_HOME: home,
    CCXRAY_IMPORT_DISABLE: '1',
    CCXRAY_EXPORT_DISABLE: '1',
    // A fixture-only bucket name: the required disable flag prevents any upload.
    CCXRAY_EXPORT_GCS_BUCKET: 'ccxray-export-health-unreachable-fixture',
    CCXRAY_EXPORT_GCS_KEY_FILE: credentialPath,
    ...(requireAuth ? { CCXRAY_LOOPBACK_REQUIRE_AUTH: '1' } : {}),
    CLOUDSDK_CONFIG: path.join(home, 'cloudsdk'),
    CCXRAY_PRICING_CACHE: path.join(home, 'pricing-cache.json'),
    PROXY_PORT: String(port),
    ...(longWarning
      ? { CCXRAY_IMPORT_HOMES: `relative-health-warning-${'x'.repeat(5200)}` }
      : {}),
  };
}

function startStandalone(home, port, options = {}) {
  const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--no-browser'], {
    env: isolatedEnv(home, port, { longWarning: true, ...options }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.getOutput = () => ({ stdout, stderr });
  children.add(child);
  return child;
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/_api/health`, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body, json: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(1000, () => req.destroy(new Error('health request timed out')));
    req.once('error', reject);
  });
}

async function waitForHealth(child, port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const output = child.getOutput();
      throw new Error(`standalone server exited (${child.exitCode})\n${output.stderr}\n${output.stdout}`);
    }
    try {
      return await requestHealth(port);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  const output = child.getOutput();
  throw new Error(`standalone health timed out: ${lastError?.message || 'no response'}\n${output.stderr}\n${output.stdout}`);
}

function runStatus(home, port, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT, 'status'], {
      env: isolatedEnv(home, port, options),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function firstLine(stdout, prefix) {
  return stdout.split('\n').find(line => line.startsWith(prefix));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

after(async () => {
  for (const child of children) await stopChild(child);
  for (const server of servers) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

describe('export health is visible without a hub', () => {
  it('status renders a large standalone health report for the reporting home', async () => {
    const serverHome = makeHome();
    const statusHome = makeHome();
    fs.writeFileSync(path.join(serverHome, 'export-cursor.json'), JSON.stringify({
      lastId: 'synthetic-export-health-entry',
      seq: {},
      partial: false,
    }));
    const port = await freePort();
    const server = startStandalone(serverHome, port);

    const health = await waitForHealth(server, port);
    const status = await runStatus(statusHome, port);
    const processLine = firstLine(status.stdout, 'Process:');
    const homeLine = firstLine(status.stdout, 'Home:');

    assert.equal(status.timedOut, false, status.stderr);
    assert.equal(status.code, 0, status.stderr);
    assert.ok(processLine, `no Process line in status output`);
    assert.doesNotMatch(processLine, /exporter state unavailable/,
      `the reachable standalone must report its exporter state`);
    assert.match(processLine, /exportState=suppressed/);
    assert.ok(processLine.length > 4096, 'the probe must accept the report beyond its former 4 KiB bound');
    assert.ok(homeLine, 'status must render the Home verdict');
    assert.ok(homeLine.startsWith(`Home: ${serverHome} —`),
      'the Home verdict must use the standalone process identity');
    assert.ok(homeLine.includes('current — cursor has consumed through the index tail'),
      'the Home verdict must read the reporting server home cursor');
    assert.ok(!homeLine.includes('never-flushed'),
      'the caller home has no cursor and must not determine the verdict');
    assert.ok(!homeLine.includes(statusHome), 'the Home verdict must not read the status caller home');

    assert.equal(health.statusCode, 200);
    assert.equal(health.json.app, 'ccxray');
    assert.equal(health.json.hub, false);
    assert.equal(health.json.exportState, 'suppressed');
    assert.equal(health.json.exportReason, 'explicitly-disabled');
    assert.equal(health.json.exportReportUnavailableReason, undefined);
    assert.equal(health.json.identity.home, serverHome);
    assert.equal(health.json.identity.logsDir, path.join(serverHome, 'logs'));
    assert.equal(fs.existsSync(path.join(serverHome, 'hub.json')), false,
      'the --port server must not write a hub lockfile');
    assert.ok(Buffer.byteLength(health.body) > 4096 && Buffer.byteLength(health.body) < 64 * 1024);
    assert.equal(health.json.credential, null);
    assert.ok(!health.body.includes(path.join(serverHome, 'secrets', 'synthetic-service-account.json')));
    assert.ok(!health.body.includes('synthetic-private-key-DO-NOT-EMIT'));
    assert.ok(!health.body.includes('ccxray-export-health-unreachable-fixture'));
  });

  it('names a legacy standalone as too old to report export state', async () => {
    const statusHome = makeHome();
    const legacy = http.createServer((req, res) => {
      if (req.url !== '/_api/health') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        app: 'ccxray',
        pid: process.pid,
        hub: false,
        version: 'legacy-fixture',
      }));
    });
    servers.add(legacy);
    await new Promise((resolve, reject) => {
      legacy.once('error', reject);
      legacy.listen(0, '127.0.0.1', resolve);
    });
    const port = legacy.address().port;

    const status = await runStatus(statusHome, port);
    const processLine = firstLine(status.stdout, 'Process:');
    const homeLine = firstLine(status.stdout, 'Home:');

    assert.equal(status.code, 0, status.stderr);
    assert.ok(processLine?.includes(`older than export reporting`),
      `legacy process should be named in fallback reason: ${processLine || 'missing Process line'}`);
    assert.match(processLine, /exporter state unavailable/);
    assert.match(homeLine, /exporter state unavailable/);
  });

  it('keeps public health minimal when loopback auth is required and explains unavailable status', async () => {
    const serverHome = makeHome();
    const statusHome = makeHome();
    const port = await freePort();
    const server = startStandalone(serverHome, port, { requireAuth: true });

    const health = await waitForHealth(server, port);
    const status = await runStatus(statusHome, port, { requireAuth: true });
    const processLine = firstLine(status.stdout, 'Process:');
    const homeLine = firstLine(status.stdout, 'Home:');

    assert.equal(health.statusCode, 200);
    assert.equal(health.json.app, 'ccxray');
    assert.equal(health.json.hub, false);
    assert.equal(health.json.exportState, undefined);
    assert.equal(health.json.identity, undefined);
    assert.equal(health.json.credential, undefined);
    assert.equal(health.json.configWarnings, undefined);
    assert.equal(health.json.exportReportUnavailableReason, 'authentication-required');
    assert.ok(!health.body.includes(serverHome), 'unauthenticated health must not reveal the server home');

    assert.equal(status.timedOut, false, status.stderr);
    assert.equal(status.code, 0, status.stderr);
    assert.match(processLine, /loopback authentication is required \(CCXRAY_LOOPBACK_REQUIRE_AUTH=1\)/);
    assert.match(homeLine, /loopback authentication is required/);
    assert.ok(homeLine.startsWith(`Home: ${statusHome} —`),
      'without the report, status must name the home it actually inspected');
    assert.ok(!status.stdout.includes(serverHome), 'status must not learn the protected server home');
  });
});
