'use strict';
// Test-only preload for mutation runs (stryker.config.mjs). Never import this from
// production code. A pricing mutant can flip fetchPricing()'s cache/TTL checks and
// reach for LiteLLM; this makes every non-loopback connection fail at once, so a
// mutation run is deterministic and never touches the network. If
// CCXRAY_NETWORK_GUARD_LOG is set, each blocked attempt appends one line there.
// If CCXRAY_NETWORK_GUARD_ENFORCE=1 (the unit lane, via scripts/run-tests.js), a blocked attempt is
// also sticky: it prints a stderr line and forces a non-zero exit code, so code that catches the
// thrown error (e.g. pricing startup) still fails the process. Without it the guard only throws.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

// Propagate to Node children, like home-guard.js, so a spawned test process is covered too.
if (!(process.env.NODE_OPTIONS || '').includes(__filename)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(__filename)}`.trim();
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

const ENFORCE = process.env.CCXRAY_NETWORK_GUARD_ENFORCE === '1';
let violated = false;
if (ENFORCE) process.on('exit', () => { if (violated) process.exitCode = 1; });

// ipcPaths: only the net/tls overloads treat a bare non-numeric string as an IPC path; for
// http/https/fetch a string is a URL ('https:example.com' is a valid absolute one).
function hostOf(args, ipcPaths) {
  const [a, b] = args;
  if (ipcPaths && typeof a === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a) && !/^\d+$/.test(a)) return '';
  if (typeof a === 'string' || a instanceof URL) {
    try { return new URL(String(a)).hostname; } catch { return String(a); }
  }
  if (a && typeof a === 'object') {
    if (a.path && !a.host && !a.hostname && !a.port) return ''; // unix socket
    return a.hostname || a.host || 'localhost';
  }
  if (typeof a === 'number') return typeof b === 'string' ? b : 'localhost';
  return 'localhost';
}

function block(what, host) {
  if (process.env.CCXRAY_NETWORK_GUARD_LOG) {
    try { fs.appendFileSync(process.env.CCXRAY_NETWORK_GUARD_LOG, `${process.pid} ${what} ${host}\n`); } catch {}
  }
  if (ENFORCE) {
    violated = true;
    process.exitCode = 1;
    try { fs.writeSync(2, `no-network guard: BLOCKED ${what} to ${host} (unit lane must not use the network)\n`); } catch {}
  }
  throw new Error(`no-network guard: blocked ${what} to ${host}`);
}

function wrap(mod, name, label, ipcPaths) {
  const orig = mod[name];
  mod[name] = function guarded(...args) {
    const host = hostOf(args, ipcPaths);
    if (!LOOPBACK.has(host)) block(label, host);
    return orig.apply(this, args);
  };
}

wrap(http, 'request', 'http.request');
wrap(http, 'get', 'http.get');
wrap(https, 'request', 'https.request');
wrap(https, 'get', 'https.get');
wrap(net, 'connect', 'net.connect', true);
wrap(net, 'createConnection', 'net.createConnection', true);
wrap(tls, 'connect', 'tls.connect', true);

// Socket#connect takes (port[, host]), (options) or (path) — a bare string is an IPC path and
// stays allowed. Node's internals call it with an already-normalized [options, cb] array.
function socketHost(args) {
  let [a, b] = args;
  if (Array.isArray(a)) [a, b] = a;
  if (typeof a === 'string') return /^\d+$/.test(a) ? (typeof b === 'string' ? b : 'localhost') : '';
  return hostOf([a, b], true);
}
const origSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  const host = socketHost(args);
  if (!LOOPBACK.has(host)) block('net.Socket.connect', host);
  return origSocketConnect.apply(this, args);
};
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const host = hostOf([typeof input === 'object' && input && input.url ? input.url : input]);
    if (!LOOPBACK.has(host)) {
      try { block('fetch', host); } catch (e) { return Promise.reject(e); }
    }
    return origFetch.call(this, input, init);
  };
}
