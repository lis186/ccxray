'use strict';

// #732 acceptance criterion 1, for real: a plain spawn of `claude` / `codex`
// through the installed shim into a REAL ccxray server with a local fake
// upstream, asserting the recorded entries and their attribution. Temp HOME only;
// the "real" binaries are fakes that send synthetic model traffic.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { runWrapBinaries } = require('../server/launcher-shims');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const SYSTEM_PATH = '/usr/bin:/bin';
const quiet = { log() {}, error() {} };

let root; let home; let shims; let fakeBin; let upstream; let upstreamPort; const hits = [];
const procs = [];

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Polls external, asynchronous state (a spawned server, an index file) up to a cap.
async function waitFor(fn, what, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const health = port => new Promise(resolve => {
  const req = http.get(`http://127.0.0.1:${port}/_api/health`, { timeout: 1000 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

function startProxy(port, { hub = false, env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--no-browser', ...(hub ? ['--hub-mode'] : [])], {
    env: {
      PATH: process.env.PATH, HOME: root, CCXRAY_HOME: home, RESTORE_DAYS: '0', CCXRAY_IMPORT_DISABLE: '1', CCXRAY_EXPORT_DISABLE: '1',
      ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http',
      OPENAI_TEST_HOST: '127.0.0.1', OPENAI_TEST_PORT: String(upstreamPort), OPENAI_TEST_PROTOCOL: 'http',
      ...env,
    },
    stdio: 'ignore',
  });
  procs.push(child);
  return child;
}

function stop(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(killer); resolve(); });
    child.kill('SIGTERM');
  });
}

