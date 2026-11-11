'use strict';

// `ccxray gc` (#775) — offline garbage collection of unreferenced shared/ files.
//
// shared/ holds content-addressed system prompts and tool lists. Retention
// prune deletes _req/_res but never these, so unreferenced files accumulate
// forever. This command reclaims the ones no surviving record points at, in
// two reversible-then-final steps:
//
//   • --apply QUARANTINES: unreferenced, older-than-7-days files are MOVED
//     (rename, same filesystem) into shared/.gc-trash-<UTC ts>/. Nothing is
//     freed yet. LocalStorage.readShared/statShared restore a quarantined file
//     on a miss, so a hash that is referenced after all (a writer reusing an old
//     file between our scan and the move, a server on an unprobed port) comes
//     back transparently instead of being lost.
//   • --purge permanently deletes quarantine dirs older than 7 days.
//   • offline + explicit — `--dry-run` reports, there is no default action.
//     Never runs from startup prune, and nothing on the request path freshens
//     mtimes, so grace is judged on write time alone.
//   • --apply and --purge refuse while a server can be appending (a live
//     hub.json, or any listener on the configured port) and take the ADR 0021
//     maintenance lock — belt and braces next to the quarantine. --dry-run
//     (also `--purge --dry-run`) is read-only: it warns and takes no lock.
//   • roots = every sysHash/toolsHash named by any index.ndjson line or any
//     surviving *_req.json / *_req.received.json (D6). Hashes are pulled with a
//     regex over the raw text, not JSON.parse: a torn index line or an
//     unparseable _req still protects what it names, and a regex can only
//     over-root (safe direction), never under-root. Immediately before the
//     move --apply re-scans what was appended since the scan began (index tail
//     past the starting byte offset, request files modified since the start)
//     and drops newly rooted candidates.
//   • unknown shared/ names are never touched. Only our own
//     `.tmp-<pid>-<hex>-<name>` leftovers from an interrupted atomic write are
//     collected, under the same grace.

const fs = require('fs');
const net = require('net');
const readline = require('readline');
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

// Debris of an interrupted atomic write (local.js commitShared): exactly
// `.tmp-<pid>-<12 hex>-<recognized shared name>`. Any other `.tmp-*` is not ours.
const TMP_RE = /^\.tmp-\d+-[0-9a-f]{12}-(.+)$/;

function classify(name) {
  const tmp = TMP_RE.exec(name);
  if (tmp) return classify(tmp[1]) ? { prefix: '.tmp-', hash: null } : null;
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

async function readHashesFrom(storage, f, roots) {
  const suffix = f.endsWith('_req.received.json') ? '_req.received.json' : '_req.json';
  let text;
  try { text = await storage.read(f.slice(0, -suffix.length), suffix); } catch (e) {
    if (e.code === 'ENOENT') return; // removed mid-scan — no longer a root
    throw e; // unreadable ≠ unreferenced: abort rather than under-root
  }
  collectHashes(text, roots.sys, roots.tools);
}

const isReqFile = f => f.endsWith('_req.json') || f.endsWith('_req.received.json');

async function collectRoots(storage) {
  const roots = { sys: new Set(), tools: new Set(), reqFiles: 0 };
  for await (const line of storage.readIndexLines()) collectHashes(line, roots.sys, roots.tools);
  const reqFiles = (await storage.list()).filter(isReqFile);
  roots.reqFiles = reqFiles.length;
  await inBatches(reqFiles, 32, f => readHashesFrom(storage, f, roots));
  return roots;
}

// What the live writers may have added since the scan started: the index tail
// past `offset` (whole file if it shrank — it was rewritten) and any request
// file touched since `since` (1s slack for coarse mtimes). Over-rooting only.
async function rescanRoots(storage, roots, { offset, since }) {
  const indexPath = path.join(storage.location, 'index.ndjson');
  let size = 0;
  try { size = fs.statSync(indexPath).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (size > 0) {
    const input = fs.createReadStream(indexPath, { encoding: 'utf8', start: size < offset ? 0 : offset });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of rl) collectHashes(line, roots.sys, roots.tools); } finally { rl.close(); input.destroy(); }
  }
  const reqFiles = (await storage.list()).filter(isReqFile);
  await inBatches(reqFiles, 64, async f => {
    const suffix = f.endsWith('_req.received.json') ? '_req.received.json' : '_req.json';
    let st;
    try { st = await storage.stat(f.slice(0, -suffix.length), suffix); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.mtimeMs >= since - 1000) await readHashesFrom(storage, f, roots);
  });
}

const fmtBytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} B`;
const graceDays = ms => Math.round(ms / 86400000);

// ── quarantine (shared/.gc-trash-<UTC ts>/) ───────────────────────────────
const TRASH_RE = /^\.gc-trash-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const trashName = now => `.gc-trash-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;

async function listTrash(sharedDir, now, graceMs) {
  let names;
  try { names = await fs.promises.readdir(sharedDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const dir of names.sort()) {
    const m = TRASH_RE.exec(dir);
    if (!m) continue; // not ours / unparseable → never purged
    const ts = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    let files = 0, bytes = 0;
    for (const f of await fs.promises.readdir(path.join(sharedDir, dir))) {
      try { bytes += (await fs.promises.stat(path.join(sharedDir, dir, f))).size; files++; } catch {}
    }
    out.push({ dir, ts, files, bytes, purgeable: now - ts >= graceMs });
  }
  return out;
}

// Server-running policy. Returns a refusal result, or null to proceed.
async function serverGuard({ mutating, log, port }) {
  const blockingHub = liveHubBlocking();
  const listener = blockingHub ? null : await listenerOnConfiguredPort(port);
  if (!blockingHub && !listener) return null;
  if (!mutating) {
    log('\x1b[33mWarning: a server is running; results may change before --apply.\x1b[0m');
    return null;
  }
  if (blockingHub) {
    log(`\x1b[31mA ccxray hub is running (pid ${blockingHub.pid}). Stop it first.\x1b[0m`);
    log('  Run `ccxray status` to inspect, stop all `ccxray claude` clients, then retry.');
    return { refused: true, reason: 'hub-running' };
  }
  log(`\x1b[31mSomething is listening on ${listener}:${port ?? config.PORT} — a ccxray server may be recording. Stop it first.\x1b[0m`);
  return { refused: true, reason: 'listener' };
}

async function gcShared({ apply = false, verbose = false, storage = config.storage, log = console.log, now = Date.now(), graceMs = GRACE_MS, port, onScanned } = {}) {
  const refusal = await serverGuard({ mutating: apply, log, port });
  if (refusal) return refusal;

  if (!storage.location || !fs.existsSync(storage.location)) {
    log('No logs directory — nothing to collect.');
    return { applied: false, doomed: [], bytes: 0 };
  }
  const lock = apply ? acquireMaintenanceLock(storage, 'gc', log) : null;
  if (apply && !lock) return { refused: true, reason: 'maintenance-locked' };

  const sharedDir = path.join(storage.location, 'shared');
  try {
    const scanStart = Date.now();
    let indexOffset = 0;
    try { indexOffset = fs.statSync(path.join(storage.location, 'index.ndjson')).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const roots = await collectRoots(storage);
    const trash = await listTrash(sharedDir, now, graceMs);

    // Stat everything first; decisions are made after the final root re-scan.
    const entries = [];
    let unknown = 0;
    await inBatches(await storage.listShared(), 64, async name => {
      const c = classify(name);
      if (!c) { unknown++; return; }
      const st = await storage.statShared(name);
      if (!st) return; // vanished
      entries.push({ name, ...c, size: st.size, mtimeMs: st.mtimeMs });
    });
    if (apply) {
      if (onScanned) await onScanned(); // test seam: a writer lands between scan and move
      await rescanRoots(storage, roots, { offset: indexOffset, since: scanStart });
    }

    const stats = new Map(PREFIXES.concat([{ prefix: '.tmp-' }]).map(({ prefix }) => [prefix, {
      files: 0, bytes: 0, rooted: 0, young: 0, doomed: 0, doomedBytes: 0,
    }]));
    const doomed = [];
    for (const e of entries) {
      const st = stats.get(e.prefix);
      st.files++; st.bytes += e.size;
      if (e.hash !== null && roots[PREFIXES.find(p => p.prefix === e.prefix).roots].has(e.hash)) { st.rooted++; continue; }
      if (now - e.mtimeMs < graceMs) { st.young++; continue; }
      st.doomed++; st.doomedBytes += e.size;
      doomed.push(e.name);
    }
    doomed.sort();

    const verb = apply ? 'quarantine' : 'would quarantine';
    log(`${apply ? 'gc --apply' : 'gc --dry-run'}: ${roots.sys.size} sysHash + ${roots.tools.size} toolsHash roots from the index and ${roots.reqFiles} request files`);
    const total = { files: 0, bytes: 0, rooted: 0, young: 0, doomed: 0, doomedBytes: 0 };
    const row = (label, t) => log(`  ${label.padEnd(22)} ${String(t.files).padStart(7)} files ${fmtBytes(t.bytes).padStart(9)} | rooted ${t.rooted} | <${graceDays(graceMs)}d old ${t.young} | ${verb} ${t.doomed} (${fmtBytes(t.doomedBytes)})`);
    for (const [prefix, st] of stats) {
      if (!st.files) continue;
      for (const k of Object.keys(total)) total[k] += st[k];
      row(prefix, st);
    }
    row('total', total);
    const totalBytes = total.doomedBytes;
    if (unknown) log(`  ${unknown} unrecognized shared/ file(s) left untouched`);
    if (trash.length) {
      const purgeable = trash.filter(t => t.purgeable);
      log(`  already quarantined: ${trash.length} dir(s), ${trash.reduce((n, t) => n + t.files, 0)} files (${fmtBytes(trash.reduce((n, t) => n + t.bytes, 0))}); ${purgeable.length} older than ${graceDays(graceMs)}d — \`ccxray gc --purge\` frees them`);
    }
    if (verbose) for (const name of doomed) log(`  ${verb} ${name}`);

    if (!apply) {
      log(`${doomed.length} file(s), ${fmtBytes(totalBytes)} would be quarantined (--apply moves them to shared/${trashName(now)}/; nothing is freed until \`gc --purge\`). --verbose lists each file.`);
      return { applied: false, doomed, bytes: totalBytes };
    }
    const dir = trashName(now);
    if (doomed.length) {
      await fs.promises.mkdir(path.join(sharedDir, dir), { recursive: true, mode: 0o700 });
      await inBatches(doomed, 64, async name => {
        try { await fs.promises.rename(path.join(sharedDir, name), path.join(sharedDir, dir, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      });
    }
    log(`Quarantined ${doomed.length} file(s), ${fmtBytes(totalBytes)}${doomed.length ? ` into shared/${dir}/` : ''}. Nothing is freed yet: \`ccxray gc --purge\` deletes quarantine dirs older than ${graceDays(graceMs)}d; a read of a quarantined file restores it.`);
    return { applied: true, doomed, bytes: totalBytes, trashDir: doomed.length ? dir : null };
  } finally {
    releaseMaintenanceLock(lock);
  }
}

// `gc --purge [--dry-run]`: the irreversible step — delete quarantine dirs
// whose timestamp is older than the grace period.
async function purgeTrash({ dryRun = false, storage = config.storage, log = console.log, now = Date.now(), graceMs = GRACE_MS, port } = {}) {
  const refusal = await serverGuard({ mutating: !dryRun, log, port });
  if (refusal) return refusal;
  if (!storage.location || !fs.existsSync(storage.location)) {
    log('No logs directory — nothing to purge.');
    return { applied: false, purged: [], bytes: 0 };
  }
  const lock = dryRun ? null : acquireMaintenanceLock(storage, 'gc-purge', log);
  if (!dryRun && !lock) return { refused: true, reason: 'maintenance-locked' };
  const sharedDir = path.join(storage.location, 'shared');
  try {
    const trash = await listTrash(sharedDir, now, graceMs);
    const old = trash.filter(t => t.purgeable);
    const keep = trash.filter(t => !t.purgeable);
    const bytes = old.reduce((n, t) => n + t.bytes, 0);
    log(`${dryRun ? 'gc --purge --dry-run' : 'gc --purge'}: ${trash.length} quarantine dir(s)`);
    for (const t of old) log(`  ${dryRun ? 'would purge' : 'purge'} ${t.dir}  ${t.files} files (${fmtBytes(t.bytes)})`);
    for (const t of keep) log(`  keep  ${t.dir}  ${t.files} files (${fmtBytes(t.bytes)}) — under ${graceDays(graceMs)}d old`);
    if (!dryRun) for (const t of old) await fs.promises.rm(path.join(sharedDir, t.dir), { recursive: true, force: true });
    log(dryRun
      ? `${old.length} dir(s), ${fmtBytes(bytes)} would be permanently deleted. Re-run \`ccxray gc --purge\` to delete.`
      : `Permanently deleted ${old.length} dir(s), ${fmtBytes(bytes)}.`);
    return { applied: !dryRun, purged: old.map(t => t.dir), kept: keep.map(t => t.dir), bytes };
  } finally {
    releaseMaintenanceLock(lock);
  }
}

module.exports = { gcShared, purgeTrash, classify, GRACE_MS };
