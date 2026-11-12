'use strict';

// #774: prune's re-anchor scan (delta-helpers classifyReqHead) classifies a
// `_req.json` whose depth-1 "messages" key precedes any depth-1 "prevId" as a
// FULL record. That is only sound while the writer emits prevId/msgOffset BEFORE
// messages and never lets an extra request param inject a top-level "messages".
// This pins the order through the REAL writer path: two live requests through a
// child proxy, then the bytes on disk.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { readLogText } = require('./helpers/read-log');
const { spawn } = require('node:child_process');
const { classifyReqHead } = require('../server/delta-helpers');

const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

function post(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'anthropic-version': '2023-06-01' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.once('end', () => resolve({ status: res.statusCode, data }));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.end(payload);
  });
}

describe('delta writer key order (#774 classifyReqHead invariant)', () => {
  let home, upstream, child, done, port, output = '';
  let n = 0;

  async function waitFor(check) {
    for (let i = 0; i < 100; i++) {
      const result = await check();
      if (result) return result;
      if (child?.exitCode !== null) throw new Error(`proxy exited: ${output}`);
      await delay(50);
    }
    throw new Error(`proxy condition timed out: ${output}`);
  }

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-writer-order-'));
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs/index.ndjson'), '');
    fs.writeFileSync(path.join(home, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));
    upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: `msg_order_${++n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 },
        }));
      });
    });
    const upstreamPort = await listen(upstream);
    const reserve = http.createServer();
    port = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|XAI_|GROK_)/.test(key)) delete env[key];
    }
    delete env.STORAGE_BACKEND;
    delete env.PROXY_HOST;
    child = spawn(process.execPath, [path.join(__dirname, '../server/index.js'), '--port', String(port), '--no-browser'], {
      env: { ...env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs'), CLAUDE_CONFIG_DIR: home,
        CCXRAY_IMPORT_DISABLE: '1', CCXRAY_EXPORT_DISABLE: '1', LOG_RETENTION_DAYS: '14',
        CCXRAY_PRICING_CACHE: path.join(home, 'pricing.json'), RESTORE_DAYS: '0',
        ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await waitFor(async () => {
      try { return (await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/_api/health`, res => { res.resume(); resolve(res.statusCode); }).once('error', reject);
      })) === 200; } catch { return false; }
    });
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await done; } finally { clearTimeout(timer); }
    }
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('emits prevId and msgOffset before messages, after the extra params, with no top-level messages injected by them', async () => {
    const m = (role, content) => ({ role, content });
    // An extra param that itself contains a nested "messages" key.
    const extra = { context_management: { edits: [], messages: ['nested, not the record\'s own'] }, temperature: 0 };
    const turn1 = [m('user', 'one'), m('assistant', 'two')];
    const turn2 = [...turn1, m('user', 'three'), m('assistant', 'four')];
    for (const messages of [turn1, turn2]) {
      assert.equal((await post(port, { model: 'claude-sonnet-4-6', max_tokens: 32, metadata: { session_id: SESSION },
        system: 'Primary working directory: /synthetic/writer-order', messages, ...extra })).status, 200);
    }
    const rows = await waitFor(() => {
      const lines = fs.readFileSync(path.join(home, 'logs/index.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      return lines.length >= 2 ? lines : null;
    });
    const [first, second] = rows.map(r => r.id).sort();

    const read = id => readLogText(path.join(home, 'logs', id + '_req.json')); // #776: decoded text keeps the on-disk key order
    const fullText = read(first), deltaText = read(second);
    const full = JSON.parse(fullText), delta = JSON.parse(deltaText);

    assert.ok(!('prevId' in full), 'the first turn is a full anchor');
    assert.equal(classifyReqHead(fullText.slice(0, 4096)), 'full');

    assert.equal(delta.prevId, first, 'the second turn is a delta onto the first');
    const keys = Object.keys(delta);
    assert.ok(keys.indexOf('prevId') >= 0 && keys.indexOf('msgOffset') === keys.indexOf('prevId') + 1);
    assert.ok(keys.indexOf('prevId') < keys.indexOf('messages'), `prevId must precede messages; got ${keys.join(',')}`);
    assert.ok(keys.indexOf('context_management') < keys.indexOf('prevId'), 'extra params are written before the chain head');
    assert.equal(keys.filter(k => k === 'messages').length, 1);
    assert.deepEqual(delta.context_management.messages, extra.context_management.messages, 'the nested messages survived as an extra param');
    assert.equal(classifyReqHead(deltaText.slice(0, 4096)), 'delta', 'the depth-aware scanner is not fooled by the nested key');
  });
});
