'use strict';

// #555 — port-occupant probe + honest port-conflict messages.
//
// The hub's default port being taken used to produce two lies: an
// unconditional `kill $(lsof -t -i:PORT)` hint (destructive when the occupant
// is a deliberate listener, e.g. a long-running standalone `ccxray --port
// 5577`), and `ccxray status` reporting a bare "No hub running." while the
// port was held. These tests cover the probe, the shared message composer,
// and both end-to-end surfaces.
//
// Isolation (docs/testing.md): every spawn gets a throwaway CCXRAY_HOME, a
// throwaway HOME, and CCXRAY_IMPORT_HOMES pinned to an empty dir so the
// importer never scans the developer's real transcripts. Synthetic listeners
// bind port 0 (kernel-assigned) — never the real hub ports.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-port-occupant-'));
const NO_TRANSCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-port-occupant-empty-'));
process.env.CCXRAY_HOME = process.env.CCXRAY_HOME || TEST_HOME; // hub.js reads it at require time

const hub = require('../server/hub');
const SERVER_SCRIPT = path.resolve(__dirname, '..', 'server', 'index.js');

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(NO_TRANSCRIPTS, { recursive: true, force: true });
});

// Wildcard bind, like a real ccxray server: on macOS a listener bound only to
// 127.0.0.1 does NOT make the hub's own wildcard listen(port) fail with
// EADDRINUSE, so a loopback-bound occupant would not reproduce the conflict.
function listen(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, () => resolve(srv));
    srv.on('error', reject);
  });
}

function isolatedEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-port-occupant-run-'));
  return {
    ...process.env,
    HOME: home,
    CCXRAY_HOME: home,
    CCXRAY_IMPORT_HOMES: NO_TRANSCRIPTS,
    BROWSER: 'none',
    ...extra,
  };
}

function runServer(args, env, timeoutMs = 45000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER_SCRIPT, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    // Full-server-boot budget: 45s (the #538/#542 precedent), enforced here
    // rather than by any outer tool timeout.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

describe('#555 probePortOccupant', () => {
  it('classifies a standalone ccxray by its health identity', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'ccxray', pid: 4242, hub: false, version: '9.9.9' }));
    });
    try {
      const occ = await hub.probePortOccupant(srv.address().port);
      assert.equal(occ.kind, 'ccxray-standalone');
      assert.equal(occ.pid, 4242);
    } finally { srv.close(); }
  });

  it('classifies a lockfile-less hub as ccxray-hub', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'ccxray', pid: 77, hub: true }));
    });
    try {
      const occ = await hub.probePortOccupant(srv.address().port);
      assert.equal(occ.kind, 'ccxray-hub');
      assert.equal(occ.pid, 77);
    } finally { srv.close(); }
  });

  it('classifies a bare { ok: true } as an older ccxray-shaped health', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const occ = await hub.probePortOccupant(srv.address().port);
      assert.equal(occ.kind, 'health-ok');
    } finally { srv.close(); }
  });

  it('classifies a non-ccxray HTTP service as foreign-http', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    try {
      const occ = await hub.probePortOccupant(srv.address().port);
      assert.equal(occ.kind, 'foreign-http');
    } finally { srv.close(); }
  });

  it('does not trust an ok-shaped body on a non-200 response', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'ccxray', pid: 1 }));
    });
    try {
      const occ = await hub.probePortOccupant(srv.address().port);
      assert.equal(occ.kind, 'foreign-http');
    } finally { srv.close(); }
  });

  it('classifies a listener that never answers as silent', async () => {
    const srv = await listen(() => { /* accept, never respond */ });
    try {
      const occ = await hub.probePortOccupant(srv.address().port, 300);
      assert.equal(occ.kind, 'silent');
    } finally { srv.close(); }
  });

  it('classifies a closed port as free', async () => {
    const srv = await listen(() => {});
    const port = srv.address().port;
    await new Promise(resolve => srv.close(resolve));
    const occ = await hub.probePortOccupant(port);
    assert.equal(occ.kind, 'free');
  });
});

