'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
}

function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const value = await check();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw lastError || new Error('timed out');
  })();
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readHubLock(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8'));
  } catch {
    return null;
  }
}

function hubStatus(lock) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(lock.sockPath);
    let body = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('hub status timeout')), 1000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.once('connect', () => socket.write('{"cmd":"status"}\n'));
    socket.on('data', chunk => {
      body += chunk;
      if (!body.includes('\n')) return;
      try { finish(null, JSON.parse(body.trim())); } catch (error) { finish(error); }
    });
    socket.once('error', error => finish(error));
  });
}

function agentPid(marker) {
  try {
    const pid = Number(fs.readFileSync(marker, 'utf8').trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function makeFakeClaude(home) {
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude, [
    '#!/bin/sh',
    "trap 'exit 0' HUP TERM INT",
    'echo $$ > "$CCXRAY_TEST_AGENT_PID_FILE"',
    'echo CCXRAY_FAKE_AGENT_READY',
    'while :; do sleep 1; done',
    '',
  ].join('\n'));
  fs.chmodSync(claude, 0o755);
  return binDir;
}

function clientEnv({ home, binDir, port, marker, importHomes }) {
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
  ]) delete env[key];

  return {
    ...env,
    BROWSER: 'none',
    CI: '1',
    CCXRAY_HOME: home,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    CCXRAY_TEST_AGENT_PID_FILE: marker,
    ...(importHomes === undefined ? {} : { CCXRAY_IMPORT_HOMES: importHomes }),
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    PROXY_PORT: String(port),
  };
}

function spawnClient(options) {
  const child = spawn(process.execPath, [SERVER, '--no-browser', 'claude'], {
    env: clientEnv(options),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

// CCXRAY_EXPORT_DISABLE is mandatory on both real child clients, so exportState is
// intentionally not the divergence axis here: suppression wins before the retired
// export control. Rows 6/7 exercise the independent coded configWarnings carrier;
// the five exportState values remain covered by the in-process status tables.
async function waitForRegisteredClient(home, clientPid) {
  return waitFor(async () => {
    const lock = readHubLock(home);
    if (!lock || !lock.sockPath || !pidAlive(lock.pid)) return null;
    const status = await hubStatus(lock);
    return status.clients?.some(client => client.pid === clientPid)
      ? { lock, status }
      : null;
  });
}

async function waitForFakeAgent(client, marker) {
  return waitFor(() => {
    const pid = agentPid(marker);
    return pid && pidAlive(pid) && client.stdout.includes('CCXRAY_FAKE_AGENT_READY') ? pid : null;
  });
}

async function killAndConfirm(pid, label) {
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await waitFor(() => !pidAlive(pid), 5000);
  assert.equal(pidAlive(pid), false, `${label} pid ${pid} survived cleanup`);
}

async function stopClient(client, marker) {
  let clientError = null;
  if (client && client.child.exitCode == null && client.child.signalCode == null) {
    try { client.child.kill('SIGKILL'); } catch {}
    try { await waitForExit(client.child); } catch (error) { clientError = error; }
  }
  let agentError = null;
  try { await killAndConfirm(agentPid(marker), 'fake agent'); } catch (error) { agentError = error; }
  if (clientError || agentError) {
    throw new Error([
      clientError && `client cleanup: ${clientError.message}`,
      agentError && `agent cleanup: ${agentError.message}`,
    ].filter(Boolean).join('; '));
  }
}

async function runDivergence({ badFirst }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-owned-status-e2e-'));
  const firstMarker = path.join(home, 'first-agent.pid');
  const secondMarker = path.join(home, 'second-agent.pid');
  const badValue = 'relative/not-absolute';
  const clients = [];
  let hubPid = null;

  try {
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
    const binDir = makeFakeClaude(home);
    const port = await freePort();
    const first = spawnClient({
      home,
      binDir,
      port,
      marker: firstMarker,
      importHomes: badFirst ? badValue : undefined,
    });
    clients.push(first);
    const firstReady = await waitForRegisteredClient(home, first.child.pid);
    hubPid = firstReady.lock.pid;
    await waitForFakeAgent(first, firstMarker);

    const second = spawnClient({
      home,
      binDir,
      port,
      marker: secondMarker,
      importHomes: badFirst ? undefined : badValue,
    });
    clients.push(second);
    const secondReady = await waitForRegisteredClient(home, second.child.pid);
    assert.equal(secondReady.lock.pid, hubPid, 'both clients must attach to one hub');
    await waitForFakeAgent(second, secondMarker);

    return { badValue, home, hubPid, hubPort: firstReady.lock.port, second };
  } finally {
    const cleanupErrors = [];
    for (const client of clients) {
      const marker = client === clients[0] ? firstMarker : secondMarker;
      try { await stopClient(client, marker); } catch (error) { cleanupErrors.push(error); }
    }

    const lock = readHubLock(home);
    if (!hubPid && lock) hubPid = lock.pid;
    try { await killAndConfirm(hubPid, 'hub'); } catch (error) { cleanupErrors.push(error); }
    fs.rmSync(home, { recursive: true, force: true });
    if (cleanupErrors.length) {
      throw new Error('process cleanup failed: ' + cleanupErrors.map(error => error.message).join(' | '));
    }
  }
}

describe('hub-owned config status divergence', () => {
  it('row 6: shows a bad hub warning to a clean attaching client', async () => {
    const result = await runDivergence({ badFirst: true });
    const output = result.second.stdout;
    const warning = `configWarnings=CCXRAY_IMPORT_HOMES: "${result.badValue}"`;

    assert.ok(
      output.includes(warning),
      `row 6 expected the hub warning ${warning}; stdout:\n${output}`,
    );
    assert.ok(output.includes('"kind":"hub"'), `row 6 must identify the hub; stdout:\n${output}`);
    assert.ok(output.includes(`"pid":${result.hubPid}`),
      `row 6 must name the hub pid ${result.hubPid}; stdout:\n${output}`);
    assert.ok(output.includes(`"port":${result.hubPort}`),
      `row 6 must name the hub port ${result.hubPort}; stdout:\n${output}`);
    assert.ok(output.includes(`"home":"${result.home}"`),
      `row 6 must name the hub home ${result.home}; stdout:\n${output}`);
    assert.ok(output.includes(`"logsDir":"${path.join(result.home, 'logs')}"`),
      `row 6 must name the hub logs directory; stdout:\n${output}`);
  });

  it('row 7: hides a bad attaching client value while showing the clean hub state', async () => {
    const result = await runDivergence({ badFirst: false });
    const output = result.second.stdout;

    assert.doesNotMatch(
      output,
      new RegExp(result.badValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `row 7 must not show the client's bad value; stdout:\n${output}`,
    );
    assert.ok(output.includes('exportState=suppressed exportReason=explicitly-disabled'),
      `row 7 must show the hub's own state; stdout:\n${output}`);
    assert.ok(output.includes('"kind":"hub"'), `row 7 must identify the hub; stdout:\n${output}`);
    assert.ok(output.includes(`"pid":${result.hubPid}`),
      `row 7 must name the hub pid ${result.hubPid}; stdout:\n${output}`);
    assert.ok(output.includes(`"port":${result.hubPort}`),
      `row 7 must name the hub port ${result.hubPort}; stdout:\n${output}`);
    assert.ok(output.includes(`"home":"${result.home}"`),
      `row 7 must name the hub home ${result.home}; stdout:\n${output}`);
    assert.ok(output.includes(`"logsDir":"${path.join(result.home, 'logs')}"`),
      `row 7 must name the hub logs directory; stdout:\n${output}`);
  });
});
