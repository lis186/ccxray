'use strict';

// Occupy a port on the addresses a ccxray server binds by default (127.0.0.1,
// plus ::1 when the host has IPv6 loopback), so a server started on that port
// fails to bind on every OS. A wildcard listen(port) is not enough: on Windows
// (and with SO_REUSEADDR on macOS) a wildcard holder does not stop a later
// 127.0.0.1 bind. With port 0 the OS picks the port; a ::1 clash on that pick
// is retried.
const { bindPort } = require('../../server/listen');

async function occupyLoopbackPort(server, port = 0) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await bindPort(server, port, { primary: '127.0.0.1', optional: ['::1'] });
    } catch (err) {
      if (port !== 0 || err.code !== 'EADDRINUSE' || attempt >= 10) throw err;
    }
  }
}

module.exports = { occupyLoopbackPort };
