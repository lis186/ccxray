'use strict';

// Ask windows, steps W1-W7 of docs/agentflow-integration.md. Pure: the notebook
// and the owner submissions come in, windows and host membership come out.

const { paragraphs } = require('./notebook');

const DEFAULT_TAIL_MS = 2 * 60 * 1000;

function byTime(a, b) {
  return (a.at - b.at)
    || (a.sessionIds[0] < b.sessionIds[0] ? -1 : a.sessionIds[0] > b.sessionIds[0] ? 1 : 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function buildWindows(asks, submissions, { now, tailMs = DEFAULT_TAIL_MS } = {}) {
  if (!Number.isFinite(now)) throw new Error('buildWindows needs `now`');
  // W2: one global sequence of paragraphs, ordered by submission then index.
  const subs = [...submissions].sort(byTime);
  const positions = [];
  for (const sub of subs) {
    paragraphs(sub.text).forEach((text, idx) => { if (text) positions.push({ sub, idx, text }); });
  }

  const consumedBy = new Map(); // submission → Ask id (a submission serves one Ask)
  let cursor = -1;              // last consumed position, across all Asks (W4)
  let latestStamp = null;
  const windows = [];

  for (const ask of asks) {
    const w = { id: ask.id, start: null, end: null, startKind: null, labels: [], hostSessions: [], unmatchedBullets: 0, matches: [], firstSub: null };
    windows.push(w);
    const lower = latestStamp;
    if (ask.stamp != null) latestStamp = latestStamp == null ? ask.stamp : Math.max(latestStamp, ask.stamp);
    if (!ask.bullets.length && !ask.hasReply) { w.labels.push('empty'); continue; }
    if (ask.hasReply && ask.stamp == null) { w.labels.push('stamp unreadable'); continue; }
    const upper = ask.hasReply ? ask.stamp : now;
    const inBounds = s => s.at < upper && (lower == null || s.at > lower);
    const free = s => !consumedBy.has(s) || consumedBy.get(s) === ask.id;

    for (const bullet of ask.bullets) {
      const before = cursor;
      let found = -1;
      for (let p = cursor + 1; p < positions.length; p++) {
        const pos = positions[p];
        if (pos.text === bullet && inBounds(pos.sub) && free(pos.sub)) { found = p; break; }
      }
      if (found < 0) { w.unmatchedBullets++; continue; }
      const sub = positions[found].sub;
      cursor = found;
      consumedBy.set(sub, ask.id);
      w.matches.push(sub);
      if (!w.firstSub) {
        w.firstSub = sub;
        // W5: another eligible, unconsumed submission could have supplied it.
        const tie = positions.some((pos, p) => p > before && pos.sub !== sub && pos.text === bullet && inBounds(pos.sub) && !consumedBy.has(pos.sub));
        if (tie) w.labels.push('start tie');
      }
    }

    // W6. With no owner submission of this machine inside the bounds, the Ask
    // most likely ran elsewhere: its window serves dispatch and completion
    // evidence only and never takes this machine's host turns.
    w.lower = lower;
    if (w.firstSub) { w.start = w.firstSub.at; w.startKind = 'matched'; }
    else if (lower != null && subs.some(inBounds)) { w.start = lower; w.startKind = 'estimated'; w.labels.push('estimated start'); }
    else if (lower != null) { w.start = lower; w.startKind = 'no local evidence'; w.labels.push('no local evidence'); }
    else { w.labels.push('unmeasured'); continue; }
    w.end = ask.hasReply ? ask.stamp : now;
    w.stamp = ask.hasReply ? ask.stamp : null;
    if (!ask.hasReply) w.labels.push('open');
  }

  // Tail: the window ends at stamp + tail, never before its own stamp. Only a
  // matched next start caps it: an estimated start IS this stamp, and capping
  // at it would hand this Ask's wrap-up turns to the next one.
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (w.stamp == null) continue;
    const next = windows.slice(i + 1).find(n => n.startKind === 'matched');
    w.end = Math.max(w.stamp, Math.min(w.stamp + tailMs, next ? next.start : Infinity));
  }
  // An estimated start is the previous Reply stamp; it begins after that Ask's
  // tail instead, or the latest-start rule would hand the tail to it anyway.
  const endByStamp = new Map(windows.filter(w => w.stamp != null).map(w => [w.stamp, w.end]));
  for (const w of windows) {
    if (w.startKind !== 'estimated' && w.startKind !== 'no local evidence') continue;
    const prevEnd = endByStamp.get(w.lower);
    if (prevEnd != null) w.start = Math.min(Math.max(w.start, prevEnd), w.end);
  }

  // W7: every session with a matched submission is a prompt-match host row.
  for (const w of windows) {
    w.hostSessions = [...new Set(w.matches.flatMap(s => s.sessionIds))];
    w.firstMatchAt = Object.fromEntries(w.hostSessions.map(sid => [sid, w.matches.find(s => s.sessionIds.includes(sid)).at]));
  }
  const consumed = new Set([...consumedBy.keys()].map(s => s.key));
  return { windows: windows.map(({ matches, firstSub, lower, ...w }) => w), submissions: subs, consumed };
}

// Disclosure for one host row: that host's owner submissions inside the window
// that matched no bullet, and the times of its submissions after its first
// matched one (a window-evidence host has none matched, so none are "after").
function disclose(w, sessionId, { submissions, consumed }) {
  const inWin = submissions.filter(s => s.sessionIds.includes(sessionId) && s.at >= w.start && s.at < w.end);
  const first = w.firstMatchAt[sessionId];
  return {
    unmatched: inWin.filter(s => !consumed.has(s.key)).length,
    after: first == null ? [] : inWin.filter(s => s.at > first).map(s => s.at),
  };
}

// W7 per-turn resolution within one notebook: among windows holding the turn,
// the one with the latest start; the overlap is reported. A `no local evidence`
// window never takes a host turn.
function resolveTurn(windows, at) {
  const holding = windows.filter(w => (w.startKind === 'matched' || w.startKind === 'estimated') && at >= w.start && at < w.end);
  if (!holding.length) return null;
  holding.sort((a, b) => b.start - a.start);
  return { id: holding[0].id, overlap: holding.length > 1 };
}

module.exports = { DEFAULT_TAIL_MS, buildWindows, disclose, resolveTurn };
