'use strict';

// #732 review round 1: the probe's decisions, in-process. Loopback listeners and a
// unix socket stand in for the proxy and the hub; every path is under a temp dir.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');

const probe = require('../server/shim/shim-probe');
const { summarizeBypasses } = require('../server/shim-bypass');

const identityRoot = Buffer.alloc(32, 0x42);
function proofFor(nonce, port, rootKey = identityRoot) {
  const key = crypto.hkdfSync('sha256', rootKey, Buffer.alloc(0), Buffer.from('ccxray/v1/shim-identity'), 32);
  return crypto.createHmac('sha256', key).update(`ccxray-shim-identity/v1\n${nonce}\n${port}`).digest('base64url');
}
let root; let health; let healthPort; let healthBody; let seenPath;
let proveIdentity; let proofPort; let proofRoot; let seenNonces;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-probe-')));
  health = http.createServer((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const nonce = req.headers['x-ccxray-shim-challenge'];
    if (nonce) seenNonces.push(nonce);
    const body = { ...healthBody };
    if (proveIdentity && nonce) body.shimProof = proofFor(nonce, proofPort ?? healthPort, proofRoot);
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  healthPort = health.address().port;
});
after(async () => { await new Promise(resolve => health.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { healthBody = { ok: true, app: 'ccxray' }; proveIdentity = true; proofPort = undefined; proofRoot = identityRoot; seenNonces = []; });

const envFor = (extra = {}) => ({ CCXRAY_SHIM_HOME: path.join(root, 'home'), CCXRAY_SHIM_PORT: String(healthPort), ...extra });
const logLines = () => {
  try { return fs.readFileSync(path.join(root, 'home', 'shim-bypass.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
};
beforeEach(() => {
  const home = path.join(root, 'home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'local-secret'), identityRoot, { mode: 0o600 });
});

describe('listener identity', () => {
  for (const body of [
    { app: 'ccxray', ok: true },
    { app: 'ccxray', ok: true, hub: true },
    { app: 'ccxray', ok: true, shimProof: 'A'.repeat(43) },
  ]) {
    for (const tool of ['claude', 'codex']) {
      it(`bypasses an unverified listener for ${tool} (${JSON.stringify(body)})`, async () => {
        healthBody = body;
        proveIdentity = false;
        assert.equal(await probe.decide(tool, ['hello'], envFor()), 'direct');
        assert.equal(logLines().at(-1).reason, 'unverified-listener');
        assert.equal(summarizeBypasses(path.join(root, 'home')).byReason['unverified-listener'], 1);
        assert.match(await probe.decide(tool, ['hello'], envFor({ CCXRAY_SHIM_STRICT: '1' })), /^refuse .*unverified-listener/);
        assert.equal(logLines().at(-1).action, 'refused');
      });
    }
  }

  it('rejects a proof from a different port or root', async () => {
    for (const tool of ['claude', 'codex']) {
      proofPort = healthPort === 65535 ? 65534 : healthPort + 1;
      assert.equal(await probe.decide(tool, ['hello'], envFor()), 'direct');
      assert.equal(logLines().at(-1).reason, 'unverified-listener');
      proofPort = undefined;
      proofRoot = Buffer.alloc(32, 0x43);
      assert.equal(await probe.decide(tool, ['hello'], envFor()), 'direct');
      assert.equal(logLines().at(-1).reason, 'unverified-listener');
      proofRoot = identityRoot;
    }
  });

  it('rejects a proof saved from a previous launch', async () => {
    assert.match(await probe.decide('claude', ['hello'], envFor()), /^claude http:/);
    healthBody.shimProof = proofFor(seenNonces.at(-1), healthPort);
    proveIdentity = false;
    assert.equal(await probe.decide('claude', ['hello'], envFor()), 'direct');
    assert.equal(logLines().at(-1).reason, 'unverified-listener');
  });

  it('uses a fresh challenge for each launch', async () => {
    for (const tool of ['claude', 'codex']) assert.match(await probe.decide(tool, ['hello'], envFor()), new RegExp(`^${tool} http:`));
    assert.equal(seenNonces.length, 2);
    for (const nonce of seenNonces) assert.match(nonce, /^[0-9a-f]{64}$/);
    assert.notEqual(seenNonces[0], seenNonces[1]);
  });

  for (const kind of ['missing', 'symlink', '0644', 'short', 'long', 'directory']) {
    it(`does not use a ${kind} local-secret`, async () => {
      const file = path.join(root, 'home', 'local-secret');
      fs.unlinkSync(file);
      if (kind === 'symlink') {
        const target = path.join(root, 'dummy-secret');
        fs.writeFileSync(target, identityRoot, { mode: 0o600 });
        fs.symlinkSync(target, file);
      } else if (kind === 'directory') fs.mkdirSync(file);
      else if (kind !== 'missing') fs.writeFileSync(file, kind === 'short' ? Buffer.alloc(31) : kind === 'long' ? Buffer.alloc(33) : identityRoot, { mode: kind === '0644' ? 0o644 : 0o600 });
      if (kind === '0644') fs.chmodSync(file, 0o644);
      for (const tool of ['claude', 'codex']) {
        assert.equal(await probe.decide(tool, ['hello'], envFor()), 'direct');
        assert.equal(logLines().at(-1).reason, 'unverified-listener');
      }
    });
  }

  it('uses AUTH_TOKEN before a local-secret', async () => {
    proofRoot = crypto.createHash('sha256').update('dummy-shim-token').digest();
    fs.unlinkSync(path.join(root, 'home', 'local-secret'));
    for (const tool of ['claude', 'codex']) assert.match(await probe.decide(tool, ['hello'], envFor({ AUTH_TOKEN: 'dummy-shim-token' })), new RegExp(`^${tool} http:`));
  });

  it('leaves an already chosen loopback URL unchanged without a proof or secret', async () => {
    proveIdentity = false;
    fs.unlinkSync(path.join(root, 'home', 'local-secret'));
    for (const tool of ['claude', 'codex']) {
      const name = tool === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL';
      assert.equal(await probe.decide(tool, ['hello'], envFor({ [name]: `http://127.0.0.1:${healthPort}` })), 'passthrough');
    }
    assert.deepEqual(logLines(), []);
  });

  it('keeps the refused reason when no listener answers, even without a secret', async () => {
    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    fs.unlinkSync(path.join(root, 'home', 'local-secret'));
    for (const tool of ['claude', 'codex']) {
      assert.equal(await probe.decide(tool, ['hello'], envFor({ CCXRAY_SHIM_PORT: String(port) })), 'direct');
      assert.equal(logLines().at(-1).reason, 'refused');
    }
  });
});

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

  for (const kind of ['symlink', 'group-writable', 'other-writable', 'directory']) {
    it(`does not register through a ${kind} hub.json`, async () => {
      writeLock();
      const file = path.join(root, 'home', 'hub.json');
      if (kind === 'symlink') {
        fs.renameSync(file, file + '.real');
        fs.symlinkSync(file + '.real', file);
      } else if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
      else fs.chmodSync(file, kind === 'group-writable' ? 0o620 : 0o602);
      healthBody.hub = true;
      assert.equal(await probe.decide('claude', ['hello'], envFor({ CCXRAY_SHIM_PID: '4242' })), 'direct');
      assert.equal(logLines().at(-1).reason, 'hub-registration-failed');
      assert.equal(received.length, 0);
    });
  }

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

// ── Review round 2 (#734) ──

describe('a hub that cannot register this launch is bypassed (round 2, should-fix 1)', () => {
  let sock; let hubDir;
  before(async () => {
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxh2-'));
    sock = net.createServer(c => { c.on('data', () => c.write(JSON.stringify({ ok: false }) + '\n')); });
    await new Promise(resolve => sock.listen(path.join(hubDir, 'h.sock'), resolve));
  });
  after(async () => { await new Promise(resolve => sock.close(resolve)); fs.rmSync(hubDir, { recursive: true, force: true }); });
  const lock = extra => {
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    fs.writeFileSync(path.join(root, 'home', 'hub.json'), JSON.stringify({ port: healthPort, pid: 1, sockPath: path.join(hubDir, 'h.sock'), ...extra }));
  };

  for (const [name, setup] of Object.entries({
    'no hub.json at all': () => {},
    'a stale socket path': () => lock({ sockPath: path.join(hubDir, 'gone.sock') }),
    'a lock naming another port': () => lock({ port: healthPort + 1 }),
    'a hub that refuses the registration': () => lock({}),
  })) {
    it(`logs hub-registration-failed instead of emitting a bare URL (${name})`, async () => {
      healthBody = { ok: true, app: 'ccxray', hub: true };
      setup();
      for (const tool of ['claude', 'codex']) {
        assert.equal(await probe.decide(tool, tool === 'claude' ? ['-p', 'x'] : ['exec', 'x'], envFor({ CCXRAY_SHIM_PID: '9' }), new Date(), '/w'), 'direct');
        assert.equal(logLines().at(-1).reason, 'hub-registration-failed');
      }
      const strict = await probe.decide('codex', ['exec'], envFor({ CCXRAY_SHIM_PID: '9', CCXRAY_SHIM_STRICT: '1' }), new Date(), '/w');
      assert.match(strict, /^refuse .*hub-registration-failed/);
      assert.equal(logLines().at(-1).action, 'refused');
    });
  }

  it('a standalone (non-hub) listener still gets the plain URL', async () => {
    healthBody = { ok: true, app: 'ccxray', hub: false };
    assert.equal(await probe.decide('codex', ['exec'], envFor({ CCXRAY_SHIM_PID: '9' })), `codex http://127.0.0.1:${healthPort}`);
    assert.deepEqual(logLines(), []);
  });
});

describe('the probe log writer only appends to private regular files (round 2, should-fix 2)', () => {
  const rec = cwd => ({ t: new Date().toISOString(), tool: 'claude', cwd, reason: 'timeout', action: 'bypass' });
  const file = name => path.join(root, name, 'shim-bypass.log');

  it('makes a pre-existing 0644 log 0600 before appending, and rotates it privately', () => {
    const dir = path.join(root, 'perm'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file('perm'), 'old\n', { mode: 0o644 });
    fs.chmodSync(file('perm'), 0o644);
    probe.appendBypass(dir, rec('/a'));
    assert.equal(fs.statSync(file('perm')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file('perm'), 'utf8').split('\n').length, 3);
    fs.writeFileSync(file('perm'), `${'x'.repeat(1100000)}\n`);
    fs.chmodSync(file('perm'), 0o644);
    probe.appendBypass(dir, rec('/b'));
    assert.equal(fs.statSync(`${file('perm')}.1`).mode & 0o777, 0o600);
    assert.equal(fs.statSync(file('perm')).mode & 0o777, 0o600);
  });

  it('never writes through a symlink at the log path or the rotated path', () => {
    const dir = path.join(root, 'link'); fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'OUTSIDE');
    fs.symlinkSync(outside, file('link'));
    probe.appendBypass(dir, rec('/secret/project'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
    fs.rmSync(file('link'));
    fs.writeFileSync(file('link'), `${'x'.repeat(1100000)}\n`);
    fs.symlinkSync(outside, `${file('link')}.1`);
    probe.appendBypass(dir, rec('/secret/project'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
    assert.ok(fs.lstatSync(`${file('link')}.1`).isFile());
  });

  it('skips a FIFO without blocking, and keeps appending when .1 is a directory', () => {
    const dir = path.join(root, 'odd'); fs.mkdirSync(dir, { recursive: true });
    if (require('child_process').spawnSync('mkfifo', [file('odd')]).status === 0) {
      probe.appendBypass(dir, rec('/x'));
      assert.ok(fs.lstatSync(file('odd')).isFIFO());
      fs.rmSync(file('odd'));
    }
    fs.writeFileSync(file('odd'), `${'x'.repeat(1100000)}\n`);
    fs.mkdirSync(`${file('odd')}.1`);
    probe.appendBypass(dir, rec('/x'));
    assert.match(fs.readFileSync(file('odd'), 'utf8'), /"cwd":"\/x"/);
  });

  it('writes the cwd as printable ASCII only (non-ASCII and controls become ?)', () => {
    const dir = path.join(root, 'ascii'); fs.mkdirSync(dir, { recursive: true });
    probe.appendBypass(dir, rec('/caf\u00e9/\u2603\n"q"\\'));
    const line = fs.readFileSync(file('ascii'), 'utf8').trim();
    assert.match(line, /^[ -~]+$/);
    assert.equal(JSON.parse(line).cwd, '/caf?/??"q"\\');
  });
});
