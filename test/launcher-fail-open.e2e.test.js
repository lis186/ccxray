'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');
const PACKAGE = require('../package.json');

function mkHome(prefix = 'ccxray-launcher-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, 'claude-config'), { recursive: true });
  return home;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server.address().port));
  });
}

function freePort() {
  const server = net.createServer();
  return listen(server).then(port => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve(port));
  }));
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise(resolve => {
    let closed = false;
    const timer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      if (!closed) {
        closed = true;
        resolve();
      }
    }, 1500);
    server.close(() => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function reserveConsecutivePorts(count) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const base = await freePort();
    if (base + count > 65535 || (base <= 5577 && 5577 < base + count)) continue;
    const servers = [];
    try {
      for (let i = 0; i < count; i++) {
        const server = net.createServer();
        await listen(server, base + i);
        servers.push(server);
      }
      return {
        base,
        async close() { await Promise.all(servers.map(closeServer)); },
      };
    } catch {
      await Promise.all(servers.map(closeServer));
    }
  }
  throw new Error(`could not reserve ${count} consecutive loopback ports`);
}

function installFakeAgent(binDir, command) {
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, command);
  fs.writeFileSync(bin, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const capture = {
  args: process.argv.slice(2),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  anthropicCustomHeaders: process.env.ANTHROPIC_CUSTOM_HEADERS ?? null,
  hubClientPid: process.env.CCXRAY_HUB_CLIENT_PID ?? null,
  marker: process.env.PASSTHROUGH_MARKER ?? null,
  pid: process.pid,
};
if (process.env.FAKE_AGENT_CAPTURE) fs.writeFileSync(process.env.FAKE_AGENT_CAPTURE, JSON.stringify(capture));
setTimeout(() => {
  if (process.env.FAKE_AGENT_SIGNAL) process.kill(process.pid, process.env.FAKE_AGENT_SIGNAL);
  else process.exit(Number(process.env.FAKE_AGENT_EXIT_CODE || 0));
}, Number(process.env.FAKE_AGENT_DELAY_MS || 0));
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function cliEnv(home, binDir, port, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CCXRAY_')) delete env[key];
  }
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  delete env.CCXRAY_HUB_CLIENT_PID;
  Object.assign(env, {
    CCXRAY_HOME: home,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'),
    BROWSER: 'none',
    CI: '1',
    PATH: `${binDir}${path.delimiter}${env.PATH || ''}`,
    PROXY_PORT: String(port),
    ...extra,
  });
  return env;
}

function spawnCli(home, binDir, port, args, extraEnv = {}, testContext) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    env: cliEnv(home, binDir, port, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const wait = (timeoutMs = 10000) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`ccxray did not exit within ${timeoutMs}ms\n${stderr}`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const fixture = {
    child,
    wait,
    output: () => ({ stdout, stderr }),
    async kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        try {
          await waitFor(() => child.exitCode !== null || child.signalCode !== null, 1500, 'launcher did not exit after cleanup');
        } catch {}
      }
      const capturePath = extraEnv.FAKE_AGENT_CAPTURE;
      if (capturePath) {
        try {
          const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
          if (captured.pid && captured.pid !== process.pid && pidAlive(captured.pid)) {
            try { process.kill(captured.pid, 'SIGKILL'); } catch {}
            try { await waitFor(() => !pidAlive(captured.pid), 1500, 'fixture agent did not exit after cleanup'); } catch {}
          }
        } catch {}
      }
      // The failed launch may have forked the hub before taking its old exit
      // path. Its pid is recorded in this fixture's lockfile, so clean only
      // that process (never the test runner or a shared service).
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8'));
        if (lock.pid && lock.pid !== process.pid && lock.pid !== child.pid) {
          try { process.kill(lock.pid, 'SIGTERM'); } catch {}
          try { await waitFor(() => !pidAlive(lock.pid), 3000, 'fixture hub did not exit after cleanup'); } catch {}
        }
      } catch {}
    },
  };
  if (testContext) testContext.after(() => fixture.kill());
  return fixture;
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message || `timed out after ${timeoutMs}ms`);
}

