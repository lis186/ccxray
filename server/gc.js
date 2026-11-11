'use strict';

// `ccxray gc` (#775) — offline garbage collection of unreferenced shared/ files.
//
// shared/ holds content-addressed system prompts and tool lists. Retention
// prune deletes _req/_res but never these, so unreferenced files accumulate
// forever. This command removes the ones no surviving record points at.
//
//   • offline + explicit — `--dry-run` reports, `--apply` deletes; there is no
//     default action. Never runs from startup prune, and nothing on the request
//     path freshens mtimes, so grace is judged on write time alone.
//   • --apply refuses while a server can be appending: a live hub.json, or any
//     listener on the configured port (standalone/--port servers write no
//     hub.json), and takes the ADR 0021 maintenance lock (serializing against
//     rebuild-index). --dry-run is read-only: it only warns and takes no lock.
//   • roots = every sysHash/toolsHash named by any index.ndjson line or any
//     surviving *_req.json / *_req.received.json (D6). Hashes are pulled with a
//     regex over the raw text, not JSON.parse: a torn index line or an
//     unparseable _req still protects what it names, and a regex can only
//     over-root (safe direction), never under-root.
//   • grace — a file with mtime inside the last 7 days is never deleted.
//   • unknown shared/ names are never deleted. Only our own `.tmp-*` leftovers
//     from an interrupted atomic write are collected, under the same grace.

const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('./config');
const { liveHubBlocking, acquireMaintenanceLock, releaseMaintenanceLock } = require('./rebuild-index');

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// prefix → which root set protects it. `meta` follows its instructions file.
const PREFIXES = [
  { prefix: 'sys_', roots: 'sys' },
  { prefix: 'tools_', roots: 'tools' },
  { prefix: 'openai_instructions_', roots: 'sys' },
  { prefix: 'openai_tools_', roots: 'tools' },
  { prefix: 'openai_prompt_meta_', roots: 'sys' },
];

const HASH_RE = /"(sysHash|toolsHash)"\s*:\s*"([A-Za-z0-9_-]+)"/g;

function collectHashes(text, sys, tools) {
  HASH_RE.lastIndex = 0;
  let m;
  while ((m = HASH_RE.exec(text))) (m[1] === 'sysHash' ? sys : tools).add(m[2]);
}

function classify(name) {
  if (name.startsWith('.tmp-')) return { prefix: '.tmp-', hash: null };
  for (const { prefix } of PREFIXES) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const hash = name.slice(prefix.length, -'.json'.length);
    if (hash) return { prefix, hash };
  }
  return null; // unknown shared/ name — never touched
}

function probeListener(host, port, timeoutMs = 1000) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = v => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(true)); // can't tell → assume a listener
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false)); // ECONNREFUSED / EADDRNOTAVAIL (no ::1) → free
  });
}

