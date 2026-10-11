'use strict';

// Locating the transcripts of known sessions. Sessions come from the index (by
// cwd); files are found by session id, never by encoding a cwd into a project
// directory name (Claude Code replaces every non-alphanumeric character, `_`
// included, so the encoding is not reversible).

const fs = require('fs');
const path = require('path');
const { discoverHomes, discoverCodexHomes } = require('../importer');

function readdir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function defaultRoots() {
  return {
    claudeDirs: discoverHomes().map(h => h.dir),
    codexDirs: discoverCodexHomes().map(h => h.dir),
  };
}

// sessionIds → Map(sessionId → { provider, file }). A session missing from the
// map has no readable transcript on this machine.
function findTranscripts(sessionIds, { claudeDirs, codexDirs } = defaultRoots()) {
  const wanted = new Set(sessionIds);
  const found = new Map();
  for (const projects of claudeDirs) {
    for (const p of readdir(projects)) {
      if (!p.isDirectory()) continue;
      for (const sid of wanted) {
        if (found.has(sid)) continue;
        const file = path.join(projects, p.name, `${sid}.jsonl`);
        if (fs.existsSync(file)) found.set(sid, { provider: 'anthropic', file });
      }
    }
  }
  // Codex rollouts: sessions/YYYY/MM/DD/rollout-<time>-<sessionId>.jsonl
  const walk = (dir, depth) => {
    for (const d of readdir(dir)) {
      const full = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (d.isFile() && d.name.endsWith('.jsonl')) {
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(d.name);
        if (m && wanted.has(m[1]) && !found.has(m[1])) found.set(m[1], { provider: 'openai', file: full });
      }
    }
  };
  for (const sessions of codexDirs) walk(sessions, 0);
  return found;
}

function headCwd(file, pattern) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = pattern.exec(buf.toString('utf8', 0, n));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Host sessions straight from the transcripts, so a session the index has not
// imported yet still contributes its owner submissions (and the report can say
// the Ask is not imported yet rather than that it ran elsewhere). The project
// directory name only narrows the search; the recorded cwd decides.
function checkoutTranscripts(root, { claudeDirs, codexDirs } = defaultRoots(), { from = 0 } = {}) {
  const found = new Map();
  const dirName = root.replace(/[^a-zA-Z0-9]/gu, '-');
  for (const projects of claudeDirs) {
    const dir = path.join(projects, dirName);
    for (const f of readdir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      try { if (fs.statSync(file).mtimeMs < from) continue; } catch { continue; }
      if (headCwd(file, /"cwd":"((?:[^"\\]|\\.)*)"/u) === root) found.set(f.name.slice(0, -'.jsonl'.length), { provider: 'anthropic', file });
    }
  }
  const walk = (dir, depth) => {
    for (const d of readdir(dir)) {
      const full = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (d.isFile() && d.name.endsWith('.jsonl')) {
        try { if (fs.statSync(full).mtimeMs < from) continue; } catch { continue; }
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(d.name);
        if (m && headCwd(full, /"cwd":"((?:[^"\\]|\\.)*)"/u) === root) found.set(m[1], { provider: 'openai', file: full });
      }
    }
  };
  for (const sessions of codexDirs) walk(sessions, 0);
  return found;
}

// A Claude host's Task-subagent transcripts: `<project>/<sessionId>/subagents/*.jsonl`.
// Their lines carry the host's session id; their tool events are evidence too.
function subagentTranscripts(hostFile) {
  const dir = path.join(path.dirname(hostFile), path.basename(hostFile, '.jsonl'), 'subagents');
  return readdir(dir).filter(d => d.isFile() && d.name.endsWith('.jsonl')).map(d => path.join(dir, d.name));
}

module.exports = { defaultRoots, findTranscripts, checkoutTranscripts, subagentTranscripts };