function waitWithDeadline(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function startFakeHub(home, variant, version = PACKAGE.version) {
  const clients = new Set();
  const registrations = [];
  const unregisters = [];
  let idleTimer = null;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/_api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method !== 'POST' || !['/_api/hub/register', '/_api/hub/unregister'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const message = JSON.parse(body || '{}');
      if (req.url === '/_api/hub/register') {
        registrations.push(message.pid);
        if (variant === 'hold') return;
        if (variant === 'delayed-apply') {
          setTimeout(() => {
            if (idleTimer) clearTimeout(idleTimer);
            clients.add(message.pid);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, firstClient: false }));
          }, 1300);
          return;
        }
        if (idleTimer) clearTimeout(idleTimer);
        clients.add(message.pid);
        if (variant === 'lost') return; // addClient happened; the reply never arrives
        if (variant === 'null') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        if (variant === 'reject') {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, firstClient: false }));
        return;
      }

      clients.delete(message.pid);
      unregisters.push(message.pid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      if (clients.size === 0) {
        idleTimer = setTimeout(() => server.close(resolveClosed), 5000);
      }
    });
  });
  const port = await listen(server);
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({
    pid: process.pid,
    port,
    version,
  }));
  return {
    port,
    clients,
    registrations,
    unregisters,
    closed,
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      await closeServer(server);
    },
  };
}

function readFailOpen(home) {
  const lines = fs.readFileSync(path.join(home, 'fail-open.log'), 'utf8').trim().split('\n');
  return lines.map(line => JSON.parse(line));
}

describe('launcher fixture cleanup', () => {
  it('registers bounded cleanup for launcher and fake-agent processes at spawn time', () => {
    const helper = spawnCli.toString();
    assert.ok(helper.includes('if (testContext) testContext.after(() => fixture.kill())'));
    assert.ok(helper.includes("launcher did not exit after cleanup"));
    assert.ok(helper.includes("fixture agent did not exit after cleanup"));
    assert.ok(closeServer.toString().includes('server.closeAllConnections()'));
  });
});

