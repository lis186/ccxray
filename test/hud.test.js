'use strict';
// #692: the Context HUD is off by default, `ccxray hud on|off|status` toggles
// it in the same settings.json the dashboard writes, and the HUD line is
// printed only by proxy/launcher startup and `hud status`.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hud-'));
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
  return home;
}

function isolatedEnv(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|XAI_|GROK_)/.test(key)) delete env[key];
  }
  delete env.LOGS_DIR;
  delete env.STORAGE_BACKEND;
  delete env.PROXY_PORT;
  return {
    ...env,
    HOME: home, USERPROFILE: home, CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    CLOUDSDK_CONFIG: home, CCXRAY_PRICING_CACHE: path.join(home, 'pricing-cache.json'),
    CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
    RESTORE_DAYS: '0', LOG_RETENTION_DAYS: '0', BROWSER: 'none', TZ: 'UTC',
  };
}

function cli(home, args) {
  return spawnSync(process.execPath, [SERVER, ...args], {
    encoding: 'utf8', timeout: 15000, env: isolatedEnv(home),
  });
}

function settingsFile(home) { return path.join(home, 'settings.json'); }
function readSettingsFile(home) { return JSON.parse(fs.readFileSync(settingsFile(home), 'utf8')); }

function withHome(run) {
  const home = makeHome();
  try { return run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

describe('ccxray hud', () => {
  it('defaults to disabled on a fresh home and status writes nothing', () => withHome(home => {
    const r = cli(home, ['hud', 'status']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'Context HUD: disabled (settings.json)\n');
    assert.equal(fs.existsSync(settingsFile(home)), false);
  }));

  it('a settings.json without statusLine is disabled; an explicit true stays enabled', () => withHome(home => {
    fs.writeFileSync(settingsFile(home), JSON.stringify({ starredSessions: ['synthetic-session'] }));
    assert.match(cli(home, ['hud', 'status']).stdout, /Context HUD: disabled/);
    fs.writeFileSync(settingsFile(home), JSON.stringify({ statusLine: true }));
    assert.match(cli(home, ['hud', 'status']).stdout, /Context HUD: enabled/);
  }));

  it('on/off persist statusLine and keep every other setting', () => withHome(home => {
    fs.writeFileSync(settingsFile(home), JSON.stringify({ starredSessions: ['synthetic-session'], hiddenProjects: ['p'] }));
    let r = cli(home, ['hud', 'on']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Context HUD: enabled \(settings\.json\)\n/);
    assert.match(r.stdout, /dashboard toggle changes it live/);
    assert.deepEqual(readSettingsFile(home), { starredSessions: ['synthetic-session'], hiddenProjects: ['p'], statusLine: true });
    assert.match(cli(home, ['hud', 'status']).stdout, /Context HUD: enabled/);

    r = cli(home, ['hud', 'off']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Context HUD: disabled/);
    assert.equal(readSettingsFile(home).statusLine, false);
    assert.deepEqual(readSettingsFile(home).starredSessions, ['synthetic-session']);
    assert.match(cli(home, ['hud', 'status']).stdout, /Context HUD: disabled/);
    assert.deepEqual(fs.readdirSync(home).filter(name => name.includes('.tmp-')), []);
  }));

  it('hud on creates settings.json on a fresh home', () => withHome(home => {
    assert.equal(cli(home, ['hud', 'on']).status, 0);
    assert.deepEqual(readSettingsFile(home), { statusLine: true });
  }));

  it('prints usage for no argument and --help, and exits 1 on an unknown argument', () => withHome(home => {
    for (const args of [['hud'], ['hud', '--help'], ['hud', '-h']]) {
      const r = cli(home, args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stdout, /^Usage: ccxray hud on\|off\|status/);
    }
    for (const args of [['hud', 'enable'], ['hud', 'on', 'extra'], ['hud', '--bogus']]) {
      const r = cli(home, args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /unknown hud argument/);
      assert.match(r.stderr, /Usage: ccxray hud on\|off\|status/);
    }
    assert.equal(fs.existsSync(settingsFile(home)), false);
  }));

  it('refuses to rewrite a settings.json that is not a JSON object', () => withHome(home => {
    fs.writeFileSync(settingsFile(home), '{not json');
    const r = cli(home, ['hud', 'on']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a JSON object/);
    assert.equal(fs.readFileSync(settingsFile(home), 'utf8'), '{not json');
  }));

  it('is listed in the global help', () => withHome(home => {
    assert.match(cli(home, ['--help']).stdout, /hud on\|off\|status\s+\S/);
  }));
});

describe('Context HUD line placement', () => {
  it('utility subcommands do not print it', () => withHome(home => {
    for (const args of [['status'], ['usage'], ['--version'], ['open'], ['setup', '--check', '--no-probe'], ['import', '--help']]) {
      const r = cli(home, args);
      assert.notEqual(r.status, null, `${args.join(' ')} timed out`);
      assert.doesNotMatch(r.stdout + r.stderr, /Context HUD:/, args.join(' '));
    }
  }));

  it('standalone proxy startup prints it, and the dashboard toggle persists over the new default', async () => {
    const home = makeHome();
    const port = await new Promise(resolve => {
      const srv = http.createServer().listen(0, '127.0.0.1', () => {
        const p = srv.address().port; srv.close(() => resolve(p));
      });
    });
    const child = spawn(process.execPath, [SERVER, '--port', String(port), '--no-browser'], {
      env: isolatedEnv(home), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    const request = (method, body) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/_api/settings', method,
        headers: body ? { 'Content-Type': 'application/json' } : {} }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
    try {
      const started = Date.now();
      while (!/Context HUD:/.test(out)) {
        assert.ok(Date.now() - started < 15000, `no HUD line in startup output:\n${out}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.match(out, /Context HUD: disabled \(settings\.json\)/);
      assert.equal(out.match(/Context HUD:/g).length, 1, out);

      const before = await request('GET');
      assert.equal(before.status, 200, before.body);
      assert.equal(JSON.parse(before.body).statusLine, false);
      const toggled = await request('POST', JSON.stringify({ statusLine: true }));
      assert.equal(toggled.status, 200, toggled.body);
      const waitStart = Date.now();
      while (!(fs.existsSync(settingsFile(home)) && readSettingsFile(home).statusLine === true)) {
        assert.ok(Date.now() - waitStart < 5000, 'dashboard toggle was not persisted');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(JSON.parse((await request('GET')).body).statusLine, true);
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.on('exit', resolve); });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
