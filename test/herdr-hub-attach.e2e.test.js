'use strict';

// #673: a Herdr plugin launch that finds a running hub must keep it alive.
//
// The plugin starts agents natively (`herdr agent start`), so nothing it
// launches ever registers with the hub. A hub with no registered clients
// idle-exits IDLE_TIMEOUT_MS (5s) later and deletes hub.json — while the agent
// it just handed the hub's port to is still running. The next plugin launch
// then finds no hub and starts a standalone `--no-browser` server on the same
// port: the hub has been "replaced by a standalone".
//
// Asserted against a real `--hub-mode` process with no other clients, so the
// hub's own idle timer is armed when the launch happens.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'herdr');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_api/health`);
    return await res.json();
  } catch {
    return null;
  }
}

// Only what launch-agent needs from the real env; HERDR_*/CCXRAY_*/PROXY_PORT
// from the developer's shell must not leak in.
function baseEnv(home, port) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('HERDR_') || key.startsWith('CCXRAY_') || key === 'PROXY_PORT'
      || key.startsWith('ANTHROPIC_') || key.startsWith('OPENAI_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    CCXRAY_HOME: path.join(home, '.ccxray'),
    PROXY_PORT: String(port),
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    BROWSER: 'none',
  };
}

function fakeHerdr(dir, shellPid) {
  const bin = path.join(dir, 'herdr');
  const opened = { id: 't', result: { type: 'tab_created', root_pane: { pane_id: 'w1:p7' }, tab: { tab_id: 'w1:t2' } } };
  const info = { id: 'i', result: { type: 'pane_process_info', process_info: { pane_id: 'w1:p7', shell_pid: shellPid, foreground_processes: [] } } };
  const agentOk = { id: 'a', result: { type: 'agent_started', agent: { agent: 'claude', pane_id: 'w1:p7' } } };
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    'const [a, b] = process.argv.slice(2);',
    `if (a === 'agent' && b === 'start') { process.stdout.write(${JSON.stringify(JSON.stringify(agentOk) + '\n')}); process.exit(0); }`,
    `if (a === 'pane' && b === 'process-info') { process.stdout.write(${JSON.stringify(JSON.stringify(info) + '\n')}); process.exit(0); }`,
    `if (a === 'tab' && b === 'create') { process.stdout.write(${JSON.stringify(JSON.stringify(opened) + '\n')}); process.exit(0); }`,
    "process.stdout.write('{\"result\":{\"ok\":true}}\\n');",
    '',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe('#673 holdHubForPane only touches a hub on the launch port', () => {
  // A standalone writes no hub.json and has no client registry: the plugin
  // keeps reusing it as before, and must not ask Herdr for anything.
  it('is a no-op without a hub lockfile or for a hub on another port', () => {
    const { holdHubForPane } = require('../plugins/herdr/bin/lib/ccxray');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-673-nohub-'));
    try {
      const env = { ...baseEnv(home, 5999), HERDR_BIN_PATH: path.join(home, 'no-such-herdr') };
      assert.deepEqual(holdHubForPane({ env, port: 5999, paneId: 'w1:p1' }), { ok: false, reason: 'no hub' });
      fs.mkdirSync(env.CCXRAY_HOME, { recursive: true });
      fs.writeFileSync(path.join(env.CCXRAY_HOME, 'hub.json'),
        JSON.stringify({ port: 5577, pid: 1, sockPath: path.join(env.CCXRAY_HOME, 'hub.sock') }));
      assert.equal(holdHubForPane({ env, port: 5999, paneId: 'w1:p1' }).ok, false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('#673 Herdr launch keeps a running hub', () => {
  it('registers the launched pane so the hub does not idle-exit and get replaced', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-673-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-673-project-'));
    const port = await freePort();
    const env = baseEnv(home, port);
    const lock = path.join(env.CCXRAY_HOME, 'hub.json');

    const hub = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js'), '--hub-mode'], {
      env, stdio: 'ignore',
    });
    // Stands in for the shell of the pane Herdr creates for the agent.
    const paneShell = spawn('sleep', ['120'], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !fs.existsSync(lock); i++) await sleep(100);
      assert.ok(fs.existsSync(lock), 'hub should write hub.json');
      const hubPid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid;

      const result = spawnSync(process.execPath, [path.join(PLUGIN, 'bin', 'launch-agent.js'), 'claude'], {
        cwd: PLUGIN,
        env: {
          ...env,
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
            focused_pane_id: 'w1:p1', focused_pane_cwd: project, workspace_id: 'w1', tab_id: 'w1:t1',
          }),
          HERDR_BIN_PATH: fakeHerdr(home, paneShell.pid),
          HERDR_PLUGIN_STATE_DIR: path.join(home, 'plugin-state'),
        },
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`proxy: localhost:${port}`), 'the launch must use the hub port');

      // Outlast the hub's 5s idle timeout with margin.
      await sleep(7000);
      assert.ok(isAlive(hubPid), 'the hub must still be running after the launch');
      assert.ok(fs.existsSync(lock), 'hub.json must be kept');
      const h = await health(port);
      assert.equal(h && h.hub, true, `health must report the hub, got ${JSON.stringify(h)}`);
      assert.equal(h.pid, hubPid, 'the port must still be held by the same hub');
    } finally {
      try { paneShell.kill('SIGKILL'); } catch {}
      try { hub.kill('SIGTERM'); } catch {}
      await sleep(300);
      try { hub.kill('SIGKILL'); } catch {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(project, { recursive: true, force: true }); } catch {}
    }
  });
});