describe('launcher fail-open behavior', () => {
  it('closes a ready hub that never gets a client', async t => {
    const home = mkHome();
    const binDir = path.join(home, 'bin');
    const port = await freePort();
    const run = spawnCli(home, binDir, port, ['--port', String(port), '--hub-mode'], {}, t);
    try {
      await waitFor(() => fs.existsSync(path.join(home, 'hub.json')), 5000, 'hub never wrote its readiness lock');
      const result = await run.wait(15000);
      assert.equal(result.code, 0, run.output().stderr);
      assert.equal(result.signal, null);
      assert.equal(fs.existsSync(path.join(home, 'hub.json')), false, 'idle hub should remove its lockfile on shutdown');
    } finally {
      await run.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  for (const provider of ['claude', 'codex', 'grok']) {
    it(`falls back to the plain ${provider} command on a major version mismatch`, async t => {
      const home = mkHome();
      const binDir = path.join(home, 'bin');
      installFakeAgent(binDir, provider);
      const capture = path.join(home, 'agent.json');
      const hub = await startFakeHub(home, 'healthy', '9000.0.0');
      const run = spawnCli(home, binDir, hub.port, [provider, '--sentinel', 'original-arg'], {
        FAKE_AGENT_CAPTURE: capture,
        FAKE_AGENT_EXIT_CODE: '23',
        PASSTHROUGH_MARKER: 'environment-preserved',
        ANTHROPIC_BASE_URL: 'https://user-upstream.example',
        ANTHROPIC_CUSTOM_HEADERS: 'X-User-Header: retained',
      }, t);
      try {
        const result = await run.wait(5000);
        assert.equal(result.code, 23, run.output().stderr);
        assert.equal(result.signal, null);
        assert.match(run.output().stderr, /fail-open: version-mismatch/);
        const record = readFailOpen(home)[0];
        assert.deepEqual(Object.keys(record).sort(), ['agent', 'reason', 'ts', 'version']);
        assert.equal(record.reason, 'version-mismatch');
        assert.equal(record.agent, provider);
        assert.equal(record.version, PACKAGE.version);
        assert.ok(!Number.isNaN(Date.parse(record.ts)));
        assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), {
          args: ['--sentinel', 'original-arg'],
          anthropicBaseUrl: 'https://user-upstream.example',
          anthropicCustomHeaders: 'X-User-Header: retained',
          hubClientPid: null,
          marker: 'environment-preserved',
          pid: JSON.parse(fs.readFileSync(capture, 'utf8')).pid,
        });
      } finally {
        await run.kill();
        await hub.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  for (const variant of ['lost', 'null', 'reject']) {
    it(`fails open and unregisters when the registration reply is ${variant}`, async t => {
      const home = mkHome();
      const binDir = path.join(home, 'bin');
      installFakeAgent(binDir, 'claude');
      const capture = path.join(home, 'agent.json');
      const hub = await startFakeHub(home, variant);
      const run = spawnCli(home, binDir, hub.port, ['claude', '--print', 'fixture prompt'], {
        CCXRAY_ATTACH_TIMEOUT_MS: '120',
        FAKE_AGENT_CAPTURE: capture,
        FAKE_AGENT_DELAY_MS: '1800',
        FAKE_AGENT_EXIT_CODE: '24',
      }, t);
      try {
        await waitFor(() => hub.registrations.includes(run.child.pid), 3000, 'fake hub did not apply registration');
        const result = await run.wait(5000);
        assert.equal(result.code, 24, run.output().stderr);
        assert.match(run.output().stderr, /fail-open:/);
        assert.equal(hub.clients.has(run.child.pid), false, 'late registration must be unregistered');
        assert.ok(hub.unregisters.includes(run.child.pid), 'fallback should send unregister after registration settles or times out');
        assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, ['--print', 'fixture prompt']);
        const record = readFailOpen(home)[0];
        assert.equal(record.agent, 'claude');
        assert.equal(record.reason, variant === 'lost' ? 'attach-timeout' : variant === 'null' ? 'hub-registration-rejected' : 'hub-registration-failed');
        await waitWithDeadline(hub.closed, 8500, 'empty fake hub did not exit after its idle interval');
        assert.equal(hub.clients.size, 0);
      } finally {
        await run.kill();
        await hub.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it('unregisters again when the hub applies a registration after fail-open cleanup', async t => {
    const home = mkHome();
    const binDir = path.join(home, 'bin');
    installFakeAgent(binDir, 'claude');
    const capture = path.join(home, 'agent.json');
    const hub = await startFakeHub(home, 'delayed-apply');
    const run = spawnCli(home, binDir, hub.port, ['claude', '--print', 'late registration'], {
      CCXRAY_ATTACH_TIMEOUT_MS: '120',
      FAKE_AGENT_CAPTURE: capture,
      FAKE_AGENT_DELAY_MS: '2400',
      FAKE_AGENT_EXIT_CODE: '25',
    }, t);
    t.after(async () => {
      await run.kill();
      await hub.close();
      fs.rmSync(home, { recursive: true, force: true });
    });

    await waitFor(() => hub.registrations.includes(run.child.pid), 3000, 'fake hub did not receive registration');
    const result = await run.wait(5000);
    assert.equal(result.code, 25, run.output().stderr);
    assert.equal(hub.clients.has(run.child.pid), false, 'late success must trigger a second unregister');
    assert.ok(hub.unregisters.filter(pid => pid === run.child.pid).length >= 2, 'late registration must be unregistered again');
  });

  for (const { signal, expectedCode } of [
    { signal: 'SIGTERM', expectedCode: 1 },
    { signal: 'SIGINT', expectedCode: 130 },
    { signal: 'SIGHUP', expectedCode: 1 },
  ]) {
    it(`does not fail open after ${signal} starts shutdown during registration`, async t => {
      const home = mkHome();
      const binDir = path.join(home, 'bin');
      installFakeAgent(binDir, 'claude');
      const capture = path.join(home, 'agent.json');
      const hub = await startFakeHub(home, 'hold');
      const run = spawnCli(home, binDir, hub.port, ['claude', '--sentinel'], {
        CCXRAY_ATTACH_TIMEOUT_MS: '300',
        FAKE_AGENT_CAPTURE: capture,
        FAKE_AGENT_DELAY_MS: '3000',
      }, t);
      t.after(async () => {
        await run.kill();
        await hub.close();
        fs.rmSync(home, { recursive: true, force: true });
      });

      await waitFor(() => hub.registrations.includes(run.child.pid), 3000, 'fake hub did not receive registration');
      run.child.kill(signal);
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.equal(fs.existsSync(capture), false, 'shutdown must cancel the attach fallback');
      assert.equal(fs.existsSync(path.join(home, 'fail-open.log')), false);

      const result = await run.wait(3000);
      assert.equal(result.code, expectedCode, run.output().stderr);
      assert.equal(result.signal, null);
    });
  }

  it('fails open after standalone bind failure and preserves child exit/signal codes', async t => {
    const occupied = await reserveConsecutivePorts(11);
    const home = mkHome();
    const binDir = path.join(home, 'bin');
    installFakeAgent(binDir, 'claude');
    try {
      const capture = path.join(home, 'agent.json');
      const run = spawnCli(home, binDir, occupied.base,
        ['--port', String(occupied.base), 'claude', '--model', 'fixture-model'], {
          FAKE_AGENT_CAPTURE: capture,
          FAKE_AGENT_EXIT_CODE: '37',
          PASSTHROUGH_MARKER: 'unchanged',
        }, t);
      const result = await run.wait(5000);
      assert.equal(result.code, 37, run.output().stderr);
      assert.match(run.output().stderr, /fail-open: server-start-failed/);
      const child = JSON.parse(fs.readFileSync(capture, 'utf8'));
      assert.deepEqual(child.args, ['--model', 'fixture-model']);
      assert.equal(child.anthropicBaseUrl, null, 'fallback must not inject the proxy URL');
      assert.equal(child.anthropicCustomHeaders, null, 'fallback must not inject ccxray auth headers');
      assert.equal(child.hubClientPid, null, 'fallback must not inject the hub route');
      assert.equal(child.marker, 'unchanged');
      assert.equal(readFailOpen(home)[0].reason, 'server-start-failed');

      const signalHome = mkHome();
      const signalCapture = path.join(signalHome, 'agent.json');
      try {
        const signaled = spawnCli(signalHome, binDir, occupied.base,
          ['--port', String(occupied.base), 'claude', '--signal-case'], {
            FAKE_AGENT_CAPTURE: signalCapture,
            FAKE_AGENT_SIGNAL: 'SIGINT',
          }, t);
        const signalResult = await signaled.wait(5000);
        assert.equal(signalResult.code, 130, signaled.output().stderr);
        assert.equal(signalResult.signal, null);
      } finally {
        fs.rmSync(signalHome, { recursive: true, force: true });
      }

      const closedHome = mkHome();
      const closedCapture = path.join(closedHome, 'agent.json');
      try {
        const closed = spawnCli(closedHome, binDir, occupied.base,
          ['--port', String(occupied.base), 'claude', '--must-not-run'], {
            CCXRAY_FAIL_CLOSED: '1',
            FAKE_AGENT_CAPTURE: closedCapture,
          }, t);
        const closedResult = await closed.wait(5000);
        assert.equal(closedResult.code, 1);
        assert.equal(fs.existsSync(closedCapture), false, 'fail-closed mode must not spawn the original agent');
        assert.equal(fs.existsSync(path.join(closedHome, 'fail-open.log')), false);
      } finally {
        fs.rmSync(closedHome, { recursive: true, force: true });
      }
    } finally {
      await occupied.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('bypasses Claude background flags but ignores values and arguments after --', async t => {
    const home = mkHome();
    const binDir = path.join(home, 'bin');
    installFakeAgent(binDir, 'claude');
    try {
      const bgCapture = path.join(home, 'bg-agent.json');
      const bg = spawnCli(home, binDir, await freePort(), ['claude', '--bg', '--verbose'], {
        FAKE_AGENT_CAPTURE: bgCapture,
        FAKE_AGENT_EXIT_CODE: '19',
      }, t);
      try {
        const bgResult = await bg.wait(5000);
        assert.equal(bgResult.code, 19, bg.output().stderr);
        assert.match(bg.output().stderr, /fail-open: bg-bypass/);
        assert.deepEqual(JSON.parse(fs.readFileSync(bgCapture, 'utf8')).args, ['--bg', '--verbose']);
        assert.equal(readFailOpen(home)[0].reason, 'bg-bypass');
      } finally {
        await bg.kill();
      }

      const backgroundHome = mkHome();
      const backgroundCapture = path.join(backgroundHome, 'agent.json');
      const background = spawnCli(backgroundHome, binDir, await freePort(),
        ['claude', '--background'], {
          FAKE_AGENT_CAPTURE: backgroundCapture,
          FAKE_AGENT_EXIT_CODE: '20',
        }, t);
      try {
        const backgroundResult = await background.wait(5000);
        assert.equal(backgroundResult.code, 20, background.output().stderr);
        assert.match(background.output().stderr, /fail-open: bg-bypass/);
        assert.deepEqual(JSON.parse(fs.readFileSync(backgroundCapture, 'utf8')).args, ['--background']);
        assert.equal(readFailOpen(backgroundHome)[0].reason, 'bg-bypass');
      } finally {
        await background.kill();
        fs.rmSync(backgroundHome, { recursive: true, force: true });
      }

      for (const args of [['--resume', '--bg'], ['-r', '--background']]) {
        const optionalHome = mkHome();
        const optionalCapture = path.join(optionalHome, 'agent.json');
        const optional = spawnCli(optionalHome, binDir, await freePort(), ['claude', ...args], {
          FAKE_AGENT_CAPTURE: optionalCapture,
          FAKE_AGENT_EXIT_CODE: '22',
        }, t);
        try {
          const optionalResult = await optional.wait(5000);
          assert.equal(optionalResult.code, 22, optional.output().stderr);
          assert.match(optional.output().stderr, /fail-open: bg-bypass/);
          assert.deepEqual(JSON.parse(fs.readFileSync(optionalCapture, 'utf8')).args, args);
          assert.equal(readFailOpen(optionalHome)[0].reason, 'bg-bypass');
        } finally {
          await optional.kill();
          fs.rmSync(optionalHome, { recursive: true, force: true });
        }
      }

      for (const args of [['-p', '--bg'], ['--', '--bg']]) {
        const caseHome = mkHome();
        const caseCapture = path.join(caseHome, 'agent.json');
        const port = await freePort();
        const proxied = spawnCli(caseHome, binDir, port,
          ['--port', String(port), 'claude', ...args], {
            FAKE_AGENT_CAPTURE: caseCapture,
            FAKE_AGENT_EXIT_CODE: '21',
          }, t);
        try {
          const result = await proxied.wait(8000);
          assert.equal(result.code, 21, proxied.output().stderr);
          assert.equal(fs.existsSync(path.join(caseHome, 'fail-open.log')), false);
          const child = JSON.parse(fs.readFileSync(caseCapture, 'utf8'));
          assert.deepEqual(child.args, args);
          assert.match(child.anthropicBaseUrl, new RegExp(`^http://localhost:${port}`));
        } finally {
          await proxied.kill();
          fs.rmSync(caseHome, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs an intentional background bypass even when fail-closed is enabled', async t => {
    const home = mkHome();
    const binDir = path.join(home, 'bin');
    installFakeAgent(binDir, 'claude');
    const capture = path.join(home, 'agent.json');
    const run = spawnCli(home, binDir, await freePort(), ['claude', '--bg'], {
      CCXRAY_FAIL_CLOSED: '1',
      FAKE_AGENT_CAPTURE: capture,
      FAKE_AGENT_EXIT_CODE: '26',
    }, t);
    t.after(async () => {
      await run.kill();
      fs.rmSync(home, { recursive: true, force: true });
    });

    const result = await run.wait(5000);
    assert.equal(result.code, 26, run.output().stderr);
    assert.match(run.output().stderr, /fail-open: bg-bypass/);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, ['--bg']);
    assert.equal(readFailOpen(home)[0].reason, 'bg-bypass');
  });
});
