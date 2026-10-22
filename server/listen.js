'use strict';

// Listen addresses for the proxy + dashboard port.
//
// Default: loopback only. 127.0.0.1 is required; ::1 is added on the same port
// when the host has IPv6 loopback, because `localhost` resolves to ::1 first on
// macOS and some Linux setups and not every client falls back to 127.0.0.1.
// The ::1 listener hands each connection to the main HTTP server, so request,
// 'upgrade' (WebSocket), SSE and hub routes behave identically on both.
//
// PROXY_HOST opts in to a single listener on another address (0.0.0.0, ::, or
// one interface). Non-loopback peers still need a ccxray credential.

const net = require('net');

// Optional listeners are skipped when the address does not exist on this host.
const SKIPPABLE_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);
const EXTRA_LISTENERS = Symbol('ccxray.extraListeners');

function resolveListenHosts(env = process.env) {
  const host = String(env.PROXY_HOST || '').trim();
  if (!host) return { primary: '127.0.0.1', optional: ['::1'] };
  return { primary: host, optional: [] };
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || /^::ffff:127\./.test(h);
}

function listenOnce(target, port, host) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      target.removeListener('listening', onListening);
      reject(err);
    }
    function onListening() {
      target.removeListener('error', onError);
      resolve();
    }
    target.once('error', onError);
    target.once('listening', onListening);
    target.listen(port, host);
  });
}

// Stop the extra listeners together with the main server. The override is
// removed after one call so the server can listen again (port scan retries).
function attachExtras(srv, extras) {
  srv[EXTRA_LISTENERS] = extras;
  if (!extras.length) return;
  const hadOwnClose = Object.prototype.hasOwnProperty.call(srv, 'close');
  const close = srv.close;
  srv.close = function closeAll(cb) {
    if (hadOwnClose) srv.close = close; else delete srv.close;
    for (const extra of srv[EXTRA_LISTENERS] || []) extra.close();
    srv[EXTRA_LISTENERS] = [];
    return close.call(this, cb);
  };
}

// Bind `srv` on one port across every selected host. Either every required
// listener is up on the same port, or nothing is left listening and the error
// is rethrown — an EADDRINUSE on ::1 makes the whole port count as in use, so
// the caller's port scan / bind retry moves on instead of splitting the port
// across two processes.
async function bindPort(srv, port, hosts = resolveListenHosts()) {
  await listenOnce(srv, port, hosts.primary);
  const bound = srv.address().port;
  const extras = [];
  for (const host of hosts.optional) {
    const extra = net.createServer(socket => srv.emit('connection', socket));
    try {
      await listenOnce(extra, bound, host);
      extras.push(extra);
    } catch (err) {
      if (SKIPPABLE_CODES.has(err.code)) continue;
      for (const e of extras) e.close();
      await new Promise(resolve => srv.close(() => resolve()));
      throw err;
    }
  }
  attachExtras(srv, extras);
  return bound;
}

function listenAddresses(srv) {
  const out = [];
  const main = srv.address();
  if (main && typeof main === 'object') out.push(main);
  for (const extra of srv[EXTRA_LISTENERS] || []) {
    const a = extra.address();
    if (a && typeof a === 'object') out.push(a);
  }
  return out;
}

function formatAddress(a) {
  return a.family === 'IPv6' || a.address.includes(':') ? `[${a.address}]:${a.port}` : `${a.address}:${a.port}`;
}

module.exports = {
  resolveListenHosts,
  isLoopbackHost,
  bindPort,
  listenAddresses,
  formatAddress,
};
