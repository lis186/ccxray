'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function hubStatus(home) {
  return new Promise((resolve, reject) => {
    let lock;
    try { lock = JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8')); } catch (error) { reject(error); return; }
    const socket = net.connect(lock.sockPath);
    let body = '';
    const timer = setTimeout(() => socket.destroy(new Error('status timeout')), 500);
    socket.once('connect', () => socket.write('{"cmd":"status"}\n'));
    socket.on('data', chunk => {
      body += chunk;
      if (!body.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(body.trim())); } catch (error) { reject(error); }
    });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
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
}

function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('hub client signal lifecycle', () => {
  it('unregisters immediately when a Herdr pane closes with SIGHUP', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-signal-'));
    const binDir = path.join(home, 'bin');
    const agentPidFile = path.join(home, 'agent.pid');
    fs.mkdirSync(binDir, { recursive: true });
    const claude = path.join(binDir, 'claude');
    fs.writeFileSync(claude, [
      '#!/bin/sh',
      // Trap BEFORE publishing the pid: the test treats the pid file as proof
      // the agent is ready to be closed, and a pid published ahead of the trap
      // would let SIGHUP kill the shell outright — which the client reports as
      // exit 1 rather than the agent's own 0.
      "trap 'exit 0' HUP TERM INT",
      `echo $$ > ${JSON.stringify(agentPidFile)}`,
      'while :; do sleep 1; done',
      '',
    ].join('\n'));
    fs.chmodSync(claude, 0o755);

    const port = await freePort();
    const env = {
      ...process.env,
      BROWSER: 'none',
      CI: '1',
      CCXRAY_HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      PROXY_PORT: String(port),
    };
    const client = spawn(process.execPath, [SERVER, '--no-browser', 'claude'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    client.stdout.on('data', chunk => { stdout += chunk; });
    client.stderr.on('data', chunk => { stderr += chunk; });

    let hubPid = null;
    try {
      let before;
      try {
        before = await waitFor(async () => {
          const status = await hubStatus(home);
          return status.clients?.some(item => item.pid === client.pid) ? status : null;
        });
      } catch (error) {
        throw new Error(`${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`);
      }
      hubPid = before.pid;

      // The premise is "a pane RUNNING AN AGENT is closed". Without this wait
      // the kill lands while the client is still between registerClient() and
      // its signal handlers, so the assertion below was measuring that window
      // rather than the unregister path (and the fake agent never even ran).
      await waitFor(() => {
        const pid = Number(fs.readFileSync(agentPidFile, 'utf8').trim());
        return pid > 0 && pidAlive(pid);
      });

      client.kill('SIGHUP');
      await waitForExit(client);

      // Half of a pair with test/client-shutdown.test.js: with an agent running
      // the client passes through the agent's exit code, and the agent handles
      // SIGHUP and exits 0. The other half asserts the no-agent path exits 0
      // too, so closing a pane reports the same code on both sides of the
      // register→spawn window.
      assert.equal(client.exitCode, 0);
      assert.equal(client.signalCode, null);

      const after = await waitFor(async () => {
        const status = await hubStatus(home);
        return status.clients?.every(item => item.pid !== client.pid) ? status : null;
      }, 3000);
      assert.equal(after.clients.some(item => item.pid === client.pid), false);
    } finally {
      if (client.exitCode == null && client.signalCode == null) client.kill('SIGKILL');
      try {
        const agentPid = Number(fs.readFileSync(agentPidFile, 'utf8'));
        if (agentPid > 0) process.kill(agentPid, 'SIGKILL');
      } catch {}
      if (hubPid) {
        try { process.kill(hubPid, 'SIGTERM'); } catch {}
        try { await waitFor(() => !pidAlive(hubPid), 3000); } catch {}
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // The test above deliberately fires AFTER the agent is up, so it does not
  // cover the window this work exists to close. A real hub registers in about a
  // millisecond, which is not something a test can aim at — but nothing says the
  // hub has to be real. This one speaks the hub's socket protocol itself and
  // simply does not answer `register` until told to, which makes the window as
  // wide as the test wants without a single test-only branch in the server.
  it('unregisters and never spawns when the pane closes mid-registration', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-midreg-'));
    const binDir = path.join(home, 'bin');
    const agentMarker = path.join(home, 'agent-ran');
    fs.mkdirSync(binDir, { recursive: true });
    const claude = path.join(binDir, 'claude');
    // Publishes its pid, so that when this assertion FAILS the orphan it caught
    // can be cleaned up. Left running it inherits the client's stdio pipes and
    // the test runner never exits — a hang instead of a red test.
    fs.writeFileSync(claude, [
      '#!/bin/sh',
      `echo $$ > ${JSON.stringify(agentMarker)}`,
      'while :; do sleep 1; done',
      '',
    ].join('\n'));
    fs.chmodSync(claude, 0o755);

    const sockPath = path.join(home, 'fake-hub.sock');
    const commands = [];
    let releaseRegister = null;

    const hub = net.createServer(socket => {
      let buf = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          commands.push(msg.cmd);
          if (msg.cmd === 'health') socket.write(JSON.stringify({ ok: true }) + '\n');
          // Held, not dropped: the client is mid-`await registerClient()`.
          if (msg.cmd === 'register') {
            releaseRegister = () => socket.write(JSON.stringify({ ok: true, firstClient: false }) + '\n');
          }
          // Deliberately NOT answered. The client bounds this wait itself and
          // leaves on its deadline; holding it keeps the process alive long
          // enough for a missing spawn gate to actually produce an agent.
          if (msg.cmd === 'unregister') { /* held */ }
        }
      });
    });
    await new Promise(resolve => hub.listen(sockPath, resolve));

    // A lockfile the client will believe: our own pid is alive, and the version
    // has to match or checkVersionCompat rejects before any of this runs.
    fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify({
      pid: process.pid,
      port: await freePort(),
      sockPath,
      version: require('../package.json').version,
    }));

    const client = spawn(process.execPath, [SERVER, '--no-browser', 'claude'], {
      env: {
        ...process.env,
        BROWSER: 'none',
        CI: '1',
        CCXRAY_HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        PROXY_PORT: String(await freePort()),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    client.stdout.on('data', () => {});
    client.stderr.on('data', () => {});

    try {
      await waitFor(() => commands.includes('register'));

      // The pane closes while the hub still owes us a registration reply.
      client.kill('SIGHUP');
      await new Promise(resolve => setTimeout(resolve, 150));

      // Unregistering before the register lands would let the hub apply them in
      // that order and keep a pid that has already exited.
      assert.equal(commands.includes('unregister'), false, 'must not race the register round trip');

      releaseRegister();

      // The client attached its `await registerClient()` continuation before the
      // shutdown attached its own, so the main flow — including the point where
      // it would spawn the agent — has already run by the time this arrives.
      await waitFor(() => commands.includes('unregister'), 5000);

      // Leaves on UNREGISTER_DEADLINE_MS, since the reply is being withheld.
      await waitForExit(client, 5000);

      // A spawned `sh` needs to be scheduled before it writes its marker, so
      // checking the instant the parent dies would pass whether or not one was
      // started. This is the assertion that fails when the spawn gate is gone.
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(fs.existsSync(agentMarker), false, 'the agent was spawned into a process that was already leaving');
    } finally {
      if (client.exitCode == null && client.signalCode == null) client.kill('SIGKILL');
      try {
        const stray = Number(fs.readFileSync(agentMarker, 'utf8'));
        if (stray > 0) process.kill(stray, 'SIGKILL');
      } catch {}
      hub.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
