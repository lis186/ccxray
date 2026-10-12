'use strict';

// Launch-chain evidence (docs/agentflow-integration.md, E5) and clone-origin
// evidence (E4). This module finds evidence; binding runs to it is E2/E3's job.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runnerClonePaths, namesRunner, launchHandles } = require('./runner');

// Every clone path reported in runner-shaped tool results (E1 reverse discovery).
function reverseDiscovered(toolEvents, { checkoutRoots = [] } = {}) {
  const found = new Set();
  for (const ev of toolEvents) for (const p of runnerClonePaths(ev.result, { checkoutRoots })) found.add(p);
  return found;
}

// A handle mentioned as a whole token: `"session_id":1` must not match `"session_id":12`.
function mentions(text, handle) {
  const word = /[\w-]/u;
  for (let i = text.indexOf(handle); i >= 0; i = text.indexOf(handle, i + 1)) {
    const before = text[i - 1], after = text[i + handle.length];
    if ((!before || !word.test(handle[0]) || !word.test(before)) && (!after || !word.test(handle[handle.length - 1]) || !word.test(after))) return true;
  }
  return false;
}

// Tool events are paired within their original transcript (`origin`); a
// subagent's events carry its host's session id for lineage after pairing.
// Returns the launches (a), the results (b) naming a known clone, and the strong
// chains: (a) and (b) the same tool call, or (b)'s input naming a handle that
// (a)'s immediate result returned.
function chainEvidence(toolEvents, clones, { checkoutRoots = [] } = {}) {
  const launches = [], results = [], strong = [];
  for (const ev of toolEvents) {
    if (namesRunner(ev.input)) launches.push({ ev, handles: launchHandles(ev.result) });
    for (const clone of runnerClonePaths(ev.result, { checkoutRoots })) {
      if (clones.has(clone)) results.push({ ev, clone, truncated: !!ev.truncated });
    }
  }
  for (const r of results) {
    let launch = null;
    if (namesRunner(r.ev.input)) launch = r.ev;
    else {
      const via = launches.filter(l => l.ev !== r.ev && l.ev.origin === r.ev.origin && l.ev.inputAt != null && r.ev.inputAt != null
        && l.ev.inputAt <= r.ev.inputAt && l.handles.some(h => mentions(r.ev.input || '', h)));
      if (via.length) launch = via.sort((a, b) => b.ev.inputAt - a.ev.inputAt)[0].ev;
    }
    if (launch) strong.push({ clone: r.clone, launch, result: r.ev, interval: [launch.inputAt, r.ev.resultAt], truncated: r.truncated });
  }
  return { launches, results, strong };
}

function realpath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// E4: the source a clone was made from, from its `clone: from <source>` reflog
// entry, searched among all entries. null when the clone or its reflog is gone.
function cloneOrigin(clone) {
  let out;
  try {
    out = execFileSync('git', ['-C', clone, 'reflog', '--format=%gs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch { return null; }
  for (const line of out.split('\n')) {
    const m = /^clone: from (.+)$/u.exec(line.trim());
    if (m) return realpath(m[1].replace(/^file:\/\//u, ''));
  }
  return null;
}

module.exports = { reverseDiscovered, chainEvidence, cloneOrigin };
