'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

function canBind(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', err => err.code === 'EADDRINUSE' ? resolve(false) : reject(err));
    server.listen(port, '127.0.0.1', () => server.close(err => err ? reject(err) : resolve(true)));
  });
}

async function allocatePortBeforeContenders() {
  // A listen(0) result is released before it can be pinned. Verify it is still
  // bindable and retry here, before any lock contender exists in the fixture.
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = net.createServer();
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const value = server.address().port;
        server.close(err => err ? reject(err) : resolve(value));
      });
    });
    if (port !== 5577 && await canBind(port)) return port;
  }
  throw new Error('could not allocate an available lock fixture port before contenders started');
}

async function pinExportLockPort(home) {
  const port = await allocatePortBeforeContenders();
  fs.writeFileSync(path.join(home, 'export-lock-port'), `${port}\n`);
  return port;
}

module.exports = { pinExportLockPort };
