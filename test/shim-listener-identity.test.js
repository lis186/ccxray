'use strict';

const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-shim-identity-'));
process.env.CCXRAY_HOME = home;
delete process.env.AUTH_TOKEN;
fs.writeFileSync(path.join(home, 'local-secret'), Buffer.alloc(32, 0x42), { mode: 0o600 });
const hub = require('../server/hub');
const probe = require('../server/shim/shim-probe');
const port = 19876;
const env = { CCXRAY_SHIM_HOME: home, CCXRAY_SHIM_PORT: String(port), CCXRAY_SHIM_PID: '4242' };
after(() => fs.rmSync(home, { recursive: true, force: true }));

// Drive the real shared health handler through an in-process HTTP response fixture.
function healthFixture(t, change = value => value, ownPort = port) {
  t.mock.method(http, 'get', (options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    queueMicrotask(() => {
      let body;
      hub.handleHubRoutes({
        url: options.path, method: 'GET',
        headers: { 'x-ccxray-shim-challenge': options.headers?.['X-Ccxray-Shim-Challenge'] },
        socket: { localPort: ownPort, remoteAddress: '203.0.113.1' },
      }, { writeHead() {}, end(value) { body = value; } });
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit('data', JSON.stringify(change(JSON.parse(body))));
      response.emit('end');
    });
    return request;
  });
}

it('routes both tools after the shared health handler proves listener identity', async t => {
  healthFixture(t, body => { delete body.exportReportUnavailableReason; return body; });
  assert.equal(await probe.decide('claude', ['hello'], env), `claude http://127.0.0.1:${port} 0`);
  assert.equal(await probe.decide('codex', ['exec', 'hello'], env), `codex http://127.0.0.1:${port}`);
});

for (const kind of ['missing proof', 'bogus proof', 'other port']) {
  it(`bypasses both tools before registration with ${kind}`, async t => {
    healthFixture(t, body => {
      body.hub = true;
      if (kind === 'missing proof') delete body.shimProof;
      if (kind === 'bogus proof') body.shimProof = 'A'.repeat(43);
      return body;
    }, kind === 'other port' ? port + 1 : port);
    t.mock.method(net, 'connect', () => { assert.fail('registration must follow identity verification'); });
    for (const tool of ['claude', 'codex']) {
      assert.equal(await probe.decide(tool, ['hello'], env), 'direct');
      const records = fs.readFileSync(path.join(home, 'shim-bypass.log'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(records.at(-1).reason, 'unverified-listener');
      assert.match(await probe.decide(tool, ['hello'], { ...env, CCXRAY_SHIM_STRICT: '1' }), /^refuse .*unverified-listener/);
    }
  });
}

it('rejects a local-secret owned by another uid', { skip: typeof process.getuid !== 'function' }, async t => {
  healthFixture(t);
  const original = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', fd => {
    const st = original(fd);
    st.uid = process.getuid() + 1;
    return st;
  });
  assert.equal(await probe.decide('claude', ['hello'], env), 'direct');
  assert.match(fs.readFileSync(path.join(home, 'shim-bypass.log'), 'utf8'), /unverified-listener/);
});

it('skips uid checks but still requires a proof when getuid is unavailable', async t => {
  const original = process.getuid;
  process.getuid = undefined;
  try {
    let includeProof = true;
    healthFixture(t, body => {
      delete body.exportReportUnavailableReason;
      if (!includeProof) delete body.shimProof;
      return body;
    });
    assert.equal(await probe.decide('codex', ['exec'], env), `codex http://127.0.0.1:${port}`);
    includeProof = false;
    assert.equal(await probe.decide('codex', ['exec'], env), 'direct');
  } finally { process.getuid = original; }
});