const indexEntries = () => {
  try {
    return fs.readFileSync(path.join(home, 'logs', 'index.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};

// A fake agent: reports readiness, optionally waits for a barrier file, then sends
// one model request to the base URL the shim gave it (and reports what it saw).
const FAKE_AGENT = `#!${process.execPath}
const fs = require('fs'); const http = require('http');
const tool = require('path').basename(process.argv[1]);
const send = (url, p, headers, body) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname.replace(/\\/$/, '') + p, method: 'POST',
    headers: { 'content-type': 'application/json', ...headers } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});
(async () => {
  console.log('BASE:' + (process.env.ANTHROPIC_BASE_URL || ''));
  console.log('ARGS:' + process.argv.slice(2).join(' '));
  console.log('READY');
  const wait = process.env.FAKE_WAIT_FILE;
  while (wait && !fs.existsSync(wait)) await new Promise(r => setTimeout(r, 20));
  let status = 'none';
  if (tool === 'claude' && process.env.ANTHROPIC_BASE_URL) {
    status = await send(process.env.ANTHROPIC_BASE_URL, '/v1/messages', { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      { model: 'claude-sonnet-4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: JSON.stringify({ session_id: process.env.FAKE_SESSION || 'sess-claude' }) } });
  } else if (tool === 'codex') {
    const m = /openai_base_url="([^"]+)"/.exec(process.argv.join(' '));
    if (m) status = await send(m[1], '/responses', { authorization: 'Bearer sk-test', session_id: process.env.FAKE_SESSION || 'sess-codex' },
      { model: 'gpt-5.5', stream: true, instructions: 'You are Codex', input: [{ type: 'message', role: 'user', content: 'hi' }] });
  }
  console.log('STATUS:' + status);
})();
`;

function runTool(tool, args, { cwd, env = {}, onLine, port } = {}) {
  const child = spawn(tool, args, {
    cwd: cwd || root,
    env: { PATH: [shims, fakeBin, SYSTEM_PATH].join(':'), HOME: root, ...(port ? { CCXRAY_SHIM_PORT: String(port) } : {}), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  const lineWaiters = [];
  child.stdout.on('data', d => { stdout += d; lineWaiters.splice(0).forEach(w => w()); onLine?.(stdout); });
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
  const until = pattern => new Promise(resolve => {
    const check = () => (pattern.test(stdout) ? resolve(stdout) : lineWaiters.push(check));
    check();
  });
  return { child, done, until };
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-proxy-')));
  home = path.join(root, '.ccxray');
  fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const tool of ['claude', 'codex']) fs.writeFileSync(path.join(fakeBin, tool), FAKE_AGENT, { mode: 0o755 });
  assert.equal(await runWrapBinaries({ yes: true, shell: 'bash' }, {
    env: { HOME: root, CCXRAY_HOME: home, SHELL: '/bin/bash', PATH: SYSTEM_PATH }, homedir: () => root, platform: 'linux', logger: quiet,
  }), 0);
  shims = path.join(home, 'shims');

  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hits.push({ path: req.url, headers: req.headers });
      if (req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `msg_${hits.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } }));
      } else if (req.url.startsWith('/v1/responses')) {
        const response = { id: `resp_${hits.length}`, object: 'response', model: 'gpt-5.5', status: 'completed',
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 } } };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
      } else { res.writeHead(404).end('nope'); }
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;
});

after(async () => {
  await Promise.all(procs.map(stop));
  await new Promise(resolve => { upstream.closeAllConnections?.(); upstream.close(resolve); });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('plain spawn → shim → real standalone proxy → fake upstream (criterion 1)', () => {
  let port; let proxy;
  before(async () => {
    port = await freePort();
    proxy = startProxy(port);
    await waitFor(() => health(port), 'the proxy');
  });
  after(() => stop(proxy));

  it('records a Claude Messages request and a Codex Responses request, and never leaks the route upstream', async () => {
    const claude = await runTool('claude', ['-p', 'hello'], { port, env: { FAKE_SESSION: 'sess-A' } }).done;
    assert.equal(claude.code, 0, claude.stderr);
    assert.match(claude.stdout, new RegExp(`BASE:http://127.0.0.1:${port}\\n`));
    assert.match(claude.stdout, /STATUS:200/);
    const codex = await runTool('codex', ['exec', 'explain openai_base_url'], { port, env: { FAKE_SESSION: 'sess-B' } }).done;
    assert.equal(codex.code, 0, codex.stderr);
    assert.match(codex.stdout, new RegExp(`ARGS:-c openai_base_url="http://127.0.0.1:${port}/v1" exec explain openai_base_url`));
    assert.match(codex.stdout, /STATUS:200/);

    const entries = await waitFor(() => { const e = indexEntries(); return e.length >= 2 && e; }, 'two recorded entries');
    const anthropic = entries.find(e => e.provider === 'anthropic' || (e.model || '').startsWith('claude'));
    const openai = entries.find(e => (e.model || '').startsWith('gpt'));
    assert.ok(anthropic, 'the Claude request was recorded');
    assert.ok(openai, 'the Codex request was recorded');
    assert.equal(anthropic.model, 'claude-sonnet-4');
    assert.ok(hits.some(h => h.path.startsWith('/v1/messages')) && hits.some(h => h.path.startsWith('/v1/responses')));
    assert.ok(hits.every(h => !h.path.includes('_ccxray')), 'a client route must never reach the upstream');
  });
});

describe('listener-side authentication (finding 5)', () => {
  it('bypasses a proxy that gates loopback although the shim env does not say so, and refuses in strict mode', async () => {
    const authHome = fs.mkdtempSync(path.join(root, 'auth-home-'));
    const port = await freePort();
    const proxy = spawn(process.execPath, [SERVER, '--port', String(port), '--no-browser'], {
      env: { PATH: process.env.PATH, HOME: root, CCXRAY_HOME: authHome, CCXRAY_IMPORT_DISABLE: '1', CCXRAY_EXPORT_DISABLE: '1',
        CCXRAY_LOOPBACK_REQUIRE_AUTH: '1', ANTHROPIC_TEST_HOST: '127.0.0.1', ANTHROPIC_TEST_PORT: String(upstreamPort), ANTHROPIC_TEST_PROTOCOL: 'http' },
      stdio: 'ignore',
    });
    procs.push(proxy);
    try {
      await waitFor(() => health(port), 'the auth-gated proxy');
      const before = hits.length;
      const open = await runTool('claude', ['-p', 'x'], { port }).done;
      assert.equal(open.code, 0);
      assert.match(open.stdout, /BASE:\n/, 'the tool was launched unrouted');
      assert.match(open.stdout, /STATUS:none/);
      assert.equal(hits.length, before, 'no model traffic went through the gated proxy');
      const log = fs.readFileSync(path.join(home, 'shim-bypass.log'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(log.at(-1).reason, 'auth-required');
      const strict = await runTool('claude', ['-p', 'x'], { port, env: { CCXRAY_SHIM_STRICT: '1' } }).done;
      assert.equal(strict.code, 111);
      assert.doesNotMatch(strict.stdout, /READY/);
      assert.match(strict.stderr, /auth-required/);
    } finally { await stop(proxy); }
  });
});

describe('hub mode: attribution and lifetime (should-fix 1)', () => {
  it('attributes concurrent projects by their own pid and keeps them registered, never inheriting a bystander cwd', async () => {
    const hubHome = fs.mkdtempSync(path.join(root, 'hub-home-'));
    const saved = home;
    home = hubHome; // startProxy / indexEntries read the module-level home
    const port = await freePort();
    const hub = startProxy(port, { hub: true });
    // The shim bakes its home at install time, so this test installs its own.
    const hubShims = path.join(hubHome, 'shims');
    try {
      const hubUser = path.join(hubHome, 'user');
      fs.mkdirSync(hubUser);
      assert.equal(await runWrapBinaries({ yes: true, shell: 'bash', shimDir: hubShims, noSessionEnv: true }, {
        env: { HOME: hubUser, CCXRAY_HOME: hubHome, SHELL: '/bin/bash', PATH: SYSTEM_PATH }, homedir: () => hubUser, platform: 'linux', logger: { log() {}, error: console.error },
      }), 0);
      const lock = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(hubHome, 'hub.json'), 'utf8')); } catch { return null; } }, 'hub.json');
      await waitFor(() => health(port), 'the hub');
      const request = msg => new Promise((resolve, reject) => {
        const s = net.connect(lock.sockPath);
        let buf = '';
        s.on('data', d => { buf += d; if (buf.includes('\n')) { s.destroy(); resolve(JSON.parse(buf.split('\n')[0])); } });
        s.on('error', reject);
        s.write(JSON.stringify(msg) + '\n');
      });
      // A bystander project is the hub's only client: the old bare URL attributed everything to it.
      await request({ cmd: 'register', pid: process.pid, cwd: '/bystander/project', token: '0123456789abcdef' });

      const projA = fs.mkdirSync(path.join(root, 'proj-a'), { recursive: true }) || path.join(root, 'proj-a');
      const projB = fs.mkdirSync(path.join(root, 'proj-b'), { recursive: true }) || path.join(root, 'proj-b');
      const barrier = path.join(root, 'release-barrier');
      const env = { PATH: [hubShims, fakeBin, SYSTEM_PATH].join(':'), HOME: root, FAKE_WAIT_FILE: barrier };
      const launch = (cwd, session) => {
        const child = spawn('codex', ['exec', 'x'], { cwd, env: { ...env, FAKE_SESSION: session }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        const ready = new Promise(resolve => child.stdout.on('data', d => { stdout += d; if (/READY/.test(stdout)) resolve(); }));
        const done = new Promise(resolve => child.on('close', code => resolve({ code, stdout })));
        return { child, ready, done };
      };
      const a = launch(projA, 'sess-a');
      const b = launch(projB, 'sess-b');
      await Promise.all([a.ready, b.ready]);

      const status = await request({ cmd: 'status' });
      const byPid = new Map(status.clients.map(c => [c.pid, c.cwd]));
      assert.equal(byPid.get(a.child.pid), projA, 'project A registered under its own pid');
      assert.equal(byPid.get(b.child.pid), projB, 'project B registered under its own pid');

      // The last launcher goes away; the hub still has live shim sessions, so it has clients.
      await request({ cmd: 'unregister', pid: process.pid });
      const afterUnregister = await request({ cmd: 'status' });
      assert.ok(afterUnregister.clients.some(c => c.pid === a.child.pid) && afterUnregister.clients.some(c => c.pid === b.child.pid));

      fs.writeFileSync(barrier, 'go');
      const [ra, rb] = await Promise.all([a.done, b.done]);
      assert.match(ra.stdout, new RegExp(`ARGS:-c openai_base_url="http://127.0.0.1:${port}/_ccxray/client/${a.child.pid}/v1" exec x`));
      assert.match(ra.stdout, /STATUS:200/);
      assert.match(rb.stdout, /STATUS:200/);
      const entries = await waitFor(() => { const e = indexEntries(); return e.length >= 2 && e; }, 'both entries');
      // Codex puts no cwd on the wire: the registered client route is what attributes the request.
      assert.deepEqual(entries.map(e => e.cwd).sort(), [projA, projB].sort());
      assert.ok(entries.every(e => e.cwd !== '/bystander/project'), 'no entry inherited the bystander cwd');
      assert.ok(hits.every(h => !h.path.includes('_ccxray')));
    } finally {
      await stop(hub);
      home = saved;
    }
  });
});