async function listenerOnConfiguredPort(port = config.PORT) {
  const hosts = ['127.0.0.1', '::1'];
  const bound = process.env.PROXY_HOST;
  if (bound && !hosts.includes(bound) && bound !== '0.0.0.0' && bound !== '::') hosts.push(bound);
  for (const host of hosts) if (await probeListener(host, port)) return host;
  return null;
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function collectRoots(storage) {
  const sys = new Set();
  const tools = new Set();
  for await (const line of storage.readIndexLines()) collectHashes(line, sys, tools);

  const reqFiles = (await storage.list()).filter(f => f.endsWith('_req.json') || f.endsWith('_req.received.json'));
  await inBatches(reqFiles, 32, async f => {
    const suffix = f.endsWith('_req.received.json') ? '_req.received.json' : '_req.json';
    let text;
    try { text = await storage.read(f.slice(0, -suffix.length), suffix); } catch (e) {
      if (e.code === 'ENOENT') return; // removed mid-scan — no longer a root
      throw e; // unreadable ≠ unreferenced: abort rather than under-root
    }
    collectHashes(text, sys, tools);
  });
  return { sys, tools, reqFiles: reqFiles.length };
}

const fmtBytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} B`;

async function gcShared({ apply = false, verbose = false, storage = config.storage, log = console.log, now = Date.now(), graceMs = GRACE_MS, port } = {}) {
  // A live server only matters for --apply: dry-run reads and deletes nothing,
  // so it warns (the numbers may shift) instead of refusing, and takes no lock.
  const blockingHub = liveHubBlocking();
  const listener = blockingHub ? null : await listenerOnConfiguredPort(port);
  if (blockingHub || listener) {
    if (!apply) {
      log('\x1b[33mWarning: a server is running; results may change before --apply.\x1b[0m');
    } else if (blockingHub) {
      log(`\x1b[31mA ccxray hub is running (pid ${blockingHub.pid}). Stop it first.\x1b[0m`);
      log('  Run `ccxray status` to inspect, stop all `ccxray claude` clients, then retry.');
      return { refused: true, reason: 'hub-running' };
    } else {
      log(`\x1b[31mSomething is listening on ${listener}:${port ?? config.PORT} — a ccxray server may be recording. Stop it first.\x1b[0m`);
      return { refused: true, reason: 'listener' };
    }
  }

  if (!storage.location || !fs.existsSync(storage.location)) {
    log('No logs directory — nothing to collect.');
    return { applied: false, doomed: [], bytes: 0 };
  }
  const lock = apply ? acquireMaintenanceLock(storage, 'gc', log) : null;
  if (apply && !lock) return { refused: true, reason: 'maintenance-locked' };

  try {
    const roots = await collectRoots(storage);
    const stats = new Map(PREFIXES.concat([{ prefix: '.tmp-' }]).map(({ prefix }) => [prefix, {
      files: 0, bytes: 0, rooted: 0, young: 0, doomed: 0, doomedBytes: 0,
    }]));
    const doomed = [];
    let unknown = 0;

    const names = await storage.listShared();
    await inBatches(names, 64, async name => {
      const c = classify(name);
      if (!c) { unknown++; return; }
      const st = await storage.statShared(name);
      if (!st) return; // vanished
      const s = stats.get(c.prefix);
      s.files++; s.bytes += st.size;
      const rooted = c.hash !== null && roots[PREFIXES.find(p => p.prefix === c.prefix).roots].has(c.hash);
      if (rooted) { s.rooted++; return; }
      if (now - st.mtimeMs < graceMs) { s.young++; return; }
      s.doomed++; s.doomedBytes += st.size;
      doomed.push(name);
    });
    doomed.sort();

    log(`${apply ? 'gc --apply' : 'gc --dry-run'}: ${roots.sys.size} sysHash + ${roots.tools.size} toolsHash roots from the index and ${roots.reqFiles} request files`);
    const total = { files: 0, bytes: 0, rooted: 0, young: 0, doomed: 0, doomedBytes: 0 };
    const row = (label, t) => log(`  ${label.padEnd(22)} ${String(t.files).padStart(7)} files ${fmtBytes(t.bytes).padStart(9)} | rooted ${t.rooted} | <${Math.round(graceMs / 86400000)}d old ${t.young} | ${apply ? 'delete' : 'would delete'} ${t.doomed} (${fmtBytes(t.doomedBytes)})`);
    for (const [prefix, st] of stats) {
      if (!st.files) continue;
      for (const k of Object.keys(total)) total[k] += st[k];
      row(prefix, st);
    }
    row('total', total);
    const totalBytes = total.doomedBytes;
    if (unknown) log(`  ${unknown} unrecognized shared/ file(s) left untouched`);
    if (verbose) for (const name of doomed) log(`  ${apply ? 'delete' : 'would delete'} ${name}`);

    if (!apply) {
      log(`${doomed.length} file(s), ${fmtBytes(totalBytes)} would be deleted. Re-run with --apply to delete (--verbose lists each file).`);
      return { applied: false, doomed, bytes: totalBytes };
    }
    // deleteFile is relative to the logs dir and tolerates ENOENT
    await inBatches(doomed, 64, name => storage.deleteFile(path.join('shared', name)));
    log(`Deleted ${doomed.length} file(s), ${fmtBytes(totalBytes)}.`);
    return { applied: true, doomed, bytes: totalBytes };
  } finally {
    releaseMaintenanceLock(lock);
  }
}

module.exports = { gcShared, classify, GRACE_MS };
