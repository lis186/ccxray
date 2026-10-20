'use strict';
// The guard is a test-only preload; load it in a child so this process's net stays untouched,
// with the real Socket#connect stubbed so no connection is ever opened.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Children run non-enforce unless a test asks otherwise, even when this file itself runs in the
// enforcing unit lane (which exports CCXRAY_NETWORK_GUARD_ENFORCE=1).
function run(code, enforce) {
  const env = { ...process.env };
  delete env.CCXRAY_NETWORK_GUARD_ENFORCE;
  if (enforce) env.CCXRAY_NETWORK_GUARD_ENFORCE = '1';
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
}

const guard = path.join(__dirname, 'helpers', 'no-network.js');
const probe = `
const net = require('node:net');
const calls = [];
net.Socket.prototype.connect = function (...a) { calls.push(a); return this; };
require(${JSON.stringify(guard)});
const out = {};
function tryIt(name, fn) { try { fn(); out[name] = 'allowed'; } catch (e) { out[name] = /no-network guard/.test(e.message) ? 'blocked' : e.message; } }
tryIt('portHost', () => new net.Socket().connect(443, 'example.com'));
tryIt('options', () => new net.Socket().connect({ port: 443, host: 'example.com' }));
tryIt('normalized', () => new net.Socket().connect([{ port: 443, host: 'example.com' }, null]));
tryIt('loopback', () => new net.Socket().connect(80, '127.0.0.1'));
tryIt('portOnly', () => new net.Socket().connect(80));
tryIt('ipcPath', () => new net.Socket().connect('/tmp/x.sock'));
tryIt('netConnectPath', () => net.connect('/tmp/x.sock').destroy());
tryIt('ipcOptions', () => new net.Socket().connect({ path: '/tmp/x.sock' }));
out.reached = calls.length;
console.log(JSON.stringify(out));
`;

test('Socket#connect: external hosts blocked, loopback and IPC allowed', () => {
  const r = run(probe, false);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), {
    portHost: 'blocked', options: 'blocked', normalized: 'blocked',
    loopback: 'allowed', portOnly: 'allowed', ipcPath: 'allowed', netConnectPath: 'allowed', ipcOptions: 'allowed',
    reached: 5,
  });
});

// Probe that catches the guard's error, like pricing startup does. Socket#connect is stubbed so
// even a guard regression could never open a real connection.
const caught = `
const net = require('node:net');
net.Socket.prototype.connect = function () { return this; };
require(${JSON.stringify(guard)});
const https = require('node:https');
try { https.get('https://example.com/'); } catch (e) { console.log('caught', /no-network guard/.test(e.message)); }
`;

test('enforce mode: a caught outbound attempt still fails the process', () => {
  const r = run(caught, true);
  assert.match(r.stdout, /caught true/);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /no-network guard: BLOCKED https\.get to example\.com/);
});

test('enforce mode: failure is sticky even if the code later calls process.exit(0)', () => {
  const r = run(caught + 'process.exit(0);', true);
  assert.notStrictEqual(r.status, 0);
});

test('enforce mode: allowed traffic leaves the exit code alone', () => {
  const r = run(`require(${JSON.stringify(guard)}); require('node:net').Socket.prototype.connect.call; console.log('ok')`, true);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('non-enforce mode: a caught outbound attempt exits 0', () => {
  const r = run(caught, false);
  assert.match(r.stdout, /caught true/);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('bare strings are IPC paths only for net/tls, not http/https/fetch', () => {
  const r = run(`
const net = require('node:net');
net.Socket.prototype.connect = function () { return this; };
require(${JSON.stringify(guard)});
const http = require('node:http'), https = require('node:https');
const out = {};
function tryIt(name, fn) { try { fn(); out[name] = 'allowed'; } catch (e) { out[name] = /no-network guard/.test(e.message) ? 'blocked' : e.message; } }
tryIt('httpsOpaque', () => https.get('https:example.com'));
tryIt('httpOpaque', () => http.get('http:example.com'));
tryIt('httpsUrlObject', () => https.get(new URL('https://example.com/x')));
tryIt('httpUrlObject', () => http.request(new URL('http://example.com/x')));
tryIt('netPath', () => net.connect('/tmp/x.sock'));
out.fetch = 'pending';
fetch('https:example.com').then(() => { out.fetch = 'allowed'; }, (e) => { out.fetch = /no-network guard/.test(e.message) ? 'blocked' : e.message; }).then(() => console.log(JSON.stringify(out)));
`, false);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), {
    httpsOpaque: 'blocked', httpOpaque: 'blocked', httpsUrlObject: 'blocked', httpUrlObject: 'blocked',
    netPath: 'allowed', fetch: 'blocked',
  });
});
