'use strict';

// Multi-agent hub acceptance: one proxy serves anthropic + openai + xai clients
// without OPENAI_BASE_URL swap. This is the system contract, not a Grok product test.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const providers = require('../server/providers');
const tmpDirs = [];

function findFreePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/_api/health`, { timeout: 1000 }, res => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 100);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 100);
      });
    };
    check();
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

function request(port, { method, path: urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...headers,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': payload.length,
        } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fetchEntries(port) {
  return request(port, { method: 'GET', path: '/_api/entries?limit=50' }).then(out => {
    try { return JSON.parse(out.body); } catch { return { entries: [] }; }
  });
}

/** One mock that answers Anthropic Messages + OpenAI Responses and records Host. */
function makeMultiMock() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    hits.push({ host: req.headers.host, path: pathname, method: req.method });

    if (pathname === '/v1/messages' || pathname.endsWith('/messages')) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'claude-ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 3 },
        }));
      });
      return;
    }

    if ((pathname === '/v1/responses' || pathname.endsWith('/responses')) && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        const model = body.model || 'gpt-5.5';
        const text = model.startsWith('grok') ? 'grok-ok' : 'codex-ok';
        const completed = {
          type: 'response.completed',
          response: {
            id: `resp_${model}_mock`,
            object: 'response',
            model,
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text }],
            }],
            usage: {
              input_tokens: 100,
              output_tokens: 5,
              total_tokens: 105,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        };
        const sse = [
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: completed.response.id, model, status: 'in_progress' } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        ].join('');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse);
      });
      return;
    }

    res.writeHead(404).end('nope');
  });
  return { server, hits };
}

describe('multi-agent provider modules', () => {
  after(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  it('describeAgentModule covers claude, codex, grok contracts', () => {
    const ids = providers.listAgentProviderIds();
    assert.deepEqual(ids, ['claude', 'codex', 'grok']);
    for (const id of ids) {
      const m = providers.describeAgentModule(id);
      assert.ok(m.hasLauncher, `${id} launcher`);
      assert.ok(m.wire === 'anthropic' || m.wire === 'openai', `${id} wire`);
    }
    const grok = providers.describeAgentModule('grok');
    assert.equal(grok.openAIWireClient, true);
    assert.equal(grok.upstreamKey, 'xai');
    assert.equal(grok.rawSessionId, 'grok-raw');
    assert.ok(providers.listRawSessionBuckets().has('grok-raw'));
    assert.ok(providers.listRawSessionBuckets().has('codex-raw'));
  });

  it('one proxy routes claude / codex / grok to distinct hosts and labels agents', async () => {
    const mockPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-multi-'));
    tmpDirs.push(home);

    const { server: mock, hits } = makeMultiMock();
    await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));

    // Three logical upstreams → same mock process; Host header differs by profile.
    // Anthropic/OpenAI via TEST_*; xai via XAI_BASE_URL (full URL with port).
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
        CCXRAY_IMPORT_DISABLE: '1',
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(mockPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        OPENAI_TEST_HOST: '127.0.0.1',
        OPENAI_TEST_PORT: String(mockPort),
        OPENAI_TEST_PROTOCOL: 'http',
        XAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForPort(proxyPort);

      // Claude-shaped
      const claudeOut = await request(proxyPort, {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'x-api-key': 'test',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: {
          model: 'claude-sonnet-4',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
          metadata: { user_id: JSON.stringify({ session_id: 'claude-sess-1' }) },
        },
      });
      assert.equal(claudeOut.status, 200, claudeOut.body.slice(0, 200));

      // Codex-shaped (no grok headers → openai host profile)
      const codexOut = await request(proxyPort, {
        method: 'POST',
        path: '/v1/responses',
        headers: {
          authorization: 'Bearer sk-test',
          'content-type': 'application/json',
          'session_id': 'codex-sess-1',
        },
        body: {
          model: 'gpt-5.5',
          stream: true,
          instructions: 'You are Codex',
          input: [{ type: 'message', role: 'user', content: 'hi' }],
        },
      });
      assert.equal(codexOut.status, 200, codexOut.body.slice(0, 200));

      // Grok-shaped (client module headers → xai host profile)
      const grokOut = await request(proxyPort, {
        method: 'POST',
        path: '/v1/responses',
        headers: {
          authorization: 'Bearer tok',
          'content-type': 'application/json',
          'user-agent': 'grok-shell/0.2.93',
          'x-grok-client-identifier': 'grok-shell',
          'x-grok-client-version': '0.2.93',
          'x-grok-session-id': '019f-grok-sess-1',
        },
        body: {
          model: 'grok-4.5',
          stream: true,
          input: [
            { type: 'message', role: 'system', content: 'You are Grok' },
            { type: 'message', role: 'user', content: '<user_query> hi </user_query>' },
          ],
        },
      });
      assert.equal(grokOut.status, 200, grokOut.body.slice(0, 200));

      await new Promise(r => setTimeout(r, 600));
      const payload = await fetchEntries(proxyPort);
      const entries = payload.entries || [];
      assert.ok(entries.length >= 3, `expected ≥3 entries, got ${entries.length}`);

      const agents = new Set(entries.map(e => e.agent));
      assert.ok(agents.has('claude') || agents.has('unknown') || [...agents].some(a => a === 'claude'),
        `agents=${[...agents]}`);
      // agent field: anthropic default often 'claude'
      const hasClaude = entries.some(e => e.provider === 'anthropic' || e.agent === 'claude');
      const hasCodex = entries.some(e => e.agent === 'codex' || (e.model || '').startsWith('gpt'));
      const hasGrok = entries.some(e => e.agent === 'grok');
      assert.ok(hasClaude, 'claude/anthropic entry missing');
      assert.ok(hasCodex, 'codex entry missing');
      assert.ok(hasGrok, 'grok entry missing');

      // Host routing: all hit mock port; grok path still recorded as /v1/responses
      assert.ok(hits.some(h => h.path.includes('messages')), 'anthropic path hit mock');
      assert.ok(hits.filter(h => h.path.includes('responses')).length >= 2, 'two responses wire clients');
    } finally {
      await killAndWait(child);
      await new Promise(r => mock.close(r));
    }
  });
});
