'use strict';

// extractCwd's `system` branch used to return null as soon as it found
// a `system` block with no "Primary working directory" line, instead of
// falling through to the context_management / messages scan the way
// extractConfigDir already does. Claude Code 2.1.283+ sends exactly this
// shape live — a top-level `system` with no env line, and the cwd moved to a
// dedicated `messages[1]` `role:'system'` block — so the live proxy logged
// `cwd: null` for every turn of a real session.
//
// This test drives the real live-proxy path (spawn server + POST
// /v1/messages against a mock upstream) rather than calling extractCwd
// directly, so it also proves the fix reaches index.ndjson and sessions.json,
// and that subagent classification (isSubagent) is unaffected.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'index.js');

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CWD = '/tmp/live-proxy-cwd-test';

// ── Helpers copied from test/index-fields.e2e.test.js ──────────────────

function findFreePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/_api/health`, { timeout: 1000 }, res => {
        res.resume();
        res.on('end', resolve);
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
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function isolatedEnv(home, overrides = {}, { identity = 'partial' } = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|XAI_|GROK_)/.test(k)) delete base[k];
  }
  delete base.LOGS_DIR;
  delete base.STORAGE_BACKEND;
  const env = {
    ...base,
    ...overrides,
    CCXRAY_HOME: home,
    CCXRAY_PRICING_CACHE: '/nonexistent/ccxray-pricing-cache.json',
    RESTORE_DAYS: '0',
    CCXRAY_IMPORT_DISABLE: '1',
    CCXRAY_EXPORT_DISABLE: '1',
    LOG_RETENTION_DAYS: '0',
    BROWSER: 'none',
    TZ: 'Asia/Tokyo',
  };
  if (identity === 'partial' || identity === 'full') {
    env.CCXRAY_AGENT_ID = 'machine-7';
    env.CCXRAY_TEAM = 'platform';
  }
  if (identity === 'full') {
    env.CCXRAY_USER_EMAIL = 'dev@example.test';
    env.CCXRAY_AGENT_TYPE = 'ci-bot';
  }
  return env;
}

function launchProxy(port, env) {
  const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(port), '--no-browser'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return { child, stderr: () => stderr };
}

function readIndexLines(home) {
  const indexPath = path.join(home, 'logs', 'index.ndjson');
  if (!fs.existsSync(indexPath)) return [];
  return fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean)
    .map(raw => ({ raw, obj: JSON.parse(raw) }));
}

// See test/index-fields.e2e.test.js for why the timeout is this generous
// (#538 — restore + pricing warm-up run before the importer, under load).
function waitForIndexLines(home, expected, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      let lines = [];
      try { lines = readIndexLines(home); } catch {}
      if (lines.length >= expected) return resolve(lines);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`expected ${expected} index lines, found ${lines.length}`));
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function postJson(port, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path: reqPath, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function postMessages(port, body, headers = {}) {
  return postJson(port, '/v1/messages', body, {
    'x-api-key': 'sk-test',
    'anthropic-version': '2023-06-01',
    ...headers,
  });
}

// mock upstream: a unique responseId per request so ADR 0012's read-time
// merge never folds the main turn and the title-gen turn into one entry.
function makeAnthropicUpstream() {
  let counter = 0;
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
      counter += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_live_proxy_cwd_${counter}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }));
    });
  });
}

// ── Fixtures — real Claude Code 2.1.283 shapes ──

const BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.283.b1c; cc_entrypoint=cli;';
const CLAUDE_CODE_B1 = "You are Claude Code, Anthropic's official CLI for Claude.";

// Case (a): main turn. Top-level `system` has no cwd line (the bug trigger);
// `context_management` is present; the cwd line moved to `messages[1]`
// (`role:'system'`), which is the format extractCwd must fall through to.
function mainTurnBody() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    metadata: { session_id: SESSION_ID },
    system: [
      { type: 'text', text: BILLING_HEADER },
      { type: 'text', text: CLAUDE_CODE_B1 },
      { type: 'text', text: 'You are an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.' },
    ],
    context_management: { edits: [] },
    messages: [
      { role: 'user', content: [
        { type: 'text', text: '<system-reminder>Some reminder text.</system-reminder>' },
      ] },
      { role: 'system', content: [
        { type: 'text', text: `# Environment\nPrimary working directory: ${CWD}\nShell: zsh` },
      ] },
      { role: 'user', content: [{ type: 'text', text: 'LIVE_PROXY_CWD_MAIN' }] },
    ],
  };
}

