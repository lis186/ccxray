'use strict';

// Bug 1 from the codex Beta-readiness handoff: when ccxray exits while a WS
// upgrade is still being recorded, the storage writes for the WS entry race
// process.exit() and get truncated to 0-byte files. This test reproduces the
// race by spawning the proxy, opening a WS upgrade through it, then SIGTERMing
// the proxy. After exit, both _req.json and _res.json for the WS entry must
// contain valid JSON with the expected transport-only metadata.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');
const tmpDirs = [];

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

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', code => { clearTimeout(t); resolve(code); });
  });
}

// Mock OpenAI/ChatGPT WS upstream that accepts the upgrade, sends one frame,
// and stays open until the proxy or client closes the socket.
function makeWsUpstream(port) {
  return new Promise(resolve => {
    const httpServer = http.createServer();
    const wss = new WebSocket.Server({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, ws => {
        try { ws.send('hello-from-upstream'); } catch {}
      });
    });
    httpServer.listen(port, '127.0.0.1', () => resolve(httpServer));
  });
}

describe('Bug 1: ccxray drains WS storage writes before process exit', () => {
  after(() => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('produces non-empty WS _req.json and _res.json after proxy is SIGTERMed mid-session', async () => {
    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ws-drain-'));
    tmpDirs.push(home);

    const upstream = await makeWsUpstream(upstreamPort);

    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env: {
        ...process.env,
        OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        CHATGPT_BASE_URL: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        CCXRAY_HOME: home,
        BROWSER: 'none',
        RESTORE_DAYS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    try {
      await waitForPort(proxyPort);

      // Open a WS upgrade through ccxray. Codex sends openai-beta +
      // chatgpt-account-id to trigger the ChatGPT-auth routing path.
      const ws = new WebSocket(`ws://localhost:${proxyPort}/v1/responses`, {
        headers: {
          'openai-beta': 'responses_websockets=2026-02-06',
          'chatgpt-account-id': '11111111-2222-3333-4444-555555555555',
          'session_id': 'shutdown-race-session',
        },
      });

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('WS open timeout')), 4000);
        ws.once('open', () => { clearTimeout(t); resolve(); });
        ws.once('error', e => { clearTimeout(t); reject(e); });
      });

      // Push one frame so byte counts are non-zero — same shape as a real
      // codex turn would generate before being interrupted.
      ws.send('shutdown-race-payload');
      await new Promise(r => setTimeout(r, 150));

      // SIGTERM the proxy while the WS is still open. This is the race: the
      // WS close fires inside the proxy, queueing async storage writes; without
      // gracefulExit, process.exit beats fs.writeFile to the disk.
      child.kill('SIGTERM');

      // Detach our WS so it doesn't hold the test process open.
      try { ws.terminate(); } catch {}

      const code = await waitForExit(child);
      assert.equal(code, 0, `proxy should exit cleanly (got ${code}); stderr: ${stderr.slice(-500)}`);

      // The WS entry's id is timestamp-based, so we just scan the logs dir.
      const logsDir = path.join(home, 'logs');
      const files = fs.readdirSync(logsDir).filter(f => f.endsWith('_res.json'));
      assert.ok(files.length >= 1, `expected at least one _res.json, found: ${files.join(', ')}`);

      // Find the WS entry (transport: websocket) — there should be exactly one.
      let wsResFile = null;
      let wsResPayload = null;
      for (const f of files) {
        const text = fs.readFileSync(path.join(logsDir, f), 'utf8');
        assert.ok(text.length > 0, `${f} must not be 0-byte after gracefulExit`);
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { throw new Error(`${f} is not valid JSON: ${text.slice(0, 80)}`); }
        if (parsed && parsed.transport === 'websocket') {
          wsResFile = f;
          wsResPayload = parsed;
          break;
        }
      }

      assert.ok(wsResFile, `WS res.json not found among: ${files.join(', ')}`);
      assert.equal(wsResPayload.capture, 'transport-only');
      assert.ok(wsResPayload.frameCounts, 'frameCounts must be present');
      assert.ok(wsResPayload.byteCounts, 'byteCounts must be present');
      assert.ok(wsResPayload.byteCounts.clientToUpstream > 0,
        `clientToUpstream bytes should reflect the sent frame, got ${wsResPayload.byteCounts.clientToUpstream}`);

      // The matching _req.json must also exist and be parseable.
      const reqFile = wsResFile.replace('_res.json', '_req.json');
      const reqText = fs.readFileSync(path.join(logsDir, reqFile), 'utf8');
      assert.ok(reqText.length > 0, `${reqFile} must not be 0-byte`);
      const reqParsed = JSON.parse(reqText);
      assert.equal(reqParsed.transport, 'websocket');
      assert.equal(reqParsed.endpoint, '/v1/responses');

      // The index.ndjson line for the WS entry must also be present.
      const indexLines = fs.readFileSync(path.join(logsDir, 'index.ndjson'), 'utf8').trim().split('\n');
      const wsIndexLine = indexLines.find(l => l.includes('"transport":"websocket"'));
      assert.ok(wsIndexLine, 'index.ndjson must contain the WS entry');
    } finally {
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
      upstream.close();
    }
  });
});
