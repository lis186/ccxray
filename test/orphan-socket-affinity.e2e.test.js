'use strict';

// #129: orphan requests (no metadata.session_id) must be attributed by socket
// affinity before temporal inference. All requests of one Claude Code process
// arrive over that process's keep-alive connection pool, so an orphan reusing
// the socket that carried session A's traffic belongs to session A — even
// when session B is temporally hotter (inflight + more recent).
//
// Harness note: http.Agent({ keepAlive: true, maxSockets: 1 }) is load-bearing.
// Without keep-alive the orphan opens a fresh socket and there is nothing to
// differentiate — the test would silently degrade into the negative case.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const tmpDirs = [];

const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';

function findFreePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => {
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

// Each mock response gets a UNIQUE message id, as real Anthropic does — a
// constant id would make the #333 responseId merge (correctly) collapse these
// logically-distinct turns into one, breaking the per-entry attribution asserted
// below. Merge behavior itself is covered by test/response-merge.test.js.
let _mockMsgSeq = 0;

// Mock Anthropic upstream. Requests whose body contains HOLD_OPEN are parked
// (response withheld) so the proxy sees that session as inflight; everything
// else gets an immediate minimal messages response.
function makeMockUpstream(held) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (body.includes('HOLD_OPEN')) { held.push(res); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock_' + (++_mockMsgSeq), type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
}

function releaseHeld(held) {
  for (const res of held.splice(0)) {
    try {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock_held_' + (++_mockMsgSeq), type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    } catch {}
  }
}

function postMessages(port, agent, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path: '/v1/messages', method: 'POST',
      agent,
      headers: { 'x-api-key': 'sk-fake', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function fetchEntries(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/_api/entries`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sessionBody(sid, marker) {
  return {
    model: 'claude-sonnet-4-6', max_tokens: 100,
    metadata: { session_id: sid },
    system: `You are Claude Code.\nPrimary working directory: /tmp/proj-${sid.slice(0, 8)}`,
    messages: [{ role: 'user', content: marker }],
  };
}

// The orphan class from #129: 1 message, no metadata, no system, no tools.
function orphanBody(marker) {
  return {
    model: 'claude-haiku-4-5-20251001', max_tokens: 100,
    messages: [{ role: 'user', content: marker }],
  };
}

describe('orphan request socket affinity (#129)', () => {
  after(() => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('orphan on session A\'s socket attributes to A even when B is inflight and hotter; fresh socket falls back to temporal inference', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-socket-affinity-'));
    tmpDirs.push(home);

    const held = [];
    const upstream = makeMockUpstream(held);
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        ANTHROPIC_TEST_HOST: '127.0.0.1',
        ANTHROPIC_TEST_PORT: String(upstreamPort),
        ANTHROPIC_TEST_PROTOCOL: 'http',
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // One keep-alive agent per simulated Claude Code process. maxSockets: 1
    // pins each client's traffic to a single reusable socket.
    const agentA = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const agentB = new http.Agent({ keepAlive: true, maxSockets: 1 });

    try {
      await waitForPort(proxyPort);

      // 1. Session A traffic on socket A (completes → A idle afterwards).
      await postMessages(proxyPort, agentA, sessionBody(SID_A, 'session A turn 1'));

      // 2. Session B traffic on socket B, parked upstream → B stays inflight
      //    and is the most recent session. Temporal inference must prefer B.
      const bPending = postMessages(proxyPort, agentB, sessionBody(SID_B, 'session B HOLD_OPEN'));
      await new Promise(r => setTimeout(r, 300));

      // 3. Orphan reusing socket A. Socket affinity → A. Temporal → B (wrong).
      //    B is inflight on its own socket, so socket A is free for immediate reuse.
      await postMessages(proxyPort, agentA, orphanBody('orphan-on-socket-A'));

      // 4. Negative case: orphan on a brand-new socket (no keep-alive history).
      //    No mapping exists → must fall back to temporal inference → B.
      await postMessages(proxyPort, null, orphanBody('orphan-fresh-socket'));

      releaseHeld(held);
      await bPending;
      await new Promise(r => setTimeout(r, 300));

      const { entries } = await fetchEntries(proxyPort);

      // Identify entries structurally: the two orphans are the haiku
      // entries, in arrival order.
      const orphans = entries.filter(e => e.model === 'claude-haiku-4-5-20251001');
      assert.equal(orphans.length, 2, `expected 2 orphan entries, got ${orphans.length}`);
      const [orphanOnA, orphanFresh] = orphans;

      assert.equal(orphanOnA.sessionInferred, true, 'orphan should be marked inferred');
      assert.equal(
        orphanOnA.sessionId, SID_A,
        `orphan on A's socket must attribute to A via socket affinity (got ${orphanOnA.sessionId})`
      );

      assert.equal(
        orphanFresh.sessionId, SID_B,
        `orphan on fresh socket must fall back to temporal inference → B (got ${orphanFresh.sessionId})`
      );
    } finally {
      releaseHeld(held);
      agentA.destroy();
      agentB.destroy();
      await killAndWait(child);
      upstream.close();
    }
  });
});
