'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');
const PACKAGE = require('../package.json');
const { occupyLoopbackPort } = require('./helpers/occupy-port');

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
        await occupyLoopbackPort(server, base + i);
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
  if (process.platform === 'win32') {
    const npmPackage = command === 'claude' ? '@anthropic-ai/claude-code'
      : command === 'codex' ? '@openai/codex' : null;
    if (!npmPackage) throw new Error(`Windows fake npm layout is not defined for ${command}`);
    const packageDir = path.join(binDir, 'node_modules', ...npmPackage.split('/'));
    const target = path.join(packageDir, 'bin', `${command}.exe`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { [command]: `bin/${command}.exe` } }));
    fs.copyFileSync(process.execPath, target);
    fs.writeFileSync(path.join(binDir, `${command}.cmd`), `@echo off\r\n"%dp0%\\node_modules\\${npmPackage.replace(/\//g, '\\')}\\bin\\${command}.exe" %*\r\n`);
    const script = path.join(binDir, `${command}.js`);
    fs.writeFileSync(script, `
'use strict';
const fs = require('fs');
const capture = {
  argv1: process.argv[1],
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
    return script;
  }
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

function fakeNpmAgentPaths(binDir, command = 'claude') {
  const npmPackage = command === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
  return {
    shim: path.join(binDir, `${command}.cmd`),
    packageJson: path.join(binDir, 'node_modules', ...npmPackage.split('/'), 'package.json'),
    target: path.join(binDir, 'node_modules', ...npmPackage.split('/'), 'bin', `${command}.exe`),
  };
}

function cliEnv(home, binDir, port, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CCXRAY_')) delete env[key];
  }
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  delete env.CCXRAY_HUB_CLIENT_PID;
  const inheritedPathKey = Object.keys(env).sort().find(key => key.toUpperCase() === 'PATH');
  const inheritedPath = inheritedPathKey === undefined ? '' : env[inheritedPathKey];
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  Object.assign(env, {
    CCXRAY_HOME: home,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'),
    BROWSER: 'none',
    CI: '1',
    PATH: `${binDir}${path.delimiter}${inheritedPath || ''}`,
    PROXY_PORT: String(port),
    ...extra,
  });
  return env;
}

function spawnCli(home, binDir, port, args, extraEnv = {}, testContext, { injectWindowsAgentScript = true } = {}) {
  const invocationArgs = [...args];
  if (process.platform === 'win32' && injectWindowsAgentScript) {
    const commandIndex = invocationArgs.findIndex(arg => ['claude', 'codex', 'grok'].includes(arg));
    if (commandIndex >= 0) invocationArgs.splice(commandIndex + 1, 0, path.join(binDir, `${invocationArgs[commandIndex]}.js`));
  }
  const child = spawn(process.execPath, [SERVER, ...invocationArgs], {
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
  const messages = [];
  const events = [];
  const recordEvent = (type, message) => events.push({ type, at: Date.now(), pid: message.pid, order: events.length });
  let idleTimer = null;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const sockPath = path.join(home, 'fake-hub.sock');
  const startIdle = () => {
    if (clients.size || idleTimer) return;
    idleTimer = setTimeout(() => server.close(resolveClosed), 5000);
  };
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.end('{"error":"parse_error"}\n'); continue; }
        messages.push(message);
        if (message.cmd === 'health') {
          recordEvent('health', message);
          socket.write('{"ok":true}\n');
          if (variant === 'error') setImmediate(() => server.close());
          continue;
        }
        if (message.cmd === 'register') {
          recordEvent('register', message);
          registrations.push(message);
          if (variant === 'hold') continue;
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
          clients.add(message.pid);
          if (variant === 'lost' || variant === 'timeout-as-error') continue;
          if (variant === 'eof') { socket.destroy(); continue; }
          if (variant === 'null') { socket.write('null\n'); continue; }
          if (variant === 'delayed-reply') {
            setTimeout(() => {
              socket.write('{"ok":true,"firstClient":false}\n', () => recordEvent('register-reply', message));
            }, 1300);
            continue;
          }
          socket.write('{"ok":true,"firstClient":false}\n', () => recordEvent('register-reply', message));
          continue;
        }
        if (message.cmd === 'unregister') {
          recordEvent('unregister', message);
          unregisters.push(message);
          clients.delete(message.pid);
          socket.write('{"ok":true}\n');
          startIdle();
        }
      }
    });
  });
  server.once('close', () => resolveClosed());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({
    pid: process.pid,
    port,
    version,
    sockPath,
  }));
  startIdle();
  return {
    port,
    sockPath,
    clients,
    registrations,
    unregisters,
    messages,
    events,
    closed,
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      if (server.listening) await new Promise(resolve => server.close(resolve));
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
  it('closes a ready hub that never gets a client', { skip: process.platform === 'win32' }, async t => {
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
    it(`falls back to the plain ${provider} command on a major version mismatch`, { skip: process.platform === 'win32' }, async t => {
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

  for (const variant of ['lost', 'null', 'eof', 'error', 'timeout-as-error']) {
    it(`fails open and unregisters when the registration reply is ${variant}`, { skip: process.platform === 'win32' }, async t => {
      const home = mkHome();
      const binDir = path.join(home, 'bin');
      installFakeAgent(binDir, 'claude');
      const capture = path.join(home, 'agent.json');
      const hub = await startFakeHub(home, variant);
      const run = spawnCli(home, binDir, hub.port, ['claude', '--print', 'fixture prompt'], {
        CCXRAY_ATTACH_TIMEOUT_MS: variant === 'timeout-as-error' ? '4000' : '120',
        FAKE_AGENT_CAPTURE: capture,
        FAKE_AGENT_DELAY_MS: '1800',
        FAKE_AGENT_EXIT_CODE: '24',
      }, t);
      try {
        if (variant !== 'error') {
          await waitFor(() => hub.registrations.some(message => message.pid === run.child.pid), 3000, 'fake hub did not receive registration');
        }
        const result = await run.wait(9000);
        assert.equal(result.code, 24, run.output().stderr);
        assert.match(run.output().stderr, /fail-open:/);
        assert.equal(hub.clients.has(run.child.pid), false, 'late registration must be unregistered');
        const unregisterMessages = hub.unregisters.filter(message => message.pid === run.child.pid);
        const registerMessages = hub.registrations.filter(message => message.pid === run.child.pid);
        if (variant === 'error') {
          assert.equal(registerMessages.length, 0, 'the listener closes after health and refuses the registration connection');
          assert.equal(unregisterMessages.length, 0, 'no socket server remains to receive the cleanup request');
        } else {
          assert.ok(unregisterMessages.length >= 1, 'fallback should send unregister after registration settles or times out');
          assert.ok(registerMessages.length >= 1);
          assert.match(registerMessages[0].token, /^[0-9a-f]{16}$/);
          assert.ok(unregisterMessages.every(message => message.token === registerMessages[0].token));
          if (variant === 'lost') {
            const registerEvent = hub.events.find(event => event.type === 'register' && event.pid === run.child.pid);
            const unregisterEvent = hub.events.find(event => event.type === 'unregister' && event.pid === run.child.pid);
            assert.ok(registerEvent && unregisterEvent, 'fake hub must record registration and cleanup socket events');
            assert.ok(unregisterEvent.at - registerEvent.at >= 2000,
              `lost registration reply must settle before unregister; delay was ${unregisterEvent.at - registerEvent.at}ms`);
          }
        }
        assert.ok(hub.messages.filter(message => message.cmd === 'health').every(message => !Object.hasOwn(message, 'token')));
        assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')).args, ['--print', 'fixture prompt']);
        const record = readFailOpen(home)[0];
        assert.equal(record.agent, 'claude');
        const expectedReason = variant === 'lost' || variant === 'eof' ? 'attach-timeout'
          : variant === 'null' ? 'hub-registration-rejected' : 'hub-registration-failed';
        assert.equal(record.reason, expectedReason);
        await waitWithDeadline(hub.closed, 10000, 'empty fake hub did not exit after its idle interval');
        assert.equal(hub.clients.size, 0);
      } finally {
        await run.kill();
        await hub.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it('waits for a delayed registration reply, then unregisters exactly once', { skip: process.platform === 'win32' }, async t => {
    const home = mkHome();
    const binDir = path.join(home, 'bin');
    installFakeAgent(binDir, 'claude');
    const capture = path.join(home, 'agent.json');
    const hub = await startFakeHub(home, 'delayed-reply');
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

    await waitFor(() => hub.registrations.some(message => message.pid === run.child.pid), 3000, 'fake hub did not receive registration');
    const result = await run.wait(5000);
    assert.equal(result.code, 25, run.output().stderr);
    assert.equal(hub.clients.has(run.child.pid), false, 'delayed registration must be removed before fallback exits');
    assert.equal(hub.unregisters.filter(message => message.pid === run.child.pid).length, 1, 'cleanup follows the delayed reply with one unregister');
    const replyEvent = hub.events.find(event => event.type === 'register-reply' && event.pid === run.child.pid);
    const unregisterEvent = hub.events.find(event => event.type === 'unregister' && event.pid === run.child.pid);
    assert.ok(replyEvent && unregisterEvent, 'fake hub must record the reply and cleanup socket events');
    assert.ok(replyEvent.order < unregisterEvent.order, 'unregister must arrive after the delayed registration reply');
    assert.ok(unregisterEvent.at >= replyEvent.at, 'unregister timestamp must not precede the delayed registration reply');
  });

  for (const { signal, expectedCode } of [
    { signal: 'SIGTERM', expectedCode: 1 },
    { signal: 'SIGINT', expectedCode: 130 },
    { signal: 'SIGHUP', expectedCode: 1 },
  ]) {
    it(`does not fail open after ${signal} starts shutdown during registration`, { skip: process.platform === 'win32' }, async t => {
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

      await waitFor(() => hub.registrations.some(message => message.pid === run.child.pid), 3000, 'fake hub did not receive registration');
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

      if (process.platform !== 'win32') {
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

  it('applies the Claude background bypass and commander terminator rule', async t => {
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

      for (const args of [['-p', '--bg']]) {
        const bypassHome = mkHome();
        const bypassCapture = path.join(bypassHome, 'agent.json');
        const bypass = spawnCli(bypassHome, binDir, await freePort(), ['claude', ...args], {
          FAKE_AGENT_CAPTURE: bypassCapture,
          FAKE_AGENT_EXIT_CODE: '21',
        }, t);
        try {
          const result = await bypass.wait(5000);
          assert.equal(result.code, 21, bypass.output().stderr);
          assert.match(bypass.output().stderr, /fail-open: bg-bypass/);
          assert.deepEqual(JSON.parse(fs.readFileSync(bypassCapture, 'utf8')).args, args);
          assert.equal(readFailOpen(bypassHome)[0].reason, 'bg-bypass');
        } finally {
          await bypass.kill();
          fs.rmSync(bypassHome, { recursive: true, force: true });
        }
      }

      for (const args of [['--', '--bg']]) {
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

describe('Windows direct executable failures', () => {
  it('reports placeholder, unsupported wrapper, and invalid-image failures once', { skip: process.platform !== 'win32' }, async t => {
    for (const variant of ['placeholder', 'wrapper', 'no-package', 'invalid-image']) {
      const home = mkHome();
      const binDir = path.join(home, 'bin');
      installFakeAgent(binDir, 'claude');
      const files = fakeNpmAgentPaths(binDir);
      if (variant === 'placeholder') fs.writeFileSync(files.target, 'text placeholder');
      if (variant === 'wrapper') fs.writeFileSync(files.shim, '@echo off\r\nset FOO=1\r\n"C:\\other\\claude.exe" %*\r\n');
      if (variant === 'no-package') fs.unlinkSync(files.packageJson);
      if (variant === 'invalid-image') fs.writeFileSync(files.target, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096)]));
      const port = await freePort();
      const run = spawnCli(home, binDir, port, ['--port', String(port), 'claude', '--version'], {}, t);
      try {
        const result = await run.wait(8000);
        const stderr = run.output().stderr;
        assert.equal(result.code, 1, stderr);
        assert.equal(result.signal, null);
        assert.doesNotMatch(stderr, /^\s+at /m, 'spawn failure must not escape as an uncaught stack trace');
        if (variant === 'placeholder') assert.match(stderr, /install\.cjs/);
        if (variant === 'wrapper' || variant === 'no-package') assert.match(stderr, /batch-file wrapper/);
        if (variant === 'invalid-image') {
          assert.equal((stderr.match(/Failed to start claude:/g) || []).length, 1);
        }
        assert.equal(fs.existsSync(path.join(home, 'fail-open.log')), false);
      } finally {
        await run.kill();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });
});

describe('Windows launcher argv round trip', () => {
  it('preserves special argv bytes through server/index.js and exits with the child code', { skip: process.platform !== 'win32' }, async t => {
    const home = mkHome('ccxray-win-argv-');
    const binDir = path.join(home, 'npm');
    installFakeAgent(binDir, 'claude');
    const echoScript = path.join(home, 'echo.js');
    const capture = path.join(home, 'argv.json');
    fs.writeFileSync(echoScript, "require('fs').writeFileSync(process.env.FAKE_AGENT_CAPTURE, JSON.stringify({ argv1: process.argv[1], args: process.argv.slice(2) })); process.exit(37);\n");
    const agentArgs = ['-p', 'multi\nline', '%PATH%', 'a&b|c<d>e', '^', '!y', 'say "hi"', '', 'trail\\'];
    const port = await freePort();
    const run = spawnCli(home, binDir, port, ['--port', String(port), 'claude', echoScript, ...agentArgs], {
      FAKE_AGENT_CAPTURE: capture,
    }, t, { injectWindowsAgentScript: false });
    try {
      const result = await run.wait(10000);
      assert.equal(result.code, 37, run.output().stderr);
      assert.equal(result.signal, null);
      const child = JSON.parse(fs.readFileSync(capture, 'utf8'));
      assert.equal(child.argv1, echoScript);
      assert.deepEqual(child.args, agentArgs);
    } finally {
      await run.kill();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
