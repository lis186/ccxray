'use strict';

// Frozen pre-hash client protocol: this consumer only requires the original
// register/status fields and ignores additive fields it does not understand.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

function request(sockPath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('legacy hub request timed out')), 2000);

    function finish(error, value) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.once('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(null, JSON.parse(buffer.slice(0, newline))); }
      catch (error) { finish(error); }
    });
    socket.once('error', error => finish(error));
  });
}

async function main() {
  const home = process.env.CCXRAY_HOME;
  assert.ok(home, 'CCXRAY_HOME must name the isolated compatibility fixture home');
  const lock = JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8'));
  assert.ok(lock.sockPath, 'current hub must expose the socket transport');

  const pid = process.pid;
  const registration = await request(lock.sockPath, {
    cmd: 'register', pid, cwd: '/legacy-protocol-consumer',
  });
  // These are the stable fields consumed by a client predating exportConfigHash.
  assert.equal(registration?.ok, true);
  assert.equal(typeof registration.identity?.pid, 'number');
  assert.equal(typeof registration.firstClient, 'boolean');

  const status = await request(lock.sockPath, { cmd: 'status' });
  assert.equal(status?.app, 'ccxray');
  assert.equal(typeof status.pid, 'number');
  assert.ok(Array.isArray(status.clients));

  await request(lock.sockPath, { cmd: 'unregister', pid });
  process.stdout.write(JSON.stringify({
    legacyOperationsSucceeded: true,
    additiveHashPresentOnRegistration: typeof registration.exportConfigHash === 'string',
    additiveHashPresentOnStatus: typeof status.exportConfigHash === 'string',
  }));
}

main().catch(error => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
