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
      `echo $$ > ${JSON.stringify(agentPidFile)}`,
      "trap 'exit 0' HUP TERM INT",
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

      client.kill('SIGHUP');
      await waitForExit(client);

      const after = await waitFor(async () => {
        const status = await hubStatus(home);
        return status.clients?.every(item => item.pid !== client.pid) ? status : null;
      }, 1500);
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
});
