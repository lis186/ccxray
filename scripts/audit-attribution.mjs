#!/usr/bin/env node
// Attribution audit — checks session-attribution invariants against a LIVE
// ccxray server (parentSessionId lives only in server memory, not in the index).
//
//   node scripts/audit-attribution.mjs [--port 5577] [--deep]
//
// Invariants:
//   I1  a session with its own cwd must not have a parentSessionId
//   I2  a child session's cwd must equal its parent's cwd (or be absent)
//   I4  a convId must not appear under more than one session
//   I3  (--deep) every inferred entry's first-message content must be findable
//       in its attributed session's other request bodies (content join).
//       Reads _req.json files from CCXRAY_HOME/logs — slow, report-only.
//
// Exit code 1 on I1/I2 violations (hard invariants). I3/I4 are report-only:
// I3 has known false negatives (pruned req files), I4 can be a legit re-run
// of the same prompt. Silence is not success: every check prints its count.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '5577';
const deep = args.includes('--deep');
const logsDir = path.join(process.env.CCXRAY_HOME || path.join(process.env.HOME, '.ccxray'), 'logs');

const res = await fetch(`http://127.0.0.1:${port}/_api/entries`);
if (!res.ok) { console.error(`fetch failed: ${res.status}`); process.exit(2); }
const entries = (await res.json()).entries;
console.log(`${entries.length} entries from :${port}\n`);

// Aggregate per session
const sess = new Map();
for (const e of entries) {
  let s = sess.get(e.sessionId);
  if (!s) sess.set(e.sessionId, s = { cwd: null, parent: null, n: 0, inferred: [] });
  if (e.cwd) s.cwd = e.cwd;
  if (e.parentSessionId) s.parent = e.parentSessionId;
  s.n++;
  if (e.sessionInferred && e.sessionId !== 'direct-api') s.inferred.push(e);
}

let hard = 0;

console.log('I1: sessions with own cwd that have a parentSessionId');
for (const [sid, s] of sess) {
  if (s.parent && s.cwd) { hard++; console.log(`  VIOLATION ${sid.slice(0, 8)} cwd=${s.cwd} → parent ${s.parent.slice(0, 8)}`); }
}
console.log(`  ${hard ? hard + ' violation(s)' : 'clean'}\n`);

console.log('I2: child cwd ≠ parent cwd');
let i2 = 0;
for (const [sid, s] of sess) {
  const p = s.parent && sess.get(s.parent);
  if (p && s.cwd && p.cwd && s.cwd !== p.cwd) { i2++; hard++; console.log(`  VIOLATION ${sid.slice(0, 8)} cwd=${s.cwd} ≠ parent cwd=${p.cwd}`); }
}
console.log(`  ${i2 ? i2 + ' violation(s)' : 'clean'}\n`);

console.log('I4: convId under multiple sessions (report-only)');
const conv = new Map();
for (const e of entries) if (e.convId) (conv.get(e.convId) || conv.set(e.convId, new Set()).get(e.convId)).add(e.sessionId);
let i4 = 0;
for (const [c, sids] of conv) if (sids.size > 1) { i4++; console.log(`  ${c} in ${[...sids].map(x => x.slice(0, 8)).join(', ')}`); }
console.log(`  ${i4 ? i4 + ' shared convId(s)' : 'clean'}\n`);

if (deep) {
  console.log('I3 (--deep): content join of inferred entries');
  const bySess = new Map();
  for (const e of entries) (bySess.get(e.sessionId) || bySess.set(e.sessionId, []).get(e.sessionId)).push(e);
  let ok = 0, suspect = 0, unreadable = 0;
  for (const [sid, s] of sess) {
    for (const e of s.inferred) {
      let req;
      try { req = JSON.parse(fs.readFileSync(path.join(logsDir, `${e.id}_req.json`), 'utf8')); } catch { unreadable++; continue; }
      const c = req.messages?.[0]?.content;
      const blocks = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text) : [];
      // Longest single line: survives the line-number prefixes that Read tool
      // results carry inside the parent's stored history (whole-block substring
      // matching false-negatives on those).
      const line = blocks.join('\n').split('\n').sort((a, b) => b.length - a.length)[0]?.trim().slice(0, 120);
      if (!line || line.length < 20) { unreadable++; continue; }
      const needle = JSON.stringify(line).slice(1, -1);
      let found = false;
      for (const sib of bySess.get(sid) || []) {
        if (sib.id === e.id) continue;
        try { if (fs.readFileSync(path.join(logsDir, `${sib.id}_req.json`), 'utf8').includes(needle)) { found = true; break; } } catch {}
      }
      if (found) ok++;
      else { suspect++; console.log(`  SUSPECT ${e.id} → ${sid.slice(0, 8)} ${JSON.stringify(line.slice(0, 60))}`); }
    }
  }
  console.log(`  confirmed=${ok} suspect=${suspect} unreadable=${unreadable}\n`);
}

process.exit(hard ? 1 : 0);
