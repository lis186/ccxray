'use strict';

// #732 review round 1: the probe's decisions, in-process. Loopback listeners and a
// unix socket stand in for the proxy and the hub; every path is under a temp dir.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const probe = require('../server/shim/shim-probe');
const { summarizeBypasses } = require('../server/shim-bypass');

let root; let health; let healthPort; let healthBody; let seenPath;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-probe-')));
  health = http.createServer((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthBody));
  });
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  healthPort = health.address().port;
});
after(async () => { await new Promise(resolve => health.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { healthBody = { ok: true, app: 'ccxray' }; });

const envFor = (extra = {}) => ({ CCXRAY_SHIM_HOME: path.join(root, 'home'), CCXRAY_SHIM_PORT: String(healthPort), ...extra });
const logLines = () => {
  try { return fs.readFileSync(path.join(root, 'home', 'shim-bypass.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
};
beforeEach(() => fs.rmSync(path.join(root, 'home'), { recursive: true, force: true }));

describe('codex argument parsing (finding 6)', () => {
  const routed = args => probe.codexAlreadyRouted(probe.parseCodexArgs(args).overrides);

  it('does not read positional prompt text as configuration', () => {
    assert.equal(routed(['exec', 'explain openai_base_url']), false);
    assert.equal(routed(['exec', 'set model_provider = "ccxray" please']), false);
    assert.equal(routed(['explain openai_base_url=foo']), false);
    assert.equal(routed(['exec', '--', '-c', 'openai_base_url="x"']), false, 'after -- everything is positional');
  });

  it('recognises genuine already-routed invocations', () => {
    assert.equal(routed(['-c', 'openai_base_url="http://localhost:1/v1"', 'exec', 'x']), true);
    assert.equal(routed(['exec', '--config', 'openai_base_url="u"', 'x']), true);
    assert.equal(routed(['--config=openai_base_url="u"', 'exec']), true);
    assert.equal(routed(['-copenai_base_url="u"', 'exec']), true);
    assert.equal(routed(['-c', 'model_provider="ccxray"', 'exec']), true);
    assert.equal(routed(['-c', 'model="gpt-5"', 'exec']), false, 'an unrelated override is not routing');
  });

  it('knows option arity so an option value is not mistaken for the subcommand', () => {
    assert.equal(probe.parseCodexArgs(['-m', 'help', 'exec', 'x']).subcommand, 'exec');
    assert.equal(probe.parseCodexArgs(['--model', 'login', 'exec']).subcommand, 'exec');
    assert.equal(probe.parseCodexArgs(['-c', 'a=b', '-p', 'mcp', 'exec']).subcommand, 'exec');
    assert.equal(probe.parseCodexArgs(['help']).subcommand, 'help');
    assert.equal(probe.parseCodexArgs(['--oss', 'login']).subcommand, 'login');
    assert.equal(probe.parseCodexArgs(['--', 'login']).subcommand, undefined);
  });

  it('decide() routes a prompt that mentions the config key and a command whose option value says "help"', async () => {
    const a = await probe.decide('codex', ['exec', 'explain openai_base_url'], envFor());
    assert.equal(a, `codex http://127.0.0.1:${healthPort}`);
    const b = await probe.decide('codex', ['-m', 'help', 'exec', 'x'], envFor());
    assert.equal(b, `codex http://127.0.0.1:${healthPort}`);
    assert.equal(await probe.decide('codex', ['help'], envFor()), 'passthrough');
    assert.equal(await probe.decide('codex', ['-c', 'openai_base_url="u"', 'exec'], envFor()), 'passthrough');
  });
});

describe('listener-side authentication (finding 5)', () => {
  beforeEach(() => { healthBody = { ok: true, app: 'ccxray', exportReportUnavailableReason: 'authentication-required' }; });

  it('does not route to a listener that gates loopback, whatever the shim environment says', async () => {
    const env = envFor();
    assert.equal(env.CCXRAY_LOOPBACK_REQUIRE_AUTH, undefined);
    assert.equal(await probe.decide('claude', ['x'], env, new Date(), '/w'), 'direct');
    assert.equal(logLines().at(-1).reason, 'auth-required');
  });

  it('refuses in strict mode with the same fixed reason', async () => {
    const line = await probe.decide('codex', ['exec', 'x'], envFor({ CCXRAY_SHIM_STRICT: '1' }), new Date(), '/w');
    assert.match(line, /^refuse proxy not usable \(auth-required\)/);
    assert.equal(logLines().at(-1).action, 'refused');
  });

  it('still treats an auth-gated ccxray as already routed when the user pointed the tool at it', async () => {
    const env = envFor({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${healthPort}` });
    assert.equal(await probe.decide('claude', ['x'], env), 'passthrough');
  });

  it('a shim environment that demands auth does not block a listener that does not', async () => {
    healthBody = { ok: true, app: 'ccxray' };
    assert.match(await probe.decide('claude', ['x'], envFor({ CCXRAY_LOOPBACK_REQUIRE_AUTH: '1' })), /^claude http:/);
  });
});

describe('one strict-aware failure decision (finding 4)', () => {
  it('a decide() exception is a helper-error: direct, or refuse in strict mode', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    assert.equal(await probe.runProbe(['claude', 'x'], envFor(), { decideFn: boom, cwd: '/w' }), 'direct');
    assert.equal(logLines().at(-1).reason, 'helper-error');
    const strict = await probe.runProbe(['claude', 'x'], envFor({ CCXRAY_SHIM_STRICT: '1' }), { decideFn: boom, cwd: '/w' });
    assert.match(strict, /^refuse /);
    assert.equal(logLines().at(-1).action, 'refused');
  });

  it('a synchronous throw is handled the same way', async () => {
    const boom = () => { throw new Error('sync'); };
    assert.match(await probe.runProbe(['codex', 'x'], envFor({ CCXRAY_SHIM_STRICT: '1' }), { decideFn: boom, cwd: '/w' }), /^refuse /);
  });

  it('the inner hard timer is strict-aware too', async () => {
    const never = () => new Promise(() => {});
    assert.equal(await probe.runProbe(['claude', 'x'], envFor(), { decideFn: never, hardMs: 20, cwd: '/w' }), 'direct');
    assert.equal(logLines().at(-1).reason, 'timeout');
    const strict = await probe.runProbe(['claude', 'x'], envFor({ CCXRAY_SHIM_STRICT: '1' }), { decideFn: never, hardMs: 20, cwd: '/w' });
    assert.match(strict, /^refuse /);
  });

  it('a removed working directory does not throw', () => {
    const cwd = process.cwd();
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-probe-gone-'));
    process.chdir(gone);
    fs.rmdirSync(gone);
    try { assert.equal(probe.safeCwd(), ''); } finally { process.chdir(cwd); }
  });
});

describe('hub client registration (should-fix 1)', () => {
  let sock; let received; let hubDir;
  before(async () => {
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxh-'));
    received = [];
    sock = net.createServer(c => {
      c.on('data', d => {
        for (const line of String(d).split('\n').filter(Boolean)) received.push(JSON.parse(line));
        c.write(JSON.stringify({ ok: true, firstClient: false }) + '\n');
      });
    });
    await new Promise(resolve => sock.listen(path.join(hubDir, 'h.sock'), resolve));
  });
  after(async () => { await new Promise(resolve => sock.close(resolve)); fs.rmSync(hubDir, { recursive: true, force: true }); });
  beforeEach(() => { received.length = 0; });

  const writeLock = (extra = {}) => {
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    fs.writeFileSync(path.join(root, 'home', 'hub.json'), JSON.stringify({ port: healthPort, pid: 1, sockPath: path.join(hubDir, 'h.sock'), ...extra }));
  };

  it('registers the launching pid with its cwd and routes through /_ccxray/client/<pid>', async () => {
    writeLock();
    const env = envFor({ CCXRAY_SHIM_PID: '4242' });
    delete env.CCXRAY_SHIM_PORT; // discover the port from hub.json
    const claude = await probe.decide('claude', ['-p', 'x'], env, new Date(), '/project/a');
    assert.equal(claude, `claude http://127.0.0.1:${healthPort}/_ccxray/client/4242 1`);
    assert.equal(received.length, 1);
    assert.equal(received[0].cmd, 'register');
    assert.equal(received[0].pid, 4242);
    assert.equal(received[0].cwd, '/project/a');
    assert.match(received[0].token, /^[0-9a-f]{16}$/);
    const codex = await probe.decide('codex', ['exec', 'x'], env, new Date(), '/project/b');
    assert.equal(codex, `codex http://127.0.0.1:${healthPort}/_ccxray/client/4242`);
    assert.equal(received.at(-1).cwd, '/project/b');
  });

  it('falls back to the plain URL (never a guessed route) without a usable registration', async () => {
    const base = `http://127.0.0.1:${healthPort}`;
    writeLock({ port: healthPort + 1 }); // lock names a different listener
    assert.equal(await probe.decide('codex', ['exec'], envFor({ CCXRAY_SHIM_PID: '7' })), `codex ${base}`);
    writeLock({ sockPath: path.join(hubDir, 'nope.sock') });
    assert.equal(await probe.decide('codex', ['exec'], envFor({ CCXRAY_SHIM_PID: '7' })), `codex ${base}`);
    writeLock();
    assert.equal(await probe.decide('codex', ['exec'], envFor()), `codex ${base}`, 'no pid, no registration');
    assert.equal(received.length, 0);
  });
});

describe('bypass dashboard counts across rotation (should-fix 4)', () => {
  it('counts the rotated generation too', () => {
    const home = path.join(root, 'rot');
    fs.mkdirSync(home, { recursive: true });
    const rec = (n, action = 'bypass') => JSON.stringify({ t: new Date(Date.now() - n * 1000).toISOString(), tool: 'claude', cwd: '/x', reason: 'refused', action });
    fs.writeFileSync(path.join(home, 'shim-bypass.log.1'), [rec(30), rec(20), rec(10, 'refused')].join('\n') + '\n');
    fs.writeFileSync(path.join(home, 'shim-bypass.log'), rec(1) + '\n');
    const s = summarizeBypasses(home);
    assert.deepEqual({ recent: s.recent, total: s.total, refused: s.refused }, { recent: 3, total: 3, refused: 1 });
    fs.rmSync(path.join(home, 'shim-bypass.log.1'));
    assert.equal(summarizeBypasses(home).total, 1, 'without the rotated file only the active log is left');
  });

  it('the probe rotates at 1 MiB and the summary keeps counting the rotated file', () => {
    const home = path.join(root, 'rot2');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'shim-bypass.log'), JSON.stringify({ t: new Date().toISOString(), tool: 'codex', cwd: '', reason: 'refused', action: 'bypass' }) + '\n' + ' '.repeat(1100000) + '\n');
    probe.appendBypass(home, { t: new Date().toISOString(), tool: 'claude', cwd: '', reason: 'timeout', action: 'bypass' });
    assert.ok(fs.existsSync(path.join(home, 'shim-bypass.log.1')));
    assert.equal(summarizeBypasses(home).total, 2);
  });
});
