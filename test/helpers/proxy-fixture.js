'use strict';
// Test-only: an isolated ccxray proxy in front of a mock Anthropic upstream.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', '..', 'server', 'index.js');

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

const getJson = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, r => {
    let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

const postMessages = (port, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' } },
  x => { let s = ''; x.on('data', c => s += c); x.on('end', () => res(x.statusCode)); });
  r.on('error', rej); r.end(d);
});

// env: extra child env. Returns { port, home, logs, child, getJson, post, stop }.
async function startProxy({ env = {}, home } = {}) {
  const ownHome = !home;
  home = home || fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fixture-'));
  fs.chmodSync(home, 0o700);
  let n = 0;
  const upstream = http.createServer((q, r) => { q.resume(); q.on('end', () => {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ id: `msg_fx_${++n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }));
  }); });
  const upPort = await freePort();
  await new Promise(r => upstream.listen(upPort, '127.0.0.1', r));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--no-browser'], {
    env: { ...process.env, ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upPort), ANTHROPIC_TEST_PROTOCOL: 'http',
      CCXRAY_HOME: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1', BROWSER: 'none', ...env },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { await getJson(port, '/_api/health'); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  const exited = new Promise(r => child.once('exit', r));
  return {
    port, home, logs: path.join(home, 'logs'), child, exited,
    getJson: p => getJson(port, p), post: body => postMessages(port, body),
    async stop() {
      if (child.exitCode === null) child.kill('SIGKILL');
      upstream.close();
      if (ownHome) fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// Preload the slow-gzip helper in the child, next to home-guard.
const slowGzipEnv = (ms, match) => ({
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(path.join(__dirname, 'slow-gzip.js'))}`.trim(),
  CCXRAY_TEST_SLOW_GZIP_MS: String(ms),
  CCXRAY_TEST_SLOW_GZIP_MATCH: match || '',
});

module.exports = { startProxy, slowGzipEnv, freePort };
