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
function request(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}
it('unmatched internal APIs return 404 without upstream calls or recorded turns', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-internal-api-'));
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'index.ndjson'), '');
  fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push(req.url); req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"synthetic":true}');
  });
  let child, done;
  const stop = async () => {
    if (!child) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await done; } finally { clearTimeout(timer); }
  };
  try {
    const upstreamPort = await listen(upstream);
    const reserve = http.createServer();
    const port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--no-browser'], {
      env: { ...process.env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: logs,
        CLAUDE_CONFIG_DIR: home, CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
        CCXRAY_PRICING_CACHE: path.join(home, 'pricing.json'), RESTORE_DAYS: '0',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if (await request(port, '/_api/health') === 200) { ready = true; break; } } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, output);
    assert.equal(await request(port, '/_api/entries?limit=1'), 200, 'registered APIs still work');
    const statuses = [];
    for (const [url, method] of [['/_api/telemetry/does-not-exist', 'GET'], ['/_api/missing?probe=1', 'POST']]) {
      statuses.push(await request(port, url, method));
    }
    await stop(); child = null;
    assert.deepEqual({ statuses, received,
      index: fs.readFileSync(path.join(logs, 'index.ndjson'), 'utf8'),
      artifacts: fs.readdirSync(logs).filter(f => /_(req|res)\.json$/.test(f)),
    }, { statuses: [404, 404], received: [], index: '', artifacts: [] });
  } finally {
    await stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