// Case (b): title-gen request in the same session. Real shape: no
// `context_management`, a single user message, and a short system prompt
// whose b2 block ("You are naming a coding session…") makes
// isAnthropicSubagent classify it as a subagent via extractAgentType — the
// protective assertion this fixture exists for. Neither the old nor the new
// extractCwd finds a cwd in THIS body (no context_management, no
// safeguards), so this entry's cwd must come from store.sessionMeta
// (inherited from the main turn above), not from its own body.
function titleGenBody() {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    metadata: { session_id: SESSION_ID },
    system: [
      { type: 'text', text: BILLING_HEADER },
      { type: 'text', text: CLAUDE_CODE_B1 },
      { type: 'text', text: 'You are naming a coding session so the user can pick it out of a long list of sessions. Given the user\'s first message, reply with a concise 2-4 word title and nothing else.' },
    ],
    messages: [
      { role: 'user', content: 'Generate a concise title.' },
    ],
  };
}

describe('live proxy cwd – 2.1.283 system+context_management shape', () => {
  let home, upstream, proxyChild, proxyPort, upstreamPort, proxyStderr;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-e2e-'));
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true });

    upstream = makeAnthropicUpstream();
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = upstream.address().port;

    proxyPort = await findFreePort();
    const env = isolatedEnv(home, {
      ANTHROPIC_TEST_HOST: '127.0.0.1',
      ANTHROPIC_TEST_PORT: String(upstreamPort),
      ANTHROPIC_TEST_PROTOCOL: 'http',
    }, { identity: 'none' });
    const launched = launchProxy(proxyPort, env);
    proxyChild = launched.child;
    proxyStderr = launched.stderr;
    await waitForPort(proxyPort);
  });

  after(async () => {
    await killAndWait(proxyChild);
    if (upstream) await new Promise(resolve => upstream.close(resolve));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it('(a) main turn: cwd extracted from role:system message when system block has no cwd', async () => {
    assert.equal(await postMessages(proxyPort, mainTurnBody()), 200, `unexpected proxy stderr: ${proxyStderr()}`);
    const lines = await waitForIndexLines(home, 1);
    const main = lines[0].obj;
    assert.equal(main.cwd, CWD, 'main turn cwd must be extracted from role:system message');
    assert.equal(main.isSubagent, false, 'main turn is not a subagent');
    assert.equal(main.sessionId, SESSION_ID);
  });

  it('(b) title-gen: isSubagent true, cwd inherited from session', async () => {
    assert.equal(await postMessages(proxyPort, titleGenBody()), 200, `unexpected proxy stderr: ${proxyStderr()}`);
    const lines = await waitForIndexLines(home, 2);
    const titleEntry = lines[1].obj;
    assert.equal(titleEntry.isSubagent, true, 'title-gen is classified as subagent');
    assert.equal(titleEntry.cwd, CWD, 'title-gen entry inherits session cwd from sessionMeta');
    assert.equal(titleEntry.sessionId, SESSION_ID);
  });

  it('(c) sessions.json: session cwd is set after shutdown', async () => {
    // gracefulExit flushes sessions.json on SIGTERM (server/index.js) before
    // process.exit; killAndWait's 3s timeout + SIGKILL guarantees the process
    // has exited (and thus flushed) by the time this resolves.
    await killAndWait(proxyChild);
    proxyChild = null; // prevent double-kill in after()
    const sessionsPath = path.join(home, 'logs', 'sessions.json');
    assert.ok(fs.existsSync(sessionsPath), 'sessions.json must exist');
    const raw = fs.readFileSync(sessionsPath, 'utf8');
    const sessions = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const sess = sessions.find(s => s.sid === SESSION_ID);
    assert.ok(sess, 'session must exist in sessions.json');
    assert.equal(sess.cwd, CWD, 'session cwd in sessions.json must match');
  });
});
