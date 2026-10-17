'use strict';

// Host and internal-subagent attribution (docs/agentflow-integration.md,
// Attribution: Host turns, Lineage; Ask windows W7). Pure: merged turns,
// parsed transcripts and per-notebook windows in, rows out.

const { AGENT_WORKTREE } = require('../usage-query');
const { resolveTurn } = require('./windows');
const { stripSlash } = require('../paths');

// Native lineage: subagent turns are recorded under their host's session id,
// whatever cwd their own worktree gave them.
function isSubagentTurn(e) {
  return e.isSubagent === true || !!e.subagentId || AGENT_WORKTREE.test(e.cwd || '');
}

// Lineage recorded by the transcript itself (a subagent file's agent id, or a
// worktree-isolated Task's cwd), as opposed to the proxy's inferred flag.
function isNativeSubagent(e) {
  return !!e.subagentId || AGENT_WORKTREE.test(e.cwd || '');
}

// Notebook evidence in a session's tool calls: the notebook path (relative or
// absolute). Generic evidence, `agf` or the workspace directory, counts only for
// the checkout's default notebook (`nb.isDefault`), the one a bare `agf` targets.
// Bash command text is part of the tool input, so it counts.
function mentionsNotebook(transcript, nb) {
  const paths = [nb.abs, nb.rel].filter(Boolean);
  const generic = nb.isDefault ? [nb.workspaceAbs + '/', nb.workspaceRel + '/'].filter(Boolean) : [];
  return transcript.tools.some(t => {
    const text = t.input || '';
    return [...paths, ...generic].some(n => text.includes(n))
      || (nb.isDefault && /(^|[^\w-])agf([^\w-]|$)/u.test(text));
  });
}

function firstStart(windows) {
  const starts = windows.filter(w => w.startKind === 'matched' || w.startKind === 'estimated').map(w => w.start);
  return starts.length ? Math.min(...starts) : null;
}

// notebooks: [{ abs, rel, workspaceAbs, workspaceRel, windows }]; `report` is the
// index of the notebook being reported; the others are evaluated so that a
// cross-notebook conflict shows as `ambiguous` instead of disappearing.
function attributeHosts({ turns, checkoutRoot, notebooks, report = 0, transcripts }) {
  const root = stripSlash(checkoutRoot);
  const bySession = new Map();
  for (const e of turns) {
    if (!e.sessionId) continue;
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId).push(e);
  }
  const reportWindows = notebooks[report].windows;
  const setupBefore = firstStart(reportWindows);
  const noLocal = reportWindows.filter(w => w.startKind === 'no local evidence');
  const out = { rows: [], setup: [], unassigned: [], excludedSessions: 0, offRoot: [], noLocalTurns: {}, hostOf: new Map(), background: 0 };
  const rowsByKey = new Map();
  const row = (ask, session, status, evidence, labels) => {
    const key = `${ask}\0${session}\0${status}`;
    if (!rowsByKey.has(key)) {
      const r = { ask, session, kind: 'host', status, evidence, labels, turns: [] };
      rowsByKey.set(key, r);
      out.rows.push(r);
    }
    return rowsByKey.get(key);
  };

  for (const [sid, rows] of bySession) {
    if (!rows.some(e => !isSubagentTurn(e) && stripSlash(e.cwd) === root)) continue;
    const transcript = transcripts.get(sid) || null;
    // Codex background threads (memory_consolidation and the like) carry a cwd
    // but are no host: left out of every total and counted (Attribution).
    if (transcript && transcript.background) { out.background++; continue; }
    const hostOf = notebooks.map((nb, i) => i).filter(i => !transcript
      || notebooks[i].windows.some(w => w.hostSessions.includes(sid))
      || mentionsNotebook(transcript, notebooks[i]));
    if (!hostOf.length) { out.excludedSessions++; continue; }
    out.hostOf.set(sid, hostOf);
    const labels = transcript ? [] : ['evidence unreadable'];

    for (const e of rows) {
      if (!(isSubagentTurn(e) || stripSlash(e.cwd) === root)) {
        // A shell `cd` below the root moves the transcript cwd; condition 1
        // keeps such turns out, and the report discloses them.
        if (e.cwd && e.cwd.startsWith(root + '/')) out.offRoot.push(e);
        continue;
      }
      const hits = [];
      for (const i of hostOf) {
        const r = resolveTurn(notebooks[i].windows, e.receivedAt);
        if (r) hits.push({ i, ...r });
      }
      const ours = hits.find(h => h.i === report);
      if (ours && hits.length > 1) { row(ours.id, sid, 'ambiguous', 'window', labels).turns.push(e); continue; }
      if (ours) {
        const w = reportWindows.find(x => x.id === ours.id);
        const evidence = w.hostSessions.includes(sid) ? 'prompt-match' : 'window';
        const r = row(ours.id, sid, 'unique', evidence, labels);
        r.turns.push(e);
        if (ours.overlap) r.overlap = true;
        continue;
      }
      if (hits.length || !hostOf.includes(report)) continue; // another notebook's turn
      if (setupBefore == null || e.receivedAt < setupBefore) { out.setup.push(e); continue; }
      out.unassigned.push(e);
      const nl = noLocal.find(w => e.receivedAt >= w.start && e.receivedAt < w.end);
      if (nl) out.noLocalTurns[nl.id] = (out.noLocalTurns[nl.id] || 0) + 1;
    }
  }
  return out;
}

module.exports = { isSubagentTurn, isNativeSubagent, mentionsNotebook, attributeHosts };
