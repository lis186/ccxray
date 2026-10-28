#!/usr/bin/env node
'use strict';

// Reproducible launch-latency measurement for the launcher shims (#732).
// Everything runs under a temp HOME with a fake `claude` and a loopback fake
// proxy; no real profile, PATH config or ccxray home is touched.
//
//   node scripts/measure-shim-latency.js [runs]     (default 15)
//
// Scenarios: direct (no shim), healthy proxy, proxy down (connection refused),
// slow proxy (answers after 1 s, past the 300 ms health budget). It prints the
// median and max of the wall-clock time from spawn to exit. Numbers depend on
// the machine; this is a measurement aid, not an assertion.

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runWrapBinaries } = require('../server/launcher-shims');

const RUNS = Math.max(3, Number(process.argv[2]) || 15);
const SYSTEM_PATH = '/usr/bin:/bin';

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function once(env, pathDirs) {
  return new Promise(resolve => {
    const t0 = process.hrtime.bigint();
    const child = spawn('claude', ['-p', 'x'], { env: { PATH: [...pathDirs, SYSTEM_PATH].join(':'), ...env }, stdio: 'ignore' });
    child.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
  });
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-latency-')));
  try {
    const home = path.join(root, '.ccxray');
    const realBin = path.join(root, 'real-bin');
    fs.mkdirSync(realBin);
    fs.writeFileSync(path.join(realBin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const quiet = { log() {}, error() {} };
    const code = await runWrapBinaries({ yes: true, shell: 'bash' }, { env: { HOME: root, CCXRAY_HOME: home, SHELL: '/bin/bash', PATH: SYSTEM_PATH }, homedir: () => root, platform: 'linux', logger: quiet });
    if (code !== 0) throw new Error('shim install failed');
    const shims = path.join(home, 'shims');

    const identityRoot = Buffer.alloc(32, 0x42);
    fs.writeFileSync(path.join(home, 'local-secret'), identityRoot, { mode: 0o600 });
    // Keep this fixture's derivation and proof aligned with server/auth.js shimIdentityProof.
    const identityKey = crypto.hkdfSync('sha256', identityRoot, Buffer.alloc(0), Buffer.from('ccxray/v1/shim-identity'), 32);
    let delay = 0;
    const proxy = http.createServer((req, res) => setTimeout(() => {
      const nonce = req.headers['x-ccxray-shim-challenge'];
      const shimProof = nonce && crypto.createHmac('sha256', identityKey)
        .update(`ccxray-shim-identity/v1\n${nonce}\n${req.socket.localPort}`).digest('base64url');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'ccxray', ...(shimProof ? { shimProof } : {}) }));
    }, delay));
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    const closedPort = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
    const base = { HOME: root, CCXRAY_HOME: home };

    const scenarios = [
      ['direct (no shim)', () => ({ ...base }), [realBin]],
      ['shim, healthy proxy', () => ({ ...base, CCXRAY_SHIM_PORT: String(proxy.address().port) }), [shims, realBin], 0],
      ['shim, proxy down', () => ({ ...base, CCXRAY_SHIM_PORT: String(closedPort) }), [shims, realBin], 0],
      ['shim, slow proxy (1 s reply)', () => ({ ...base, CCXRAY_SHIM_PORT: String(proxy.address().port) }), [shims, realBin], 1000],
    ];
    console.log(`node ${process.version}, ${os.platform()} ${os.arch()}, ${RUNS} runs each; times in ms (spawn to exit)`);
    for (const [name, env, dirs, d] of scenarios) {
      delay = d || 0;
      await once(env(), dirs); // warm-up, discarded
      const times = [];
      for (let i = 0; i < RUNS; i++) times.push(await once(env(), dirs));
      console.log(`${name.padEnd(32)} median ${median(times).toFixed(0).padStart(5)}  max ${Math.max(...times).toFixed(0).padStart(5)}`);
    }
    proxy.closeAllConnections?.();
    await new Promise(r => proxy.close(r));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
