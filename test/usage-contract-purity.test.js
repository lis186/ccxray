'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

function snapshot(root) {
  return fs.readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name);
    return fs.statSync(file).isDirectory() ? [[name, snapshot(file)]] : [[name, fs.readFileSync(file).toString('base64')]];
  });
}

it('requires and runs offline without timers, writes, sockets or price fetches; HOME stays byte-identical', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-contract-pure-'));
  const envKeys = ['HOME', 'CCXRAY_HOME', 'LOGS_DIR', 'CCXRAY_PRICING_CACHE'];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const restores = [];
  const attempts = [];
  const lines = [];
  function block(target, name) {
    if (typeof target[name] !== 'function') return;
    const original = target[name];
    restores.push(() => { target[name] = original; });
    target[name] = () => { attempts.push(name); throw new Error('Unexpected ' + name); };
  }
  try {
    const logs = path.join(home, '.ccxray', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'index.ndjson'), JSON.stringify({
      id: 'dummy', sessionId: 'dummy-session', receivedAt: 1000,
      provider: 'openai', model: 'dummy-model', imported: true,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
      cost: { cost: null, confidence: 'unknown' }, title: 'DUMMY private title',
    }) + '\n');
    fs.writeFileSync(path.join(home, 'sentinel'), 'DUMMY unchanged');
    const before = snapshot(home);
    process.env.HOME = home;
    for (const key of envKeys.slice(1)) delete process.env[key];
    const oldLog = console.log;
    restores.push(() => { console.log = oldLog; });
    console.log = line => lines.push(JSON.parse(line));
    for (const target of [globalThis, require('node:timers'), require('node:timers/promises')]) {
      for (const name of ['setTimeout', 'setInterval']) block(target, name);
    }
    for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'createWriteStream']) {
      block(fs, name); block(fs, name + 'Sync'); block(fs.promises, name);
    }
    // Also trap opening a descriptor for write, even if a caller bypasses writeFile.
    for (const [target, name] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) {
      const original = target[name];
      restores.push(() => { target[name] = original; });
      target[name] = function(file, flags, ...rest) {
        const writes = typeof flags === 'string' ? /[wa+]/.test(flags)
          : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
        if (writes) { attempts.push(name); throw new Error('Unexpected write open'); }
        return original.call(this, file, flags, ...rest);
      };
    }
    block(net.Server.prototype, 'listen'); block(net.Socket.prototype, 'connect');
    for (const protocol of ['http', 'https']) {
      const mod = require('node:' + protocol);
      block(mod, 'request'); block(mod, 'get');
    }
    block(globalThis, 'fetch');
    const resources = () => process.getActiveResourcesInfo().filter(n => !['PipeWrap', 'FSReqCallback'].includes(n));
    const beforeResources = resources();
    const usage = require('../server/usage');
    for (const argv of [['--json'], ['--json', '--turns', '--by', 'session'], ['--json', '--agent-id', 'missing']]) {
      await usage.run(argv);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].schemaVersion, 1);
    assert.equal(lines[0].totals.turns, 1);
    assert.equal(lines[2].totals.turns, 0);
    assert.equal(lines[0].sessions.topSessions[0].title, null);
    assert.deepEqual(attempts, []);
    assert.deepEqual(resources(), beforeResources);
    assert.deepEqual(snapshot(home), before);
  } finally {
    for (const restore of restores.reverse()) restore();
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
