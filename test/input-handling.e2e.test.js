'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function request(port, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      let text = ''; res.on('data', d => { text += d; });
      res.once('end', () => resolve({ status: res.statusCode, text }));
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.end(body);
  });
}

it('URL input validation and same-origin check for dashboard writes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-input-handling-'));
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'index.ndjson'), '');
  fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
  let child, done;
  const stop = async () => {
    if (!child) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await done; } finally { clearTimeout(timer); }
  };
  try {
    const reserve = http.createServer();
    const port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const env = { ...process.env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: logs,
      CLAUDE_CONFIG_DIR: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
      CCXRAY_PRICING_CACHE: path.join(home, 'pricing.json'), RESTORE_DAYS: '0' };
    delete env.CCXRAY_LOOPBACK_REQUIRE_AUTH;
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--no-browser'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await request(port, '/_api/health')).status === 200) { ready = true; break; } } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, output);

    for (const [url, method] of [
      ['/_api/session/%FF/entries', 'GET'], ['/_api/entry/%FF', 'GET'], ['/_api/tokens/%FF', 'GET'],
      ['/_api/intercept/%FF/approve', 'POST'], ['/_api/intercept/%FF/reject', 'POST'],
    ]) {
      const r = await request(port, url, { method });
      assert.equal(r.status, 400, `${method} ${url}`);
    }
    assert.equal((await request(port, '/_api/entries?limit=1')).status, 200, 'still serving');

    const json = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ statusLine: false });
    const cross = await request(port, '/_api/settings', { method: 'POST', body,
      headers: { 'Content-Type': 'text/plain', Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(cross.status, 403);
    const badOrigin = await request(port, '/_api/settings', { method: 'POST', body,
      headers: { ...json, Origin: 'https://example.com' } });
    assert.equal(badOrigin.status, 403);
    const wrongType = await request(port, '/_api/settings', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } });
    assert.equal(wrongType.status, 415);
    const noOrigin = await request(port, '/_api/settings', { method: 'POST', body, headers: json });
    assert.equal(noOrigin.status, 200);
    const sameOrigin = await request(port, '/_api/settings', { method: 'POST', body,
      headers: { ...json, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(sameOrigin.status, 200);
    const aliasOrigin = await request(port, '/_api/settings', { method: 'POST', body,
      headers: { ...json, Origin: `http://localhost:${port}` } });
    assert.equal(aliasOrigin.status, 200);
    const otherPort = await request(port, '/_api/settings', { method: 'POST', body,
      headers: { ...json, Origin: `http://127.0.0.1:${port + 1}` } });
    assert.equal(otherPort.status, 403);
    const tokenOtherPort = await request(port, '/_auth/bootstrap-token', { method: 'POST',
      headers: { Origin: `http://localhost:${port + 1}` } });
    assert.equal(tokenOtherPort.status, 403);
    assert.equal((await request(port, '/_api/health')).status, 200);
  } finally {
    await stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
