'use strict';
// The guard is a test-only preload; load it in a child so this process's net stays untouched,
// with the real Socket#connect stubbed so no connection is ever opened.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

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
tryIt('ipcOptions', () => new net.Socket().connect({ path: '/tmp/x.sock' }));
out.reached = calls.length;
console.log(JSON.stringify(out));
`;

test('Socket#connect: external hosts blocked, loopback and IPC allowed', () => {
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), {
    portHost: 'blocked', options: 'blocked', normalized: 'blocked',
    loopback: 'allowed', portOnly: 'allowed', ipcPath: 'allowed', ipcOptions: 'allowed',
    reached: 4,
  });
});
