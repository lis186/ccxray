'use strict';
// Test-only preload for mutation runs (stryker.config.mjs). Never import this from
// production code. A pricing mutant can flip fetchPricing()'s cache/TTL checks and
// reach for LiteLLM; this makes every non-loopback connection fail at once, so a
// mutation run is deterministic and never touches the network. If
// CCXRAY_NETWORK_GUARD_LOG is set, each blocked attempt appends one line there.
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

function hostOf(args) {
  const [a, b] = args;
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
  throw new Error(`no-network guard: blocked ${what} to ${host}`);
}

function wrap(mod, name, label) {
  const orig = mod[name];
  mod[name] = function guarded(...args) {
    const host = hostOf(args);
    if (!LOOPBACK.has(host)) block(label, host);
    return orig.apply(this, args);
  };
}

wrap(http, 'request', 'http.request');
wrap(http, 'get', 'http.get');
wrap(https, 'request', 'https.request');
wrap(https, 'get', 'https.get');
wrap(net, 'connect', 'net.connect');
wrap(net, 'createConnection', 'net.createConnection');
wrap(tls, 'connect', 'tls.connect');
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