describe('#555 describePortOccupant message contract', () => {
  const kinds = ['ccxray-standalone', 'ccxray-hub', 'health-ok', 'foreign-http', 'silent'];

  it('never emits the destructive one-shot kill command, for any occupant', () => {
    for (const kind of kinds) {
      const lines = hub.describePortOccupant({ kind, pid: 123 }, 5577).join('\n');
      assert.doesNotMatch(lines, /kill \$\(lsof/, `${kind} must not suggest kill $(lsof …)`);
    }
  });

  it('offers the PROXY_PORT escape hatch for every occupied kind', () => {
    for (const kind of kinds) {
      const lines = hub.describePortOccupant({ kind, pid: 123 }, 5577).join('\n');
      assert.match(lines, /PROXY_PORT/, `${kind} must mention PROXY_PORT`);
    }
  });

  it('names a standalone ccxray occupant with its pid and says it is not a hub', () => {
    const lines = hub.describePortOccupant({ kind: 'ccxray-standalone', pid: 4242 }, 5577).join('\n');
    assert.match(lines, /standalone \(non-hub\) ccxray \(pid 4242\)/);
    assert.match(lines, /cannot be shared as a hub/);
    assert.match(lines, /Leave it running/);
    // grok review P2: hub:false also covers dashboard-only servers, so the
    // message must not claim the occupant was started with --port.
    assert.doesNotMatch(lines, /--port/);
  });

  it('describes an undiscoverable hub without prescribing a restart as the only fix', () => {
    const lines = hub.describePortOccupant({ kind: 'ccxray-hub', pid: 77 }, 5577).join('\n');
    assert.match(lines, /ccxray hub \(pid 77\)/);
    assert.match(lines, /cannot discover/);
    assert.match(lines, /PROXY_PORT/);
  });

  it('shows a copy-pasteable PROXY_PORT form, not shell `set` syntax', () => {
    const lines = hub.describePortOccupant({ kind: 'foreign-http' }, 5577).join('\n');
    assert.match(lines, /PROXY_PORT=5600 ccxray claude/);
    assert.doesNotMatch(lines, /\bset PROXY_PORT\b/);
  });

  it('tells the user not to kill a foreign HTTP service', () => {
    const lines = hub.describePortOccupant({ kind: 'foreign-http' }, 5577).join('\n');
    assert.match(lines, /not ccxray/);
    assert.match(lines, /Do not kill it/);
  });

  it('reserves the kill discussion for the silent kind, gated on user recognition', () => {
    const lines = hub.describePortOccupant({ kind: 'silent' }, 5577).join('\n');
    assert.match(lines, /does not answer HTTP/);
    assert.match(lines, /only if you recognise it/);
  });

  it('returns no lines for free/unknown so callers keep their generic fallback', () => {
    assert.deepEqual(hub.describePortOccupant({ kind: 'free' }, 5577), []);
    assert.deepEqual(hub.describePortOccupant(null, 5577), []);
  });
});

describe('#555 ccxray status names a non-hub occupant', () => {
  it('reports a held default port instead of a bare "No hub running."', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'ccxray', pid: 4242, hub: false }));
    });
    try {
      const port = srv.address().port;
      const result = await runServer(['status'], isolatedEnv({ PROXY_PORT: String(port) }));
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No hub running\./);
      assert.match(result.stdout, new RegExp(`Note: port ${port} is held by a standalone \\(non-hub\\) ccxray \\(pid 4242\\)`));
      assert.match(result.stdout, /PROXY_PORT/);
    } finally { srv.close(); }
  });

  it('stays a plain "No hub running." when the port is genuinely free', async () => {
    const srv = await listen(() => {});
    const port = srv.address().port;
    await new Promise(resolve => srv.close(resolve));
    const result = await runServer(['status'], isolatedEnv({ PROXY_PORT: String(port) }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No hub running\./);
    assert.doesNotMatch(result.stdout, /Note:/);
  });
});

describe('#555 hub bind failure identifies the occupant', () => {
  it('does not advise killing a foreign HTTP occupant, and offers PROXY_PORT', async () => {
    const srv = await listen((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('mine');
    });
    try {
      const port = srv.address().port;
      // The same argv shape forkHub uses; the retry loop alone takes ~5s.
      const result = await runServer(['--port', String(port), '--hub-mode'], isolatedEnv());
      assert.equal(result.timedOut, false, 'hub-mode bind failure must exit, not hang');
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /kill \$\(lsof/, 'must not advise the blind kill');
      assert.match(result.stderr, new RegExp(`Error: port ${port} is held by another HTTP service that is not ccxray`));
      assert.match(result.stderr, /PROXY_PORT/);
    } finally { srv.close(); }
  });
});
